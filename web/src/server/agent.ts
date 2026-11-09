import {
  deleteSession,
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { REPO_DIR } from "./config.ts";
import type { ProjectRules } from "./data.ts";

// `path` is the target file taken before the display input is clipped, so a
// long write still identifies the file it produced.
export type ToolUse = { id: string; name: string; input: string; path?: string };

export type ChatEvent =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; tools: ToolUse[]; sub: boolean }
  | { kind: "tool_result"; toolUseId: string; text: string; isError: boolean }
  | { kind: "permission"; requestId: string; toolName: string; input: string; reason?: string; canAlways: boolean }
  | { kind: "question"; requestId: string; questions: Question[] }
  | { kind: "resolved"; requestId: string; outcome: string }
  | { kind: "result"; ok: boolean; text: string; costUsd?: number; durationMs?: number }
  | { kind: "error"; text: string };

export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

export type RetryInfo = { attempt: number; maxRetries: number; status: number | null; error: string; delayMs: number };

export type LiveEvent =
  | ChatEvent
  | { kind: "delta"; text: string }
  | { kind: "state"; state: SessionState; sdkSessionId: string | null }
  | { kind: "retry"; retry: RetryInfo | null };

export type SessionState = "idle" | "running" | "closed";

const MAX_TEXT = 6000;
// The UI rebuilds the task checklist from these inputs, and a clipped list
// would no longer parse; they stay small enough to send whole.
const PROGRESS_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
const MAX_EVENTS = 2000;

const WEB_APPEND = [
  "You are running behind a local web UI for this job-search repo.",
  "The user reads your replies as rendered Markdown and answers AskUserQuestion through a form, so prefer AskUserQuestion for choices.",
  "Write to the user in the language they use (usually Korean).",
  "The UI shows your todo list as the progress checklist of the task: for any multi-step request, especially slash commands such as /apply, /setup, /rank, /outcome or /interview,",
  "create the todo list (TodoWrite, or TaskCreate/TaskUpdate if that is what you have) before the first step and keep it current as steps start and finish.",
  "Write each item as a short Korean phrase a job seeker understands (e.g. '적합도 평가', '이력서 초안 작성'), never a file path, tool or command name.",
  "End a finished task with a short summary of what was produced and what the user should do next.",
].join(" ");

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max}자 생략)` : text;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringify(content);
  return content
    .map((b) => (b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b ? String(b.text) : `[${(b as { type?: string })?.type ?? "content"}]`))
    .join("\n");
}

function toolUse(b: { id?: unknown; name?: unknown; input?: unknown }): ToolUse {
  const name = String(b.name);
  const raw = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
  // A task's long description is not part of the checklist; dropping it keeps
  // the progress input well under the cap.
  const input = name === "TaskCreate" ? { subject: raw.subject, activeForm: raw.activeForm } : b.input;
  const tool: ToolUse = { id: String(b.id), name, input: clip(stringify(input), PROGRESS_TOOLS.has(name) ? 20_000 : 2000) };
  if (typeof raw.file_path === "string") tool.path = raw.file_path;
  return tool;
}

export function messageToEvents(role: string, message: unknown, sub: boolean): ChatEvent[] {
  const content = (message as { content?: unknown })?.content;
  if (role === "assistant") {
    if (!Array.isArray(content)) return [];
    const text = content
      .filter((b) => b?.type === "text")
      .map((b) => String(b.text))
      .join("\n\n");
    const tools = content.filter((b) => b?.type === "tool_use").map(toolUse);
    return text || tools.length ? [{ kind: "assistant", text, tools, sub }] : [];
  }
  if (role === "user") {
    if (typeof content === "string") return sub ? [] : [{ kind: "user", text: content }];
    if (!Array.isArray(content)) return [];
    const events: ChatEvent[] = [];
    for (const b of content) {
      if (b?.type === "tool_result") {
        events.push({ kind: "tool_result", toolUseId: String(b.tool_use_id), text: clip(blockText(b.content)), isError: Boolean(b.is_error) });
      } else if (b?.type === "text" && !sub) {
        events.push({ kind: "user", text: String(b.text) });
      }
    }
    return events;
  }
  return [];
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(item: SDKUserMessage) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type Pending = {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  canAlways: boolean;
  resolve: (r: PermissionResult) => void;
};

export type SessionOptions = {
  resume?: string;
  title?: string;
  kind?: string;
  history?: ChatEvent[];
  rules?: ProjectRules | null;
  // False while input is not allowed (a data reset is running).
  mayWrite?: () => boolean;
  onProcessChange?: (session: ChatSession, exited: boolean) => void;
};

export const FROZEN_MESSAGE = "데이터를 초기화하는 중이에요. 끝난 뒤 다시 시도하세요.";

export class ChatSession {
  readonly id = crypto.randomUUID();
  readonly createdAt = Date.now();
  lastActivity = Date.now();
  sdkSessionId: string | null;
  title: string;
  readonly kind: string;
  state: SessionState = "idle";
  events: ChatEvent[] = [];
  private input = new InputQueue();
  private q: Query | null = null;
  private pending = new Map<string, Pending>();
  // uuids of sends the SDK has not answered yet. A result names the sends it
  // consumed, so a result produced before a later send cannot mark it done.
  private unanswered: string[] = [];
  retry: RetryInfo | null = null;
  // Claude Code processes this session spawned and has not yet seen exit, and
  // when the last one exited: observed, not inferred from timers.
  private procs = new Set<ChildProcess>();
  exitedAt: number | null = null;
  private mayWrite: () => boolean;
  private onProcessChange: (session: ChatSession, exited: boolean) => void;

  constructor(
    private emit: (session: ChatSession, ev: LiveEvent) => void,
    private onClosed: (session: ChatSession) => void,
    opts: SessionOptions = {},
  ) {
    this.mayWrite = opts.mayWrite ?? (() => true);
    this.onProcessChange = opts.onProcessChange ?? (() => {});
    this.sdkSessionId = opts.resume ?? null;
    this.title = opts.title ?? "새 대화";
    this.kind = opts.kind ?? "chat";
    if (opts.history) this.events = opts.history.slice(-MAX_EVENTS);
    this.q = query({
      prompt: this.input,
      options: {
        cwd: REPO_DIR,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", append: WEB_APPEND },
        permissionMode: "default",
        canUseTool: this.canUseTool,
        includePartialMessages: true,
        resume: opts.resume,
        allowedTools: opts.rules?.allow,
        disallowedTools: opts.rules?.deny,
        spawnClaudeCodeProcess: this.spawnProcess,
      },
    });
    void this.pump();
  }

  get processAlive() {
    return this.procs.size > 0;
  }

  // Same spawn the SDK does by default, kept here so the session sees the
  // child's real exit. stderr is drained so a chatty child never blocks.
  private spawnProcess = (o: SpawnOptions): SpawnedProcess => {
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], signal: o.signal });
    child.stderr?.resume();
    this.procs.add(child);
    this.onProcessChange(this, false);
    // Only an observed exit says a writer stopped. A spawn that failed before
    // any process existed just stops being tracked; it proves nothing about
    // whoever else may be writing the transcript.
    const untrack = (exited: boolean) => {
      if (!this.procs.delete(child)) return;
      if (exited) this.exitedAt = Date.now();
      this.onProcessChange(this, exited);
    };
    child.once("exit", () => untrack(true));
    child.once("error", () => {
      if (child.pid === undefined) untrack(false);
    });
    return child as unknown as SpawnedProcess;
  };

  private record(ev: ChatEvent) {
    this.lastActivity = Date.now();
    if (this.retry && (ev.kind === "assistant" || ev.kind === "result" || ev.kind === "error")) {
      this.retry = null;
      this.emit(this, { kind: "retry", retry: null });
    }
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit(this, ev);
  }

  private setState(state: SessionState) {
    this.state = state;
    this.emit(this, { kind: "state", state, sdkSessionId: this.sdkSessionId });
  }

  send(text: string) {
    if (this.state === "closed") throw new Error("종료된 세션입니다");
    if (!this.mayWrite()) throw new Error(FROZEN_MESSAGE);
    if (this.title === "새 대화") this.title = text.slice(0, 60);
    this.record({ kind: "user", text });
    const uuid = crypto.randomUUID();
    this.unanswered.push(uuid);
    this.setState("running");
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid,
      origin: { kind: "human" },
    } as SDKUserMessage);
  }

  private async pump() {
    try {
      for await (const m of this.q!) this.handle(m);
    } catch (err) {
      this.record({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      for (const [id, p] of this.pending) {
        p.resolve({ behavior: "deny", message: "세션이 종료되었습니다" });
        this.record({ kind: "resolved", requestId: id, outcome: "cancelled" });
      }
      this.pending.clear();
      this.setState("closed");
      this.onClosed(this);
    }
  }

  private handle(m: SDKMessage) {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.sdkSessionId = m.session_id;
          this.emit(this, { kind: "state", state: this.state, sdkSessionId: this.sdkSessionId });
        } else if (m.subtype === "api_retry") {
          // Live only, not kept in the transcript: tells the user why nothing
          // is happening (bad endpoint, wrong token, rate limit) while Claude Code retries.
          this.retry = { attempt: m.attempt, maxRetries: m.max_retries, status: m.error_status, error: String(m.error), delayMs: m.retry_delay_ms };
          this.emit(this, { kind: "retry", retry: this.retry });
        }
        return;
      case "stream_event": {
        const ev = m.event as { type?: string; delta?: { type?: string; text?: string } };
        if (m.parent_tool_use_id === null && ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.emit(this, { kind: "delta", text: ev.delta.text });
        }
        return;
      }
      case "assistant":
      case "user":
        if (m.type === "user" && (m as { isReplay?: boolean }).isReplay) return;
        for (const ev of messageToEvents(m.type, m.message, m.parent_tool_use_id !== null)) {
          if (ev.kind === "user") continue;
          this.record(ev);
        }
        return;
      case "result": {
        const ok = m.subtype === "success" && !m.is_error;
        const text = m.subtype === "success" ? "" : m.subtype;
        this.record({ kind: "result", ok, text, costUsd: m.total_cost_usd, durationMs: m.duration_ms });
        // Sends are consumed in order, so everything up to the newest send this
        // result names is answered (the SDK caps its list at 64 but always
        // includes the newest). A result naming no send (a synthetic turn or a
        // session-level failure) answers none of them.
        const answered = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
        const last = Math.max(-1, ...answered.map((u) => this.unanswered.indexOf(u)));
        this.unanswered = this.unanswered.slice(last + 1);
        this.setState(this.unanswered.length > 0 ? "running" : "idle");
        return;
      }
    }
  }

  private canUseTool: CanUseTool = (toolName, input, options) => {
    const { signal, suggestions, decisionReason } = options;
    if (signal.aborted) return Promise.resolve({ behavior: "deny", message: "중단됨" });
    const requestId = crypto.randomUUID();
    // The SDK marks asks whose suggested rule grants more than this one action;
    // those never get a "don't ask again" option.
    const canAlways = Boolean(suggestions?.length) && !options.suppressAlwaysAllowRule;
    if (toolName === "AskUserQuestion") {
      this.record({ kind: "question", requestId, questions: (input.questions as Question[]) ?? [] });
    } else {
      // The full input, never clipped: the user approves exactly what will run.
      this.record({ kind: "permission", requestId, toolName, input: stringify(input), reason: decisionReason, canAlways });
    }
    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => {
        if (!this.pending.delete(requestId)) return;
        resolve({ behavior: "deny", message: "중단됨" });
        this.record({ kind: "resolved", requestId, outcome: "cancelled" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, {
        toolName,
        input,
        suggestions,
        canAlways,
        resolve: (r) => {
          signal.removeEventListener("abort", onAbort);
          resolve(r);
        },
      });
    });
  };

  answerPermission(requestId: string, allow: boolean, always = false) {
    const p = this.pending.get(requestId);
    if (!p || p.toolName === "AskUserQuestion") return false;
    this.pending.delete(requestId);
    // "Always allow" lasts for this session only; it never writes settings files.
    const updatedPermissions =
      always && p.canAlways ? p.suggestions?.map((s) => ({ ...s, destination: "session" }) as PermissionUpdate) : undefined;
    p.resolve(
      allow
        ? { behavior: "allow", updatedInput: p.input, updatedPermissions }
        : { behavior: "deny", message: "사용자가 웹 UI에서 거부했습니다" },
    );
    this.record({ kind: "resolved", requestId, outcome: allow ? (updatedPermissions ? "always" : "allowed") : "denied" });
    return true;
  }

  answerQuestion(requestId: string, answers: Record<string, string>) {
    const p = this.pending.get(requestId);
    if (!p || p.toolName !== "AskUserQuestion") return false;
    this.pending.delete(requestId);
    p.resolve({ behavior: "allow", updatedInput: { ...p.input, answers } });
    this.record({ kind: "resolved", requestId, outcome: "answered" });
    return true;
  }

  async interrupt() {
    await this.q?.interrupt().catch(() => undefined);
  }

  close() {
    this.input.close();
    this.q?.close();
  }

  summary() {
    return {
      id: this.id,
      sdkSessionId: this.sdkSessionId,
      title: this.title,
      kind: this.kind,
      state: this.state,
      retry: this.retry,
      createdAt: this.createdAt,
      pending: this.pending.size,
    };
  }
}

const IDLE_CLOSE_MS = 30 * 60 * 1000;

export class SessionManager {
  private sessions = new Map<string, ChatSession>();
  private resuming = new Map<string, Promise<ChatSession>>();
  private reaper: ReturnType<typeof setInterval>;
  // While frozen (a data reset is running) no session may start, resume or
  // take input, so nothing new writes a transcript or profile file.
  private frozen = false;
  private creating = 0;
  // Sessions with a Claude Code process still running, kept after they leave
  // the session list: a closed session's process may outlive it.
  private alive = new Set<ChatSession>();
  // When this server last saw the process writing each transcript exit.
  private exitLog = new Map<string, number>();

  constructor(
    private emit: (session: ChatSession, ev: LiveEvent) => void,
    private rules: () => Promise<ProjectRules | null>,
    private onListChanged: () => void = () => {},
  ) {
    // Idle sessions keep a Claude Code process alive. Close them after 30
    // minutes without activity; the transcript stays resumable from "past".
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const s of this.sessions.values()) {
        if (s.state === "idle" && s.summary().pending === 0 && now - s.lastActivity > IDLE_CLOSE_MS) s.close();
      }
    }, 60_000);
    this.reaper.unref?.();
  }

  get isFrozen() {
    return this.frozen;
  }

  freeze() {
    this.frozen = true;
  }

  thaw() {
    this.frozen = false;
  }

  private processChanged = (s: ChatSession, exited: boolean) => {
    if (s.processAlive) this.alive.add(s);
    else this.alive.delete(s);
    if (exited && !s.processAlive && s.sdkSessionId && s.exitedAt !== null) this.exitLog.set(s.sdkSessionId, s.exitedAt);
  };

  async create(opts: SessionOptions = {}) {
    if (this.frozen) throw new Error(FROZEN_MESSAGE);
    this.creating += 1;
    try {
      const rules = await this.rules();
      // The freeze may have started while the rules were read.
      if (this.frozen) throw new Error(FROZEN_MESSAGE);
      const s = new ChatSession(this.emit, (closed) => this.forget(closed), {
        ...opts,
        rules,
        mayWrite: () => !this.frozen,
        onProcessChange: this.processChanged,
      });
      this.sessions.set(s.id, s);
      return s;
    } finally {
      this.creating -= 1;
    }
  }

  private forget(s: ChatSession) {
    if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
    this.onListChanged();
  }

  get(id: string) {
    return this.sessions.get(id);
  }

  resume(sdkId: string): Promise<ChatSession> {
    if (this.frozen) return Promise.reject(new Error(FROZEN_MESSAGE));
    const live = [...this.sessions.values()].find((s) => s.sdkSessionId === sdkId);
    if (live) return Promise.resolve(live);
    const inFlight = this.resuming.get(sdkId);
    if (inFlight) return inFlight;
    const started = (async () => {
      const info = (await listSessions({ dir: REPO_DIR, limit: 200, includeWorktrees: false })).find((s) => s.sessionId === sdkId);
      return this.create({ resume: sdkId, title: info?.customTitle ?? info?.summary, history: await loadHistory(sdkId) });
    })().finally(() => this.resuming.delete(sdkId));
    this.resuming.set(sdkId, started);
    return started;
  }

  remove(id: string) {
    this.sessions.get(id)?.close();
  }

  active() {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  // This checkout only: sessions resume with cwd REPO_DIR, so a sibling
  // worktree's transcripts are not this folder's conversations.
  async past(limit = 40) {
    const liveIds = new Set([...this.sessions.values()].map((s) => s.sdkSessionId));
    const list = await listSessions({ dir: REPO_DIR, limit, includeWorktrees: false }).catch(() => []);
    return list
      .filter((s) => !liveIds.has(s.sessionId))
      .map((s) => ({ sdkSessionId: s.sessionId, title: s.customTitle ?? s.summary, lastModified: s.lastModified }));
  }

  closeAll() {
    clearInterval(this.reaper);
    for (const s of this.sessions.values()) s.close();
  }

  // Writers that could touch files right now: a session mid-turn, one still
  // being created, or a process that outlived its session (closed or gone from
  // the list but not yet exited). An idle listed session cannot act: input is
  // refused while frozen.
  busy() {
    const listed = new Set(this.sessions.values());
    const orphans = [...this.alive].filter((s) => !listed.has(s) || s.state === "closed").length;
    return [...this.sessions.values()].filter((s) => s.state === "running").length + this.creating + orphans;
  }

  // This checkout's transcripts (no sibling worktrees). Errors propagate: a
  // failed listing must never read as "no conversations".
  history() {
    return listSessions({ dir: REPO_DIR, includeWorktrees: false });
  }

  hasLiveProcess(sdkId: string) {
    return [...this.alive].some((s) => s.sdkSessionId === sdkId);
  }

  // The last process that wrote this transcript was ours, we saw it exit, and
  // nothing has written the transcript since (a terminal resuming it would).
  stoppedByUs(sdkId: string, lastModified: number) {
    const at = this.exitLog.get(sdkId);
    return at !== undefined && !this.hasLiveProcess(sdkId) && lastModified <= at + MTIME_SLACK_MS;
  }

  // Stops every session, including ones still being created, and waits until
  // every Claude Code process this server spawned has actually exited. Call
  // while frozen. stillRunning > 0 means the wait timed out.
  async stopAll(timeoutMs = STOP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (this.creating > 0 && Date.now() < deadline) await sleep(50);
    for (const s of this.sessions.values()) s.close();
    while ((this.sessions.size > 0 || this.alive.size > 0) && Date.now() < deadline) await sleep(50);
    return { stillRunning: this.alive.size + this.creating };
  }

  deleteTranscript(sdkId: string) {
    return deleteSession(sdkId, { dir: REPO_DIR });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The SDK sends SIGTERM 2 s after close and SIGKILL 5 s after that; this only
// bounds how long a reset waits for the observed exits.
export const STOP_TIMEOUT_MS = 15_000;
// File timestamps may round; a transcript's last write lands before its
// writer's exit is observed.
const MTIME_SLACK_MS = 1000;

export async function loadHistory(sdkId: string): Promise<ChatEvent[]> {
  const messages = await getSessionMessages(sdkId, { dir: REPO_DIR }).catch(() => []);
  return messages.flatMap((m) => messageToEvents(m.type, m.message, m.parent_tool_use_id !== null));
}

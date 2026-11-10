import { basename, extname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { FROZEN_MESSAGE, RESUME_BUSY, SessionManager, type ChatSession, type LiveEvent, type OutgoingAttachment } from "./agent.ts";
import { createReset } from "./reset.ts";
import { appendNote, countTexts, parseTransition, saveSelfIntro, transitionRow, writeSteps } from "./tracker.ts";
import { APP_CHAT_DISALLOW, PROPOSE_TOOL, appChatSystemAppend, applicationContext, parseNotes, parseSteps, parseStepsStrict, proposeServer, storedNoteText, readArchiveText, sha256, type Step } from "./applications.ts";
import { ThreadStore, parseStepDraft, sameApplication, type StepDraft, type ThreadRecord } from "./threads.ts";
import { RunStore, appKey, archiveFolder, boundRow, missingEvidence, oneAtATime, reconcile, runApplication, serialized, type AppIdentity, type ApplyRun, type RunRecord, type SelfIntroRun } from "./runs.ts";
import {
  SELF_INTRO_RESULT_SCHEMA,
  mergeAnswers,
  nextStep,
  renderSelfIntroFile,
  parseQuestions,
  parseSelfIntroResult,
  selfIntroFixMessage,
  selfIntroPrompt,
  selfIntroResumeMessage,
  selfIntroSystemAppend,
  type SelfIntroAnswer,
  type SelfIntroParams,
  type SelfIntroQuestion,
} from "./selfIntro.ts";
import { APPLY_RESULT_SCHEMA, applyPrompt, applySystemAppend, parseApplyParams, parseApplyResult, resumeMessage, type ApplyParams, type ResumeDecision } from "./results.ts";
import { HOST, PORT, REPO_DIR, UPLOAD_LIMIT_BYTES, ZIP_LIMIT_BYTES } from "./config.ts";
import { queueSend, resolveAttachments } from "./attachments.ts";
import { buildZip, uniqueNames, type ZipEntry } from "./zip.ts";
import { BYPASS_REFUSED, bypassAllowed, isWebMode } from "./modes.ts";
import { LoginError, accountConflicts, completeLogin, connectionEnv, isConnection, loginStatus, logoutLocked, serializeAuth, startLogin } from "./claudeAuth.ts";
import {
  isWorkspaceTrusted,
  listCommands,
  listFiles,
  PROFILE_DIR,
  readConnection,
  readProfile,
  readPermissionMode,
  readProjectRules,
  readSeenJobs,
  saveConnection,
  savePermissionMode,
  readStatus,
  readTracker,
  trustWorkspace,
} from "./data.ts";
import {
  clearFolder,
  fileAccessMode,
  hostAllowed,
  listFolderEntries,
  originAllowed,
  readChecked,
  resolveReadable,
  safeFileName,
  writeUpload,
} from "./security.ts";

type WsData = { subs: Set<string> };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string) => json({ error }, status);

// The UI can start Claude Code commands and approve tool calls, so no other
// site may frame it (clickjacking). Script, style and connections stay same-origin.
const APP_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".typ": "text/plain; charset=utf-8",
  ".tex": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// RFC 6266: a plain ASCII fallback plus the exact UTF-8 name for browsers that
// read filename*, so a Korean file name downloads unchanged.
function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function fileError(e: unknown): Response {
  if ((e as NodeJS.ErrnoException).code === "EFBIG") return fail(413, "파일이 너무 커서 웹에서 열 수 없습니다 (최대 50MB)");
  if ((e as NodeJS.ErrnoException).code === "ENOTSUP") return fail(503, "이 환경에서는 파일을 안전하게 열 수 없습니다. Docker로 실행하세요.");
  return fail(404, "파일을 찾을 수 없거나 접근할 수 없습니다");
}

async function buildClient() {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../client/index.html")],
    target: "browser",
    minify: process.env.NODE_ENV === "production",
  });
  if (!result.success) throw new AggregateError(result.logs, "client build failed");
  const assets = new Map<string, { body: ArrayBuffer; type: string }>();
  for (const out of result.outputs) {
    assets.set(`/${basename(out.path)}`, { body: await out.arrayBuffer(), type: out.type });
  }
  const index = assets.get("/index.html");
  if (!index) throw new Error("client build produced no index.html");
  assets.set("/", index);
  return assets;
}

const assets = await buildClient();

let server: ReturnType<typeof Bun.serve<WsData, string>>;
// `settled` marks a task going idle or closing: the point where it may have
// written files, so pages refetch their data only then.
const publishSessions = (settled = false) => server?.publish("sessions", JSON.stringify({ t: "sessions", settled }));

const runs = new RunStore();
await runs.load();
const threads = new ThreadStore();
await threads.load();

const RUN_ERROR: Record<string, string> = {
  error_max_turns: "작업 단계가 너무 많아 멈췄어요.",
  error_during_execution: "작업 중에 문제가 생겨 멈췄어요. 직접 중단했다면 이 메시지가 떠요.",
  error_max_budget_usd: "설정한 비용 한도에 도달해 멈췄어요.",
  error_max_structured_output_retries: "AI가 결과를 정해진 형식으로 돌려주지 못했어요.",
};

// Self-introduction work for one application (start, resume, a finished pass,
// the follow-up after 지원서 만들기) runs one step at a time, so two of them
// never pass the same checks at once.
const appTurn = serialized();

// Fields of either kind; settleRun only assigns them onto the record.
type RunChange = Record<string, unknown>;

async function settleRun(rec: RunRecord, change: RunChange) {
  Object.assign(rec, change, { endedAt: Date.now() });
  rec.checks = await reconcile(rec).catch(() => rec.checks);
  const row = rec.checks?.row;
  // A self-introduction run keeps the exact application it wrote for: its
  // artifact's hash is what lets that application replace the archive, so a
  // guessed date move (runs.ts boundRow) must not carry that right elsewhere.
  if (row && (!rec.application || (rec.kind === "apply" && rec.application.date !== row.date))) rec.application = { date: row.date, company: row.company, role: row.role };
  // "Done" is the agent's claim; the files and tracker row on disk decide.
  const missing = rec.state === "succeeded" ? (rec.checks ? missingEvidence(rec.checks, rec) : "결과를 확인하지 못했어요") : null;
  if (missing) Object.assign(rec, { state: "failed", error: `AI는 끝났다고 했지만 ${missing}. 이어서 하기를 누르면 빠진 부분을 마저 만들어요.` });
  await runs.save(rec);
  publishSessions(true);
  if (rec.kind === "apply") await startFollowUp(rec);
}

// Questions entered with 지원서 만들기 are answered as soon as the drafts exist.
// The outcome is recorded on the apply run, so a skipped or failed start shows
// on the application page instead of disappearing.
async function startFollowUp(rec: ApplyRun) {
  const questions = rec.params.selfIntro;
  if (rec.state !== "succeeded" || !questions?.length || rec.followUp || !rec.application) return;
  try {
    const started = await startSelfIntroRun(rec.application, questions, undefined, rec.params.selfIntroReplacesCover === true, true);
    rec.followUp = { state: "started", runId: started.id };
  } catch (e) {
    const known = e instanceof RunRequestError;
    rec.followUp = { state: known && e.skip ? "skipped" : "failed", reason: e instanceof Error ? e.message : String(e) };
  }
  await runs.save(rec);
  publishSessions(true);
}

function finishRun(session: ChatSession, ev: Extract<LiveEvent, { kind: "result" }>) {
  const rec = runs.bySession(session.id);
  if (!rec) return;
  const base = { sdkSessionId: session.sdkSessionId ?? rec.sdkSessionId, costUsd: ev.costUsd ?? rec.costUsd };
  const noResultError = ev.ok ? RUN_ERROR.error_max_structured_output_retries! : (RUN_ERROR[ev.text] ?? `작업이 멈췄어요 (${ev.text || "알 수 없는 이유"})`);
  if (rec.kind === "apply") {
    const result = ev.ok ? parseApplyResult(ev.structured) : null;
    if (!result) return void settleRun(rec, { ...base, state: "failed", error: noResultError });
    void settleRun(rec, { ...base, result, error: undefined, state: result.status === "done" ? "succeeded" : result.status === "blocked" ? "blocked" : "failed" });
    return;
  }
  const app = runApplication(rec)!;
  void appTurn(appKey(app), () => finishSelfIntro(rec, session, ev, base, noResultError)).catch((e: unknown) =>
    settleRun(rec, { ...base, state: "failed", error: `답변을 정리하지 못했어요: ${e instanceof Error ? e.message : String(e)}` }),
  );
}

const SUBMITTED = "그사이 지원 단계가 바뀌어 이미 낸 지원이 되었어요. 낸 지원의 답변은 새로 저장하지 않아요.";

// The agent only returns text. The server keeps what this pass may not change,
// counts exactly, sends out-of-range answers back, and saves the file itself.
async function finishSelfIntro(rec: SelfIntroRun, session: ChatSession, ev: Extract<LiveEvent, { kind: "result" }>, base: RunChange, noResultError: string) {
  const live = () => rec.state === "running" && rec.sessionId === session.id;
  const parsed = ev.ok ? parseSelfIntroResult(ev.structured, rec.params.questions) : null;
  if (!parsed) return settleRun(rec, { ...base, state: "failed", error: noResultError });
  if (parsed.status !== "done") return settleRun(rec, { ...base, result: parsed, error: undefined, state: "failed" });

  const revise = rec.params.revise;
  const changeable = rec.fixIndices ?? (revise ? [revise.index] : null);
  const kept = rec.fixIndices ? rec.draft : revise ? rec.params.previous : undefined;
  let answers = mergeAnswers(kept, parsed.answers, changeable);
  const counted = await countTexts([...answers.map((a) => a.text), ...answers.map((a) => a.short ?? "")]);
  answers = answers.map((a, i) => ({ ...a, counts: counted[i]!, ...(a.short ? { short_counts: counted[answers.length + i]! } : {}) }));
  const result = { ...parsed, answers };
  if (!live()) return;

  const app = runApplication(rec)!;
  const row = await draftRow(app);
  if (!live()) return;
  if (!row) return settleRun(rec, { ...base, result, state: "failed", error: SUBMITTED, draft: undefined, fixIndices: undefined });

  const next = nextStep(rec.params.questions, result, rec.fixRounds ?? 0, revise ? [revise.index] : undefined);
  if ("fix" in next) {
    if (manager.get(session.id) !== session || session.state === "closed") return settleRun(rec, { ...base, state: "failed", error: "작업이 끝나기 전에 AI 연결이 끊겼어요." });
    Object.assign(rec, base, { fixRounds: (rec.fixRounds ?? 0) + 1, draft: answers, fixIndices: next.indices });
    await runs.save(rec);
    session.send(selfIntroFixMessage(next.fix));
    publishSessions();
    return;
  }

  const owners = runs
    .list()
    .flatMap((r) => (r.kind === "self-intro" && r.artifact?.written && r.artifact.sha256 && sameApp(runApplication(r)!, app) ? [r.artifact.sha256] : []));
  const saved = await saveSelfIntro(app, renderSelfIntroFile(rec.params, answers), owners, rec.params.replacesCoverLetter === true);
  if (!live()) return;
  if (!saved.ok) {
    return settleRun(rec, { ...base, result, state: "failed", error: saved.error === "not_drafted" ? SUBMITTED : `답변을 저장하지 못했어요: ${saved.error}`, draft: undefined, fixIndices: undefined });
  }
  const artifact = { path: saved.path, written: saved.written, sha256: saved.sha256, ...(saved.reason ? { reason: saved.reason } : {}), ...(saved.cover_recorded ? { coverRecorded: true } : {}) };
  await settleRun(rec, { ...base, result, artifact, error: undefined, state: "succeeded", draft: undefined, fixIndices: undefined });
}

// Saved as soon as the SDK names the transcript, so a restart mid-run can
// still resume it.
function noteTranscript(session: ChatSession, sdkSessionId: string | null) {
  const rec = runs.bySession(session.id);
  if (rec && sdkSessionId && rec.sdkSessionId !== sdkSessionId) {
    rec.sdkSessionId = sdkSessionId;
    void runs.save(rec);
  }
}

function abandonRun(session: ChatSession) {
  const rec = runs.bySession(session.id);
  if (rec) void settleRun(rec, { sdkSessionId: session.sdkSessionId ?? rec.sdkSessionId, state: "failed", error: "작업이 끝나기 전에 AI 연결이 끊겼어요." });
}

const manager = new SessionManager(
  (session: ChatSession, ev: LiveEvent) => {
    server?.publish(`s:${session.id}`, JSON.stringify({ t: "event", id: session.id, ev }));
    if (ev.kind === "result") finishRun(session, ev);
    if (ev.kind === "state") noteTranscript(session, ev.sdkSessionId);
    if (ev.kind === "state") noteThread(session, ev.sdkSessionId);
    if (ev.kind === "state" && ev.state === "closed") abandonRun(session);
    if (ev.kind === "state") publishSessions(ev.state !== "running");
    else if (ev.kind === "permission" || ev.kind === "question" || ev.kind === "resolved" || ev.kind === "mode") publishSessions();
  },
  async () => ((await isWorkspaceTrusted()) ? readProjectRules() : null),
  () => publishSessions(true),
  () => readPermissionMode(),
  sessionEnv,
);

// An "account" task must really run on the stored login: refuse to start one
// without it, or while a settings file would route it somewhere else.
async function sessionEnv() {
  const connection = await readConnection();
  if (connection === "account") {
    if (!(await loginStatus()).loggedIn) throw new Error("Claude 계정 로그인이 없어요. 설정 > Claude 연결에서 다시 로그인하거나 .env 연결로 바꿔 주세요.");
    const conflicts = await accountConflicts(REPO_DIR);
    if (conflicts.length) throw new Error(`다음 설정이 다른 연결을 지정하고 있어 내 Claude 계정으로 연결할 수 없어요: ${conflicts.join(", ")}`);
  }
  return connectionEnv(connection);
}

async function claudeLogin(req: Request) {
  const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
  try {
    const status = await completeLogin(code);
    publishSessions(true);
    return json(status);
  } catch (e) {
    if (e instanceof LoginError) return fail(400, e.message);
    throw e;
  }
}

async function setConnection(req: Request) {
  const { connection } = (await req.json().catch(() => ({}))) as { connection?: unknown };
  if (!isConnection(connection)) return fail(400, "알 수 없는 연결 방식입니다");
  // Checked and saved in the same turn as logins and logouts, so a logout
  // cannot slip between the check and the save.
  return serializeAuth(async () => {
    if (connection === "account") {
      if (!(await loginStatus()).loggedIn) return fail(409, "먼저 Claude 계정으로 로그인해 주세요");
      const conflicts = await accountConflicts(REPO_DIR);
      if (conflicts.length) return fail(409, `다음 설정이 다른 연결을 지정하고 있어요: ${conflicts.join(", ")}`);
    }
    await saveConnection(connection);
    return json({ connection });
  });
}

function logoutAccount() {
  return serializeAuth(async () => {
    if ((await readConnection()) === "account") await saveConnection("env");
    try {
      await logoutLocked();
    } catch (e) {
      if (e instanceof LoginError) return fail(409, e.message);
      return fail(500, `로그아웃하지 못했어요. 로그인 정보가 남아 있어요: ${e instanceof Error ? e.message : String(e)}`);
    }
    return json({ ok: true });
  });
}

async function setDefaultMode(req: Request) {
  const { mode } = (await req.json().catch(() => ({}))) as { mode?: unknown };
  if (!isWebMode(mode)) return fail(400, "알 수 없는 권한 모드입니다");
  if (mode === "bypassPermissions" && !bypassAllowed()) return fail(403, BYPASS_REFUSED);
  await savePermissionMode(mode);
  return json({ mode });
}

function guard(req: Request): Response | null {
  const host = req.headers.get("host");
  if (!hostAllowed(host)) return fail(403, "허용되지 않은 Host입니다");
  if (!originAllowed(req.headers.get("origin"), host)) return fail(403, "허용되지 않은 Origin입니다");
  return null;
}

async function serveFile(req: Request) {
  const params = new URL(req.url).searchParams;
  const rel = params.get("path") ?? "";
  const abs = await resolveReadable(rel);
  let body: Buffer;
  try {
    if (!abs) throw new Error("not readable");
    body = await readChecked(abs);
  } catch (e) {
    return fileError(e);
  }
  const ext = extname(abs).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    // PDFs are previewed in an iframe on the UI itself; nothing else may frame them.
    "content-security-policy": "frame-ancestors 'self'",
    "x-frame-options": "SAMEORIGIN",
  };
  // Generated reports may carry script; run them in an opaque origin so they
  // cannot call this API (the Origin check rejects "null").
  if (ext === ".html") headers["content-security-policy"] = "sandbox allow-scripts; frame-ancestors 'self'";
  if (type === "application/octet-stream" || params.get("download") === "1") headers["content-disposition"] = attachmentDisposition(basename(abs));
  return new Response(new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength), { headers });
}

const ZIP_MAX_FILES = 200;

// "Download all": the same per-file checks as /api/file, bundled as one ZIP.
async function serveZip(req: Request) {
  const params = new URL(req.url).searchParams;
  const rels = [...new Set(params.getAll("path"))];
  if (rels.length === 0) return fail(400, "내려받을 파일이 없습니다");
  if (rels.length > ZIP_MAX_FILES) return fail(413, `한 번에 ${ZIP_MAX_FILES}개까지 내려받을 수 있습니다`);
  const files: { name: string; data: Buffer }[] = [];
  let total = 0;
  for (const rel of rels) {
    const abs = await resolveReadable(rel);
    try {
      if (!abs) throw new Error("not readable");
      const data = await readChecked(abs);
      total += data.length;
      if (total > ZIP_LIMIT_BYTES) return fail(413, "파일을 합치면 너무 커서 한 번에 내려받을 수 없습니다 (최대 200MB)");
      files.push({ name: basename(abs), data });
    } catch (e) {
      return fileError(e);
    }
  }
  const names = uniqueNames(files.map((f) => f.name));
  const entries: ZipEntry[] = files.map((f, i) => ({ name: names[i]!, data: f.data }));
  const zipName = `${(safeFileName(params.get("name") ?? "") ?? "AI-결과물").replace(/\.zip$/i, "")}.zip`;
  return new Response(buildZip(entries), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": attachmentDisposition(zipName),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

function attachmentName(name: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomUUID().slice(0, 4)}-${name}`.slice(0, 200);
}

async function upload(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "파일이 없습니다");
  if (file.size > UPLOAD_LIMIT_BYTES) return fail(413, "파일이 너무 큽니다 (최대 20MB)");
  const dir = String(form.get("dir") ?? "");
  const safe = safeFileName(file.name);
  if (!safe) return fail(400, "파일 이름을 쓸 수 없습니다");
  // Chat attachments never overwrite each other (every pasted image is "image.png").
  const name = dir === "attachments" ? attachmentName(safe) : safe;
  try {
    return json({ path: await writeUpload(dir, name, new Uint8Array(await file.arrayBuffer())), name: safe, size: file.size });
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e));
  }
}

async function createSession(req: Request) {
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  const body = (await req.json().catch(() => ({}))) as { resume?: string; prompt?: string; title?: unknown; kind?: unknown; attachments?: unknown };
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : undefined;
  const kind = typeof body.kind === "string" && /^[a-z][a-z-]{0,23}$/.test(body.kind) ? body.kind : undefined;
  let attachments: OutgoingAttachment[];
  try {
    attachments = await resolveAttachments(body.attachments);
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e));
  }
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  // An application conversation reopened from 지난 대화 keeps its context and tool limits.
  const thread = body.resume ? threads.bySdk(body.resume) : undefined;
  let session: ChatSession;
  try {
    session = thread ? await openThreadSession(thread) : body.resume ? await manager.resume(body.resume) : await manager.create({ title, kind });
  } catch (e) {
    if (e instanceof RunRequestError) return fail(e.status, e.message);
    throw e;
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt || attachments.length) {
    if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
    session.send(prompt, attachments);
  }
  publishSessions();
  return json(session.summary());
}

const PROFILE_PARTS = PROFILE_DIR.split("/");

// Deletes test leftovers: the profile folder's contents and this checkout's
// Claude Code transcripts. The same Host/Origin guard as every API applies;
// reset.ts requires the typed confirmation and the inventory the user saw.
// A deleted transcript takes its application conversation record with it.
const resetter = createReset({
  sessions: {
    freeze: () => manager.freeze(),
    thaw: () => manager.thaw(),
    busy: () => manager.busy(),
    history: () => manager.history(),
    hasLiveProcess: (id) => manager.hasLiveProcess(id),
    stoppedByUs: (id, at) => manager.stoppedByUs(id, at),
    stopAll: () => manager.stopAll(),
    deleteTranscript: async (id) => {
      await manager.deleteTranscript(id);
      await threads.forgetTranscript(id);
    },
  },
  listProfile: () => listFolderEntries(PROFILE_PARTS),
  clearProfile: () => clearFolder(PROFILE_PARTS),
});

const runOptions = (params: ApplyParams) => ({ systemAppend: applySystemAppend(params), outputSchema: APPLY_RESULT_SCHEMA });
// The server saves the answers; the agent only reads and returns text.
const SELF_INTRO_DISALLOW = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];
const selfIntroOptions = (params: SelfIntroParams) => ({ systemAppend: selfIntroSystemAppend(params), outputSchema: SELF_INTRO_RESULT_SCHEMA, disallow: SELF_INTRO_DISALLOW });
const optionsFor = (rec: RunRecord) => (rec.kind === "apply" ? runOptions(rec.params) : selfIntroOptions(rec.params));
const firstPrompt = (rec: RunRecord) => (rec.kind === "apply" ? applyPrompt(rec.params) : selfIntroPrompt(rec.params));

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameApp = (a: AppIdentity, b: AppIdentity) => a.date === b.date && sameText(a.company, b.company) && sameText(a.role, b.role);

// Checks are recomputed on every read: a file deleted or a row moved since the
// run ended shows as it is now, not as it was when the run finished.
async function listRuns() {
  const { rows } = await readTracker();
  return Promise.all(
    runs.list().map(async (r) => ({
      ...r,
      checks: r.state === "running" ? r.checks : await reconcile(r, REPO_DIR, rows).catch(() => r.checks),
      awaiting: r.state === "running" && (manager.get(r.sessionId ?? "")?.summary().pending ?? 0) > 0,
    })),
  );
}

class RunRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // An expected refusal (already submitted, already answered), not a failure.
    readonly skip = false,
  ) {
    super(message);
  }
}

// The tracker row for an application, only while it is a single draft row.
async function draftRow(app: AppIdentity) {
  const { rows } = await readTracker();
  const matches = rows.filter((r) => sameApp({ date: r.date ?? "", company: r.company ?? "", role: r.role ?? "" }, app));
  return matches.length === 1 && (matches[0]!.status ?? "").trim().toLowerCase() === "drafted" ? matches[0]! : null;
}

const selfIntroRunsFor = (app: AppIdentity) => runs.list().filter((r): r is SelfIntroRun => r.kind === "self-intro" && sameApp(runApplication(r)!, app));

// Runs for an application including those whose row date changed outside the
// web (runs.ts boundRow, the same guess the card shows them by). Good for
// finding earlier answers to show or revise, never for archive ownership,
// which stays with the exact application (finishSelfIntro owners).
function selfIntroRunsShownFor(app: AppIdentity, rows: Record<string, string>[]) {
  return runs.list().filter((r): r is SelfIntroRun => {
    if (r.kind !== "self-intro") return false;
    const own = runApplication(r)!;
    if (sameApp(own, app)) return true;
    const row = boundRow(own, rows);
    return !!row && sameApp({ date: (row.date ?? "").trim(), company: row.company ?? "", role: row.role ?? "" }, app);
  });
}

// One application, one self-introduction run at a time. Answers are written
// only while the application is still a draft: once it is submitted, the
// archived answers are what the employer received.
function startSelfIntroRun(app: AppIdentity, questions: SelfIntroQuestion[], revise?: { index: number; feedback: string }, replacesCoverLetter = false, followUp = false) {
  return appTurn(appKey(app), async () => {
    if (manager.isFrozen) throw new RunRequestError(409, FROZEN_MESSAGE);
    const { rows } = await readTracker();
    const matches = rows.filter((r) => sameApp({ date: r.date ?? "", company: r.company ?? "", role: r.role ?? "" }, app));
    if (matches.length !== 1) throw new RunRequestError(409, "지원 기록에서 이 지원을 하나로 찾지 못했어요. 화면을 새로고침해 주세요.");
    const row = matches[0]!;
    const identity = { date: row.date ?? "", company: row.company ?? "", role: row.role ?? "" };
    if ((row.status ?? "").trim().toLowerCase() !== "drafted") throw new RunRequestError(409, "이미 낸 지원이라 자기소개서 답변을 새로 쓰지 않아요.", true);
    const mine = selfIntroRunsShownFor(identity, rows);
    if (mine.some((r) => r.state === "running")) throw new RunRequestError(409, "이 지원의 자기소개서를 이미 쓰는 중이에요.", true);
    if (followUp && mine.length) throw new RunRequestError(409, "이 지원의 자기소개서 답변이 이미 있어요.", true);
    let previous: SelfIntroAnswer[] | undefined;
    const last = mine.find((r) => r.state === "succeeded" && r.result);
    if (revise) {
      if (!last?.result) throw new RunRequestError(409, "다시 쓸 답변이 없어요. 먼저 답변을 만들어 주세요.");
      questions = last.params.questions;
      previous = last.result.answers;
      replacesCoverLetter = last.params.replacesCoverLetter === true;
      if (revise.index < 1 || revise.index > questions.length) throw new RunRequestError(400, "없는 문항이에요");
    }
    const folder = await archiveFolder(identity.company, identity.role);
    if (!folder) throw new RunRequestError(400, "회사와 직무 이름으로 보관 폴더를 만들 수 없어요");
    const params: SelfIntroParams = { application: identity, folder, questions, ...(previous ? { previous, revise } : {}), ...(replacesCoverLetter ? { replacesCoverLetter } : {}) };
    const title = `자기소개서${revise ? ` ${revise.index}번 다시 쓰기` : ""} · ${identity.company} / ${identity.role}`.slice(0, 80);
    const session = await manager.create({ title, kind: "self-intro", run: selfIntroOptions(params) });
    const rec: SelfIntroRun = {
      id: crypto.randomUUID(),
      kind: "self-intro",
      title,
      params,
      subject: {},
      application: identity,
      sessionId: session.id,
      sdkSessionId: null,
      state: "running",
      startedAt: Date.now(),
    };
    await runs.save(rec);
    session.send(selfIntroPrompt(params));
    publishSessions();
    return rec;
  });
}

async function startSelfIntro(body: { application?: unknown; questions?: unknown; revise?: unknown }) {
  const a = (body.application && typeof body.application === "object" ? body.application : {}) as Record<string, unknown>;
  const app = { date: String(a.date ?? ""), company: String(a.company ?? ""), role: String(a.role ?? "") };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(app.date) || !app.company.trim() || !app.role.trim()) return fail(400, "어떤 지원인지 알 수 없어요");
  const r = (body.revise && typeof body.revise === "object" ? body.revise : null) as Record<string, unknown> | null;
  const revise = r ? { index: Number(r.index), feedback: typeof r.feedback === "string" ? r.feedback.trim().slice(0, 1500) : "" } : undefined;
  if (revise && (!Number.isInteger(revise.index) || !revise.feedback)) return fail(400, "어떻게 고칠지 적어 주세요");
  const questions = revise ? [] : parseQuestions(body.questions);
  if (typeof questions === "string") return fail(400, questions);
  try {
    return json(await startSelfIntroRun(app, questions, revise));
  } catch (e) {
    if (e instanceof RunRequestError) return fail(e.status, e.message);
    throw e;
  }
}

async function startRun(req: Request) {
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  const body = ((await req.json().catch(() => null)) ?? {}) as { kind?: unknown; params?: Record<string, unknown>; subject?: Record<string, unknown>; title?: unknown; attachments?: unknown; application?: unknown; questions?: unknown; revise?: unknown };
  if (body.kind === "self-intro") return startSelfIntro(body);
  if (body.kind !== "apply") return fail(400, "알 수 없는 작업이에요");
  let attachments: OutgoingAttachment[];
  try {
    attachments = await resolveAttachments(body.attachments);
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e));
  }
  const raw = { ...(body.params ?? {}) };
  if (!(typeof raw.posting === "string" && raw.posting.trim()) && attachments.length) raw.posting = "첨부한 공고 파일을 읽고 진행해 주세요";
  const params = parseApplyParams(raw);
  if (typeof params === "string") return fail(400, params);
  const s = body.subject ?? {};
  const subject = {
    ...(typeof s.jobKey === "string" && s.jobKey.length <= 200 ? { jobKey: s.jobKey } : {}),
    ...(typeof s.url === "string" && /^https?:\/\//.test(s.url) && s.url.length <= 2000 ? { url: s.url } : {}),
  };
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : "지원서 만들기";
  const session = await manager.create({ title, kind: "apply", run: runOptions(params) });
  const rec: RunRecord = {
    id: crypto.randomUUID(),
    kind: "apply",
    title,
    params,
    subject,
    ...(attachments.length ? { attachments: attachments.map((a) => a.path) } : {}),
    sessionId: session.id,
    sdkSessionId: null,
    state: "running",
    startedAt: Date.now(),
  };
  await runs.save(rec);
  session.send(applyPrompt(params), attachments);
  publishSessions();
  return json(rec);
}

const blocker = (r: RunRecord) => (r.kind === "apply" && r.state === "blocked" ? r.result?.blocker?.type : undefined);

const DECISIONS: Record<ResumeDecision, (r: RunRecord) => boolean> = {
  continue_below_threshold: (r) => blocker(r) === "fit_below_threshold",
  accept_flagged_posting: (r) => blocker(r) === "posting_flagged",
  retry: (r) => r.state === "failed",
};

// Resume and dismiss change a run's state across awaits; one at a time per
// run, so two clicks cannot both pass the state check and both start the agent.
const runTurn = oneAtATime<Response>(() => fail(409, RESUME_BUSY));

async function resumeRun(req: Request, id: string) {
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  const rec = runs.get(id);
  if (!rec) return fail(404, "작업을 찾을 수 없어요");
  const { decision } = ((await req.json().catch(() => null)) ?? {}) as { decision?: unknown };
  if (typeof decision !== "string" || !(decision in DECISIONS) || !DECISIONS[decision as ResumeDecision](rec)) return fail(409, "지금은 이어서 할 수 없는 작업이에요");
  const d = decision as ResumeDecision;
  if (rec.kind === "apply") return continueRun(rec, d);
  // The same checks as a new start, inside the same per-application turn.
  return appTurn(appKey(runApplication(rec)!), async () => {
    if (rec.state !== "failed") return fail(409, "지금은 이어서 할 수 없는 작업이에요");
    const app = runApplication(rec)!;
    if (!(await draftRow(app))) return fail(409, "이 지원이 지원 기록에 작성됨으로 남아 있지 않아 이어서 할 수 없어요. 답변을 다시 쓰려면 지원 상세에서 새로 시작해 주세요.");
    if (selfIntroRunsFor(app).some((r) => r.state === "running")) return fail(409, "이 지원의 자기소개서를 이미 쓰는 중이에요.");
    return continueRun(rec, d);
  });
}

async function continueRun(rec: RunRecord, d: ResumeDecision) {
  if (rec.kind === "apply") {
    rec.params = {
      ...rec.params,
      ...(d === "continue_below_threshold" ? { continueBelowThreshold: true } : {}),
      ...(d === "accept_flagged_posting" ? { acceptFlaggedPosting: true } : {}),
    };
  }
  const opts = { title: rec.title, kind: rec.kind, run: optionsFor(rec) };
  // Without a transcript the run starts over, and its posting files go with it again.
  let attachments: OutgoingAttachment[] = [];
  if (!rec.sdkSessionId && rec.attachments?.length) {
    try {
      attachments = await resolveAttachments(rec.attachments);
    } catch {
      return fail(409, "처음에 첨부한 공고 파일을 찾을 수 없어요. 공고를 다시 올려서 새로 시작해 주세요.");
    }
  }
  let session: ChatSession;
  try {
    session = rec.sdkSessionId ? await manager.resumeRun(rec.sdkSessionId, opts) : await manager.create(opts);
  } catch (e) {
    return fail(409, e instanceof Error ? e.message : String(e));
  }
  const reason = rec.error;
  Object.assign(rec, { sessionId: session.id, state: "running", error: undefined, result: undefined, endedAt: undefined, fixRounds: 0 });
  if (rec.kind === "self-intro") Object.assign(rec, { draft: undefined, fixIndices: undefined });
  await runs.save(rec);
  const message = !rec.sdkSessionId ? firstPrompt(rec) : rec.kind === "apply" ? resumeMessage(d, rec.params, reason) : selfIntroResumeMessage(reason);
  session.send(message, attachments);
  publishSessions();
  return json(rec);
}

// The answers of one self-introduction run as a text file, from its own record:
// the archive's self_intro.txt may belong to another application to the role.
function selfIntroDownload(id: string) {
  const rec = runs.get(id);
  if (!rec || rec.kind !== "self-intro" || !rec.result?.answers.length) return fail(404, "받을 답변이 없어요");
  const app = runApplication(rec)!;
  const name = safeFileName(`자기소개서_${app.company}_${app.role}_${app.date}.txt`) ?? "self_intro.txt";
  return new Response(renderSelfIntroFile(rec.params, rec.result.answers), {
    headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": attachmentDisposition(name), "x-content-type-options": "nosniff", "cache-control": "no-store" },
  });
}

async function dismissRun(id: string) {
  const rec = runs.get(id);
  if (!rec) return fail(404, "작업을 찾을 수 없어요");
  if (rec.state !== "blocked" && rec.state !== "failed") return fail(409, "진행 중이거나 끝난 작업은 그만둘 수 없어요");
  rec.state = "cancelled";
  await runs.save(rec);
  publishSessions(true);
  return json(rec);
}

async function moveTrackerRow(req: Request) {
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  const parsed = parseTransition(await req.json().catch(() => null));
  if (typeof parsed === "string") return fail(400, parsed);
  const { status, body } = await transitionRow(parsed);
  const moved = (body as { row?: Record<string, string> }).row;
  if (status === 200 && moved?.date && moved.date !== parsed.date) {
    const from = { date: parsed.date, company: parsed.company, role: parsed.role };
    const to = { date: moved.date, company: moved.company ?? parsed.company, role: moved.role ?? parsed.role };
    await runs.rebind(from, to);
    await threads.rebind(from, to);
    const warning = await rebindSteps(from, to).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (warning) (body as Record<string, unknown>).warning = warning;
  }
  // Same signal a finished task sends: every page holding tracker data refetches.
  if (status === 200) publishSessions(true);
  return json(body, status);
}

// ---- Application conversations, memos and steps ----

const identityOf = (r: Record<string, string>): AppIdentity => ({ date: (r.date ?? "").trim(), company: r.company ?? "", role: r.role ?? "" });

function parseApp(v: unknown): AppIdentity | null {
  const a = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const ok = (s: unknown, max: number): s is string => typeof s === "string" && !!s.trim() && s.length <= max;
  if (!ok(a.date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(a.date) || !ok(a.company, 200) || !ok(a.role, 300)) return null;
  return { date: a.date, company: a.company, role: a.role };
}

async function exactRow(app: AppIdentity) {
  const { rows } = await readTracker();
  const matches = rows.filter((r) => sameApplication(identityOf(r), app));
  return { rows, row: matches.length === 1 ? matches[0]! : null };
}

// The row a conversation saves to: exactly the one it is bound to. A thread
// the page shows by guessing (runs.ts boundRow, a date changed outside the
// web) saves nothing until the user links it (POST .../bind).
async function threadRow(t: ThreadRecord) {
  return (await exactRow(t.application)).row;
}

const NO_ROW = "지원 기록에서 이 지원을 하나로 찾지 못했어요. 화면을 새로고침해 주세요.";
const UNLINKED = "이 대화가 연결된 지원 기록을 찾지 못했어요. 지원 상세의 대화 목록에서 [이 지원에 연결]을 누른 뒤 다시 해 주세요.";
const BROKEN_STEPS = "전형 단계 파일을 읽을 수 없어 바꾸지 않았어요. 파일 내용을 고친 뒤 다시 해 주세요.";

function chatOptions(t: ThreadRecord, ctx: NonNullable<Awaited<ReturnType<typeof applicationContext>>>) {
  return {
    systemAppend: appChatSystemAppend(ctx),
    disallow: APP_CHAT_DISALLOW,
    allow: [PROPOSE_TOOL],
    mcpServers: { ajs: proposeServer((p) => addProposal(t.id, p)) },
  };
}

async function addProposal(threadId: string, p: { memo?: string; steps: StepDraft[] }) {
  const t = threads.get(threadId);
  if (!t) return false;
  t.proposals = [...t.proposals, { id: `pr_${crypto.randomUUID().slice(0, 8)}`, createdAt: Date.now(), ...p, state: "pending" as const }].slice(-20);
  await threads.save(t);
  publishSessions(true);
  return true;
}

function noteThread(session: ChatSession, sdkSessionId: string | null) {
  const t = threads.bySession(session.id);
  if (!t) return;
  if (sdkSessionId) t.sdkSessionId = sdkSessionId;
  t.lastActivity = Date.now();
  if (session.state === "closed") t.sessionId = null;
  void threads.save(t);
}

async function contextFor(app: AppIdentity, row: Record<string, string>) {
  const ctx = await applicationContext(app, row);
  if (!ctx) throw new RunRequestError(400, "회사와 직무 이름으로 보관 폴더를 찾을 수 없어요");
  return ctx;
}

// A live session of this conversation is reused; otherwise the transcript is
// resumed under the conversation's current context (files added since show up).
async function openThreadSession(t: ThreadRecord): Promise<ChatSession> {
  if (manager.isFrozen) throw new RunRequestError(409, FROZEN_MESSAGE);
  const live = t.sessionId ? manager.get(t.sessionId) : undefined;
  if (live && live.state !== "closed") return live;
  if (!t.sdkSessionId) throw new RunRequestError(409, "이 대화의 기록이 없어요. 새 대화를 시작해 주세요.");
  // Reading needs no exact binding: the guessed row only supplies the context.
  const { rows } = await readTracker();
  const row = (await threadRow(t)) ?? boundRow(t.application, rows);
  if (!row) throw new RunRequestError(409, NO_ROW);
  const ctx = await contextFor(identityOf(row), row);
  let session: ChatSession;
  try {
    session = await manager.resumeWith(t.sdkSessionId, { title: t.title, kind: "app-chat", chat: chatOptions(t, ctx) });
  } catch (e) {
    throw new RunRequestError(409, e instanceof Error ? e.message : String(e));
  }
  t.sessionId = session.id;
  t.lastActivity = Date.now();
  await threads.save(t);
  return session;
}

async function startThread(req: Request) {
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  const body = ((await req.json().catch(() => null)) ?? {}) as { application?: unknown; text?: unknown };
  const app = parseApp(body.application);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 8000) : "";
  if (!app) return fail(400, "어떤 지원인지 알 수 없어요");
  if (!text) return fail(400, "AI에게 할 말을 적어 주세요");
  const { row } = await exactRow(app);
  if (!row) return fail(409, NO_ROW);
  const identity = identityOf(row);
  try {
    const ctx = await contextFor(identity, row);
    const t: ThreadRecord = {
      id: `th_${crypto.randomUUID()}`,
      kind: "app-chat",
      title: `공고 대화 · ${identity.company} / ${identity.role}`.slice(0, 80),
      application: identity,
      sdkSessionId: null,
      sessionId: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      proposals: [],
    };
    const session = await manager.create({ title: t.title, kind: "app-chat", chat: chatOptions(t, ctx) });
    t.sessionId = session.id;
    await threads.save(t);
    session.send(text);
    publishSessions(true);
    return json({ thread: t, session: session.summary() });
  } catch (e) {
    if (e instanceof RunRequestError) return fail(e.status, e.message);
    return fail(409, e instanceof Error ? e.message : String(e));
  }
}

async function openThread(id: string) {
  const t = threads.get(id);
  if (!t) return fail(404, "대화를 찾을 수 없어요");
  try {
    const session = await openThreadSession(t);
    publishSessions(true);
    return json(session.summary());
  } catch (e) {
    if (e instanceof RunRequestError) return fail(e.status, e.message);
    throw e;
  }
}

// Leaves the application's list; the record stays (hidden) so the transcript
// keeps its tool limits if reopened from 지난 대화.
async function deleteThread(id: string) {
  const t = threads.get(id);
  if (!t) return fail(404, "대화를 찾을 수 없어요");
  if (t.sessionId) manager.remove(t.sessionId);
  t.sessionId = null;
  await threads.hide(t.id);
  publishSessions(true);
  return json({ ok: true });
}

// The user confirms that a thread the page found by guessing belongs here.
async function bindThread(req: Request, id: string) {
  const t = threads.get(id);
  if (!t) return fail(404, "대화를 찾을 수 없어요");
  const app = parseApp(((await req.json().catch(() => null)) ?? {}).application);
  if (!app) return fail(400, "어떤 지원인지 알 수 없어요");
  const { rows, row } = await exactRow(app);
  if (!row) return fail(409, NO_ROW);
  const identity = identityOf(row);
  if (!threads.forApplication(identity, rows).some((x) => x.id === t.id)) return fail(409, "이 지원의 대화가 아니에요");
  await threads.bind(t.id, identity);
  publishSessions(true);
  return json({ ok: true });
}

async function readSteps(app: AppIdentity) {
  const folder = await archiveFolder(app.company, app.role);
  const text = folder ? await readArchiveText(`${folder}/steps.json`) : null;
  // steps is null when the file exists but cannot be fully read: then nothing may change it.
  return { folder, text, steps: parseStepsStrict(text), shown: parseSteps(text), sha: sha256(text) };
}

// Steps belong to the application date they were saved for; a web move that
// changes the row's date takes them along, as it does runs and conversations.
// When that fails the steps stay under the old date and the page offers to
// move them (adopt), so nothing is lost.
async function rebindSteps(from: AppIdentity, to: AppIdentity): Promise<string | null> {
  return appTurn(appKey(to), async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { steps, sha } = await readSteps(to);
      if (!steps) return BROKEN_STEPS;
      if (!steps.some((s) => s.application === from.date)) return null;
      const saved = await writeSteps(to, steps.map((s) => (s.application === from.date ? { ...s, application: to.date } : s)), sha);
      if (saved.ok) return null;
    }
    return "전형 단계를 새 날짜로 옮기지 못했어요. 지원 상세에서 [이 지원으로 옮기기]를 눌러 주세요.";
  });
}

const newStep = (d: StepDraft, app: AppIdentity, from?: Step["from"]): Step => ({ id: `st_${crypto.randomUUID().slice(0, 8)}`, ...d, status: "todo", application: app.date, ...(from ? { from } : {}) });

const CHANGED = "그사이 다른 곳에서 단계가 바뀌었어요. 화면을 새로고침한 뒤 다시 해 주세요.";

async function changeSteps(app: AppIdentity, change: (steps: Step[]) => Step[] | string) {
  return appTurn(appKey(app), async () => {
    const { steps, sha } = await readSteps(app);
    if (!steps) return fail(409, BROKEN_STEPS);
    const next = change(steps);
    if (typeof next === "string") return fail(400, next);
    const saved = await writeSteps(app, next, sha);
    if (!saved.ok) return fail(409, CHANGED);
    publishSessions(true);
    return json({ steps: next });
  });
}

async function stepsAction(req: Request) {
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  const body = ((await req.json().catch(() => null)) ?? {}) as { application?: unknown; add?: unknown; set?: { id?: unknown; status?: unknown }; remove?: unknown; adopt?: unknown };
  const app = parseApp(body.application);
  if (!app) return fail(400, "어떤 지원인지 알 수 없어요");
  const { row } = await exactRow(app);
  if (!row) return fail(409, NO_ROW);
  const identity = identityOf(row);
  try {
    // Steps left under a date no tracker row has any more (a failed move) are
    // brought over by the user's click; another application's steps never are.
    if (typeof body.adopt === "string") {
      const from = body.adopt;
      const { rows } = await readTracker();
      return await changeSteps(identity, (steps) =>
        orphanDates(identity, rows, steps).includes(from) ? steps.map((s) => (s.application === from ? { ...s, application: identity.date } : s)) : "옮길 수 있는 단계가 아니에요",
      );
    }
    if (body.add !== undefined) {
      const d = parseStepDraft(body.add);
      if (typeof d === "string") return fail(400, d);
      return await changeSteps(identity, (steps) => (steps.length >= 50 ? "단계는 50개까지 둘 수 있어요" : [...steps, newStep(d, identity)]));
    }
    const id = typeof body.set?.id === "string" ? body.set.id : typeof body.remove === "string" ? body.remove : "";
    const status = body.set?.status;
    if (body.set && status !== "todo" && status !== "done" && status !== "skipped") return fail(400, "알 수 없는 상태예요");
    return await changeSteps(identity, (steps) => {
      if (!steps.some((s) => s.id === id)) return "없는 단계예요";
      return body.set ? steps.map((s) => (s.id === id ? { ...s, status: status as Step["status"] } : s)) : steps.filter((s) => s.id !== id);
    });
  } catch (e) {
    return fail(409, e instanceof Error ? e.message : String(e));
  }
}

async function addNote(req: Request) {
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  const body = ((await req.json().catch(() => null)) ?? {}) as { application?: unknown; sessionId?: unknown; text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return fail(400, "메모 내용을 적어 주세요");
  if (text.length > 8000) return fail(400, "메모가 너무 길어요 (최대 8천 자)");
  // From the page: the user's own words. From a reply in the panel: a kept AI answer.
  const thread = typeof body.sessionId === "string" ? threads.bySession(body.sessionId) : undefined;
  if (typeof body.sessionId === "string" && !thread) return fail(404, "이 대화는 지원에 연결되어 있지 않아요");
  const row = thread ? await threadRow(thread) : await (async () => {
    const app = parseApp(body.application);
    return app ? (await exactRow(app)).row : null;
  })();
  if (!row) return fail(409, NO_ROW);
  const app = identityOf(row);
  try {
    await appTurn(appKey(app), () => appendNote(app, text, thread ? "ai" : "web"));
  } catch (e) {
    return fail(409, e instanceof Error ? e.message : String(e));
  }
  publishSessions(true);
  return json({ ok: true });
}

async function proposalAction(req: Request, threadId: string, proposalId: string) {
  if (manager.isFrozen) return fail(409, FROZEN_MESSAGE);
  const t = threads.get(threadId);
  const p = t?.proposals.find((x) => x.id === proposalId);
  if (!t || !p) return fail(404, "제안을 찾을 수 없어요");
  const body = ((await req.json().catch(() => null)) ?? {}) as { save?: unknown; memo?: unknown; steps?: unknown };
  if (body.save !== true) {
    return appTurn(appKey(t.application), async () => {
      if (p.state !== "pending") return fail(409, "이미 처리한 제안이에요");
      p.state = "dismissed";
      await threads.save(t);
      publishSessions(true);
      return json(p);
    });
  }
  const row = await threadRow(t);
  if (!row) return fail(409, UNLINKED);
  const app = identityOf(row);
  return appTurn(appKey(app), async () => {
    if (p.state !== "pending") return fail(409, "이미 처리한 제안이에요");
    const memo = body.memo === true && !!p.memo;
    const picked = Array.isArray(body.steps) ? [...new Set(body.steps.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < p.steps.length))] : [];
    if (!memo && !picked.length) return fail(400, "저장할 항목을 하나 이상 골라 주세요");
    // Every item is recognised if an earlier attempt already saved it (a
    // failure, a restart before the receipt was written), so a retry adds nothing twice.
    try {
      if (picked.length) {
        const { steps, sha } = await readSteps(app);
        if (!steps) return fail(409, BROKEN_STEPS);
        const done = new Set(steps.filter((s) => s.from?.proposal === p.id).map((s) => s.from?.item));
        const added = picked.filter((i) => !done.has(i)).map((i) => newStep(p.steps[i]!, app, { thread: t.id, proposal: p.id, item: i }));
        if (added.length) {
          const saved = await writeSteps(app, [...steps, ...added], sha);
          if (!saved.ok) return fail(409, CHANGED);
        }
      }
    } catch (e) {
      return fail(409, e instanceof Error ? e.message : String(e));
    }
    if (memo) {
      const folder = await archiveFolder(app.company, app.role);
      const notes = folder ? parseNotes((await readArchiveText(`${folder}/notes.md`)) ?? "") : [];
      const already = notes.some((n) => n.application === app.date && n.source === "AI 답변 저장" && n.text === storedNoteText(p.memo!));
      if (!already) {
        try {
          await appendNote(app, p.memo!, "ai");
        } catch (e) {
          // Still pending: the next click saves only what is missing.
          publishSessions(true);
          return fail(409, `${picked.length ? "고른 단계는 저장했지만 " : ""}메모를 저장하지 못했어요. 다시 누르면 빠진 것만 저장해요. (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
    p.state = "saved";
    p.saved = { memo, steps: picked };
    await threads.save(t);
    publishSessions(true);
    return json(p);
  });
}

// Dates in steps.json that no tracker row for this company and role has any more.
function orphanDates(app: AppIdentity, rows: Record<string, string>[], steps: Step[]) {
  const live = new Set(rows.filter((r) => sameText(r.company ?? "", app.company) && sameText(r.role ?? "", app.role)).map((r) => (r.date ?? "").trim()));
  return [...new Set(steps.map((s) => s.application))].filter((d) => d !== app.date && !live.has(d));
}

async function applicationDetail(url: URL) {
  const app = parseApp({ date: url.searchParams.get("date"), company: url.searchParams.get("company"), role: url.searchParams.get("role") });
  if (!app) return fail(400, "어떤 지원인지 알 수 없어요");
  const { rows, row } = await exactRow(app);
  if (!row) return fail(404, NO_ROW);
  const identity = identityOf(row);
  const ctx = await applicationContext(identity, row);
  const notesText = ctx ? await readArchiveText(`${ctx.folder}/notes.md`) : null;
  const { steps: strict, shown: steps } = await readSteps(identity);
  const sameRole = (t: ThreadRecord) => sameText(t.application.company, identity.company) && sameText(t.application.role, identity.role);
  const mine = new Set(threads.forApplication(identity, rows).map((t) => t.id));
  const view = (t: ThreadRecord) => ({
    id: t.id,
    title: t.title,
    application: t.application,
    createdAt: t.createdAt,
    lastActivity: t.lastActivity,
    sessionId: t.sessionId && manager.get(t.sessionId)?.state !== "closed" ? t.sessionId : null,
    resumable: !!t.sdkSessionId,
    earlier: !mine.has(t.id),
    // Saving needs the exact binding; a thread shown by guess must be linked first.
    linked: !mine.has(t.id) || sameApplication(t.application, identity),
    proposals: t.proposals,
  });
  const orphans = orphanDates(identity, rows, steps).map((date) => ({ date, count: steps.filter((s) => s.application === date).length }));
  return json({
    folder: ctx?.folder ?? null,
    files: ctx?.files ?? [],
    guard: ctx?.guard ?? { verdict: "missing", findings: 0 },
    notes: notesText ? parseNotes(notesText) : [],
    steps: steps.filter((s) => s.application === identity.date),
    otherSteps: steps.filter((s) => s.application !== identity.date && !orphans.some((o) => o.date === s.application)).length,
    orphans,
    stepsBroken: strict === null,
    threads: threads.list().filter((t) => mine.has(t.id) || sameRole(t)).map(view),
  });
}

// The nearest open step with a date per application, for the board's badges.
async function applicationItems() {
  const { rows } = await readTracker();
  const out = await Promise.all(
    rows.map(async (r) => {
      const app = identityOf(r);
      if (!app.company.trim() || !app.role.trim()) return null;
      const { shown: steps } = await readSteps(app).catch(() => ({ shown: [] as Step[] }));
      const next = steps.filter((s) => s.application === app.date && s.status === "todo" && s.due).sort((a, b) => a.due!.localeCompare(b.due!))[0];
      return next ? { ...app, next: { title: next.title, kind: next.kind, due: next.due } } : null;
    }),
  );
  return out.filter(Boolean);
}

async function reset(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Parameters<typeof resetter.run>[0];
  try {
    const { status, body: out } = await resetter.run(body && typeof body === "object" ? body : {});
    return json(out, status);
  } finally {
    publishSessions(true);
  }
}

async function api(req: Request, path: string): Promise<Response> {
  const method = req.method;
  if (method === "GET" && path === "/api/status") return json(await readStatus());
  if (method === "GET" && path === "/api/tracker") return json(await readTracker());
  if (method === "PATCH" && path === "/api/tracker/row") return moveTrackerRow(req);
  if (method === "GET" && path === "/api/runs") return json(await listRuns());
  if (method === "POST" && path === "/api/runs") return startRun(req);
  const download = /^\/api\/runs\/([\w-]{1,64})\/self-intro\.txt$/.exec(path);
  if (method === "GET" && download) return selfIntroDownload(download[1]!);
  const runAction = /^\/api\/runs\/([\w-]{1,64})\/(resume|dismiss)$/.exec(path);
  if (method === "POST" && runAction) return runTurn(runAction[1]!, () => (runAction[2] === "resume" ? resumeRun(req, runAction[1]!) : dismissRun(runAction[1]!)));
  if (method === "GET" && path === "/api/applications/detail") return applicationDetail(new URL(req.url));
  if (method === "GET" && path === "/api/applications/items") return json(await applicationItems());
  if (method === "POST" && path === "/api/applications/threads") return startThread(req);
  if (method === "POST" && path === "/api/applications/notes") return addNote(req);
  if (method === "POST" && path === "/api/applications/steps") return stepsAction(req);
  const threadAction = /^\/api\/applications\/threads\/(th_[\w-]{1,60})(?:\/(open|bind)|\/proposals\/(pr_[\w-]{1,20}))?$/.exec(path);
  if (threadAction && method === "POST" && threadAction[2] === "open") return openThread(threadAction[1]!);
  if (threadAction && method === "POST" && threadAction[2] === "bind") return bindThread(req, threadAction[1]!);
  if (threadAction && method === "POST" && threadAction[3]) return proposalAction(req, threadAction[1]!, threadAction[3]);
  if (threadAction && method === "DELETE" && !threadAction[2] && !threadAction[3]) return deleteThread(threadAction[1]!);
  if (method === "GET" && path === "/api/jobs") return json(await readSeenJobs());
  if (method === "GET" && path === "/api/files") return json(await listFiles());
  if (method === "GET" && path === "/api/file") return serveFile(req);
  if (method === "GET" && path === "/api/download") return serveZip(req);
  if (method === "GET" && path === "/api/profile") return json(await readProfile());
  if (method === "GET" && path === "/api/commands") return json(await listCommands());
  if (method === "POST" && path === "/api/upload") return upload(req);
  if (method === "GET" && path === "/api/reset") return json(await resetter.preview());
  if (method === "POST" && path === "/api/reset") return reset(req);
  if (method === "POST" && path === "/api/permission-mode") return setDefaultMode(req);
  if (method === "POST" && path === "/api/claude-login/start") return json(startLogin());
  if (method === "POST" && path === "/api/claude-login/complete") return claudeLogin(req);
  if (method === "POST" && path === "/api/claude-login/logout") return logoutAccount();
  if (method === "POST" && path === "/api/connection") return setConnection(req);
  if (method === "POST" && path === "/api/trust") {
    await trustWorkspace();
    return json({ ok: true });
  }
  if (method === "GET" && path === "/api/sessions") {
    const withPast = new URL(req.url).searchParams.get("past") !== "0";
    return json({ active: manager.active(), past: withPast ? await manager.past() : [] });
  }
  if (method === "POST" && path === "/api/sessions") return createSession(req);
  const del = /^\/api\/sessions\/([\w-]+)$/.exec(path);
  if (method === "DELETE" && del) {
    manager.remove(del[1]!);
    return json({ ok: true });
  }
  return fail(404, "not found");
}

type ClientMsg =
  | { t: "subscribe"; id: string }
  | { t: "unsubscribe"; id: string }
  | { t: "send"; id: string; text: string; attachments?: unknown }
  | { t: "permission"; id: string; requestId: string; allow: boolean; always?: boolean }
  | { t: "answer"; id: string; requestId: string; answers: Record<string, string> }
  | { t: "interrupt"; id: string }
  | { t: "mode"; id: string; mode: unknown };

function onMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(String(raw)) as ClientMsg;
  } catch {
    return;
  }
  const session = manager.get(msg.id);
  if (!session) {
    ws.send(JSON.stringify({ t: "error", id: msg.id, text: "세션을 찾을 수 없습니다 (종료된 대화는 '이전 대화'에서 이어서 할 수 있습니다)" }));
    return;
  }
  try {
    switch (msg.t) {
      case "subscribe":
        ws.subscribe(`s:${session.id}`);
        ws.data.subs.add(session.id);
        ws.send(JSON.stringify({ t: "snapshot", id: session.id, session: session.summary(), events: session.events }));
        break;
      case "unsubscribe":
        ws.unsubscribe(`s:${session.id}`);
        ws.data.subs.delete(session.id);
        break;
      case "send": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text && msg.attachments === undefined) break;
        queueSend(session, text, msg.attachments, (e) => ws.send(JSON.stringify({ t: "error", id: msg.id, text: e instanceof Error ? e.message : String(e) })));
        break;
      }
      case "permission":
        session.answerPermission(msg.requestId, Boolean(msg.allow), Boolean(msg.always));
        break;
      case "answer":
        session.answerQuestion(msg.requestId, msg.answers ?? {});
        break;
      case "interrupt":
        void session.interrupt();
        break;
      case "mode":
        if (!isWebMode(msg.mode)) throw new Error("알 수 없는 권한 모드입니다");
        session
          .setMode(msg.mode)
          .then(() => publishSessions())
          .catch((e: unknown) => ws.send(JSON.stringify({ t: "error", id: msg.id, text: `권한 모드를 바꾸지 못했어요: ${e instanceof Error ? e.message : String(e)}` })));
        break;
    }
  } catch (e) {
    ws.send(JSON.stringify({ t: "error", id: msg.id, text: e instanceof Error ? e.message : String(e) }));
  }
}

server = Bun.serve<WsData, string>({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const host = req.headers.get("host");
      if (!hostAllowed(host) || !originAllowed(req.headers.get("origin"), host, true)) return fail(403, "forbidden");
      if (srv.upgrade(req, { data: { subs: new Set<string>() } })) return undefined;
      return fail(400, "WebSocket upgrade failed");
    }
    const blocked = guard(req);
    if (blocked) return blocked;
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, url.pathname);
      } catch (e) {
        return fail(500, e instanceof Error ? e.message : String(e));
      }
    }
    const asset = req.method === "GET" ? assets.get(url.pathname) : undefined;
    if (!asset) return Response.redirect("/", 302);
    return new Response(asset.body, { headers: { "content-type": asset.type, ...APP_HEADERS } });
  },
  websocket: {
    open(ws) {
      ws.subscribe("sessions");
    },
    message: onMessage,
  },
});

console.log(`AI Job Search web: http://localhost:${PORT}  (repo: ${REPO_DIR})`);
if (fileAccessMode() === "blocked") {
  console.warn("File access is disabled: this platform has no /proc/self/fd for race-free path checks. Run in Docker, or set AJS_INSECURE_PATH_CHECKS=1 (see web/README.md).");
} else if (fileAccessMode() === "insecure") {
  console.warn("AJS_INSECURE_PATH_CHECKS=1: file access uses path-based checks that a local process could race. Use only if nothing untrusted can write to the repo.");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    manager.closeAll();
    process.exit(0);
  });
}

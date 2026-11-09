import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatEvent, LiveEvent, RetryInfo, SessionState } from "../server/agent.ts";
import type { WebMode } from "../server/modes.ts";
import type { AppIdentity, ApplyRun as ApplyRunRecord, RunRecord, SelfIntroRun as SelfIntroRunRecord } from "../server/runs.ts";
import type { SelfIntroQuestion } from "../server/selfIntro.ts";
import type { ApplyParams, ResumeDecision } from "../server/results.ts";
import { commandLabel } from "./labels.ts";
import { panel } from "./panel.ts";

export type { ApplyParams, ChatEvent, LiveEvent, ResumeDecision, RetryInfo, SessionState, WebMode };
export type Run = RunRecord & { awaiting: boolean };
export type ApplyRun = ApplyRunRecord & { awaiting: boolean };
export type SelfIntroRun = SelfIntroRunRecord & { awaiting: boolean };
export type { AppIdentity, SelfIntroQuestion };

export const WEB_MODES: WebMode[] = ["default", "acceptEdits", "auto", "bypassPermissions"];

export type SessionSummary = {
  id: string;
  sdkSessionId: string | null;
  title: string;
  kind: string;
  mode: WebMode;
  state: SessionState;
  retry: RetryInfo | null;
  createdAt: number;
  pending: number;
};

export type PastSession = { sdkSessionId: string; title: string; lastModified: number };

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const getJSON = <T>(url: string) => fetch(url).then((r) => parse<T>(r));

export const sendJSON = <T>(url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => parse<T>(r));

const LIVE_DEBOUNCE_MS = 300;

function debounce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  run.cancel = () => timer && clearTimeout(timer);
  return run;
}

// `live` refetches when a task settles (goes idle or closes), so a page shows
// what it wrote (tracker rows, ranked jobs, PDFs) without a manual reload.
// Bursts are coalesced, and only the newest request may commit its response.
// live: "any" also refetches on events that write nothing (a permission ask,
// an answer), for data that tracks task state rather than files.
export function useFetch<T>(url: string, opts: { live?: boolean | "any" } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    getJSON<T>(url)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => mine === seq.current && setError(e.message));
  }, [url]);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (!opts.live) return;
    const soon = debounce(reload, LIVE_DEBOUNCE_MS);
    const off = live.listen((m) => m.t === "sessions" && (m.settled || opts.live === "any") && soon());
    return () => {
      off();
      soon.cancel();
    };
  }, [opts.live, reload]);
  return { data, error, reload };
}

// One shared copy of the active-session list for the whole app (sidebar
// badges, task panel, toast, chat list). It skips the on-disk history scan.
let activeSessions: SessionSummary[] = [];
let activeSeq = 0;
const activeListeners = new Set<() => void>();

const refreshActive = debounce(() => {
  const mine = ++activeSeq;
  getJSON<{ active: SessionSummary[] }>("/api/sessions?past=0")
    .then((d) => {
      if (mine !== activeSeq) return;
      activeSessions = d.active;
      for (const l of activeListeners) l();
    })
    .catch(() => undefined);
}, 100);

// Module-level so its identity is stable: React resubscribes whenever the
// subscribe function changes, and a fresh one per render would empty the
// listener set and refetch after every update, forever.
function subscribeActive(l: () => void) {
  if (activeListeners.size === 0) refreshActive();
  activeListeners.add(l);
  return () => {
    activeListeners.delete(l);
  };
}

const readActive = () => activeSessions;

export function useActiveSessions(): SessionSummary[] {
  return useSyncExternalStore(subscribeActive, readActive);
}

export const fileUrl = (path: string, download = false) => `/api/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

export const zipUrl = (paths: string[], name: string) =>
  `/api/download?${new URLSearchParams([...paths.map((p): [string, string] => ["path", p]), ["name", name]])}`;

export const fileName = (path: string) => path.split("/").pop() ?? path;

export type Uploaded = { path: string; name: string; size: number };

export async function uploadFile(dir: string, file: File): Promise<Uploaded> {
  const form = new FormData();
  form.set("dir", dir);
  form.set("file", file);
  return parse<Uploaded>(await fetch("/api/upload", { method: "POST", body: form }));
}

// Saves text the AI wrote (a reply, a whole conversation) as a file.
export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function stamp(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function safeHttpUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export type TaskMeta = { title?: string; kind?: string };

export type ApplyOptions = Omit<ApplyParams, "posting" | "acceptFlaggedPosting">;

export async function startSelfIntro(application: AppIdentity, body: { questions: SelfIntroQuestion[] } | { revise: { index: number; feedback: string } }) {
  const run = await sendJSON<Run>("/api/runs", "POST", { kind: "self-intro", application, ...body });
  if (run.sessionId) panel.show(run.sessionId);
  return run;
}

export async function startApply(posting: string, options: ApplyOptions, meta: { title: string; jobKey?: string; url?: string }, attachments: string[] = []) {
  const run = await sendJSON<Run>("/api/runs", "POST", {
    kind: "apply",
    params: { posting, ...options },
    subject: { jobKey: meta.jobKey, url: meta.url },
    title: meta.title,
    ...(attachments.length ? { attachments } : {}),
  });
  if (run.sessionId) panel.show(run.sessionId);
  return run;
}

export async function resumeRun(id: string, decision: ResumeDecision) {
  const run = await sendJSON<Run>(`/api/runs/${encodeURIComponent(id)}/resume`, "POST", { decision });
  if (run.sessionId) panel.show(run.sessionId);
  return run;
}

export const dismissRun = (id: string) => sendJSON<Run>(`/api/runs/${encodeURIComponent(id)}/dismiss`, "POST");

export const useRuns = () => useFetch<Run[]>("/api/runs", { live: "any" });

export async function runCommand(prompt: string, meta: TaskMeta = {}, attachments: string[] = []) {
  const title = meta.title ?? commandLabel(prompt) ?? undefined;
  const kind = meta.kind ?? /^\/([a-z][a-z-]*)/.exec(prompt)?.[1];
  const s = await sendJSON<SessionSummary>("/api/sessions", "POST", { prompt, title, kind, ...(attachments.length ? { attachments } : {}) });
  panel.show(s.id);
  return s;
}

type ServerMsg =
  | { t: "snapshot"; id: string; session: SessionSummary; events: ChatEvent[] }
  | { t: "event"; id: string; ev: LiveEvent }
  | { t: "sessions"; settled?: boolean }
  | { t: "error"; id?: string; text: string };

type Listener = (msg: ServerMsg) => void;

class Live {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  // Reference counts: the task panel and the chat page may watch one session.
  private subs = new Map<string, number>();
  private queue: string[] = [];

  constructor() {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      for (const id of this.subs.keys()) ws.send(JSON.stringify({ t: "subscribe", id }));
      for (const m of this.queue.splice(0)) ws.send(m);
      // Anything may have changed while disconnected.
      this.dispatch({ t: "sessions", settled: true });
    };
    ws.onmessage = (e) => this.dispatch(JSON.parse(String(e.data)) as ServerMsg);
    ws.onclose = () => setTimeout(() => this.connect(), 1500);
  }

  private dispatch(msg: ServerMsg) {
    for (const l of this.listeners) l(msg);
  }

  send(msg: Record<string, unknown>) {
    const raw = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(raw);
    else this.queue.push(raw);
  }

  subscribe(id: string) {
    this.subs.set(id, (this.subs.get(id) ?? 0) + 1);
    this.send({ t: "subscribe", id });
  }

  unsubscribe(id: string) {
    const n = (this.subs.get(id) ?? 0) - 1;
    if (n > 0) {
      this.subs.set(id, n);
      return;
    }
    this.subs.delete(id);
    this.send({ t: "unsubscribe", id });
  }

  listen(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}

export const live = new Live();
live.listen((m) => m.t === "sessions" && refreshActive());

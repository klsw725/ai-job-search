import { useCallback, useEffect, useState } from "react";
import type { ChatEvent, LiveEvent, RetryInfo, SessionState } from "../server/agent.ts";

export type { ChatEvent, LiveEvent, RetryInfo, SessionState };

export type SessionSummary = {
  id: string;
  sdkSessionId: string | null;
  title: string;
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

export function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    getJSON<T>(url)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [url]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export const fileUrl = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;

export function safeHttpUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export async function runCommand(prompt: string) {
  const s = await sendJSON<SessionSummary>("/api/sessions", "POST", { prompt });
  location.hash = `#/chat/${s.id}`;
}

type ServerMsg =
  | { t: "snapshot"; id: string; session: SessionSummary; events: ChatEvent[] }
  | { t: "event"; id: string; ev: LiveEvent }
  | { t: "sessions" }
  | { t: "error"; id?: string; text: string };

type Listener = (msg: ServerMsg) => void;

class Live {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subs = new Set<string>();
  private queue: string[] = [];

  constructor() {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      for (const id of this.subs) ws.send(JSON.stringify({ t: "subscribe", id }));
      for (const m of this.queue.splice(0)) ws.send(m);
      this.dispatch({ t: "sessions" });
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
    this.subs.add(id);
    this.send({ t: "subscribe", id });
  }

  unsubscribe(id: string) {
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

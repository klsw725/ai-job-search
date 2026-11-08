import { basename, extname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { SessionManager, type ChatSession, type LiveEvent } from "./agent.ts";
import { HOST, PORT, REPO_DIR, UPLOAD_LIMIT_BYTES } from "./config.ts";
import {
  isWorkspaceTrusted,
  listCommands,
  listFiles,
  readProfile,
  readProjectRules,
  readSeenJobs,
  readStatus,
  readTracker,
  trustWorkspace,
} from "./data.ts";
import { fileAccessMode, hostAllowed, originAllowed, readChecked, resolveReadable, safeFileName, writeUpload } from "./security.ts";

type WsData = { subs: Set<string> };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string) => json({ error }, status);

// The UI can start Claude Code commands and approve tool calls, so no other
// site may frame it (clickjacking). Script, style and connections stay same-origin.
const APP_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
};

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
const publishSessions = () => server?.publish("sessions", JSON.stringify({ t: "sessions" }));

const manager = new SessionManager(
  (session: ChatSession, ev: LiveEvent) => {
    server?.publish(`s:${session.id}`, JSON.stringify({ t: "event", id: session.id, ev }));
    if (ev.kind === "state" || ev.kind === "permission" || ev.kind === "question" || ev.kind === "resolved") publishSessions();
  },
  async () => ((await isWorkspaceTrusted()) ? readProjectRules() : null),
  publishSessions,
);

function guard(req: Request): Response | null {
  const host = req.headers.get("host");
  if (!hostAllowed(host)) return fail(403, "허용되지 않은 Host입니다");
  if (!originAllowed(req.headers.get("origin"), host)) return fail(403, "허용되지 않은 Origin입니다");
  return null;
}

async function serveFile(req: Request) {
  const rel = new URL(req.url).searchParams.get("path") ?? "";
  const abs = await resolveReadable(rel);
  let body: Buffer;
  try {
    if (!abs) throw new Error("not readable");
    body = await readChecked(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EFBIG") return fail(413, "파일이 너무 커서 웹에서 열 수 없습니다 (최대 50MB)");
    if ((e as NodeJS.ErrnoException).code === "ENOTSUP") return fail(503, "이 환경에서는 파일을 안전하게 열 수 없습니다. Docker로 실행하세요.");
    return fail(404, "파일을 찾을 수 없거나 접근할 수 없습니다");
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
  if (type === "application/octet-stream") headers["content-disposition"] = "attachment";
  return new Response(new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength), { headers });
}

async function upload(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "파일이 없습니다");
  if (file.size > UPLOAD_LIMIT_BYTES) return fail(413, "파일이 너무 큽니다 (최대 20MB)");
  const name = safeFileName(file.name);
  if (!name) return fail(400, "파일 이름을 쓸 수 없습니다");
  try {
    return json({ path: await writeUpload(String(form.get("dir") ?? ""), name, new Uint8Array(await file.arrayBuffer())) });
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e));
  }
}

async function createSession(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { resume?: string; prompt?: string };
  const session = body.resume ? await manager.resume(body.resume) : await manager.create();
  if (body.prompt?.trim()) session.send(body.prompt.trim());
  publishSessions();
  return json(session.summary());
}

async function api(req: Request, path: string): Promise<Response> {
  const method = req.method;
  if (method === "GET" && path === "/api/status") return json(await readStatus());
  if (method === "GET" && path === "/api/tracker") return json(await readTracker());
  if (method === "GET" && path === "/api/jobs") return json(await readSeenJobs());
  if (method === "GET" && path === "/api/files") return json(await listFiles());
  if (method === "GET" && path === "/api/file") return serveFile(req);
  if (method === "GET" && path === "/api/profile") return json(await readProfile());
  if (method === "GET" && path === "/api/commands") return json(await listCommands());
  if (method === "POST" && path === "/api/upload") return upload(req);
  if (method === "POST" && path === "/api/trust") {
    await trustWorkspace();
    return json({ ok: true });
  }
  if (method === "GET" && path === "/api/sessions") return json({ active: manager.active(), past: await manager.past() });
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
  | { t: "send"; id: string; text: string }
  | { t: "permission"; id: string; requestId: string; allow: boolean; always?: boolean }
  | { t: "answer"; id: string; requestId: string; answers: Record<string, string> }
  | { t: "interrupt"; id: string };

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
      case "send":
        if (typeof msg.text === "string" && msg.text.trim()) session.send(msg.text.trim());
        break;
      case "permission":
        session.answerPermission(msg.requestId, Boolean(msg.allow), Boolean(msg.always));
        break;
      case "answer":
        session.answerQuestion(msg.requestId, msg.answers ?? {});
        break;
      case "interrupt":
        void session.interrupt();
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

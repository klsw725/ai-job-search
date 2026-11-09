import { basename, extname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { FROZEN_MESSAGE, SessionManager, type ChatSession, type LiveEvent, type OutgoingAttachment } from "./agent.ts";
import { createReset } from "./reset.ts";
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

const manager = new SessionManager(
  (session: ChatSession, ev: LiveEvent) => {
    server?.publish(`s:${session.id}`, JSON.stringify({ t: "event", id: session.id, ev }));
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
  const session = body.resume ? await manager.resume(body.resume) : await manager.create({ title, kind });
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
const resetter = createReset({
  sessions: manager,
  listProfile: () => listFolderEntries(PROFILE_PARTS),
  clearProfile: () => clearFolder(PROFILE_PARTS),
});

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

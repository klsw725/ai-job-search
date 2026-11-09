import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rmdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { DOWNLOAD_LIMIT_BYTES, EXTRA_HOSTS, REPO_DIR } from "./config.ts";

// The server runs Claude Code with tool access, so any page that can reach it
// can act as the user. Two checks keep other sites out even on localhost:
// the Host header (DNS rebinding) and the Origin header (cross-site requests).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostAllowed(host: string | null, extra: string[] = EXTRA_HOSTS): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(name) || extra.includes(name);
}

// Browsers send Origin on every cross-origin request and on same-origin
// non-GET requests. A missing Origin is a non-browser client (curl) on the
// same machine; the literal "null" is a sandboxed or opaque origin and is
// refused like any foreign one.
export function originAllowed(origin: string | null, host: string | null, requireOrigin = false): boolean {
  if (origin === null) return !requireOrigin;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

// Paths the file browser may read. Everything else in the repo (.git, .env,
// settings, tools) stays out of reach of the HTTP API.
export const READ_ROOTS = ["cv", "cover_letters", "documents", "reports", "upskill", "company_research", "templates"];
const READ_FILES = ["CLAUDE.md", "job_search_tracker.csv"];

export const UPLOAD_DIRS = ["cv", "linkedin", "diplomas", "references", "projects", "postings", "attachments"];

// Files dropped into a chat or task. Only these may be handed to the agent as
// attachments, so a message cannot smuggle in any other readable file.
export const ATTACHMENT_DIR = "documents/attachments";

const inAttachmentDir = (parts: string[]) => parts.length === 3 && `${parts[0]}/${parts[1]}` === ATTACHMENT_DIR;

export function isAttachmentPath(rel: unknown): rel is string {
  const parts = typeof rel === "string" ? normalizeRel(rel) : null;
  return parts !== null && inAttachmentDir(parts);
}

function allowedRel(parts: string[]): boolean {
  if (parts.length === 0 || parts.some((p) => p === "" || p === ".." || p.startsWith(".env") || p === ".git" || p === "node_modules")) {
    return false;
  }
  if (parts.length === 1) return READ_FILES.includes(parts[0]!);
  return READ_ROOTS.includes(parts[0]!);
}

export function normalizeRel(rel: string): string[] | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024 || rel.includes("\0")) return null;
  const norm = posix.normalize(rel.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (norm === "." || norm.startsWith("../") || norm === "..") return null;
  const parts = norm.split("/");
  return allowedRel(parts) ? parts : null;
}

function blockedSegment(p: string) {
  return p === "" || p === ".." || p === ".git" || p === "node_modules" || p.startsWith(".env");
}

async function realInside(rel: string, repo: string, accept: (parts: string[]) => boolean): Promise<string | null> {
  if (typeof rel !== "string" || rel.includes("\0")) return null;
  let real: string;
  let realRepo: string;
  try {
    real = await realpath(resolve(repo, rel));
    realRepo = await realpath(repo);
  } catch {
    return null;
  }
  if (!real.startsWith(realRepo + sep)) return null;
  const parts = relative(realRepo, real).split(sep);
  return parts.some(blockedSegment) || !accept(parts) ? null : real;
}

// Resolve a repo-relative path for the file API. Symlinks are followed and the
// real target must still sit under an allowed root inside the repo.
export async function resolveReadable(rel: string, repo = REPO_DIR): Promise<string | null> {
  const parts = normalizeRel(rel);
  return parts ? realInside(parts.join("/"), repo, allowedRel) : null;
}

// An attachment must be spelled canonically and its real target must also be
// a file in the attachment folder: a symlink there cannot pass a profile file
// (readable through the file API, but not something the user attached) to the model.
export async function resolveAttachment(rel: unknown, repo = REPO_DIR): Promise<{ rel: string; abs: string } | null> {
  if (!isAttachmentPath(rel)) return null;
  const canonical = normalizeRel(rel)!.join("/");
  if (canonical !== rel) return null;
  const abs = await realInside(canonical, repo, inAttachmentDir);
  return abs ? { rel: canonical, abs } : null;
}

// Same confinement for the server's own fixed-path reads (tracker, profile,
// scraper state): a symlink planted at one of those paths cannot pull a file
// from outside the repo into an API response.
export async function resolveInRepo(rel: string, repo = REPO_DIR): Promise<string | null> {
  return realInside(rel, repo, () => true);
}

const PROC_FD = existsSync("/proc/self/fd");
const C = constants;
const READ_CHUNK = 1024 * 1024;

export function fileAccessMode(): "secure" | "insecure" | "blocked" {
  if (PROC_FD) return "secure";
  return process.env.AJS_INSECURE_PATH_CHECKS === "1" ? "insecure" : "blocked";
}

function codeError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

// Opens <realRepo>/<parts...> one component at a time, refusing a symlink at
// every step. On Linux each step is relative to the previous directory's
// descriptor (/proc/self/fd/<fd>/<name>), so swapping a parent folder for a
// symlink between check and use cannot redirect the open outside the repo.
// Elsewhere (macOS) there is no descriptor-relative open, so a path-based walk
// cannot close that race: those platforms fail closed unless the user opts in
// with AJS_INSECURE_PATH_CHECKS=1 (README: only when nothing untrusted can
// write to the repo). The supported way to run there is Docker.
async function openBeneath(
  realRepo: string,
  parts: string[],
  flags: number,
  opts: { mode?: number; createDirs?: boolean } = {},
): Promise<FileHandle> {
  if (parts.length === 0 || parts.some(blockedSegment) || parts.some((p) => p === "." || p.includes("/"))) {
    throw codeError("invalid path", "EINVAL");
  }
  if (!PROC_FD) {
    if (process.env.AJS_INSECURE_PATH_CHECKS !== "1") {
      throw codeError("secure file access needs Linux (/proc/self/fd): run the web UI in Docker, or set AJS_INSECURE_PATH_CHECKS=1", "ENOTSUP");
    }
    return openBeneathByPath(realRepo, parts, flags, opts);
  }
  let dir = await open(realRepo, C.O_RDONLY | C.O_DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) {
      const at = `/proc/self/fd/${dir.fd}/${part}`;
      if (opts.createDirs) await mkdir(at).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
      const next = await open(at, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      await dir.close();
      dir = next;
    }
    return await open(`/proc/self/fd/${dir.fd}/${parts.at(-1)}`, flags | C.O_NOFOLLOW, opts.mode);
  } finally {
    await dir.close();
  }
}

async function openBeneathByPath(realRepo: string, parts: string[], flags: number, opts: { mode?: number; createDirs?: boolean }) {
  let path = realRepo;
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    const l = await lstat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" && opts.createDirs) return null;
      throw e;
    });
    if (l === null) await mkdir(path);
    else if (l.isSymbolicLink() || !l.isDirectory()) throw codeError(`${relative(realRepo, path)} is not a plain folder`, "ENOTDIR");
  }
  const target = join(path, parts.at(-1)!);
  const fh = await open(target, flags | C.O_NOFOLLOW, opts.mode);
  try {
    const opened = await fh.stat();
    const now = await stat(target);
    if ((await realpath(target)) !== target || opened.ino !== now.ino || opened.dev !== now.dev) {
      throw codeError("file changed while it was being opened", "ESTALE");
    }
    return fh;
  } catch (e) {
    await fh.close();
    throw e;
  }
}

// Up to the fstat size (+1 byte to detect growth) the chunk matches the file,
// so an unchanged file costs one allocation of its own size; only a file that
// actually grew past the snapshot gets normal 1 MiB chunks. Never beyond maxBytes + 1.
export function nextChunkSize(snapshotSize: number, read: number, maxBytes: number): number {
  const want = read <= snapshotSize ? snapshotSize - read + 1 : READ_CHUNK;
  return Math.max(1, Math.min(want, READ_CHUNK, maxBytes + 1 - read));
}

// Reads a file already resolved under the repo (resolveReadable/resolveInRepo)
// through openBeneath, and refuses anything larger than maxBytes so a big file
// cannot exhaust the server's memory.
export async function readChecked(abs: string, repo = REPO_DIR, maxBytes = DOWNLOAD_LIMIT_BYTES): Promise<Buffer> {
  const realRepo = await realpath(repo);
  if (!abs.startsWith(realRepo + sep)) throw codeError("outside the repo", "EACCES");
  const fh = await openBeneath(realRepo, relative(realRepo, abs).split(sep), C.O_RDONLY);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw codeError("not a regular file", "EISDIR");
    if (st.size > maxBytes) throw codeError("file too large", "EFBIG");
    // Read in chunks sized to the file, stopping at maxBytes + 1: a file that
    // grows after fstat cannot push memory past the cap, and a small file
    // allocates only what it holds.
    const chunks: Buffer[] = [];
    let len = 0;
    while (len <= maxBytes) {
      const chunk = Buffer.allocUnsafe(nextChunkSize(st.size, len, maxBytes));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, len);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.length ? chunk : Buffer.from(chunk.subarray(0, bytesRead)));
      len += bytesRead;
    }
    if (len > maxBytes) throw codeError("file too large", "EFBIG");
    return Buffer.concat(chunks, len);
  } finally {
    await fh.close();
  }
}

// Uploads land in documents/<dir>/<name>; every component is opened through
// openBeneath, and folders are created only beneath an already-verified one.
export async function writeUpload(dir: string, name: string, data: Uint8Array, repo = REPO_DIR): Promise<string> {
  if (!UPLOAD_DIRS.includes(dir)) throw new Error("업로드할 수 없는 폴더입니다");
  const realRepo = await realpath(repo);
  let fh: FileHandle;
  try {
    // No O_TRUNC here: an existing file is truncated only after the open is verified.
    fh = await openBeneath(realRepo, ["documents", dir, name], C.O_WRONLY | C.O_CREAT, { mode: 0o644, createDirs: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EMLINK") throw new Error("업로드 경로에 일반 폴더가 아닌 항목(링크 등)이 있습니다");
    throw e;
  }
  try {
    if (!(await fh.stat()).isFile()) throw new Error("일반 파일이 아닙니다");
    await fh.truncate(0);
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
  return `documents/${dir}/${name}`;
}

// Opens <realRepo>/<parts...> as a folder with the same per-component checks as
// openBeneath and returns a path that addresses its entries: through the
// descriptor on Linux, through the verified real path on the opt-in fallback.
// A missing folder yields null.
async function openDirBeneath(realRepo: string, parts: string[]): Promise<{ at: string; close: () => Promise<void> } | null> {
  if (parts.length === 0 || parts.some(blockedSegment) || parts.some((p) => p === "." || p.includes("/"))) {
    throw codeError("invalid path", "EINVAL");
  }
  const missing = (e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    if (e.code === "ELOOP" || e.code === "ENOTDIR") throw codeError(`${parts.join("/")} 경로에 일반 폴더가 아닌 항목(링크 등)이 있습니다`, "ENOTDIR");
    throw e;
  };
  if (!PROC_FD) {
    if (process.env.AJS_INSECURE_PATH_CHECKS !== "1") {
      throw codeError("secure file access needs Linux (/proc/self/fd): run the web UI in Docker, or set AJS_INSECURE_PATH_CHECKS=1", "ENOTSUP");
    }
    let path = realRepo;
    for (const part of parts) {
      path = join(path, part);
      const l = await lstat(path).catch(missing);
      if (l === null) return null;
      if (l.isSymbolicLink() || !l.isDirectory()) missing(Object.assign(new Error(), { code: "ENOTDIR" }));
    }
    return { at: path, close: async () => {} };
  }
  let dir = await open(realRepo, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const next = await open(`/proc/self/fd/${dir.fd}/${part}`, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW).catch(missing);
      if (next === null) {
        await dir.close();
        return null;
      }
      await dir.close();
      dir = next;
    }
  } catch (e) {
    await dir.close();
    throw e;
  }
  const handle = dir;
  return { at: `/proc/self/fd/${handle.fd}`, close: () => handle.close() };
}

// Mount points listed in /proc/self/mountinfo (field 5, octal-escaped).
export function mountPoints(mountinfo: string): string[] {
  return mountinfo
    .split("\n")
    .map((line) => line.split(" ")[4])
    .filter((p): p is string => Boolean(p))
    .map((p) => p.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
}

// Mount points that a recursive delete of `realFolder` would reach through:
// the folder itself, anything inside it, and any folder between the repo and
// it (a bind-mounted documents/ would put the whole target elsewhere). The
// repo's own mount is fine. Bind mounts share a device id, so this list, not
// a device comparison, is the check.
export function mountsInTheWay(points: string[], realRepo: string, realFolder: string): string[] {
  const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
  return points.filter((m) => m !== realRepo && under(m, realRepo) && (under(m, realFolder) || under(realFolder, m)));
}

async function refuseMounts(realRepo: string, realFolder: string) {
  if (!existsSync("/proc/self/mountinfo")) return;
  const found = mountsInTheWay(mountPoints(await readFile("/proc/self/mountinfo", "utf-8")), realRepo, realFolder);
  if (found.length) throw codeError(`지울 폴더 경로에 마운트된 폴더가 있어 지우지 않았습니다: ${found.join(", ")}`, "EXDEV");
}

// Deletes one entry. A folder is opened without following links before its
// contents are removed, so a folder swapped for a symlink mid-way makes the
// removal fail instead of reaching outside; a symlink itself is unlinked, never
// followed. A folder on another device than the starting one (a mount) stops
// the walk before anything inside it is touched.
async function removeEntry(parentAt: string, name: string, dev: number, progress: { removed: number }): Promise<void> {
  const at = `${parentAt}/${name}`;
  const l = await lstat(at);
  if (l.isDirectory()) {
    if (l.dev !== dev) throw codeError(`${name}은(는) 다른 장치(마운트)에 있어 지우지 않았습니다`, "EXDEV");
    const dh = await open(at, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try {
      if ((await dh.stat()).dev !== dev) throw codeError(`${name}은(는) 다른 장치(마운트)에 있어 지우지 않았습니다`, "EXDEV");
      const inner = PROC_FD ? `/proc/self/fd/${dh.fd}` : at;
      for (const n of (await readdir(inner)).sort()) await removeEntry(inner, n, dev, progress);
    } finally {
      await dh.close();
    }
    await rmdir(at);
  } else {
    await unlink(at);
  }
  progress.removed += 1;
}

// Carries what was removed before a failure, so a partial reset is reported
// as partial rather than as a bare error: `deleted` names the top-level
// entries fully gone, `removedAny` is true if anything at all was removed,
// including files deep inside an entry that was not finished.
export class PartialDeleteError extends Error {
  constructor(
    message: string,
    readonly deleted: string[],
    readonly removedAny: boolean,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function listFolderEntries(parts: string[], repo = REPO_DIR): Promise<string[]> {
  const dir = await openDirBeneath(await realpath(repo), parts);
  if (!dir) return [];
  try {
    return (await readdir(dir.at)).sort();
  } finally {
    await dir.close();
  }
}

// Empties a folder beneath the repo and keeps the folder itself, the way
// /reset profile does. Returns the top-level entries it deleted; on failure
// throws PartialDeleteError naming the ones already gone.
export async function clearFolder(parts: string[], repo = REPO_DIR): Promise<string[]> {
  const realRepo = await realpath(repo);
  const dir = await openDirBeneath(realRepo, parts);
  if (!dir) return [];
  const deleted: string[] = [];
  const progress = { removed: 0 };
  try {
    await refuseMounts(realRepo, join(realRepo, ...parts));
    const { dev } = await stat(dir.at);
    if ((await stat(realRepo)).dev !== dev) throw codeError(`${parts.join("/")}이(가) 저장소와 다른 장치에 있어 지우지 않았습니다`, "EXDEV");
    for (const name of (await readdir(dir.at)).sort()) {
      await removeEntry(dir.at, name, dev, progress);
      deleted.push(name);
    }
    return deleted;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new PartialDeleteError(err.message, deleted, progress.removed > 0, err.code);
  } finally {
    await dir.close();
  }
}

export function safeFileName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFC").replace(/[^\p{L}\p{N}._\- ()]/gu, "_").replace(/^\.+/, "").trim();
  if (!cleaned || cleaned.length > 200 || cleaned.startsWith(".env")) return null;
  return cleaned;
}

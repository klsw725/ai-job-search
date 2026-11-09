import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bypassAllowed, isWebMode, type WebMode } from "./modes.ts";
import { accountConflicts, isConnection, loginStatus, type Connection } from "./claudeAuth.ts";
import { REPO_DIR } from "./config.ts";
import { csvToObjects } from "./csv.ts";
import { fileAccessMode, readChecked, resolveInRepo } from "./security.ts";

const FINAL_STATUSES = new Set(["hired", "rejected", "no_response", "no response", "offer_declined", "offer declined", "withdrawn"]);

export type TrackerRow = Record<string, string> & { _open: string };

async function readText(rel: string, repo = REPO_DIR): Promise<string | null> {
  const abs = await resolveInRepo(rel, repo);
  if (!abs) return null;
  try {
    return (await readChecked(abs, repo)).toString("utf-8");
  } catch {
    return null;
  }
}

export async function readTracker(repo = REPO_DIR) {
  const text = await readText("job_search_tracker.csv", repo);
  if (text === null) return { exists: false, header: [] as string[], rows: [] as TrackerRow[] };
  const { header, rows } = csvToObjects(text);
  return {
    exists: true,
    header,
    rows: rows.map((r): TrackerRow => ({ ...r, _open: FINAL_STATUSES.has((r.status ?? "").trim().toLowerCase()) ? "0" : "1" })),
  };
}

export async function readSeenJobs(repo = REPO_DIR) {
  const text = await readText("job_scraper/seen_jobs.json", repo);
  if (text === null) return { exists: false, jobs: [] as Record<string, unknown>[] };
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    // Same rule as tools/rank_state.py load_state: {"seen": {...}} or the legacy bare map.
    const data = (doc && typeof doc === "object" && "seen" in doc ? doc.seen : doc) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    const jobs = Object.entries(data)
      .filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
      .map(([key, v]) => ({ key, ...(v as Record<string, unknown>) }));
    return { exists: true, jobs };
  } catch {
    return { exists: true, jobs: [], error: "seen_jobs.json을 읽을 수 없습니다 (JSON 형식 오류)" };
  }
}

export type FileEntry = { path: string; size: number; mtime: number };

const LIST_ROOTS = ["cv", "cover_letters", "documents", "reports", "upskill", "company_research"];
const SKIP = new Set([".gitkeep", ".DS_Store", "node_modules", "build", "OpenFonts"]);

async function walk(repo: string, rel: string, depth: number, out: FileEntry[]) {
  if (depth > 5 || out.length > 2000) return;
  let entries;
  try {
    entries = await readdir(join(repo, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(repo, child, depth + 1, out);
    else if (e.isFile()) {
      const s = await stat(join(repo, child));
      out.push({ path: child, size: s.size, mtime: s.mtimeMs });
    }
  }
}

export async function listFiles(repo = REPO_DIR): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const root of LIST_ROOTS) await walk(repo, root, 0, out);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export const PROFILE_DIR = "documents/profile";
const PROFILE_FILES = [
  "candidate.md",
  "01-candidate-profile.md",
  "02-behavioral-profile.md",
  "04-job-evaluation.md",
  "05-cv-templates.md",
  "07-interview-prep.md",
  "search-queries.md",
];

export async function readProfile(repo = REPO_DIR) {
  let masterCv: string | null = null;
  try {
    masterCv = (await readdir(join(repo, PROFILE_DIR))).find((n) => n.startsWith("master-cv.")) ?? null;
  } catch {
    masterCv = null;
  }
  const names = masterCv ? [...PROFILE_FILES, masterCv] : PROFILE_FILES;
  const files = await Promise.all(
    names.map(async (name) => {
      const path = `${PROFILE_DIR}/${name}`;
      const content = await readText(path, repo);
      return { path, exists: content !== null, content: content ?? "" };
    }),
  );
  const candidate = files[0]!;
  return { configured: candidate.exists && !candidate.content.includes("[YOUR_NAME]"), files };
}

export async function listCommands(repo = REPO_DIR) {
  let names: string[] = [];
  try {
    names = (await readdir(join(repo, ".claude/commands"))).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (n) => {
      const text = (await readText(`.claude/commands/${n}`, repo)) ?? "";
      const title = text.split("\n").find((l) => l.startsWith("# ")) ?? "";
      const description = title.replace(/^#\s*\/?[\w-]+\s*-\s*/, "").trim();
      return { name: n.replace(/\.md$/, ""), description };
    }),
  );
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude");
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

// Claude Code's own trust record (written by its interactive trust dialog).
// Read-only here: the web UI never edits Claude Code's config file.
async function claudeCodeTrusts(repo: string) {
  const path = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(process.env.HOME ?? "", ".claude.json");
  const config = await readJson<{ projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }>(path);
  return config?.projects?.[repo]?.hasTrustDialogAccepted === true;
}

const consentPath = () => join(configDir(), "ai-job-search-web.json");
type Consent = { trustedRepos?: string[]; permissionModes?: Record<string, string>; connection?: string };
let consentWrite: Promise<void> = Promise.resolve();

export async function isWorkspaceTrusted(repo = REPO_DIR) {
  const consent = await readJson<Consent>(consentPath());
  return Boolean(consent?.trustedRepos?.includes(repo)) || (await claudeCodeTrusts(repo));
}

// Records the user's choices in the web UI's own file. Only this process
// writes it, so serializing writes in-process is enough; mode 0600 like other config.
function updateConsent(change: (c: Consent) => Consent): Promise<void> {
  // catch() first: one failed write must not poison every later click.
  const next = consentWrite.catch(() => undefined).then(async () => {
    await mkdir(configDir(), { recursive: true, mode: 0o700 });
    const consent = (await readJson<Consent>(consentPath())) ?? {};
    const tmp = `${consentPath()}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(change(consent), null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, consentPath());
  });
  consentWrite = next;
  return next;
}

export function trustWorkspace(repo = REPO_DIR): Promise<void> {
  return updateConsent((consent) => ({ ...consent, trustedRepos: [...new Set([...(consent.trustedRepos ?? []), repo])] }));
}

// The mode new tasks start in. A saved bypass that this environment no longer
// allows (the server moved out of Docker) falls back to asking.
export async function readPermissionMode(repo = REPO_DIR): Promise<WebMode> {
  const saved = (await readJson<Consent>(consentPath()))?.permissionModes?.[repo];
  if (!isWebMode(saved) || (saved === "bypassPermissions" && !bypassAllowed())) return "default";
  return saved;
}

// How new tasks reach Claude: "env" uses .env as before (an API key, a token or
// a proxy such as Meridian), "account" uses the Claude login made in Settings.
export async function readConnection(): Promise<Connection> {
  const saved = (await readJson<Consent>(consentPath()))?.connection;
  return isConnection(saved) ? saved : "env";
}

export function saveConnection(connection: Connection): Promise<void> {
  return updateConsent((consent) => ({ ...consent, connection }));
}

export function savePermissionMode(mode: WebMode, repo = REPO_DIR): Promise<void> {
  return updateConsent((consent) => ({ ...consent, permissionModes: { ...consent.permissionModes, [repo]: mode } }));
}

export type ProjectRules = { allow: string[]; deny: string[] };

// The repo's permission rules, applied by the web UI itself once the user has
// trusted the workspace (Claude Code ignores them in an untrusted folder).
export async function readProjectRules(repo = REPO_DIR): Promise<ProjectRules> {
  const rules: ProjectRules = { allow: [], deny: [] };
  for (const rel of [".claude/settings.json", ".claude/settings.local.json"]) {
    const text = await readText(rel, repo);
    if (!text) continue;
    try {
      const perms = (JSON.parse(text) as { permissions?: { allow?: unknown; deny?: unknown } }).permissions ?? {};
      for (const [key, list] of [["allow", perms.allow], ["deny", perms.deny]] as const) {
        if (Array.isArray(list)) rules[key].push(...list.filter((r): r is string => typeof r === "string"));
      }
    } catch {
      continue;
    }
  }
  return rules;
}

// Shown on the dashboard, so drop anything secret-looking a URL can carry.
export function displayBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "(잘못된 URL: http:// 또는 https://로 시작해야 합니다)";
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "(잘못된 URL)";
  }
}

export async function readStatus(repo = REPO_DIR) {
  const cvGuide = (await readText(".claude/skills/job-application-assistant/05-cv-templates.md", repo)) ?? "";
  const activeTemplate = /Active template override: `([^`]+)`/.exec(cvGuide)?.[1] ?? null;
  const env = process.env;
  const connection = await readConnection();
  const login = await loginStatus();
  const envAuth = env.CLAUDE_CODE_OAUTH_TOKEN
    ? "subscription"
    : env.ANTHROPIC_API_KEY
      ? "api_key"
      : env.ANTHROPIC_AUTH_TOKEN
        ? "auth_token"
        : login.loggedIn
          ? "login"
          : null;
  const auth = connection === "account" ? (login.loggedIn ? "account" : null) : envAuth;
  return {
    repo,
    auth,
    connection,
    login,
    accountConflicts: await accountConflicts(repo),
    envAuth,
    envBaseUrl: displayBaseUrl(env.ANTHROPIC_BASE_URL),
    baseUrl: connection === "account" ? null : displayBaseUrl(env.ANTHROPIC_BASE_URL),
    fileAccess: fileAccessMode(),
    model: env.ANTHROPIC_MODEL || null,
    typst: Bun.which("typst") !== null,
    lualatex: Bun.which("lualatex") !== null,
    activeTemplate,
    trusted: await isWorkspaceTrusted(repo),
    permissionMode: await readPermissionMode(repo),
    bypassAllowed: bypassAllowed(),
  };
}

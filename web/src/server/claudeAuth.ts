import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The same manual-code OAuth flow Claude Code's own /login uses (and Meridian
// mirrors): PKCE, the user signs in on claude.com, copies the code shown on
// the callback page, and we exchange it for an access + refresh token pair.
// The result is written where Claude Code reads its login, so Claude Code
// itself renews the access token with the refresh token.
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];
const SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ACCESS_TTL_S = 8 * 60 * 60;

export type Connection = "env" | "account";

export const isConnection = (v: unknown): v is Connection => v === "env" || v === "account";

// Variables that pick Claude Code's provider, endpoint, credential, model
// names or credential store (names taken from the bundled CLI). Any of them
// would make an "account" task skip the stored login or send it elsewhere.
export function overridesLogin(name: string): boolean {
  return (
    name.startsWith("ANTHROPIC_") ||
    /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY|GATEWAY|MANTLE|ANTHROPIC_AWS|ANTHROPIC_GOOGLE_CLOUD)$/.test(name) ||
    /^CLAUDE_CODE_(OAUTH|API)_/.test(name) ||
    name === "CLAUDE_CODE_OAUTH_TOKEN" ||
    name === "CLAUDE_SECURESTORAGE_CONFIG_DIR" ||
    name === "AWS_BEARER_TOKEN_BEDROCK"
  );
}

export function connectionEnv(connection: Connection, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> | undefined {
  if (connection === "env") return undefined;
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) if (!overridesLogin(k)) env[k] = v;
  return env;
}

// Settings keys that replace the stored login with another credential source.
const SETTINGS_AUTH_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"];

// Settings files Claude Code loads for a web task (user, project, local, and
// the managed policy file) can set the same variables through "env" or name a
// credential helper, which the task environment cannot undo. An "account"
// task refuses to start while any of them does, naming the file and key.
export async function accountConflicts(repo: string, dir = claudeConfigDir()): Promise<string[]> {
  const files = [
    join(dir, "settings.json"),
    join(repo, ".claude/settings.json"),
    join(repo, ".claude/settings.local.json"),
    "/etc/claude-code/managed-settings.json",
  ];
  const found: string[] = [];
  for (const file of files) {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!settings || typeof settings !== "object") continue;
    for (const key of SETTINGS_AUTH_KEYS) if (settings[key] !== undefined) found.push(`${file}: ${key}`);
    const env = settings.env;
    if (env && typeof env === "object") for (const k of Object.keys(env)) if (overridesLogin(k)) found.push(`${file}: env.${k}`);
  }
  return found;
}

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude");
}

const credentialsPath = (dir = claudeConfigDir()) => join(dir, ".credentials.json");

type OAuthCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  refresh_token_expires_in?: number;
  refresh_token_expires_at?: number;
  scope?: string;
};

export type LoginStatus = {
  supported: boolean;
  loggedIn: boolean;
  subscriptionType: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
};

// On macOS Claude Code keeps its login in the Keychain, not in this file, so
// writing the file there would look like success and change nothing.
export const loginSupported = (platform: string = process.platform) => platform !== "darwin";

const MAX_PENDING = 20;
const pending = new Map<string, { verifier: string; expiresAt: number; generation: number }>();
// Bumped by logout: a login started or still exchanging before it must not
// write credentials after the user logged out.
let generation = 0;

export function startLogin(now = Date.now()): { authorizeUrl: string } {
  for (const [state, s] of pending) if (s.expiresAt < now) pending.delete(state);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  pending.set(state, { verifier, expiresAt: now + SESSION_TTL_MS, generation });
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { authorizeUrl: url.toString() };
}

// The callback page shows "<code>#<state>"; a pasted callback URL works too.
export function parseCodeInput(input: string): { code: string; state?: string } | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  try {
    const url = new URL(trimmed);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const code = url.searchParams.get("code") ?? hash.get("code");
    const state = url.searchParams.get("state") ?? hash.get("state") ?? undefined;
    return code ? { code, state } : null;
  } catch {
    // Not a URL: the plain "<code>#<state>" form.
  }
  const [codePart, hashState] = trimmed.split("#", 2);
  const code = codePart?.split("&", 1)[0]?.trim();
  const ampState = codePart?.includes("&") ? new URLSearchParams(codePart.slice(codePart.indexOf("&") + 1)).get("state") : null;
  const state = ampState ?? hashState?.trim() ?? undefined;
  return code ? { code, state: state || undefined } : null;
}

export class LoginError extends Error {}

// Login commits, logout and connection changes run one at a time in this
// process, so a check ("is anyone logged in?") and the write that depends on
// it cannot interleave with another of them.
let authQueue: Promise<unknown> = Promise.resolve();

export function serializeAuth<T>(fn: () => Promise<T>): Promise<T> {
  const next = authQueue.catch(() => undefined).then(fn);
  authQueue = next;
  return next;
}

// Claude Code guards every change to its credential store with
// proper-lockfile on <config dir>/.storage-write (a .storage-write.lock
// directory, stale after 15 s, mtime refreshed by the holder). Taking the
// same lock around our read-modify-write keeps a token refresh running in a
// task from losing our change, or restoring a login we just removed.
const LOCK_STALE_MS = 15_000;
const LOCK_ATTEMPTS = 30;

async function withStorageLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".storage-write.lock");
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = await stat(lock).catch(() => null);
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rmdir(lock).catch(() => undefined);
        continue;
      }
      if (attempt >= LOCK_ATTEMPTS) throw new LoginError("Claude Code가 로그인 정보를 쓰고 있어요. 잠시 뒤 다시 시도해 주세요.");
      await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 1000)));
    }
  }
  const keepAlive = setInterval(() => {
    const now = new Date();
    void utimes(lock, now, now).catch(() => undefined);
  }, LOCK_STALE_MS / 2);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
    await rmdir(lock).catch(() => undefined);
  }
}

async function planFields(accessToken: string, fetchFn: typeof fetch) {
  try {
    const res = await fetchFn(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return {};
    const org = ((await res.json()) as { organization?: { organization_type?: string; rate_limit_tier?: string } }).organization;
    const type = { claude_max: "max", claude_pro: "pro", claude_team: "team", claude_enterprise: "enterprise" }[org?.organization_type ?? ""];
    return { ...(type ? { subscriptionType: type } : {}), ...(org?.rate_limit_tier ? { rateLimitTier: org.rate_limit_tier } : {}) };
  } catch {
    return {};
  }
}

export function buildCredentials(token: TokenResponse, plan: Partial<OAuthCredentials>, now = Date.now()): OAuthCredentials {
  const refreshDeadline =
    token.refresh_token_expires_at ?? (token.refresh_token_expires_in && token.refresh_token_expires_in > 0 ? now + token.refresh_token_expires_in * 1000 : undefined);
  return {
    accessToken: token.access_token!,
    refreshToken: token.refresh_token!,
    expiresAt: token.expires_at ?? now + (token.expires_in ?? DEFAULT_ACCESS_TTL_S) * 1000,
    ...(refreshDeadline && refreshDeadline > now ? { refreshTokenExpiresAt: refreshDeadline } : {}),
    scopes: token.scope?.split(" ").filter(Boolean) ?? SCOPES,
    ...plan,
  };
}

async function readCredentialsFile(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(credentialsPath(dir), "utf-8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function replaceCredentialsFile(dir: string, content: Record<string, unknown>) {
  const tmp = `${credentialsPath(dir)}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(content), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, credentialsPath(dir));
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

// Other keys Claude Code keeps in the file (e.g. MCP OAuth) are preserved;
// the file is re-read under the lock so a change made meanwhile is kept.
function writeLogin(creds: OAuthCredentials, dir: string) {
  return withStorageLock(dir, async () => replaceCredentialsFile(dir, { ...((await readCredentialsFile(dir)) ?? {}), claudeAiOauth: creds }));
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTime = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v > 0);

// Checked before anything touches the file, so a malformed reply never
// replaces a working login.
export function validTokenResponse(v: unknown): v is TokenResponse {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  if (!isText(t.access_token) || !isText(t.refresh_token)) return false;
  if (![t.expires_in, t.expires_at, t.refresh_token_expires_in, t.refresh_token_expires_at].every(isTime)) return false;
  if (t.scope !== undefined && (typeof t.scope !== "string" || !t.scope.split(" ").includes("user:inference"))) return false;
  return true;
}

export async function completeLogin(
  input: unknown,
  opts: { fetchFn?: typeof fetch; dir?: string; now?: number; platform?: string } = {},
): Promise<LoginStatus> {
  if (!loginSupported(opts.platform)) throw new LoginError("이 환경(macOS 직접 실행)에서는 로그인 정보를 저장할 수 없어요. Docker로 실행해 주세요.");
  const parsed = typeof input === "string" ? parseCodeInput(input) : null;
  if (!parsed) throw new LoginError("코드를 읽지 못했어요. 로그인 후 화면에 나온 코드를 그대로 붙여넣어 주세요.");
  const now = opts.now ?? Date.now();
  // The callback page always carries the state; without it the code cannot be
  // tied to a login this server started.
  const session = parsed.state ? pending.get(parsed.state) : undefined;
  const startedIn = session?.generation;
  if (!parsed.state || !session || session.expiresAt < now) throw new LoginError("로그인 시간이 지났거나 다른 로그인 창의 코드예요. 로그인을 다시 시작해 주세요.");
  pending.delete(parsed.state);
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: parsed.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: session.verifier,
        state: parsed.state,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new LoginError(`Claude 서버에 연결하지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new LoginError(`코드 확인에 실패했어요 (HTTP ${res.status}). 로그인을 다시 시작해 주세요.`);
  const token: unknown = await res.json().catch(() => null);
  if (!validTokenResponse(token)) throw new LoginError("Claude 서버가 쓸 수 있는 로그인 정보를 주지 않았어요. 다시 시도해 주세요.");
  const plan = await planFields(token.access_token!, fetchFn);
  const dir = opts.dir ?? claudeConfigDir();
  return serializeAuth(async () => {
    if (startedIn !== generation) throw new LoginError("로그인하는 동안 로그아웃해서 이 로그인은 저장하지 않았어요.");
    await writeLogin(buildCredentials(token, plan, now), dir);
    return loginStatus(dir);
  });
}

export async function loginStatus(dir = claudeConfigDir()): Promise<LoginStatus> {
  const oauth = (await readCredentialsFile(dir))?.claudeAiOauth as Partial<OAuthCredentials> | undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    supported: loginSupported(),
    loggedIn: typeof oauth?.accessToken === "string" && oauth.accessToken.length > 0 && typeof oauth.refreshToken === "string",
    subscriptionType: typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : null,
    accessTokenExpiresAt: num(oauth?.expiresAt),
    refreshTokenExpiresAt: num(oauth?.refreshTokenExpiresAt),
  };
}

// Call inside serializeAuth. Cancels every login still pending or exchanging,
// then removes only the Claude login from the store, under Claude Code's lock.
// A failure to remove it is reported, never swallowed.
export async function logoutLocked(dir = claudeConfigDir()) {
  generation += 1;
  pending.clear();
  await withStorageLock(dir, async () => {
    const existing = await readCredentialsFile(dir);
    if (!existing || !("claudeAiOauth" in existing)) return;
    const { claudeAiOauth: _drop, ...rest } = existing;
    if (Object.keys(rest).length > 0) await replaceCredentialsFile(dir, rest);
    else {
      await unlink(credentialsPath(dir)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  });
}

export const logout = (dir = claudeConfigDir()) => serializeAuth(() => logoutLocked(dir));

import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginError, accountConflicts, completeLogin, connectionEnv, loginStatus, logout, parseCodeInput, startLogin } from "../src/server/claudeAuth.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOGIN = { claudeAiOauth: { accessToken: "old-at", refreshToken: "old-rt", expiresAt: 1 } };

const linux = { platform: "linux" };

function stateOf(authorizeUrl: string) {
  return new URL(authorizeUrl).searchParams.get("state")!;
}

function fakeFetch(calls: { url: string; body?: any }[], token: Record<string, unknown> = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith("/oauth/token")) {
      return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, refresh_token_expires_in: 30 * 86400, scope: "user:inference user:profile", ...token });
    }
    if (u.endsWith("/oauth/profile")) return Response.json({ organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("claude login", () => {
  test("the authorize URL carries PKCE S256, the Claude Code client and the manual-code redirect", () => {
    const u = new URL(startLogin().authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(u.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
    expect(u.searchParams.get("scope")).toContain("user:inference");
  });

  test("the pasted code is read in every form the callback page gives", () => {
    expect(parseCodeInput("abc#st")).toEqual({ code: "abc", state: "st" });
    expect(parseCodeInput("  abc#st \n")).toEqual({ code: "abc", state: "st" });
    expect(parseCodeInput("https://platform.claude.com/oauth/code/callback?code=abc&state=st")).toEqual({ code: "abc", state: "st" });
    expect(parseCodeInput("abc")).toEqual({ code: "abc", state: undefined });
    expect(parseCodeInput("")).toBeNull();
  });

  test("a code exchanges into Claude Code's credentials file, keeping its other entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ mcpOAuth: { keep: 1 } }));
    const calls: { url: string; body?: any }[] = [];
    const state = stateOf(startLogin().authorizeUrl);
    const status = await completeLogin(`the-code#${state}`, { ...linux, dir, fetchFn: fakeFetch(calls), now: 1_000_000 });

    const exchange = calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect(exchange.body).toMatchObject({ grant_type: "authorization_code", code: "the-code", state, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" });
    expect(exchange.body.code_verifier).toMatch(/^[\w-]{43}$/);

    const file = JSON.parse(await readFile(join(dir, ".credentials.json"), "utf-8"));
    expect(file.mcpOAuth).toEqual({ keep: 1 });
    expect(file.claudeAiOauth).toMatchObject({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 1_000_000 + 3600_000,
      refreshTokenExpiresAt: 1_000_000 + 30 * 86400_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    });
    expect((await stat(join(dir, ".credentials.json"))).mode & 0o777).toBe(0o600);
    expect(status).toMatchObject({ loggedIn: true, subscriptionType: "max" });
  });

  test("a code from no login this server started, or one used twice, is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    const calls: { url: string }[] = [];
    await expect(completeLogin("code#made-up-state", { ...linux, dir, fetchFn: fakeFetch(calls) })).rejects.toBeInstanceOf(LoginError);
    await expect(completeLogin("code-without-state", { ...linux, dir, fetchFn: fakeFetch(calls) })).rejects.toBeInstanceOf(LoginError);
    const state = stateOf(startLogin().authorizeUrl);
    await completeLogin(`c#${state}`, { ...linux, dir, fetchFn: fakeFetch(calls) });
    await expect(completeLogin(`c#${state}`, { ...linux, dir, fetchFn: fakeFetch(calls) })).rejects.toBeInstanceOf(LoginError);
    expect(calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  test("a token response without a refresh token is not stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    const state = stateOf(startLogin().authorizeUrl);
    await expect(completeLogin(`c#${state}`, { ...linux, dir, fetchFn: fakeFetch([], { refresh_token: undefined }) })).rejects.toBeInstanceOf(LoginError);
    expect((await loginStatus(dir)).loggedIn).toBe(false);
  });

  test("macOS is refused: Claude Code reads its login from the Keychain there", async () => {
    const state = stateOf(startLogin().authorizeUrl);
    await expect(completeLogin(`c#${state}`, { platform: "darwin", dir: tmpdir(), fetchFn: fakeFetch([]) })).rejects.toThrow("Docker");
  });

  test("logout removes only the Claude login", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" }, other: 1 }));
    expect((await loginStatus(dir)).loggedIn).toBe(true);
    await logout(dir);
    expect(JSON.parse(await readFile(join(dir, ".credentials.json"), "utf-8"))).toEqual({ other: 1 });
    expect((await loginStatus(dir)).loggedIn).toBe(false);
  });

  test("an account task drops every provider, endpoint, credential and store override; an env task keeps them", () => {
    const base = {
      ANTHROPIC_BASE_URL: "http://meridian",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_CUSTOM_HEADERS: "x: y",
      ANTHROPIC_MODEL: "gateway-model",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/elsewhere",
      AWS_BEARER_TOKEN_BEDROCK: "b",
      CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: "1",
      CLAUDE_CONFIG_DIR: "/home/bun/.claude",
      HOME: "/home/bun",
    };
    expect(connectionEnv("account", base)).toEqual({ CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: "1", CLAUDE_CONFIG_DIR: "/home/bun/.claude", HOME: "/home/bun" });
    expect(connectionEnv("env", base)).toBeUndefined();
  });

  test("settings that route Claude Code elsewhere are named, harmless ones are not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    const repo = await mkdtemp(join(tmpdir(), "ajs-repo-"));
    await mkdir(join(repo, ".claude"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "/bin/key", env: { ANTHROPIC_BASE_URL: "http://proxy", FOO: "1" } }));
    await writeFile(join(repo, ".claude/settings.local.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }));
    await writeFile(join(repo, ".claude/settings.json"), JSON.stringify({ permissions: { allow: [] } }));
    const found = await accountConflicts(repo, dir);
    expect(found).toEqual([
      `${join(dir, "settings.json")}: apiKeyHelper`,
      `${join(dir, "settings.json")}: env.ANTHROPIC_BASE_URL`,
      `${join(repo, ".claude/settings.local.json")}: env.CLAUDE_CODE_USE_VERTEX`,
    ]);
  });

  test("writes wait for Claude Code's credential lock and reclaim a stale one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    const lock = join(dir, ".storage-write.lock");
    await mkdir(lock);
    const state = stateOf(startLogin().authorizeUrl);
    const done = completeLogin(`c#${state}`, { ...linux, dir, fetchFn: fakeFetch([]) });
    await sleep(400);
    expect((await loginStatus(dir)).loggedIn).toBe(false);
    await rmdir(lock);
    await done;
    expect((await loginStatus(dir)).loggedIn).toBe(true);

    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const t0 = Date.now();
    await logout(dir);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await loginStatus(dir)).loggedIn).toBe(false);
  });

  test("a logout during the code exchange cancels that login", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/oauth/token")) await gate;
      return fakeFetch([])(url, init);
    }) as typeof fetch;
    const state = stateOf(startLogin().authorizeUrl);
    const pendingState = stateOf(startLogin().authorizeUrl);
    const login = completeLogin(`c#${state}`, { ...linux, dir, fetchFn: slow });
    await sleep(20);
    await logout(dir);
    release();
    await expect(login).rejects.toBeInstanceOf(LoginError);
    expect((await loginStatus(dir)).loggedIn).toBe(false);
    await expect(completeLogin(`c#${pendingState}`, { ...linux, dir, fetchFn: fakeFetch([]) })).rejects.toBeInstanceOf(LoginError);
  });

  test("a malformed or unusable token reply leaves the existing login alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    await writeFile(join(dir, ".credentials.json"), JSON.stringify(LOGIN));
    const replies: unknown[] = [null, { access_token: { x: 1 }, refresh_token: 5 }, { access_token: "a", refresh_token: "r", scope: "user:profile" }, { access_token: "a", refresh_token: "r", expires_in: "soon" }];
    for (const reply of replies) {
      const f = (async (url: string | URL | Request) => (String(url).endsWith("/oauth/token") ? Response.json(reply) : new Response("", { status: 404 }))) as typeof fetch;
      const state = stateOf(startLogin().authorizeUrl);
      await expect(completeLogin(`c#${state}`, { ...linux, dir, fetchFn: f })).rejects.toBeInstanceOf(LoginError);
    }
    expect(JSON.parse(await readFile(join(dir, ".credentials.json"), "utf-8"))).toEqual(LOGIN);
  });

  test("a logout that cannot remove the login says so", async () => {
    if (process.getuid?.() === 0) return;
    const dir = await mkdtemp(join(tmpdir(), "ajs-claude-"));
    await writeFile(join(dir, ".credentials.json"), JSON.stringify(LOGIN));
    await chmod(dir, 0o500);
    try {
      await expect(logout(dir)).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }
    expect((await loginStatus(dir)).loggedIn).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";

// Non-Linux hosts have no race-free path walk; the tests exercise the path-based fallback.
if (process.platform !== "linux") process.env.AJS_INSECURE_PATH_CHECKS = "1";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageToEvents } from "../src/server/agent.ts";
import { parseCsv } from "../src/server/csv.ts";
import { displayBaseUrl, isWorkspaceTrusted, listFiles, readProfile, readProjectRules, readSeenJobs, readTracker, trustWorkspace } from "../src/server/data.ts";
import { hostAllowed, nextChunkSize, normalizeRel, originAllowed, readChecked, resolveReadable, safeFileName, writeUpload } from "../src/server/security.ts";
import { renderMarkdown } from "../src/client/markdown.ts";
import { isVetoed, recommended } from "../src/client/jobs.ts";

async function fixtureRepo() {
  const repo = await mkdtemp(join(tmpdir(), "ajs-web-"));
  await mkdir(join(repo, "cv"), { recursive: true });
  await mkdir(join(repo, "documents/cv"), { recursive: true });
  await mkdir(join(repo, "job_scraper"), { recursive: true });
  await writeFile(join(repo, "cv/main_toss_backend.pdf"), "%PDF");
  await writeFile(join(repo, ".env"), "SECRET=1");
  await writeFile(join(repo, "documents/cv/.gitkeep"), "");
  await writeFile(
    join(repo, "job_search_tracker.csv"),
    'date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline\n' +
      '2026-11-01,토스,핀테크,"백엔드, 결제",dev,원티드,applied,,82,"메모 ""인용""\n둘째 줄",cv/main_toss_backend.typ,,https://example.com,2026-11-20\n' +
      "2026-10-01,당근,커머스,서버,dev,사람인,rejected,,60,,,,,\n",
  );
  await writeFile(join(repo, "job_scraper/seen_jobs.json"), JSON.stringify({ a: { title: "백엔드", status: "ranked", rank_score: 77 }, bad: 3 }));
  return repo;
}

describe("security", () => {
  test("Host allowlist blocks DNS rebinding names", () => {
    expect(hostAllowed("localhost:3000")).toBe(true);
    expect(hostAllowed("127.0.0.1:3000")).toBe(true);
    expect(hostAllowed("evil.example:3000")).toBe(false);
    expect(hostAllowed(null)).toBe(false);
    expect(hostAllowed("my-mac.local:3000", ["my-mac.local"])).toBe(true);
  });

  test("Origin must match Host", () => {
    expect(originAllowed("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(originAllowed("http://evil.example", "localhost:3000")).toBe(false);
    expect(originAllowed("null", "localhost:3000")).toBe(false);
    expect(originAllowed(null, "localhost:3000")).toBe(true);
    expect(originAllowed(null, "localhost:3000", true)).toBe(false);
  });

  test("paths outside the allowed roots are refused", () => {
    expect(normalizeRel("cv/main_x.pdf")).not.toBeNull();
    expect(normalizeRel("job_search_tracker.csv")).not.toBeNull();
    expect(normalizeRel("../etc/passwd")).toBeNull();
    expect(normalizeRel(".env")).toBeNull();
    expect(normalizeRel("documents/../.env")).toBeNull();
    expect(normalizeRel(".git/config")).toBeNull();
    expect(normalizeRel("tools/fetch_page.py")).toBeNull();
    expect(normalizeRel("documents/cv/.env.local")).toBeNull();
  });

  test("symlinks cannot escape the allowed roots", async () => {
    const repo = await fixtureRepo();
    await symlink(join(repo, ".env"), join(repo, "cv/leak.txt"));
    expect(await resolveReadable("cv/main_toss_backend.pdf", repo)).not.toBeNull();
    expect(await resolveReadable("cv/leak.txt", repo)).toBeNull();
    expect(await resolveReadable("cv/missing.pdf", repo)).toBeNull();
  });

  test("upload names are sanitized", () => {
    expect(safeFileName("이력서 2026.pdf")).toBe("이력서 2026.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName(".env")).toBe("env");
    expect(safeFileName("...")).toBeNull();
    expect(safeFileName("a<b>.pdf")).toBe("a_b_.pdf");
  });
});

describe("confinement", () => {
  test("uploads refuse a symlinked folder or destination", async () => {
    const repo = await fixtureRepo();
    const outside = await mkdtemp(join(tmpdir(), "ajs-outside-"));
    await mkdir(join(repo, "documents"), { recursive: true });
    await symlink(outside, join(repo, "documents/references"));
    await expect(writeUpload("references", "x.txt", new TextEncoder().encode("x"), repo)).rejects.toThrow();
    await symlink(join(outside, "target.txt"), join(repo, "documents/cv/link.txt"));
    await expect(writeUpload("cv", "link.txt", new TextEncoder().encode("x"), repo)).rejects.toThrow();
    await expect(stat(join(outside, "target.txt"))).rejects.toThrow();
    expect(await writeUpload("cv", "ok.txt", new TextEncoder().encode("ok"), repo)).toBe("documents/cv/ok.txt");
    await expect(writeUpload("../../etc", "x", new Uint8Array(), repo)).rejects.toThrow();
  });

  test("small reads allocate only about what the file holds", async () => {
    const repo = await fixtureRepo();
    const abs = await resolveReadable("cv/main_toss_backend.pdf", repo);
    const out = await readChecked(abs!, repo);
    expect(out.toString()).toBe("%PDF");
    expect(out.buffer.byteLength).toBeLessThan(64 * 1024);
  });

  test.skipIf(process.platform === "linux")("without the opt-in, non-Linux hosts refuse file access", async () => {
    const repo = await fixtureRepo();
    const abs = await resolveReadable("cv/main_toss_backend.pdf", repo);
    delete process.env.AJS_INSECURE_PATH_CHECKS;
    try {
      await expect(readChecked(abs!, repo)).rejects.toMatchObject({ code: "ENOTSUP" });
      await expect(writeUpload("cv", "x.txt", new Uint8Array(), repo)).rejects.toMatchObject({ code: "ENOTSUP" });
    } finally {
      process.env.AJS_INSECURE_PATH_CHECKS = "1";
    }
  });

  test("a file that grows after fstat is read in normal chunks, not byte by byte", () => {
    const simulate = (snapshot: number, actual: number, max: number) => {
      let read = 0, calls = 0, peak = 0;
      while (read <= max) {
        const want = nextChunkSize(snapshot, read, max);
        peak = Math.max(peak, want);
        calls++;
        const got = Math.min(want, actual - read);
        if (got <= 0) break;
        read += got;
      }
      return { read, calls, peak };
    };
    expect(simulate(0, 4096, 50 * 1024 * 1024)).toEqual({ read: 4096, calls: 3, peak: 1024 * 1024 });
    expect(simulate(10, 10, 100)).toEqual({ read: 10, calls: 2, peak: 11 });
    expect(simulate(5000, 5000, 50 * 1024 * 1024).peak).toBe(5001);
    const grew = simulate(0, 200 * 1024 * 1024, 50 * 1024 * 1024);
    expect(grew.read).toBe(50 * 1024 * 1024 + 1);
    expect(grew.calls).toBeLessThanOrEqual(51);
    expect(nextChunkSize(100, 0, 4)).toBe(5);
  });

  test("reads stop at the size cap", async () => {
    const repo = await fixtureRepo();
    const abs = await resolveReadable("cv/main_toss_backend.pdf", repo);
    await writeFile(abs!, "123456789");
    await expect(readChecked(abs!, repo, 4)).rejects.toThrow("file too large");
    expect((await readChecked(abs!, repo, 9)).toString()).toBe("123456789");
  });

  test("profile reads do not follow symlinks out of the repo", async () => {
    const repo = await fixtureRepo();
    const outside = await mkdtemp(join(tmpdir(), "ajs-outside-"));
    await writeFile(join(outside, "secret.md"), "OUTSIDE");
    await mkdir(join(repo, "documents/profile"), { recursive: true });
    await symlink(join(outside, "secret.md"), join(repo, "documents/profile/candidate.md"));
    const p = await readProfile(repo);
    expect(p.files[0]?.content).toBe("");
    expect(p.files[0]?.exists).toBe(false);
  });
});

describe("workspace trust", () => {
  test("consent goes to the web UI's own file, survives concurrent clicks, mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajs-config-"));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      await writeFile(join(dir, ".claude.json"), JSON.stringify({ keep: 1 }));
      expect(await isWorkspaceTrusted("/repo/a")).toBe(false);
      await Promise.all(["/repo/a", "/repo/b", "/repo/c", "/repo/d"].map((r) => trustWorkspace(r)));
      const consent = JSON.parse(await readFile(join(dir, "ai-job-search-web.json"), "utf-8"));
      expect(consent.trustedRepos.sort()).toEqual(["/repo/a", "/repo/b", "/repo/c", "/repo/d"]);
      expect((await stat(join(dir, "ai-job-search-web.json"))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(join(dir, ".claude.json"), "utf-8"))).toEqual({ keep: 1 });
      expect(await isWorkspaceTrusted("/repo/a")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  test("project rules come from settings.json and settings.local.json", async () => {
    const repo = await fixtureRepo();
    await mkdir(join(repo, ".claude"), { recursive: true });
    await writeFile(join(repo, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"], deny: ["Read(.env)"] } }));
    await writeFile(join(repo, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(pwd)", 3] } }));
    expect(await readProjectRules(repo)).toEqual({ allow: ["Bash(ls:*)", "Bash(pwd)"], deny: ["Read(.env)"] });
  });
});

describe("data", () => {
  test("CSV handles quotes, commas and newlines", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nline"\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nline'],
    ]);
  });

  test("tracker rows carry an open flag from the status vocabulary", async () => {
    const t = await readTracker(await fixtureRepo());
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]?.role).toBe("백엔드, 결제");
    expect(t.rows[0]?._open).toBe("1");
    expect(t.rows[1]?._open).toBe("0");
  });

  test("seen_jobs entries become a list and non-objects are skipped", async () => {
    const s = await readSeenJobs(await fixtureRepo());
    expect(s.jobs).toEqual([{ key: "a", title: "백엔드", status: "ranked", rank_score: 77 }]);
  });

  test("seen_jobs in the canonical {seen: ...} wrapper", async () => {
    const repo = await fixtureRepo();
    await writeFile(join(repo, "job_scraper/seen_jobs.json"), JSON.stringify({ seen: { acme: { title: "Backend", rank_score: 90 } } }));
    expect((await readSeenJobs(repo)).jobs).toEqual([{ key: "acme", title: "Backend", rank_score: 90 }]);
  });

  test("profile is read from the documents/profile overlays", async () => {
    const repo = await fixtureRepo();
    expect((await readProfile(repo)).configured).toBe(false);
    await mkdir(join(repo, "documents/profile"), { recursive: true });
    await writeFile(join(repo, "documents/profile/candidate.md"), "# Candidate\n- **Name:** [YOUR_NAME]\n");
    expect((await readProfile(repo)).configured).toBe(false);
    await writeFile(join(repo, "documents/profile/candidate.md"), "# Candidate\n- **Name:** 홍길동\n");
    await writeFile(join(repo, "documents/profile/master-cv.typ"), "#let x = 1");
    const p = await readProfile(repo);
    expect(p.configured).toBe(true);
    expect(p.files.map((f) => f.path)).toContain("documents/profile/master-cv.typ");
    expect(p.files.find((f) => f.path.endsWith("02-behavioral-profile.md"))?.exists).toBe(false);
  });

  test("file list skips dotfiles", async () => {
    const files = await listFiles(await fixtureRepo());
    expect(files.map((f) => f.path)).toEqual(["cv/main_toss_backend.pdf"]);
  });
});

describe("status", () => {
  test("the endpoint shown on the dashboard drops credentials and query strings", () => {
    expect(displayBaseUrl(undefined)).toBeNull();
    expect(displayBaseUrl("https://user:secret@gw.example.com/anthropic?key=abc")).toBe("https://gw.example.com/anthropic");
    expect(displayBaseUrl("http://host.docker.internal:8080/")).toBe("http://host.docker.internal:8080");
    expect(displayBaseUrl("not a url")).toBe("(잘못된 URL)");
    expect(displayBaseUrl("host.docker.internal:3456")).toContain("http://");
  });
});

describe("job recommendations", () => {
  test("a FAIL on any gate keeps a high-scoring job out of the Top 5", () => {
    const jobs = [
      { key: "elig", status: "ranked", rank_score: 99, eligibility_gate: "FAIL" },
      { key: "lang", status: "ranked", rank_score: 98, language_gate: "FAIL" },
      { key: "loc", status: "ranked", rank_score: 97, location_verdict: "FAIL" },
      { key: "flag", status: "ranked", rank_score: 80, eligibility_gate: "FLAG" },
      { key: "ok", status: "ranked", rank_score: 70 },
      { key: "new", status: "new" },
    ];
    expect(recommended(jobs).map((j) => j.key)).toEqual(["flag", "ok"]);
    expect(isVetoed(jobs[0]!)).toBe(true);
    expect(isVetoed(jobs[3]!)).toBe(false);
  });
});

describe("rendering", () => {
  test("markdown escapes raw HTML and unsafe links", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://example.com)');
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://example.com/"');
  });

  test("assistant and tool_result messages map to UI events", () => {
    const a = messageToEvents("assistant", { content: [{ type: "text", text: "안녕" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] }, false);
    expect(a).toEqual([{ kind: "assistant", text: "안녕", tools: [{ id: "t1", name: "Bash", input: '{\n  "command": "ls"\n}' }], sub: false }]);
    const u = messageToEvents("user", { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] }, false);
    expect(u).toEqual([{ kind: "tool_result", toolUseId: "t1", text: "ok", isError: false }]);
  });
});

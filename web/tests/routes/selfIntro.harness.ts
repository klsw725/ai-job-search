// Route-level checks for 자기소개서 runs against the real server module, with the
// Agent SDK mocked and Bun.serve intercepted (no port is opened). It needs its
// own process: the server reads REPO_DIR when first imported, so tests/routes.test.ts
// runs this file with `bun test` as a child.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = await mkdtemp(join(tmpdir(), "ajs-routes-"));
process.env.REPO_DIR = repo;
process.env.CLAUDE_CONFIG_DIR = join(repo, ".config");
process.env.PORT = "0";
if (process.platform !== "linux") process.env.AJS_INSECURE_PATH_CHECKS = "1";
afterAll(() => rm(repo, { recursive: true, force: true }));

const TOOLS = join(import.meta.dir, "../../../tools");
await mkdir(join(repo, "tools"), { recursive: true });
for (const t of ["tracker_state.py", "self_intro_count.py"]) await cp(join(TOOLS, t), join(repo, "tools", t));

const HEADER = "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline";
type Row = { date: string; company: string; status: string; cv?: string; source?: string };
const rows: Row[] = [
  { date: "2026-11-09", company: "Fixes", status: "drafted" },
  { date: "2026-11-09", company: "Progress", status: "drafted" },
  { date: "2026-11-09", company: "Submitted", status: "applied" },
  { date: "2026-11-09", company: "Concurrent", status: "drafted" },
  { date: "2026-11-09", company: "Duplicate", status: "drafted" },
  { date: "2026-11-09", company: "Again", status: "drafted" },
  { date: "2026-11-09", company: "Follow", status: "drafted", cv: "cv/main_follow.typ", source: "https://x.io/follow" },
  { date: "2026-11-09", company: "Late", status: "applied", cv: "cv/main_late.typ", source: "https://x.io/late" },
];
const saveRows = () =>
  writeFile(join(repo, "job_search_tracker.csv"), `${HEADER}\n${rows.map((r) => `${r.date},${r.company},,Engineer,,,${r.status},,80,,${r.cv ?? ""},,${r.source ?? ""},`).join("\n")}\n`);
await saveRows();

const app = (company: string) => ({ date: "2026-11-09", company, role: "Engineer" });
await mkdir(join(repo, ".ajs/runs"), { recursive: true });
for (const company of ["Submitted", "Duplicate"]) {
  const identity = app(company);
  await writeFile(
    join(repo, `.ajs/runs/old-${company}.json`),
    JSON.stringify({
      id: `old-${company}`,
      kind: "self-intro",
      title: company,
      subject: {},
      application: identity,
      params: { application: identity, folder: `documents/applications/${company.toLowerCase()}_engineer`, questions: [{ question: "Q", count: "with_spaces" }] },
      state: "failed",
      startedAt: Date.now() - 60_000,
      sessionId: null,
      sdkSessionId: null,
    }),
  );
}
await mkdir(join(repo, "documents/applications/again_engineer"), { recursive: true });
await writeFile(join(repo, "documents/applications/again_engineer/self_intro.txt"), "earlier submitted answers");

type Fake = { options: Record<string, any>; inputs: any[]; emit: (m: unknown) => void; end: () => void };
const fakes: Fake[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) => {
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const fake: Fake = {
      options,
      inputs: [],
      emit: (m) => {
        queue.push(m);
        wake?.();
      },
      end: () => {
        done = true;
        wake?.();
      },
    };
    fakes.push(fake);
    void (async () => {
      for await (const m of prompt) fake.inputs.push(m);
    })();
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) yield queue.shift();
          else if (done) return;
          else await new Promise<void>((r) => (wake = r));
        }
      },
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      close: () => fake.end(),
    };
  },
  listSessions: async () => [],
  getSessionMessages: async () => [],
  deleteSession: async () => undefined,
}));

let serveOptions: { fetch: (req: Request, srv: unknown) => Promise<Response> } | null = null;
const realServe = Bun.serve;
(Bun as unknown as { serve: unknown }).serve = (options: typeof serveOptions) => {
  serveOptions = options;
  return { publish() {} };
};
await import("../../src/server/server.ts");
(Bun as unknown as { serve: unknown }).serve = realServe;

const call = async (path: string, body?: unknown) => {
  const res = await serveOptions!.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {},
  );
  return { status: res.status, body: (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : await res.text() };
};
const runs = async () => (await call("/api/runs")).body as any[];
const runById = async (id: string) => (await runs()).find((r) => r.id === id);
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await get();
    if (ok(v)) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const lastInput = (f: Fake) => f.inputs.at(-1);
const inputText = (m: any) => (typeof m.message.content === "string" ? m.message.content : m.message.content.at(-1).text);
const result = (f: Fake, structured: unknown) =>
  f.emit({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0, duration_ms: 1, structured_output: structured, user_message_uuids: [lastInput(f).uuid] });
const answers = (...texts: string[]) => ({ status: "done", summary_md: "ok", answers: texts.map((text, i) => ({ index: i + 1, question: "", text })) });
const start = (company: string, questions: unknown[]) => call("/api/runs", { kind: "self-intro", application: app(company), questions });
const Q2 = [{ question: "Q1", limit: 100 }, { question: "Q2" }];
const fakeFor = async (n: number): Promise<Fake> => (await until(async () => fakes[n], (f) => !!f && f.inputs.length > 0, "a session"))!;

describe("self-introduction runs through the server routes", () => {
  test("the agent cannot write; out-of-range answers go back; only they change; the server saves the file", async () => {
    const n = fakes.length;
    const started = await start("Fixes", Q2);
    expect(started.status).toBe(200);
    const f = await fakeFor(n);
    expect(f.options.disallowedTools).toEqual(expect.arrayContaining(["AskUserQuestion", "Write", "Edit", "Bash"]));

    result(f, answers("가".repeat(120), "나".repeat(50)));
    await until(async () => f.inputs.length, (l) => l === 2, "the fix message");
    expect(inputText(lastInput(f))).toContain("문항 1");
    expect(inputText(lastInput(f))).not.toContain("문항 2");

    result(f, answers("가".repeat(95), "바뀐 둘째"));
    const done = await until(() => runById(started.body.id), (r) => r?.state === "succeeded", "success");
    expect(done.result.answers.map((a: any) => a.text)).toEqual(["가".repeat(95), "나".repeat(50)]);
    expect(done.result.answers[0].counts.with_spaces).toBe(95);
    expect(done.artifact.written).toBe(true);
    const file = await readFile(join(repo, "documents/applications/fixes_engineer/self_intro.txt"), "utf8");
    expect(file).toContain("가".repeat(95));
    expect(file).not.toContain("바뀐 둘째");

    const n2 = fakes.length;
    const revise = await call("/api/runs", { kind: "self-intro", application: app("Fixes"), revise: { index: 2, feedback: "더 구체적으로" } });
    expect(revise.status).toBe(200);
    const g = await fakeFor(n2);
    result(g, answers("다".repeat(95), "라".repeat(40)));
    const revised = await until(() => runById(revise.body.id), (r) => r?.state === "succeeded", "revision");
    expect(revised.result.answers.map((a: any) => a.text)).toEqual(["가".repeat(95), "라".repeat(40)]);
    expect(await readFile(join(repo, "documents/applications/fixes_engineer/self_intro.txt"), "utf8")).toContain("라".repeat(40));
  });

  test("a row whose date changes outside the web: answers show and can be revised, but the guess grants no right to replace the archive", async () => {
    const path = join(repo, "documents/applications/fixes_engineer/self_intro.txt");
    const before = await readFile(path, "utf8");
    const fixes = rows.find((r) => r.company === "Fixes")!;
    fixes.date = "2026-11-10";
    await saveRows();
    const mine = (await runs()).filter((r) => r.kind === "self-intro" && r.application?.company === "Fixes");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.application.date === "2026-11-09" && r.checks.row.date === "2026-11-10")).toBe(true);
    for (const r of mine) expect(JSON.parse(await readFile(join(repo, `.ajs/runs/${r.id}.json`), "utf8")).application.date).toBe("2026-11-09");
    const n = fakes.length;
    const revise = await call("/api/runs", { kind: "self-intro", application: { ...app("Fixes"), date: "2026-11-10" }, revise: { index: 1, feedback: "짧게" } });
    expect(revise.status).toBe(200);
    const f = await fakeFor(n);
    result(f, answers("마".repeat(93), "무시될 답"));
    const done = await until(() => runById(revise.body.id), (r) => r?.state === "succeeded", "revision after the move");
    expect(done.result.answers.map((a: any) => a.text)).toEqual(["마".repeat(93), "라".repeat(40)]);
    expect(done.artifact).toMatchObject({ written: false, reason: "owned_by_other" });
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await call(`/api/runs/${revise.body.id}/self-intro.txt`)).body).toContain("마".repeat(93));
    fixes.date = "2026-11-09";
    await saveRows();
  });

  test("an application submitted while its answers are written gets no further pass and no file", async () => {
    const n = fakes.length;
    const started = await start("Progress", [{ question: "Q", limit: 100 }]);
    const f = await fakeFor(n);
    rows.find((r) => r.company === "Progress")!.status = "applied";
    await saveRows();
    result(f, answers("가".repeat(150)));
    const failed = await until(() => runById(started.body.id), (r) => r?.state === "failed", "failure");
    expect(failed.error).toContain("이미 낸 지원");
    expect(f.inputs).toHaveLength(1);
    expect(await Bun.file(join(repo, "documents/applications/progress_engineer/self_intro.txt")).exists()).toBe(false);
  });

  test("a submitted application's failed run cannot be resumed", async () => {
    const res = await call("/api/runs/old-Submitted/resume", { decision: "retry" });
    expect(res.status).toBe(409);
    expect((await runById("old-Submitted")).state).toBe("failed");
  });

  test("two starts at once make one run", async () => {
    const both = await Promise.all([start("Concurrent", Q2), start("Concurrent", Q2)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await runs()).filter((r) => r.kind === "self-intro" && r.application?.company === "Concurrent" && r.state === "running")).toHaveLength(1);
  });

  test("an older failed run cannot be resumed while a newer one runs", async () => {
    expect((await start("Duplicate", Q2)).status).toBe(200);
    expect((await call("/api/runs/old-Duplicate/resume", { decision: "retry" })).status).toBe(409);
  });

  test("another application's archived answers are kept and this run's answers download from its record", async () => {
    const n = fakes.length;
    const started = await start("Again", [{ question: "Q", limit: 100 }]);
    const f = await fakeFor(n);
    result(f, answers("가".repeat(92)));
    const done = await until(() => runById(started.body.id), (r) => r?.state === "succeeded", "success");
    expect(done.artifact).toMatchObject({ written: false, reason: "owned_by_other" });
    expect(await readFile(join(repo, "documents/applications/again_engineer/self_intro.txt"), "utf8")).toBe("earlier submitted answers");
    const download = await call(`/api/runs/${started.body.id}/self-intro.txt`);
    expect(download.status).toBe(200);
    expect(download.body).toContain("가".repeat(92));
  });

  test("questions given with 지원서 만들기 start a follow-up for a draft and are skipped, with a reason, for a submitted one", async () => {
    await mkdir(join(repo, "cv"), { recursive: true });
    for (const [company, url] of [
      ["Follow", "https://x.io/follow"],
      ["Late", "https://x.io/late"],
    ] as const) {
      const n = fakes.length;
      const res = await call("/api/runs", { kind: "apply", params: { posting: url, selfIntro: [{ question: "지원 동기", limit: 100 }], selfIntroReplacesCover: true } });
      expect(res.status).toBe(200);
      const f = await fakeFor(n);
      expect(f.options.systemPrompt.append).toContain("leave cover_letter_file empty");
      await writeFile(join(repo, `cv/main_${company.toLowerCase()}.pdf`), "%PDF-1.7");
      result(f, { status: "done", company, role: "Engineer", summary_md: "ok" });
      const done = await until(() => runById(res.body.id), (r) => r?.state === "succeeded" && !!r.followUp, `the ${company} follow-up`);
      if (company === "Follow") {
        expect(done.followUp.state).toBe("started");
        const follow = await runById(done.followUp.runId);
        expect(follow).toMatchObject({ kind: "self-intro", state: "running", application: app("Follow") });
        expect(follow.params.replacesCoverLetter).toBe(true);
      } else {
        expect(done.followUp.state).toBe("skipped");
        expect(done.followUp.reason).toContain("이미 낸 지원");
      }
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
if (process.platform !== "linux") process.env.AJS_INSECURE_PATH_CHECKS = "1";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySystemAppend, parseApplyParams, parseApplyResult, resumeMessage, type ApplyParams } from "../src/server/results.ts";
import { INTERRUPTED, RunStore, serialized, boundRow, matchRow, missingEvidence, oneAtATime, reconcile, runRow, type ApplyRun } from "../src/server/runs.ts";

const HEADER = "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline";
const PARAMS: ApplyParams = { posting: "https://example.com/job/1", fitThreshold: 60, continueBelowThreshold: false, draftFormFields: false, acceptFlaggedPosting: false };

let repo: string;
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ajs-runs-"));
});

afterEach(() => rm(repo, { recursive: true, force: true }));

const run = (over: Partial<ApplyRun> = {}): ApplyRun => ({
  id: "r1",
  kind: "apply",
  title: "지원서 만들기",
  params: PARAMS,
  subject: {},
  sessionId: "s1",
  sdkSessionId: null,
  state: "running",
  startedAt: Date.now() - 60_000,
  ...over,
});

describe("apply run parameters", () => {
  test("defaults are conservative and unknown thresholds fall back to 60", () => {
    expect(parseApplyParams({ posting: " https://x.io/1 " })).toEqual({ ...PARAMS, posting: "https://x.io/1" });
    expect(parseApplyParams({ posting: "x", fitThreshold: 12, continueBelowThreshold: "yes" })).toMatchObject({ fitThreshold: 60, continueBelowThreshold: false });
    expect(parseApplyParams({ posting: "x", fitThreshold: 45, draftFormFields: true })).toMatchObject({ fitThreshold: 45, draftFormFields: true });
    expect(parseApplyParams({ posting: "  " })).toBeString();
  });

  test("the run instructions carry every parameter and the three never-assumed stops", () => {
    const text = applySystemAppend({ ...PARAMS, fitThreshold: 75, draftFormFields: true });
    expect(text).toContain("fit_threshold: 75");
    expect(text).toContain("draft_form_fields: true");
    for (const blocker of ["posting_flagged", "fit_below_threshold", "posting_unreachable"]) expect(text).toContain(blocker);
    expect(text).toContain("Never invent or assume a fact about the candidate");
    expect(resumeMessage("continue_below_threshold", { ...PARAMS, continueBelowThreshold: true })).toContain("continue_below_threshold: true");
  });
});

describe("apply results", () => {
  test("a valid payload is kept and trimmed to the shape the UI uses", () => {
    const r = parseApplyResult({
      status: "done",
      company: "Acme",
      role: "ML Engineer",
      fit_score: 82,
      files: { cv_pdf: "cv/main_acme.pdf", other: "x", cover_pdf: 3 },
      tailoring_points: ["RAG 운영 경험 강조", 7],
      assumptions: [{ topic: "언어", assumed: "국문", why: "국내 공고" }, { topic: "빈 값" }],
      summary_md: "완료",
    });
    expect(r).toEqual({
      status: "done",
      company: "Acme",
      role: "ML Engineer",
      fit_score: 82,
      files: { cv_pdf: "cv/main_acme.pdf" },
      tailoring_points: ["RAG 운영 경험 강조"],
      assumptions: [{ topic: "언어", assumed: "국문", why: "국내 공고" }],
      summary_md: "완료",
    });
  });

  test("malformed payloads and a blocked result without a blocker are rejected", () => {
    expect(parseApplyResult(null)).toBeNull();
    expect(parseApplyResult({ status: "done", company: "A", role: "B" })).toBeNull();
    expect(parseApplyResult({ status: "maybe", company: "A", role: "B", summary_md: "" })).toBeNull();
    expect(parseApplyResult({ status: "blocked", company: "A", role: "B", summary_md: "" })).toBeNull();
    expect(parseApplyResult({ status: "blocked", company: "A", role: "B", summary_md: "", blocker: { type: "nope", detail: "" } })).toBeNull();
    expect(parseApplyResult({ status: "blocked", company: "A", role: "B", summary_md: "", blocker: { type: "fit_below_threshold", detail: "42점" } })?.blocker).toEqual({
      type: "fit_below_threshold",
      detail: "42점",
    });
  });
});

describe("run reconciliation", () => {
  test("the tracker row is found by the posting URL and files are checked on disk, not trusted", async () => {
    await mkdir(join(repo, "cv"), { recursive: true });
    await writeFile(join(repo, "cv", "main_acme.typ"), "src");
    await writeFile(join(repo, "cv", "main_acme.pdf"), "%PDF-1.7 test");
    const old = new Date(Date.now() - 3_600_000);
    await writeFile(join(repo, "cv", "stale.pdf"), "old");
    await utimes(join(repo, "cv", "stale.pdf"), old, old);
    await writeFile(join(repo, "job_search_tracker.csv"), `${HEADER}\n${TODAY},Acme,,ML Engineer,,portal,drafted,,82,,cv/main_acme.typ,,https://example.com/job/1,\n`);
    const checks = await reconcile(
      run({ result: { status: "done", company: "Other", role: "Other", summary_md: "", files: { cover_pdf: "cover_letters/missing.pdf", form_fields: "cv/stale.pdf", posting: "../outside.md" } } }),
      repo,
    );
    expect(checks.row).toEqual({ date: TODAY, company: "Acme", role: "ML Engineer", status: "drafted", fit_rating: "82" });
    const byLabel = Object.fromEntries(checks.files.map((f) => [f.label, f]));
    expect(byLabel["이력서 PDF"]).toMatchObject({ path: "cv/main_acme.pdf", exists: true, fresh: true });
    expect(byLabel["커버레터 PDF"]).toMatchObject({ exists: false });
    expect(byLabel["지원서 입력 칸 초안"]).toMatchObject({ exists: true, fresh: false });
    expect(byLabel["공고 원문"]).toMatchObject({ exists: false });
  });

  test("a source file claimed as the CV PDF does not count as one", async () => {
    await mkdir(join(repo, "cv"), { recursive: true });
    await writeFile(join(repo, "cv", "main_acme.typ"), "#set page()");
    await writeFile(join(repo, "cv", "fake.pdf"), "not a pdf");
    await writeFile(join(repo, "job_search_tracker.csv"), `${HEADER}\n${TODAY},Acme,,ML Engineer,,portal,drafted,,82,,,,https://example.com/job/1,\n`);
    for (const claim of ["cv/main_acme.typ", "cv/fake.pdf"]) {
      const checks = await reconcile(run({ result: { status: "done", company: "Acme", role: "ML Engineer", summary_md: "", files: { cv_pdf: claim } } }), repo);
      expect(checks.files.find((f) => f.key === "cv_pdf")?.exists).toBe(false);
      expect(missingEvidence(checks)).toBeString();
    }
  });

  test("without a URL the row is matched by the result's company and role", async () => {
    await writeFile(join(repo, "job_search_tracker.csv"), `${HEADER}\n${TODAY},acme,,ml engineer,,,drafted,,70,,,,,\n`);
    const checks = await reconcile(run({ params: { ...PARAMS, posting: "pasted posting text" }, result: { status: "done", company: "Acme", role: "ML Engineer", summary_md: "" } }), repo);
    expect(checks.row?.fit_rating).toBe("70");
  });
});

describe("binding a run to its application", () => {
  const URL = "https://example.com/job/1";
  const row = (date: string, status: string, source = URL, company = "Acme", role = "Engineer") => ({ date, company, role, status, source });

  test("a redraft of an older open application binds to it", () => {
    expect(matchRow(run(), [row("2026-11-01", "applied")])?.date).toBe("2026-11-01");
  });

  test("the open row wins over an earlier closed application to the same role", () => {
    expect(matchRow(run(), [row("2026-01-10", "rejected"), row("2026-11-12", "drafted")])?.date).toBe("2026-11-12");
  });

  test("a row with the posting URL wins over one that only shares the name", () => {
    const rows = [row("2026-11-09", "drafted", "https://other.example/2"), row("2026-11-10", "drafted")];
    const named = run({ result: { status: "done", company: "Acme", role: "Engineer", summary_md: "" } });
    expect(matchRow(named, rows)?.date).toBe("2026-11-10");
    expect(matchRow(named, [row("2026-11-09", "drafted", "https://careers.acme.example/9")])?.date).toBe("2026-11-09");
  });

  test("two open matches are ambiguous and bind nothing", () => {
    expect(matchRow(run(), [row("2026-11-01", "applied"), row("2026-11-02", "drafted")])).toBeNull();
  });

  test("a bound run keeps its row after it closes and a newer application appears", () => {
    const rows = [row("2026-01-10", "rejected"), row("2026-11-12", "drafted")];
    expect(runRow(run({ application: { date: "2026-01-10", company: "acme", role: "engineer" } }), rows)?.date).toBe("2026-01-10");
    expect(runRow(run({ application: { date: "2026-11-12", company: "Acme", role: "Engineer" } }), rows)?.date).toBe("2026-11-12");
  });

  test("a bound row whose date moved outside the web is the single later row", () => {
    const app = { date: "2026-11-01", company: "Acme", role: "Engineer" };
    expect(boundRow(app, [row("2026-11-05", "applied")])?.date).toBe("2026-11-05");
    expect(boundRow(app, [row("2026-11-05", "applied"), row("2026-11-07", "drafted")])).toBeNull();
  });

  test("an ambiguous exact binding never falls through to a later application", () => {
    const app = { date: "2026-11-01", company: "Acme", role: "Engineer" };
    expect(boundRow(app, [row("2026-11-01", "rejected"), row("2026-11-01", "withdrawn"), row("2026-11-09", "drafted")])).toBeNull();
    expect(runRow(run({ application: app }), [row("2026-11-01", "rejected"), row("2026-11-01", "withdrawn"), row("2026-11-09", "drafted")])).toBeNull();
  });

  test("the store moves a binding when the web changes the row's date", async () => {
    const store = new RunStore(join(repo, ".ajs", "runs"));
    await store.save(run({ id: "a", application: { date: "2026-11-01", company: "Acme", role: "Engineer" } }));
    await store.save(run({ id: "b", application: { date: "2026-10-01", company: "Acme", role: "Engineer" } }));
    await store.rebind({ date: "2026-11-01", company: "acme", role: "engineer" }, { date: "2026-11-09", company: "Acme", role: "Engineer" });
    expect(store.get("a")?.application?.date).toBe("2026-11-09");
    expect(store.get("b")?.application?.date).toBe("2026-10-01");
  });
});

describe("finished-run evidence", () => {
  const file = (key: string, exists: boolean, fresh: boolean) => ({ key, label: key, path: `cv/${key}.pdf`, exists, fresh });
  const row = { date: "2026-11-09", company: "A", role: "B", status: "drafted", fit_rating: "70" };

  test("done needs the tracker row and a CV PDF written during the run", () => {
    expect(missingEvidence({ row, files: [file("cv_pdf", true, true)] })).toBeNull();
    expect(missingEvidence({ row: null, files: [file("cv_pdf", true, true)] })).toBeString();
    expect(missingEvidence({ row, files: [] })).toBeString();
    expect(missingEvidence({ row, files: [file("cv_pdf", true, false)] })).toBeString();
    expect(missingEvidence({ row, files: [file("cv_pdf", true, true), file("cover_pdf", false, false)] })).toBeNull();
  });
});

describe("per-application turns", () => {
  test("work for one key runs in order, a failure does not block the next, other keys run alongside", async () => {
    const turn = serialized();
    const log: string[] = [];
    let release!: () => void;
    const first = turn("a", () => new Promise<void>((r) => (release = r)).then(() => void log.push("a1")));
    const failing = turn("a", async () => {
      log.push("a2");
      throw new Error("boom");
    });
    const third = turn("a", async () => void log.push("a3"));
    await turn("b", async () => void log.push("b1"));
    expect(log).toEqual(["b1"]);
    release();
    await first;
    await expect(failing).rejects.toThrow("boom");
    await third;
    expect(log).toEqual(["b1", "a1", "a2", "a3"]);
  });
});

describe("one action per run at a time", () => {
  test("a second call while the first is in flight gets busy, and the key frees afterwards", async () => {
    const turn = oneAtATime(() => "busy");
    let release!: () => void;
    const first = turn("r1", () => new Promise<string>((r) => (release = () => r("first"))));
    expect(await turn("r1", async () => "second")).toBe("busy");
    expect(await turn("r2", async () => "other run")).toBe("other run");
    release();
    expect(await first).toBe("first");
    expect(await turn("r1", async () => "again")).toBe("again");
  });
});

describe("run store", () => {
  test("records survive a restart, and one left running is marked interrupted", async () => {
    const dir = join(repo, ".ajs", "runs");
    const store = new RunStore(dir);
    await store.save(run({ id: "a1", state: "running" }));
    await store.save(run({ id: "b2", state: "succeeded", sessionId: null }));
    await writeFile(join(dir, "junk.json"), "{not json");
    await writeFile(join(dir, "evil.json"), JSON.stringify(run({ id: "../x" })));

    const after = new RunStore(dir);
    await after.load(async () => ({ row: null, files: [] }));
    expect(after.list().map((r) => r.id).sort()).toEqual(["a1", "b2"]);
    expect(after.get("a1")).toMatchObject({ state: "failed", error: INTERRUPTED, sessionId: null });
    expect(after.get("b2")?.state).toBe("succeeded");
    expect(JSON.parse(await readFile(join(dir, "a1.json"), "utf8")).state).toBe("failed");
    expect(after.get("../x")).toBeUndefined();
    expect(after.bySession("s1")).toBeUndefined();
  });
});

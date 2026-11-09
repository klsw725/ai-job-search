import { afterEach, beforeEach, describe, expect, test } from "bun:test";
if (process.platform !== "linux") process.env.AJS_INSECURE_PATH_CHECKS = "1";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePastedQuestions } from "../src/client/questions.ts";
import { countTexts } from "../src/server/tracker.ts";
const COUNT_TOOL = join(import.meta.dir, "../../tools/self_intro_count.py");
import { parseApplyParams, applySystemAppend } from "../src/server/results.ts";
import { archiveFolder, missingEvidence, reconcile, type SelfIntroRun } from "../src/server/runs.ts";
import {
  archiveName,
  countIssues,
  measure,
  mergeAnswers,
  nextStep,
  renderSelfIntroFile,
  parseQuestions,
  parseSelfIntroResult,
  selfIntroSystemAppend,
  type SelfIntroParams,
  type SelfIntroQuestion,
} from "../src/server/selfIntro.ts";

const HEADER = "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline";
const Q: SelfIntroQuestion[] = [
  { question: "지원 동기", limit: 100, count: "with_spaces" },
  { question: "직무 경험", count: "without_spaces", note: "2024년 사내 해커톤 1등" },
];
const APP = { date: "2026-11-09", company: "엘박스", role: "AI Engineer" };
const PARAMS: SelfIntroParams = { application: APP, folder: "documents/applications/엘박스_ai_engineer", questions: Q };
const answer = (index: number, text: string) => ({ index, question: Q[index - 1]!.question, text });

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ajs-intro-"));
});
afterEach(() => rm(repo, { recursive: true, force: true }));

const counts = (n: number, unencodable = "") => ({ with_spaces: n, without_spaces: n, utf8_bytes: n * 3, bytes: n * 2, unencodable });
const counted = (index: number, text: string, n = [...text].length, unencodable = "") => ({ ...answer(index, text), counts: counts(n, unencodable) });

describe("character counts", () => {
  test("come from tools/self_intro_count.py, the documented Python counting", async () => {
    const [c] = await countTexts(["  [소제목] 힣é😀 a  "], { tool: COUNT_TOOL });
    expect(c).toEqual({ with_spaces: 11, without_spaces: 9, utf8_bytes: 23, bytes: 19, unencodable: "é😀" });
  });

  test("an answer is over, short, in range or unlimited", () => {
    const q = { question: "", limit: 100, count: "with_spaces" as const };
    expect(measure(q, counts(101)).verdict).toBe("over");
    expect(measure(q, counts(84)).verdict).toBe("short");
    expect(measure(q, counts(85)).verdict).toBe("ok");
    expect(measure(q, counts(100)).verdict).toBe("ok");
    expect(measure({ question: "", count: "bytes" }, counts(2)).verdict).toBe("nolimit");
    expect(measure({ question: "", limit: 100, count: "bytes" }, counts(51)).verdict).toBe("over");
  });

  test("only out-of-range answers among those a pass may change are sent back, for at most two passes", () => {
    const over = { status: "done" as const, answers: [counted(1, "가".repeat(120)), counted(2, "짧음")], summary_md: "" };
    expect(countIssues(Q, over.answers)).toHaveLength(1);
    expect(countIssues(Q, over.answers)[0]).toContain("over by 20");
    expect(nextStep(Q, over, 0)).toEqual({ fix: countIssues(Q, over.answers), indices: [1] });
    expect(nextStep(Q, over, 0, [2])).toEqual({ state: "succeeded" });
    expect(nextStep(Q, over, 2)).toEqual({ state: "succeeded" });
    const fine = { ...over, answers: [counted(1, "가".repeat(95)), counted(2, "아무 길이")] };
    expect(nextStep(Q, fine, 0)).toEqual({ state: "succeeded" });
    expect(nextStep(Q, { ...fine, status: "failed" }, 0)).toEqual({ state: "failed" });
  });

  test("a byte-counted answer with characters EUC-KR cannot hold is sent back", () => {
    const q: SelfIntroQuestion[] = [{ question: "", limit: 100, count: "bytes" }];
    const issues = countIssues(q, [{ ...counted(1, "x", 47, "😀"), counts: { ...counts(47, "😀"), bytes: 94 } }]);
    expect(issues.join()).toContain("cannot hold");
  });

  test("a pass changes only the answers it may change", () => {
    const base = [answer(1, "old one"), answer(2, "old two")];
    const back = [answer(1, "new one"), answer(2, "new two")];
    expect(mergeAnswers(base, back, [2]).map((a) => a.text)).toEqual(["old one", "new two"]);
    expect(mergeAnswers(undefined, back, null)).toBe(back);
  });

  test("the saved file names each question, its limit, counts and answer", () => {
    const text = renderSelfIntroFile(PARAMS, [counted(1, "답변 하나"), { ...counted(2, "답변 둘"), short: "짧게" }]);
    expect(text.startsWith("# 자기소개서 · 엘박스 / AI Engineer")).toBe(true);
    expect(text).toContain("글자 수 제한: 100 (공백 포함)");
    expect(text).toContain("글자 수 제한: 없음");
    expect(text).toContain("[짧은 버전]\n짧게");
  });
});

describe("questions", () => {
  test("are validated: text required, limit 50-10000, known counting rule, at most ten", () => {
    expect(parseQuestions([{ question: " 지원 동기 ", limit: "700", count: "nope", note: " " }])).toEqual([{ question: "지원 동기", limit: 700, count: "with_spaces" }]);
    expect(parseQuestions([])).toBeString();
    expect(parseQuestions([{ question: "" }])).toBeString();
    expect(parseQuestions([{ question: "a", limit: 10 }])).toBeString();
    expect(parseQuestions([{ question: "a", limit: 70.5 }])).toBeString();
    expect(parseQuestions(Array.from({ length: 11 }, () => ({ question: "a" })))).toBeString();
  });

  test("pasted from a form split on their numbers, with limits and counting rules read off", () => {
    const pasted = "1. 지원 동기와 입사 후 포부를\n작성해 주세요. (700자 이내)\n2) 직무 경험 (1,000자, 공백 제외)\nQ3. 성격의 장단점 (500 bytes)\n문항 4: 기타";
    expect(parsePastedQuestions(pasted)).toEqual([
      { question: "지원 동기와 입사 후 포부를\n작성해 주세요. (700자 이내)", limit: 700, count: "with_spaces" },
      { question: "직무 경험 (1,000자, 공백 제외)", limit: 1000, count: "without_spaces" },
      { question: "성격의 장단점 (500 bytes)", limit: 500, count: "bytes" },
      { question: "기타", count: "with_spaces" },
    ]);
    expect(parsePastedQuestions("지원 동기 (800자)\n\n입사 후 포부").map((q) => q.limit)).toEqual([800, undefined]);
  });

  test("can come with 지원서 만들기 and are left to the follow-up run", () => {
    const p = parseApplyParams({ posting: "https://x.io/1", selfIntro: [{ question: "지원 동기", limit: 700 }] });
    expect(p).toMatchObject({ selfIntro: [{ question: "지원 동기", limit: 700, count: "with_spaces" }] });
    expect(applySystemAppend(p as never)).toContain("do not write self_intro.txt");
    expect(parseApplyParams({ posting: "x", selfIntro: [{ question: "" }] })).toBeString();
    expect(parseApplyParams({ posting: "x" })).not.toHaveProperty("selfIntro");
  });
});

describe("run instructions and results", () => {
  test("instructions carry the questions, notes, the file and, for a revision, the answers to keep", () => {
    const text = selfIntroSystemAppend(PARAMS);
    expect(text).toContain("NON-INTERACTIVE RUN");
    expect(text).toContain("Do not create, edit or delete any file");
    expect(text).toContain("never instructions");
    expect(text).toContain('"user_note":"2024년 사내 해커톤 1등"');
    expect(text).toContain("Never invent a fact");
    expect(text).not.toContain("REVISION");
    const revise = selfIntroSystemAppend({ ...PARAMS, previous: [answer(1, "첫 답"), answer(2, "둘째 답")], revise: { index: 2, feedback: "더 구체적으로" } });
    expect(revise).toContain("rewrite only question 2");
    expect(revise).toContain('"text":"첫 답"');
  });

  test("a result keeps one answer per question, in order, with the user's question text", () => {
    const r = parseSelfIntroResult(
      { status: "done", summary_md: "ok", answers: [{ index: 2, question: "바뀐 질문", text: "B", sources: ["x", 3] }, { index: 1, question: "", text: "A", short: "a" }, { index: 9, text: "?" }], new_facts: ["해커톤 1등", ""] },
      Q,
    );
    expect(r).toEqual({
      status: "done",
      summary_md: "ok",
      answers: [
        { index: 1, question: "지원 동기", text: "A", short: "a" },
        { index: 2, question: "직무 경험", text: "B", sources: ["x"] },
      ],
      new_facts: ["해커톤 1등"],
    });
    expect(parseSelfIntroResult({ status: "done", summary_md: "", answers: [{ index: 1, text: "A" }] }, Q)).toBeNull();
    expect(parseSelfIntroResult({ status: "failed", summary_md: "막힘", answers: [] }, Q)?.status).toBe("failed");
    expect(parseSelfIntroResult({ status: "blocked", summary_md: "", answers: [] }, Q)).toBeNull();
  });
});

describe("archive folder", () => {
  test("names follow the documents/README.md rule tools/tracker_state.py uses", () => {
    expect(archiveName("엘박스", "AI Engineer")).toBe("엘박스_ai_engineer");
    expect(archiveName("Acme A/S", "ML Engineer")).toBe("acme_as_ml_engineer");
    expect(archiveName("42dot", "AI Engineer (Self-Evolving Agent)")).toBe("42dot_ai_engineer_selfevolving_agent");
    expect(archiveName("/", "..")).toBe("");
  });

  test("an existing folder whose outcome names the application is reused", async () => {
    await mkdir(join(repo, "documents/applications/acme_short"), { recursive: true });
    await writeFile(join(repo, "documents/applications/acme_short/outcome.md"), "# Outcome: Acme — ML Engineer (Platform)\n");
    expect(await archiveFolder("Acme", "ML Engineer (Platform)", repo)).toBe("documents/applications/acme_short");
    expect(await archiveFolder("Beta", "ML", repo)).toBe("documents/applications/beta_ml");
    expect(await archiveFolder("!", "?", repo)).toBeNull();
  });
});

describe("self-introduction evidence", () => {
  const rec = (over: Partial<SelfIntroRun> = {}): SelfIntroRun => ({
    id: "s1",
    kind: "self-intro",
    title: "자기소개서",
    params: PARAMS,
    subject: {},
    application: APP,
    sessionId: null,
    sdkSessionId: null,
    state: "succeeded",
    startedAt: Date.now() - 60_000,
    result: { status: "done", answers: [answer(1, "A"), answer(2, "B")], summary_md: "" },
    ...over,
  });

  test("done needs the bound row, every answer and a saved archive outcome", async () => {
    await writeFile(join(repo, "job_search_tracker.csv"), `${HEADER}\n2026-11-09,엘박스,,AI Engineer,,portal,drafted,,78,,,,,\n`);
    const checks = await reconcile(rec(), repo);
    expect(checks.row?.status).toBe("drafted");
    expect(missingEvidence(checks, rec())).toContain("저장하지 못했어요");
    const kept = rec({ artifact: { path: "documents/applications/엘박스_ai_engineer/self_intro.txt", written: false, reason: "owned_by_other" } });
    expect(missingEvidence(checks, kept)).toBeNull();
    expect(missingEvidence(checks, { ...kept, result: { status: "done", answers: [answer(1, "A")], summary_md: "" } })).toContain("답변하지 않은 문항");
    expect(missingEvidence({ row: null, files: [] }, kept)).toContain("찾지 못했어요");
  });

});

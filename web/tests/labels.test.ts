import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "../src/server/agent.ts";
import { commandLabel, describePath, describePermission, describeTool, objectParticle, pathOutsideRepo } from "../src/client/labels.ts";
import { currentActivity, lastReply, progressOf, sessionOutputs } from "../src/client/progress.ts";

const tool = (id: string, name: string, input: unknown, sub = false): ChatEvent => ({
  kind: "assistant",
  text: "",
  tools: [{ id, name, input: JSON.stringify(input, null, 2) }],
  sub,
});
const done = (id: string, text = "ok"): ChatEvent => ({ kind: "tool_result", toolUseId: id, text, isError: false });

describe("labels", () => {
  test("commands get user-facing names", () => {
    expect(commandLabel("/apply https://example.com/job")).toBe("지원서 만들기");
    expect(commandLabel("/outcome followup 토스 백엔드")).toBe("후속 연락 메일 쓰기");
    expect(commandLabel("/unknown")).toBeNull();
    expect(commandLabel("그냥 질문")).toBeNull();
  });

  test("tool calls are described in words", () => {
    expect(describeTool("WebFetch", JSON.stringify({ url: "https://www.wanted.co.kr/wd/1" }))).toBe("wanted.co.kr 페이지 읽기");
    expect(describeTool("Write", JSON.stringify({ file_path: "/workspace/cv/main_toss_backend.typ" }))).toBe("이력서 초안 작성");
    expect(describeTool("Bash", JSON.stringify({ command: "python3 tools/verify_pdf.py cv/a.pdf" }))).toBe("PDF 레이아웃 검사");
    expect(describeTool("Bash", JSON.stringify({ command: "bun .agents/skills/linkedin-search/cli/src/cli.ts search" }))).toBe("LinkedIn 공고 검색");
  });

  test("a clipped input that is not valid JSON still yields a description", () => {
    const clipped = `{\n  "file_path": "/workspace/cover_letters/cover_a.typ",\n  "content": "Dear hiring`;
    expect(describeTool("Write", clipped)).toBe("커버레터 초안 작성");
  });

  test("paths map to what they are", () => {
    expect(describePath("job_search_tracker.csv")).toBe("지원 기록");
    expect(describePath("/workspace/cv/main_a.pdf")).toBe("이력서 PDF");
    expect(describePath("documents/cv/resume.pdf")).toBe("올린 이력서");
  });

  test("a Bash permission keeps the exact command visible", () => {
    const p = describePermission("Bash", JSON.stringify({ command: "rm -rf build && make" }));
    expect(p.risk).toBe("high");
    expect(p.shown).toEqual([{ label: "명령", text: "rm -rf build && make" }]);
  });

  test("a WebFetch permission shows the whole URL, not just the host", () => {
    const url = "https://jobs.example.com/collect?profile=secret";
    const p = describePermission("WebFetch", JSON.stringify({ url, prompt: "summarise" }));
    expect(p.title).toContain("jobs.example.com");
    expect(p.shown).toEqual([{ label: "주소", text: url }]);
  });

  test("a write shows its exact path and the content that replaces the file", () => {
    const p = describePermission("Write", JSON.stringify({ file_path: "/repo/cv/main_a.typ", content: "= 이력서\n내용" }), "/repo");
    expect(p.title).toContain("이력서 초안");
    expect(p.shown.map((f) => f.text)).toEqual(["/repo/cv/main_a.typ", "= 이력서\n내용"]);
    expect(p.warning).toBeUndefined();
    const edit = describePermission("Edit", JSON.stringify({ file_path: "/repo/cv/a.typ", old_string: "옛", new_string: "새" }), "/repo");
    expect(edit.shown.map((f) => f.text)).toEqual(["/repo/cv/a.typ", "옛", "새"]);
  });

  test("a path that escapes the repo never gets a reassuring label", () => {
    for (const file_path of ["/repo/cv/../.claude/settings.json", "/tmp/cv/payload.sh", "cv/../../etc/passwd"]) {
      const p = describePermission("Write", JSON.stringify({ file_path, content: "x" }), "/repo");
      expect(p.title).not.toContain("이력서");
      expect(p.risk).toBe("high");
      expect(p.warning).toBeDefined();
      expect(p.shown[0]).toEqual({ label: "파일", text: file_path });
    }
    expect(pathOutsideRepo("/repo/cv/a.typ", "/repo")).toBe(false);
    expect(pathOutsideRepo("/repository/cv/a.typ", "/repo")).toBe(true);
  });

  test("MultiEdit and NotebookEdit show the fields that decide what changes", () => {
    const multi = describePermission(
      "MultiEdit",
      JSON.stringify({ file_path: "/repo/cv/a.typ", edits: [{ old_string: "A", new_string: "B", replace_all: true }] }),
      "/repo",
    );
    expect(multi.shown[1]!.label).toContain("모든 곳");
    const del = describePermission("NotebookEdit", JSON.stringify({ notebook_path: "/repo/reports/n.ipynb", cell_id: "c7", edit_mode: "delete", new_source: "" }), "/repo");
    expect(del.title).toContain("셀 삭제");
    expect(del.risk).toBe("high");
    expect(del.shown.map((f) => f.text)).toContain("c7");
  });

  test("before the repo root is known an absolute path gets a neutral name", () => {
    const p = describePermission("Write", JSON.stringify({ file_path: "/tmp/cv/payload.sh", content: "x" }), null);
    expect(p.title).not.toContain("이력서");
    expect(p.shown[0]!.text).toBe("/tmp/cv/payload.sh");
  });

  test("an input that cannot be parsed is shown raw and treated as high risk", () => {
    const p = describePermission("Write", '{"file_path": "/repo/cv/a.typ", "content": "unterminated');
    expect(p.risk).toBe("high");
    expect(p.shown[0]!.label).toBe("입력");
  });

  test("object particle follows the final syllable", () => {
    expect(objectParticle("이력서")).toBe("를");
    expect(objectParticle("지원 기록")).toBe("을");
    expect(objectParticle("PDF")).toBe("을(를)");
  });
});

describe("task outputs", () => {
  const write = (id: string, path: string): ChatEvent => ({
    kind: "assistant",
    text: "",
    // A long write arrives clipped: the input is not valid JSON, only `path` is reliable.
    tools: [{ id, name: "Write", input: `{"file_path": "${path}", "content": "…`, path }],
    sub: false,
  });
  const since = 10_000;

  test("a long, clipped write still yields its compiled PDF", () => {
    const events = [write("w", "/repo/cv/main_a.typ"), done("w")];
    const files = [{ path: "cv/main_a.typ", mtime: 11_000 }, { path: "cv/main_a.pdf", mtime: 12_000 }];
    expect(sessionOutputs(events, files, since, "/repo")).toEqual([["cv/main_a.pdf", "이력서 PDF"]]);
  });

  test("old, failed, outside-repo and stale outputs are not claimed", () => {
    const files = [
      { path: "cv/old.pdf", mtime: 1_000 },
      { path: "cv/old.typ", mtime: 11_000 },
      { path: "cv/stale.typ", mtime: 30_000 },
      { path: "cv/stale.pdf", mtime: 12_000 },
      { path: "cv/a.pdf", mtime: 12_000 },
      { path: "cv/denied.pdf", mtime: 12_000 },
    ];
    const events: ChatEvent[] = [
      write("old", "/repo/cv/old.typ"),
      done("old"),
      write("stale", "/repo/cv/stale.typ"),
      done("stale"),
      write("tmp", "/tmp/cv/a.typ"),
      done("tmp"),
      write("denied", "/repo/cv/denied.typ"),
      { kind: "tool_result", toolUseId: "denied", text: "denied", isError: true },
    ];
    expect(sessionOutputs(events, files, since, "/repo")).toEqual([]);
  });
});

describe("progress", () => {
  test("the latest TodoWrite list is the checklist, sub-agent lists are ignored", () => {
    const events: ChatEvent[] = [
      tool("t1", "TodoWrite", { todos: [{ content: "적합도 평가", status: "in_progress", activeForm: "적합도 평가 중" }, { content: "이력서 초안 작성", status: "pending" }] }),
      tool("t2", "TodoWrite", { todos: [{ content: "다른 목록", status: "pending" }] }, true),
      tool("t3", "TodoWrite", { todos: [{ content: "적합도 평가", status: "completed" }, { content: "이력서 초안 작성", status: "in_progress", activeForm: "이력서 초안 작성 중" }] }),
    ];
    expect(progressOf(events)).toEqual([
      { text: "적합도 평가", status: "completed" },
      { text: "이력서 초안 작성 중", status: "in_progress" },
    ]);
  });

  test("TaskCreate/TaskUpdate build the same checklist", () => {
    const events: ChatEvent[] = [
      tool("c1", "TaskCreate", { subject: "적합도 평가" }),
      done("c1", "Task #1 created successfully: 적합도 평가"),
      tool("c2", "TaskCreate", { subject: "PDF 만들기" }),
      done("c2", "Task #2 created successfully: PDF 만들기"),
      tool("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
      tool("u2", "TaskUpdate", { taskId: "2", status: "in_progress" }),
    ];
    expect(progressOf(events)).toEqual([
      { text: "적합도 평가", status: "completed" },
      { text: "PDF 만들기", status: "in_progress" },
    ]);
  });

  test("a failed or unrecognised TaskCreate never claims an id that updates could hit", () => {
    const events: ChatEvent[] = [
      tool("c1", "TaskCreate", { subject: "실패한 단계" }),
      { kind: "tool_result", toolUseId: "c1", text: "Error: limit 3 reached", isError: true },
      tool("c2", "TaskCreate", { subject: "다른 형식" }),
      done("c2", "created item 7"),
      tool("c3", "TaskCreate", { subject: "진행 중인 생성" }),
      tool("u1", "TaskUpdate", { taskId: "3", status: "completed" }),
      tool("u2", "TaskUpdate", { taskId: "7", status: "completed" }),
    ];
    expect(progressOf(events)).toEqual([
      { text: "다른 형식", status: "pending" },
      { text: "진행 중인 생성", status: "pending" },
    ]);
  });

  test("a failed TodoWrite does not replace the checklist", () => {
    const events: ChatEvent[] = [
      tool("t1", "TodoWrite", { todos: [{ content: "적합도 평가", status: "in_progress" }] }),
      done("t1"),
      tool("t2", "TodoWrite", { todos: [{ content: "잘못된 목록", status: "completed" }] }),
      { kind: "tool_result", toolUseId: "t2", text: "InputValidationError", isError: true },
    ];
    expect(progressOf(events)).toEqual([{ text: "적합도 평가", status: "in_progress" }]);
  });

  test("current activity is the newest unfinished tool call, and the reply resets on a new user turn", () => {
    const events: ChatEvent[] = [
      tool("a", "WebFetch", { url: "https://careers.toss.im/job" }),
      done("a"),
      { kind: "assistant", text: "평가를 마쳤어요", tools: [], sub: false },
      tool("b", "Bash", { command: "typst compile cv/main.typ" }),
    ];
    const results = new Map(events.flatMap((e) => (e.kind === "tool_result" ? [[e.toolUseId, e] as const] : [])));
    expect(currentActivity(events, results)).toBe("PDF 만들기");
    expect(lastReply(events)).toBe("평가를 마쳤어요");
    expect(lastReply([...events, { kind: "user", text: "더 짧게" }])).toBe("");
  });
});

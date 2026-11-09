import { describe, expect, test } from "bun:test";
import { keyFacts, markFenced, pendingItems, plainCommands, profileView, sectionTitle, splitSections } from "../src/client/profile.ts";

const SAMPLE = `# Candidate Profile (summary)

<!-- Written by /setup. -->

## Identity
- **Name:** 홍길동 (영문 표기: 미확인 - 여권 표기 확인 필요)
- **Location:** Seoul, South Korea
- **Languages:**
  | Language | Level |
  |----------|-------|
  | 한국어 (Korean) | 미확인 - /setup 후속 질문에서 확인 필요 |
  | 영어 (English) | 기초 회화 |
- **희망 연봉:** 6,000만원 이상 / **현재 연봉:** 4,700만원
- **LinkedIn headline:** (미입력)

## Behavioral Profile
- **근거 중심 검증** - 검증 단계를 분리함 *[이력서에서 추론 - 검토 필요]*

\`\`\`
## not a heading inside a fence
\`\`\`

## Growth Areas (frame positively in applications)
- 미확인
`;

describe("profile view", () => {
  test("sections split on ## outside fences, with Korean titles", () => {
    const s = splitSections(SAMPLE);
    expect(s.map((x) => x.title)).toEqual(["기본 정보", "일하는 방식", "성장할 부분"]);
    expect(s[1]!.body).toContain("## not a heading inside a fence");
    expect(s.some((x) => x.body.includes("Written by"))).toBe(false);
  });

  test("text before the first ## becomes an untitled section", () => {
    expect(splitSections("# Title\n\nintro line\n\n## Awards\n- x")).toEqual([
      { heading: "", title: "", body: "intro line" },
      { heading: "Awards", title: "수상", body: "- x" },
    ]);
  });

  test("headings map regardless of numbering and trailing notes", () => {
    expect(sectionTitle("1. Technical Skills Match")).toBe("기술 적합도");
    expect(sectionTitle("Installed portal CLIs (primary for `/scrape`)")).toBe("채용 사이트 연결");
    expect(sectionTitle("Something New")).toBe("Something New");
  });

  test("key facts come from the Identity bullets with values", () => {
    expect(keyFacts(SAMPLE)).toEqual([
      { label: "이름", value: "홍길동 (영문 표기: 미확인 - 여권 표기 확인 필요)" },
      { label: "지역", value: "Seoul, South Korea" },
      { label: "희망 연봉", value: "6,000만원 이상 / 현재 연봉: 4,700만원" },
      { label: "LinkedIn 한 줄 소개", value: "(미입력)" },
    ]);
  });

  test("unconfirmed items are collected from bullets and table rows", () => {
    expect(pendingItems(SAMPLE)).toEqual([
      { label: "이름", value: "홍길동 (영문 표기: 미확인 - 여권 표기 확인 필요)" },
      { label: "한국어 (Korean)", value: "미확인 - '프로필 만들기' 후속 질문에서 확인 필요" },
      { label: "LinkedIn 한 줄 소개", value: "(미입력)" },
      { label: "근거 중심 검증", value: "검증 단계를 분리함 [이력서에서 추론 - 검토 필요]" },
      { label: "", value: "미확인" },
    ]);
  });

  test("only known slash commands become plain words", () => {
    expect(plainCommands("/setup 후속 질문")).toBe("'프로필 만들기' 후속 질문");
    expect(plainCommands("(`/scrape` 우선)")).toBe("(`'새 공고 찾기'` 우선)");
    expect(plainCommands("documents/profile/a.md 와 /usr/bin")).toBe("documents/profile/a.md 와 /usr/bin");
    expect(plainCommands("/unknown 명령")).toBe("/unknown 명령");
  });

  test("URLs and paths that contain a command name are left alone", () => {
    for (const text of [
      "https://example.com/setup 참고",
      "https://example.com/apply/123",
      "[링크](https://x.io/scrape)",
      "./setup.sh 실행",
      "/setup/notes.md 파일",
      "/apply.md 참고",
    ]) {
      expect(plainCommands(text)).toBe(text);
    }
  });

  test("a fence closes only on the same character, at least as long, with nothing after", () => {
    const md = ["````md", "```", "## inside", "```", "````", "~~~", "```", "~~~~", "## after"].join("\n");
    expect(markFenced(md).map((l) => l.fenced)).toEqual([true, true, true, true, true, true, true, true, false]);
    expect(splitSections(md).map((s) => s.heading)).toEqual(["", "after"]);
  });

  test("fenced examples never become facts or pending items", () => {
    const md = ["## Identity", "- **Location:** Seoul", "````", "```", "- **Name:** 미확인", "```", "- **Market:** 예시", "````", "- **Status:** 재직 중"].join("\n");
    expect(keyFacts(md)).toEqual([
      { label: "지역", value: "Seoul" },
      { label: "현재 상태", value: "재직 중" },
    ]);
    expect(pendingItems(md)).toEqual([]);
  });

  test("an unfinished summary does not hide the other profile files", () => {
    expect(profileView(null)).toEqual({ setupPrompt: false, files: false });
    expect(profileView({ configured: false, files: [{ exists: false }, { exists: true }] })).toEqual({ setupPrompt: true, files: true });
    expect(profileView({ configured: false, files: [{ exists: false }] })).toEqual({ setupPrompt: true, files: false });
    expect(profileView({ configured: true, files: [{ exists: true }] })).toEqual({ setupPrompt: false, files: true });
  });
});

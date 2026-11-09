// Display-only reading of the profile markdown /setup writes; the files stay the source of truth.

import { COMMAND_LABEL } from "./labels.ts";

export type Section = { heading: string; title: string; body: string };
export type Fact = { label: string; value: string };

const SECTION_TITLE: Record<string, string> = {
  identity: "기본 정보",
  education: "학력",
  "professional experience": "경력",
  "independent projects": "개인 프로젝트",
  "technical skills": "기술",
  certifications: "자격증",
  publications: "논문·출판",
  awards: "수상",
  references: "추천인",
  "behavioral profile": "일하는 방식",
  "what excites you": "끌리는 일",
  "target sectors": "희망 분야",
  "deal-breakers": "피하고 싶은 조건",
  overview: "요약",
  "core behavioral drives": "핵심 동기",
  "strongest behaviors": "강점이 되는 행동",
  "how you work best": "잘 일하는 환경",
  "growth areas": "성장할 부분",
  "mapping to job posting language": "공고 표현과 연결하기",
  "management style preferences": "선호하는 관리 방식",
  "using this in applications": "지원서에 활용하기",
  "technical skills match": "기술 적합도",
  "experience match": "경력 적합도",
  "career alignment & motivation": "커리어 방향·동기",
  "calibration from past applications": "지난 지원에서 배운 점",
  "profile statement templates": "자기소개 문구",
  "ready-made star examples": "STAR 답변 예시",
  "common tough questions": "어려운 질문 대비",
  "installed portal clis": "채용 사이트 연결",
  "search sites": "검색할 사이트",
  "query categories": "검색어 묶음",
  "location filter": "지역 조건",
  "employment filter": "고용 형태 조건",
  "language filter": "언어 조건",
  "date filter": "기간 조건",
  "adapting queries": "검색어 조정",
};

const FACT_LABEL: Record<string, string> = {
  name: "이름",
  market: "구직 시장",
  location: "지역",
  "cv language": "이력서 언어",
  "active cv template": "이력서 디자인",
  status: "현재 상태",
  "linkedin headline": "LinkedIn 한 줄 소개",
  strengths: "강점",
  "growth areas": "성장할 부분",
  "thrives in": "잘 맞는 환경",
};

// "1. Technical Skills Match", "Growth Areas (frame positively …)" and
// "Installed portal CLIs (primary for `/scrape`)" all key on the bare name.
export function sectionTitle(heading: string): string {
  const bare = heading
    .replace(/^\d+\.\s*/, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
  return SECTION_TITLE[bare.toLowerCase()] ?? bare;
}

export function factLabel(key: string): string {
  return FACT_LABEL[key.trim().toLowerCase()] ?? key.trim();
}

const COMMENT = /<!--[\s\S]*?-->/g;

// CommonMark fences: a block closes only on a bare run of the same character
// at least as long as the opener, so a ``` example inside ```` stays fenced.
export function markFenced(md: string): { line: string; fenced: boolean }[] {
  let open: { ch: string; len: number } | null = null;
  return md.split("\n").map((line) => {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) open = { ch: m[1]![0]!, len: m[1]!.length };
      return { line, fenced: open !== null };
    }
    if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && !m[2]!.trim()) open = null;
    return { line, fenced: true };
  });
}

// Which parts of the profile page to show. The file tabs follow the files
// themselves: an unfinished summary must not hide a finished career profile.
export function profileView(data: { configured: boolean; files: { exists: boolean }[] } | null) {
  return {
    setupPrompt: data !== null && !data.configured,
    files: (data?.files ?? []).some((f) => f.exists),
  };
}

// Splits on "## " headings outside code fences. The "# " file title is
// dropped (the tab already names the file); text before the first "## "
// becomes an untitled section.
export function splitSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: "", title: "", body: "" };
  for (const { line, fenced } of markFenced(md.replace(COMMENT, ""))) {
    if (!fenced && /^# /.test(line)) continue;
    const m = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      out.push(cur);
      cur = { heading: m[1]!, title: sectionTitle(m[1]!), body: "" };
      continue;
    }
    cur.body += `${line}\n`;
  }
  out.push(cur);
  return out.map((s) => ({ ...s, body: s.body.trim() })).filter((s) => s.heading || s.body);
}

// "- **Key:** value" or "- **Key** - value", with the emphasis markers removed
// from the value ("6,000만원 / **현재 연봉:** 4,705만원", "*[검토 필요]*").
const BOLD_ITEM = /^\s*[-*]\s+\*\*(.+?)\*\*\s*:?\s*(?:[-–]\s+)?(.*)$/;

const unemphasize = (text: string) => text.replace(/\*/g, "").trim();

function boldItem(line: string): Fact | null {
  const m = BOLD_ITEM.exec(line);
  if (!m) return null;
  return { label: m[1]!.replace(/:$/, "").trim(), value: unemphasize(m[2]!) };
}

export function keyFacts(md: string): Fact[] {
  const identity = splitSections(md).find((s) => sectionTitle(s.heading) === "기본 정보");
  if (!identity) return [];
  return markFenced(identity.body).flatMap(({ line, fenced }) => {
    if (fenced || /^\s{2,}/.test(line)) return [];
    const f = boldItem(line);
    return f && f.value ? [{ label: factLabel(f.label), value: plainCommands(f.value) }] : [];
  });
}

const PENDING = /미확인|미입력|확인 필요|검토 필요|\(none\)|\(not provided\)/i;

// Items /setup left unconfirmed: bold bullets, table rows and plain bullets
// whose text says 미확인 / 미입력 / 확인 필요 / 검토 필요.
export function pendingItems(md: string): Fact[] {
  const out: Fact[] = [];
  for (const { line, fenced } of markFenced(md.replace(COMMENT, ""))) {
    if (fenced || !PENDING.test(line)) continue;
    const item = boldItem(line);
    if (item) {
      out.push({ label: factLabel(item.label), value: plainCommands(item.value) });
      continue;
    }
    const row = /^\s*\|([^|]+)\|(.+?)\|?\s*$/.exec(line);
    if (row) {
      out.push({ label: row[1]!.trim(), value: plainCommands(row[2]!.replace(/\|/g, " · ").trim()) });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) out.push({ label: "", value: plainCommands(unemphasize(bullet[1]!)) });
  }
  return out;
}

// "/setup 후속 질문에서 확인 필요" → "'프로필 만들기' 후속 질문에서 확인 필요".
// Only known commands at a word start are swapped, so paths stay intact.
export function plainCommands(text: string): string {
  return text.replace(/(^|[\s(`'"])\/([a-z][\w-]*)\b(?![/.])/g, (whole, pre: string, name: string) => {
    const label = COMMAND_LABEL[name]?.label;
    return label ? `${pre}'${label}'` : whole;
  });
}

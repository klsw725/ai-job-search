// Plain-language wording for the UI. Slash commands, file paths and tool names
// stay out of the main screens; they surface only under "자세히" disclosures.

export const COMMAND_LABEL: Record<string, { label: string; description: string }> = {
  setup: { label: "프로필 만들기", description: "이력서를 읽거나 질문에 답하며 내 프로필을 만들어요" },
  expand: { label: "프로필 보강하기", description: "올린 자료와 온라인 활동에서 빠진 역량을 찾아 채워요" },
  scrape: { label: "새 공고 찾기", description: "채용 사이트에서 내 조건에 맞는 공고를 모아요" },
  rank: { label: "공고 평가하기", description: "모은 공고를 내 프로필과 비교해 점수를 매겨요" },
  apply: { label: "지원서 만들기", description: "공고에 맞춘 이력서와 커버레터를 만들어요" },
  outcome: { label: "결과 기록하기", description: "서류 결과, 면접, 불합격 같은 소식을 기록해요" },
  interview: { label: "면접 준비", description: "예상 질문과 답변 소재를 정리하고 모의 면접을 해요" },
  upskill: { label: "보완할 역량 분석", description: "원하는 직무에 비해 부족한 역량과 학습 방법을 정리해요" },
  "html-report": { label: "활동 리포트 만들기", description: "지금까지의 구직 활동을 한 장짜리 리포트로 만들어요" },
  "add-template": { label: "서류 템플릿 추가", description: "새 이력서·커버레터 디자인을 등록해요" },
  "add-portal": { label: "채용 사이트 추가", description: "공고를 검색할 채용 사이트를 늘려요" },
  "notion-sync": { label: "Notion으로 내보내기", description: "지원 기록을 Notion 데이터베이스와 맞춰요" },
  "gmail-sync": { label: "Gmail에서 소식 가져오기", description: "메일함에서 지원 결과 메일을 찾아 기록해요" },
  reset: { label: "초기화", description: "프로필과 기록을 처음 상태로 되돌려요" },
};

export function commandLabel(prompt: string): string | null {
  const m = /^\/([\w-]+)(?:\s+(\S+))?/.exec(prompt.trim());
  if (!m) return null;
  if (m[1] === "outcome" && m[2] === "followup") return "후속 연락 메일 쓰기";
  return COMMAND_LABEL[m[1]!]?.label ?? null;
}

export const STATUS_LABEL: Record<string, string> = {
  drafted: "작성됨",
  applied: "지원함",
  interview: "면접",
  offer: "오퍼",
  hired: "합격",
  rejected: "불합격",
  no_response: "무응답",
  "no response": "무응답",
  offer_declined: "오퍼 거절",
  "offer declined": "오퍼 거절",
  withdrawn: "지원 철회",
  new: "새 공고",
  ranked: "평가 완료",
  expired: "마감",
  unreachable: "열리지 않음",
  skipped: "제외",
};

export const GATE_TEXT: Record<string, { FAIL: string; FLAG: string }> = {
  location_verdict: { FAIL: "희망 근무지와 맞지 않아요", FLAG: "근무지를 확인해 보세요" },
  language_gate: { FAIL: "요구 언어를 충족하기 어려워요", FLAG: "요구 언어를 확인해 보세요" },
  eligibility_gate: { FAIL: "지원 자격을 충족하지 않아요", FLAG: "지원 자격을 확인해 보세요" },
};

export function objectParticle(word: string): string {
  const last = word.trim().at(-1);
  if (!last) return "을(를)";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "를" : "을";
  return "을(를)";
}

function parseInput(input: string): Record<string, unknown> {
  try {
    const v = JSON.parse(input) as unknown;
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    // Inputs are clipped at 2000 characters, so a long one may not parse.
  }
  const out: Record<string, unknown> = {};
  for (const key of ["command", "file_path", "url", "query", "description", "pattern", "skill"]) {
    const m = new RegExp(`"${key}":\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(input);
    if (m) out[key] = m[1]!.replace(/\\n/g, " ").replace(/\\(.)/g, "$1");
  }
  return out;
}

const s = (v: unknown) => (typeof v === "string" ? v : "");

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "웹";
  }
}

const REPO_ROOTS = /(?:^|\/)((?:cv|cover_letters|documents|company_research|reports|upskill|templates|job_scraper|\.claude)\/.*)$/;

// Tools report absolute paths (/workspace/cv/a.typ); the leftmost whole-segment
// match keeps documents/cv/ from being mistaken for the generated cv/ folder.
export function repoRelative(path: string): string {
  return REPO_ROOTS.exec(path)?.[1] ?? path;
}

export function describePath(path: string): string {
  if (path.split(/[\\/]/).includes("..")) return path.split(/[\\/]/).pop() || "파일";
  const p = repoRelative(path);
  const pdf = /\.pdf$/i.test(p);
  if (/(^|\/)job_search_tracker\.csv$/.test(p)) return "지원 기록";
  if (/(^|\/)CLAUDE\.md$/.test(p)) return "기본 설정";
  if (/^cv\//.test(p)) return pdf ? "이력서 PDF" : "이력서 초안";
  if (/^cover_letters\//.test(p)) return pdf ? "커버레터 PDF" : "커버레터 초안";
  if (/^documents\/profile\//.test(p) || /job-application-assistant\/0\d-/.test(p)) return "프로필";
  if (/^documents\/cv\//.test(p)) return "올린 이력서";
  if (/^documents\/postings\//.test(p)) return "공고 원문";
  if (/^documents\//.test(p)) return "올린 자료";
  if (/^company_research\//.test(p)) return "회사 조사 자료";
  if (/^job_scraper\//.test(p)) return "공고 목록";
  if (/^reports\//.test(p)) return "리포트";
  if (/^upskill\//.test(p)) return "역량 분석 자료";
  if (/^templates\//.test(p)) return "서류 템플릿";
  if (/^\.claude\//.test(p)) return "작업 지침";
  return p.split("/").pop() || "파일";
}

const PORTAL_NAME: Record<string, string> = {
  linkedin: "LinkedIn",
  jobindex: "Jobindex",
  jobnet: "Jobnet",
  jobdanmark: "Jobdanmark",
  jobbank: "Jobbank",
  freehire: "Freehire",
};

function describeCommand(cmd: string): string {
  const portal = /([\w-]+)-search\b/.exec(cmd)?.[1];
  if (portal) return `${PORTAL_NAME[portal] ?? portal} 공고 검색`;
  if (/verify_pdf|verify_layout/.test(cmd)) return "PDF 레이아웃 검사";
  if (/\btypst\b|lualatex|pdflatex|xelatex|latexmk/.test(cmd)) return "PDF 만들기";
  if (/pdftotext|pdftoppm|pdfinfo/.test(cmd)) return "PDF 내용 확인";
  if (/rank_state/.test(cmd)) return "공고 평가 결과 정리";
  if (/scrape_state/.test(cmd)) return "모은 공고 정리";
  if (/job_key/.test(cmd)) return "중복 공고 확인";
  if (/fetch_page|page_decode/.test(cmd)) return "공고 페이지 가져오기";
  if (/robots_check/.test(cmd)) return "사이트 수집 허용 여부 확인";
  if (/posting_guard/.test(cmd)) return "공고 내용 안전 검사";
  if (/salary_lookup/.test(cmd)) return "연봉 정보 조회";
  if (/private_data/.test(cmd)) return "개인 자료 백업";
  if (/^\s*(ls|find|cat|head|tail|wc|grep|rg)\b/.test(cmd)) return "파일 살펴보기";
  if (/^\s*(mkdir|cp|mv)\b/.test(cmd)) return "파일 정리";
  if (/^\s*date\b/.test(cmd)) return "오늘 날짜 확인";
  return "프로그램 실행";
}

export function describeTool(name: string, input: string): string {
  const i = parseInput(input);
  switch (name) {
    case "WebFetch":
      return `${hostOf(s(i.url))} 페이지 읽기`;
    case "WebSearch":
      return s(i.query) ? `'${s(i.query)}' 웹 검색` : "웹 검색";
    case "Read":
      return `${describePath(s(i.file_path))} 읽기`;
    case "Write":
      return `${describePath(s(i.file_path))} 작성`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `${describePath(s(i.file_path))} 수정`;
    case "Glob":
    case "Grep":
    case "LS":
      return "파일 찾아보기";
    case "Bash":
      return describeCommand(s(i.command));
    case "Agent":
    case "Task":
      return s(i.description) ? `보조 AI: ${s(i.description)}` : "보조 AI에게 맡기기";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return "진행 계획 정리";
    case "Skill":
      return "작업 지침 불러오기";
    case "AskUserQuestion":
      return "질문하기";
    default:
      return name.startsWith("mcp__") ? "외부 도구 사용" : name;
  }
}

export type Risk = "low" | "medium" | "high";

export type PermissionView = {
  title: string;
  risk: Risk;
  warning?: string;
  shown: { label: string; text: string }[];
};

const PREVIEW_LINES = 40;

function preview(text: string): string {
  const lines = text.split("\n");
  return lines.length <= PREVIEW_LINES ? text : `${lines.slice(0, PREVIEW_LINES).join("\n")}\n… (전체 ${lines.length}줄 중 ${PREVIEW_LINES}줄만 표시, 나머지는 기술 정보에)`;
}

// A friendly name is only a headline. A path that leaves the repository or
// climbs with ".." gets no reassuring label, so a disguised target stands out.
export function pathOutsideRepo(path: string, repoRoot: string | null): boolean {
  if (path.split(/[\\/]/).includes("..")) return true;
  if (!path.startsWith("/") || !repoRoot) return false;
  const root = repoRoot.replace(/\/+$/, "");
  return path !== root && !path.startsWith(`${root}/`);
}

const OUTSIDE_WARNING = "작업 폴더 밖이거나 상위 폴더(..)를 거치는 경로예요. 아래 경로가 맞는지 꼭 확인하세요.";

// Everything the approval acts on stays visible: the exact path, URL or
// command, and what a write or edit puts into the file. Only ancillary fields
// (fetch prompts, flags) sit under the "기술 정보" disclosure.
export function describePermission(toolName: string, input: string, repoRoot: string | null = null): PermissionView {
  let i: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(input) as unknown;
    if (v && typeof v === "object") i = v as Record<string, unknown>;
  } catch {
    i = null;
  }
  if (!i) return { title: `AI가 '${toolName}' 기능을 쓰려고 해요`, risk: "high", shown: [{ label: "입력", text: input }] };

  const path = s(i.file_path) || s(i.notebook_path) || s(i.path);
  const outside = path !== "" && pathOutsideRepo(path, repoRoot);
  // Until the repo root is known an absolute path cannot be vouched for.
  const unverified = path.startsWith("/") && !repoRoot;
  const what = outside ? "작업 폴더 밖의 파일" : unverified ? "파일" : describePath(path);
  const obj = `${what}${objectParticle(what)}`;
  const file = { label: "파일", text: path };
  const fileView = (title: string, risk: Risk, shown: PermissionView["shown"]): PermissionView =>
    outside ? { title, risk: "high", warning: OUTSIDE_WARNING, shown } : { title, risk, shown };

  switch (toolName) {
    case "WebFetch":
      return { title: `AI가 ${hostOf(s(i.url))} 페이지를 읽으려고 해요`, risk: "low", shown: [{ label: "주소", text: s(i.url) }] };
    case "WebSearch":
      return { title: "AI가 웹에서 검색하려고 해요", risk: "low", shown: [{ label: "검색어", text: s(i.query) }] };
    case "Read":
      return fileView(`AI가 ${obj} 읽으려고 해요`, "low", [file]);
    case "Glob":
    case "Grep":
      return fileView("AI가 파일을 찾아보려고 해요", "low", [
        { label: "찾는 내용", text: s(i.pattern) },
        ...(path ? [{ label: "위치", text: path }] : []),
      ]);
    case "Write":
      return fileView(`AI가 ${obj} 저장하려고 해요`, "medium", [file, { label: "저장할 내용 (파일 전체를 이 내용으로 바꿔요)", text: preview(s(i.content)) }]);
    case "Edit":
      return fileView(`AI가 ${obj} 고치려고 해요`, "medium", [
        file,
        { label: i.replace_all ? "바꿀 부분 (파일 안의 모든 곳)" : "바꿀 부분", text: preview(s(i.old_string)) },
        { label: "바뀐 내용", text: preview(s(i.new_string)) },
      ]);
    case "MultiEdit": {
      const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [];
      return fileView(`AI가 ${obj} 고치려고 해요 (${edits.length}곳)`, "medium", [
        file,
        ...edits.flatMap((e, n) => [
          { label: `${n + 1}. 바꿀 부분${e.replace_all ? " (파일 안의 모든 곳)" : ""}`, text: preview(s(e.old_string)) },
          { label: `${n + 1}. 바뀐 내용`, text: preview(s(e.new_string)) },
        ]),
      ]);
    }
    case "NotebookEdit": {
      const mode = s(i.edit_mode) || "replace";
      const modeText = mode === "delete" ? "셀 삭제" : mode === "insert" ? "새 셀 추가" : "셀 내용 바꾸기";
      return fileView(`AI가 ${obj} 고치려고 해요 (${modeText})`, mode === "delete" ? "high" : "medium", [
        file,
        { label: "대상 셀", text: s(i.cell_id) || "(지정 없음)" },
        { label: "편집 방식", text: `${modeText} (${mode}${i.cell_type ? `, ${s(i.cell_type)}` : ""})` },
        ...(mode === "delete" ? [] : [{ label: "새 내용", text: preview(s(i.new_source)) }]),
      ]);
    }
    case "Bash": {
      const did = describeCommand(s(i.command));
      return {
        title: did === "프로그램 실행" ? "AI가 아래 프로그램을 실행하려고 해요" : `AI가 프로그램을 실행하려고 해요 (${did})`,
        risk: "high",
        shown: [{ label: "명령", text: s(i.command) }],
      };
    }
    default:
      return { title: `AI가 '${describeTool(toolName, input)}' 기능을 쓰려고 해요`, risk: "medium", shown: [{ label: "입력", text: input }] };
  }
}

const RESULT_ERROR: Record<string, string> = {
  error_max_turns: "작업 단계가 너무 많아 멈췄어요. 이어서 하려면 메시지를 보내 주세요.",
  error_during_execution: "작업 중에 문제가 생겨 멈췄어요.",
  error_max_budget_usd: "설정한 비용 한도에 도달해 멈췄어요.",
};

export function resultErrorText(subtype: string): string {
  return RESULT_ERROR[subtype] ?? (subtype ? `작업이 멈췄어요 (${subtype})` : "작업이 멈췄어요");
}

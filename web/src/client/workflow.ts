import { recommended } from "./jobs.ts";

// The repo's core route (README "What this is"): /setup → /scrape → /rank →
// /apply → /interview → /outcome. The home screen shows where the user is on
// it, computed only from data the commands themselves write.

export type StageId = "setup" | "scrape" | "rank" | "apply" | "interview" | "outcome";
export type StageState = "done" | "current" | "todo";

export type Stage = {
  id: StageId;
  title: string;
  summary: string;
  state: StageState;
  metric: string | null;
};

export type NextAction = {
  stage: StageId;
  headline: string;
  detail: string;
  cta: { label: string; prompt?: string; href?: string; task?: string };
  secondary?: { label: string; prompt?: string; href?: string; task?: string };
};

export type JourneyInput = {
  profileConfigured: boolean;
  resumeUploaded: boolean;
  jobs: Record<string, unknown>[];
  rows: Record<string, string>[];
};

const STAGES: { id: StageId; title: string; summary: string }[] = [
  { id: "setup", title: "프로필 만들기", summary: "이력서로 내 경력·희망 조건 정리" },
  { id: "scrape", title: "공고 찾기", summary: "채용 사이트에서 공고 모으기" },
  { id: "rank", title: "공고 평가", summary: "내 프로필과 비교해 추천 고르기" },
  { id: "apply", title: "지원서 만들기", summary: "맞춤 이력서·커버레터 작성" },
  { id: "interview", title: "면접 준비", summary: "예상 질문과 답변 소재 정리" },
  { id: "outcome", title: "결과 기록", summary: "합격·불합격·무응답 기록" },
];

const status = (r: Record<string, string>) => (r.status ?? "").trim().toLowerCase().replaceAll(" ", "_");
const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
// Scheme and host are case-insensitive; a path or query may not be.
const urlKey = (v: unknown) => {
  const raw = typeof v === "string" ? v.trim().replace(/#.*$/, "").replace(/\/+$/, "") : "";
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?]*)(.*)$/i.exec(raw);
  return m ? m[1]!.toLowerCase() + m[2]! : raw;
};

// The tracker row for a posting: same link first, else same company and
// title. With several (a re-application), the newest row is the one shown.
export function trackedRow<R extends Record<string, string>>(job: Record<string, unknown>, rows: R[]): R | undefined {
  const url = urlKey(job.url);
  const byUrl = url ? rows.filter((r) => urlKey(r.source) === url) : [];
  const byName = norm(job.company) ? rows.filter((r) => norm(r.company) === norm(job.company) && norm(r.role) === norm(job.title)) : [];
  const found = byUrl.length ? byUrl : byName;
  return found.reduce<R | undefined>((best, r) => (!best || (r.date ?? "") >= (best.date ?? "") ? r : best), undefined);
}

// A ranked posting the tracker already has a row for (same link, or same
// company and title) is no longer something to apply to.
export function untracked(jobs: Record<string, unknown>[], rows: Record<string, string>[]) {
  return jobs.filter((j) => !trackedRow(j, rows));
}
const REACHED_INTERVIEW = new Set(["interview", "offer", "hired", "offer_declined"]);
const FINAL = new Set(["hired", "rejected", "no_response", "offer_declined", "withdrawn"]);

export function journey(input: JourneyInput): { stages: Stage[]; next: NextAction; doneCount: number } {
  const { profileConfigured, resumeUploaded, jobs, rows } = input;
  const newJobs = jobs.filter((j) => j.status === "new").length;
  const ranked = jobs.filter((j) => j.status === "ranked" || typeof j.rank_score === "number").length;
  const picks = recommended(untracked(jobs, rows), Infinity);
  const drafted = rows.filter((r) => status(r) === "drafted");
  const applied = rows.filter((r) => status(r) === "applied");
  const interviewing = rows.filter((r) => status(r) === "interview");
  const offers = rows.filter((r) => status(r) === "offer");
  const finals = rows.filter((r) => FINAL.has(status(r)));

  const done: Record<StageId, boolean> = {
    setup: profileConfigured,
    scrape: jobs.length > 0,
    rank: ranked > 0,
    apply: rows.length > 0,
    interview: rows.some((r) => REACHED_INTERVIEW.has(status(r))),
    outcome: finals.length > 0,
  };
  const metric: Record<StageId, string | null> = {
    setup: profileConfigured ? "완료" : resumeUploaded ? "이력서 올림" : null,
    scrape: jobs.length ? `${jobs.length}건 모음` : null,
    rank: newJobs ? `평가 대기 ${newJobs}건` : ranked ? `추천 ${picks.length}건` : null,
    apply: rows.length ? `${rows.length}건 작성` : null,
    interview: interviewing.length ? `진행 중 ${interviewing.length}건` : null,
    outcome: finals.length ? `${finals.length}건 기록` : null,
  };

  const next = nextAction({ ...input, newJobs, picks, drafted, applied, interviewing, offers, done });
  const stages = STAGES.map((s) => ({
    ...s,
    metric: metric[s.id],
    state: (s.id === next.stage ? "current" : done[s.id] ? "done" : "todo") as StageState,
  }));
  return { stages, next, doneCount: STAGES.filter((s) => done[s.id]).length };
}

type Ctx = JourneyInput & {
  newJobs: number;
  picks: Record<string, unknown>[];
  drafted: Record<string, string>[];
  applied: Record<string, string>[];
  interviewing: Record<string, string>[];
  offers: Record<string, string>[];
  done: Record<StageId, boolean>;
};

const who = (r: Record<string, string>) => [r.company, r.role].filter(Boolean).join(" ");

function nextAction(c: Ctx): NextAction {
  if (!c.profileConfigured) {
    return c.resumeUploaded
      ? {
          stage: "setup",
          headline: "올린 이력서로 프로필을 만들어요",
          detail: "AI가 이력서를 읽고 경력, 기술, 희망 조건을 정리해요. 중간에 몇 가지 질문에 답하면 돼요.",
          cta: { label: "프로필 만들기 시작", prompt: "/setup" },
        }
      : {
          stage: "setup",
          headline: "먼저 이력서를 올려 주세요",
          detail: "AI가 지원서를 쓰려면 내 경력을 알아야 해요. 이력서를 올리면 프로필을 자동으로 만들어요. 이력서가 없으면 질문에 답하면서 만들 수도 있어요.",
          cta: { label: "이력서 올리기", href: "#/documents" },
          secondary: { label: "이력서 없이 시작", prompt: "/setup" },
        };
  }
  if (c.interviewing.length > 0) {
    const r = c.interviewing[0]!;
    return {
      stage: "interview",
      headline: `${who(r) || "진행 중인 지원"} 면접을 준비해요`,
      detail: "제출한 서류와 어긋나지 않게 예상 질문, STAR 답변 소재, 회사에 물어볼 질문을 정리하고 모의 면접도 할 수 있어요.",
      cta: { label: "면접 준비 시작", prompt: `/interview ${r.company ?? ""}`.trim(), task: `면접 준비 · ${who(r)}` },
      secondary: { label: "결과 기록", prompt: "/outcome" },
    };
  }
  if (c.offers.length > 0) {
    const r = c.offers[0]!;
    return {
      stage: "outcome",
      headline: `${who(r) || "지원한 곳"}에서 오퍼를 받았어요`,
      detail: "조건을 검토하고 수락·거절을 결정하면 기록해 두세요. 결정이 나면 진행 중인 다른 지원도 함께 정리할 수 있어요.",
      cta: { label: "결정 기록", prompt: `/outcome ${r.company ?? ""}`.trim(), task: `결과 기록 · ${who(r)}` },
    };
  }
  if (c.newJobs > 0) {
    return {
      stage: "rank",
      headline: `새 공고 ${c.newJobs}건이 평가를 기다려요`,
      detail: "AI가 공고마다 내 프로필과 비교해 점수를 매기고, 근무지·언어·자격 조건이 안 맞는 공고는 걸러 줘요.",
      cta: { label: "공고 평가하기", prompt: "/rank" },
    };
  }
  if (c.picks.length > 0 && c.drafted.length === 0 && c.applied.length === 0) {
    const top = c.picks[0]!;
    const name = [top.company, top.title].filter(Boolean).map(String).join(" / ");
    return {
      stage: "apply",
      headline: `추천 공고 ${c.picks.length}건 — 가장 잘 맞는 곳부터 지원해 보세요`,
      detail: `1순위: ${name} (${String(top.rank_score)}점). 지원서를 만들면 적합도를 먼저 확인한 뒤 공고에 맞춘 이력서와 커버레터를 써요.`,
      cta: typeof top.url === "string" ? { label: "1순위 지원서 만들기", prompt: `/apply ${top.url}`, task: `지원서 만들기 · ${name}` } : { label: "추천 공고 보기", href: "#/jobs" },
      secondary: { label: "추천 공고 전체 보기", href: "#/jobs" },
    };
  }
  if (c.drafted.length > 0) {
    return {
      stage: "apply",
      headline: `작성한 지원서 ${c.drafted.length}건을 제출할 차례예요`,
      detail: `${c.drafted.slice(0, 2).map(who).join(", ")}${c.drafted.length > 2 ? " 외" : ""}. 서류함에서 PDF를 받아 제출한 뒤, 지원했다고 기록해 두면 마감·후속 연락을 챙겨 드려요.`,
      cta: { label: "서류 받으러 가기", href: "#/documents" },
      secondary: { label: "지원 완료 기록", prompt: "/outcome" },
    };
  }
  if (c.applied.length > 0) {
    return {
      stage: "outcome",
      headline: `지원한 ${c.applied.length}곳의 소식을 기록해요`,
      detail: "서류 결과나 면접 연락이 오면 기록하세요. 오래 답이 없는 곳에는 정중한 후속 연락 메일을 써 드려요.",
      cta: { label: "결과 기록", prompt: "/outcome" },
      secondary: { label: "후속 연락 메일 쓰기", prompt: "/outcome followup", task: "후속 연락 메일 쓰기" },
    };
  }
  return {
    stage: "scrape",
    headline: c.done.scrape ? "새로운 기회를 찾아볼까요?" : "내 조건에 맞는 공고를 찾아봐요",
    detail: "채용 사이트에서 희망 조건에 맞는 공고를 모아요. 이미 지원하고 싶은 공고가 있다면 아래에 링크를 붙여넣어도 돼요.",
    cta: { label: "새 공고 찾기", prompt: "/scrape" },
  };
}

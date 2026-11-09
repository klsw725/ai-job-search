import { useMemo, useState } from "react";
import { safeHttpUrl, useFetch } from "../api.ts";
import { GATES, fitBand, jobTab, type JobTab } from "../jobs.ts";
import { GATE_TEXT, STATUS_LABEL, portalName } from "../labels.ts";
import { CommandButton, EmptyState, ErrorBox, Icon, PageHeader, daysUntil } from "../ui.tsx";

type Job = Record<string, unknown> & { key: string };
type Tab = JobTab | "all";

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "recommended", label: "추천", hint: "평가를 마치고 근무지·언어·자격 조건을 통과한 공고" },
  { id: "unranked", label: "평가 전", hint: "아직 내 프로필과 비교하지 않은 공고" },
  { id: "excluded", label: "제외됨", hint: "점수가 낮거나 근무지·언어·자격 조건이 맞지 않는 공고" },
  { id: "closed", label: "마감·열리지 않음", hint: "마감됐거나 페이지가 열리지 않는 공고" },
  { id: "all", label: "전체", hint: "모은 공고 전부" },
];

function shortDate(date: string): string | null {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  return m ? `${Number(m[1])}월 ${Number(m[2])}일` : null;
}

// "Seoul, Seoul, South Korea" reads as "Seoul": repeats and the country go.
function shortLocation(location: string): string {
  const parts = [...new Set(location.split(",").map((p) => p.trim()).filter(Boolean))];
  const local = parts.filter((p) => !/^(south korea|korea|republic of korea|대한민국|한국)$/i.test(p));
  return (local.length ? local : parts).join(", ");
}

function ScoreBadge({ score, unscored }: { score: unknown; unscored: string }) {
  if (typeof score !== "number") {
    return (
      <div className="score-badge none">
        <b>–</b>
        <span>{unscored}</span>
      </div>
    );
  }
  return (
    <div className={`score-badge ${fitBand(score).tone}`}>
      <b>{score}</b>
      <span>점</span>
    </div>
  );
}

function DeadlineText({ date }: { date: string }) {
  const n = daysUntil(date);
  if (n === null) return null;
  return <span className={n < 0 ? "dl-past" : n <= 7 ? "dl-soon" : ""}>마감 {n < 0 ? "지남" : n === 0 ? "오늘" : `D-${n}`}</span>;
}

function Points({ kind, title, items, open }: { kind: "plus" | "minus"; title: string; items: string[]; open: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className={`points ${kind}`}>
      <div className="points-head">
        {title} <span className="muted">{items.length}</span>
      </div>
      <ul>
        {(open ? items : items.slice(0, 1)).map((t, i) => (
          <li key={i}>
            <span className="mark">{kind === "plus" ? "+" : "−"}</span>
            <p>{t}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobCard({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const url = safeHttpUrl(job.url);
  const tab = jobTab(job);
  const status = str(job.status);
  const strengths = list(job.strengths);
  const gaps = list(job.gaps);
  const posted = shortDate(str(job.posted_date));
  const found = posted ? null : shortDate(str(job.first_seen));
  const band = typeof job.rank_score === "number" ? fitBand(job.rank_score) : null;
  const flags = GATES.flatMap(([field, , noteField]) => {
    const verdict = str(job[field]);
    if (verdict !== "FAIL" && verdict !== "FLAG") return [];
    return [{ field, fail: verdict === "FAIL", text: GATE_TEXT[field]![verdict], note: noteField ? str(job[noteField]) : "" }];
  });
  // Points and notes are clamped by width, which a character count cannot
  // predict on a narrow screen, so any detail gets the toggle.
  const expandable = strengths.length > 0 || gaps.length > 0 || flags.some((f) => f.note);

  return (
    <li className={`job-card${tab === "excluded" || tab === "closed" ? " dim" : ""}${open ? " open" : ""}`}>
      <ScoreBadge score={job.rank_score} unscored={tab === "unranked" ? "평가 전" : (STATUS_LABEL[status] ?? "제외")} />
      <div className="job-main">
        <div className="job-head">
          <span className="job-company">{str(job.company)}</span>
          {url ? (
            <a className="job-title" href={url} target="_blank" rel="noopener noreferrer">{str(job.title)}</a>
          ) : (
            <span className="job-title">{str(job.title)}</span>
          )}
        </div>
        <div className="job-meta">
          {band && <span className={`fit-text ${band.tone}`}>{band.label}</span>}
          {band && tab === "closed" && STATUS_LABEL[status] && <span>{STATUS_LABEL[status]}</span>}
          {str(job.portal) && <span>{portalName(str(job.portal))}</span>}
          {str(job.location) && (
            <span>
              <Icon name="pin" size={12} /> {shortLocation(str(job.location))}
            </span>
          )}
          {posted && <span>{posted} 게시</span>}
          {found && <span>{found} 모음</span>}
          {str(job.deadline) && <DeadlineText date={str(job.deadline)} />}
        </div>
        {flags.length > 0 && (
          <ul className="job-flags">
            {flags.map((f) => (
              <li key={f.field}>
                <span className={`flag ${f.fail ? "fail" : "warn"}`}>
                  <Icon name="alert" size={13} /> {f.text}
                </span>
                {f.note && <span className="flag-note muted">{f.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {(strengths.length > 0 || gaps.length > 0) && (
          <div className="job-points">
            <Points kind="plus" title="잘 맞는 점" items={strengths} open={open} />
            <Points kind="minus" title="부족한 점" items={gaps} open={open} />
          </div>
        )}
        {expandable && (
          <button className="more" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "접기" : "자세히 보기"} <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
          </button>
        )}
      </div>
      <div className="job-actions">
        {url && tab !== "closed" && (
          <CommandButton prompt={`/apply ${url}`} label="지원서 만들기" task={`지원서 만들기 · ${str(job.company)} / ${str(job.title)}`} />
        )}
        {url && (
          <a className="btn ghost small-btn" href={url} target="_blank" rel="noopener noreferrer">
            <Icon name="open" size={14} /> 공고 원문
          </a>
        )}
      </div>
    </li>
  );
}

export function Jobs() {
  const { data, error, reload } = useFetch<{ exists: boolean; jobs: Job[]; error?: string }>("/api/jobs", { live: true });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Tab | null>(null);

  const all = data?.jobs;
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { recommended: 0, unranked: 0, excluded: 0, closed: 0, all: all?.length ?? 0 };
    for (const j of all ?? []) c[jobTab(j)]++;
    return c;
  }, [all]);
  const tab: Tab = picked ?? (counts.recommended > 0 ? "recommended" : "all");

  const needle = q.trim().toLowerCase();
  const jobs = useMemo(
    () =>
      (all ?? [])
        .filter((j) => tab === "all" || jobTab(j) === tab)
        .filter((j) => !needle || `${str(j.title)} ${str(j.company)} ${str(j.location)} ${portalName(str(j.portal))}`.toLowerCase().includes(needle))
        .sort((a, b) => (Number(b.rank_score ?? -1) - Number(a.rank_score ?? -1)) || str(b.first_seen ?? b.posted_date).localeCompare(str(a.first_seen ?? a.posted_date))),
    [all, tab, needle],
  );

  const rankButton = (kind: "primary" | "secondary") => (
    <CommandButton
      prompt="/rank"
      label={counts.unranked > 0 ? `공고 평가하기 (${counts.unranked})` : "공고 평가하기"}
      icon="sparkle"
      kind={kind}
      hint="모은 공고를 내 프로필과 비교해 점수를 매겨요"
    />
  );
  const scrapeButton = (kind: "primary" | "secondary") => (
    <CommandButton prompt="/scrape" label="새 공고 찾기" icon="search" kind={kind} hint="채용 사이트에서 내 조건에 맞는 공고를 모아요" />
  );

  let empty = null;
  if (needle) {
    empty = (
      <EmptyState icon="search" title={`'${q.trim()}'에 맞는 공고가 없어요`}>
        다른 낱말로 찾아보거나 전체 탭에서 찾아보세요.
      </EmptyState>
    );
  } else if (tab === "recommended") {
    empty =
      counts.unranked > 0 ? (
        <EmptyState icon="sparkle" title={`평가 전 공고가 ${counts.unranked}건 있어요`} action={rankButton("primary")}>
          AI가 내 프로필과 비교해 점수를 매기면 잘 맞는 공고가 여기에 모여요.
        </EmptyState>
      ) : (
        <EmptyState icon="briefcase" title="추천할 공고가 아직 없어요" action={scrapeButton("primary")}>
          새 공고를 모으면 AI가 평가해서 잘 맞는 순서로 보여 드려요.
        </EmptyState>
      );
  } else {
    empty = <EmptyState icon="briefcase" title="이 목록은 비어 있어요" />;
  }

  return (
    <div className="stack">
      <PageHeader
        title="공고 찾기"
        description="채용 사이트에서 모은 공고를 내 프로필과 비교해, 잘 맞는 순서로 보여 드려요."
        actions={
          <>
            <button className="btn ghost" onClick={reload} title="새로고침" aria-label="새로고침">
              <Icon name="refresh" size={15} />
            </button>
            {scrapeButton("secondary")}
            {rankButton(counts.unranked > 0 ? "primary" : "secondary")}
          </>
        }
      />
      <ErrorBox error={error ?? data?.error ?? null} />
      {data && !data.exists ? (
        <EmptyState icon="briefcase" title="아직 모은 공고가 없어요" action={scrapeButton("primary")}>
          [새 공고 찾기]를 누르면 AI가 채용 사이트에서 내 조건에 맞는 공고를 모아요. 이미 찾아 둔 공고가 있다면 <a href="#/">홈</a>에서 링크를 넣어 바로
          지원서를 만들 수 있어요.
        </EmptyState>
      ) : (
        <>
          <div className="toolbar">
            <div className="seg" role="group" aria-label="공고 목록">
              {TABS.map((t) => (
                <button key={t.id} aria-pressed={tab === t.id} className={tab === t.id ? "on" : ""} title={t.hint} onClick={() => setPicked(t.id)}>
                  {t.label}
                  <span className="n">{counts[t.id]}</span>
                </button>
              ))}
            </div>
            <label className="search">
              <Icon name="search" size={15} />
              <input placeholder="회사·직무·지역으로 찾기" value={q} onChange={(e) => setQ(e.target.value)} aria-label="공고 검색" />
            </label>
          </div>
          {data && (jobs.length === 0 ? empty : <ul className="job-list">{jobs.map((j) => <JobCard key={j.key} job={j} />)}</ul>)}
        </>
      )}
    </div>
  );
}

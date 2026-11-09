import { useMemo, useState } from "react";
import { safeHttpUrl, useFetch, useRuns, type Run } from "../api.ts";
import { ApplyButton, RUN_STATE_TEXT, runStateKey } from "../apply.tsx";
import { panel } from "../panel.ts";
import { applicationId, canonicalStatus, columnOf } from "../pipeline.ts";
import { trackedRow } from "../workflow.ts";
import { GATES, fitBand, jobTab, type JobTab } from "../jobs.ts";
import { GATE_TEXT, STATUS_LABEL, portalName } from "../labels.ts";
import { CommandButton, EmptyState, ErrorBox, Icon, PageHeader, daysUntil } from "../ui.tsx";

type Job = Record<string, unknown> & { key: string };
type Tab = JobTab | "tracked" | "all";
type Row = Record<string, string>;

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "recommended", label: "추천", hint: "평가를 마치고 근무지·언어·자격 조건을 통과했고, 아직 지원서를 만들지 않은 공고" },
  { id: "tracked", label: "지원서 만듦", hint: "지원서를 만들었거나 지원한 공고. 내 지원에서 단계를 관리해요" },
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

function RunBadge({ run }: { run: Run }) {
  const state = runStateKey(run);
  const row = run.checks?.row;
  const href = state === "succeeded" && row ? `#/applications/${applicationId(row)}` : `#/runs/${run.id}`;
  if ((state === "running" || state === "awaiting") && run.sessionId) {
    return (
      <button className={`run-badge ${state}`} onClick={() => panel.show(run.sessionId!)}>
        <span className="spinner" /> {RUN_STATE_TEXT[state]}
      </button>
    );
  }
  return (
    <a className={`run-badge ${state}`} href={href}>
      {state === "succeeded" ? <Icon name="check" size={13} /> : <Icon name="alert" size={13} />} {state === "succeeded" ? "지원서 완성 · 보기" : `${RUN_STATE_TEXT[state]} · 보기`}
    </a>
  );
}

function TrackedBadge({ row }: { row: Row }) {
  const status = canonicalStatus(row.status);
  const day = (row.date ?? "").slice(5).replace("-", "/");
  return (
    <a className={`tracked-badge col-${columnOf(status)}`} href={`#/applications/${applicationId(row)}`}>
      <Icon name="clipboard" size={13} /> {STATUS_LABEL[status] ?? status} {day && <span className="muted">· {day}</span>}
    </a>
  );
}

function JobCard({ job, run, row, onStarted }: { job: Job; run?: Run; row?: Row; onStarted: () => void }) {
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
  // An earlier application to this role has ended; a new one may be made.
  const rowClosed = !!row && columnOf(canonicalStatus(row.status)) === "closed";
  const expandable = strengths.length > 0 || gaps.length > 0 || flags.some((f) => f.note);

  return (
    <li className={`job-card${tab === "excluded" || tab === "closed" ? " dim" : ""}${row ? " tracked" : ""}${open ? " open" : ""}`}>
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
        {row && <TrackedBadge row={row} />}
        {run && run.state !== "cancelled" && !(row && run.state === "succeeded") && <RunBadge run={run} />}
        {url && tab !== "closed" && (!row || rowClosed) && (!run || run.state === "cancelled" || run.state === "failed" || (rowClosed && run.state === "succeeded")) && (
          <ApplyButton
            posting={url}
            url={url}
            jobKey={job.key}
            label={rowClosed ? "다시 지원서 만들기" : "지원서 만들기"}
            title={`지원서 만들기 · ${str(job.company)} / ${str(job.title)}`}
            onStarted={onStarted}
          />
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
  const runs = useRuns();
  const runFor = useMemo(() => {
    const byKey = new Map<string, Run>();
    // Runs are newest first, so the first one seen for a job is its latest.
    for (const r of (runs.data ?? []).filter((x) => x.kind === "apply")) {
      for (const k of [r.subject.jobKey, r.subject.url]) if (k && !byKey.has(k)) byKey.set(k, r);
    }
    return (j: Job) => byKey.get(j.key) ?? (typeof j.url === "string" ? byKey.get(j.url) : undefined);
  }, [runs.data]);
  const tracker = useFetch<{ rows: Row[] }>("/api/tracker", { live: true });
  const rowFor = useMemo(() => {
    const rows = tracker.data?.rows ?? [];
    const found = new Map((data?.jobs ?? []).map((j) => [j.key, trackedRow(j, rows)]));
    return (j: Job) => found.get(j.key);
  }, [data, tracker.data]);
  // A posting with an application leaves the recommendations, like on the home page.
  const tabOf = (j: Job): Tab => (rowFor(j) ? "tracked" : jobTab(j));
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Tab | null>(null);

  const all = data?.jobs;
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { recommended: 0, tracked: 0, unranked: 0, excluded: 0, closed: 0, all: all?.length ?? 0 };
    for (const j of all ?? []) c[tabOf(j)]++;
    return c;
  }, [all, rowFor]);
  const tab: Tab = picked ?? (counts.recommended > 0 ? "recommended" : "all");

  const needle = q.trim().toLowerCase();
  const jobs = useMemo(
    () =>
      (all ?? [])
        .filter((j) => tab === "all" || tabOf(j) === tab)
        .filter((j) => !needle || `${str(j.title)} ${str(j.company)} ${str(j.location)} ${portalName(str(j.portal))}`.toLowerCase().includes(needle))
        .sort((a, b) => (Number(b.rank_score ?? -1) - Number(a.rank_score ?? -1)) || str(b.first_seen ?? b.posted_date).localeCompare(str(a.first_seen ?? a.posted_date))),
    [all, tab, needle, rowFor],
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
  } else if (tab === "tracked") {
    empty = (
      <EmptyState icon="clipboard" title="아직 지원서를 만든 공고가 없어요">
        추천 공고에서 [지원서 만들기]를 누르면 여기로 옮겨 와요.
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
          {data && (jobs.length === 0 ? empty : <ul className="job-list">{jobs.map((j) => <JobCard key={j.key} job={j} run={runFor(j)} row={rowFor(j)} onStarted={() => { runs.reload(); tracker.reload(); }} />)}</ul>)}
        </>
      )}
    </div>
  );
}

import { useState } from "react";
import { safeHttpUrl, useActiveSessions, useFetch, type SessionSummary } from "../api.ts";
import { ApplyButton, ApplyDialog } from "../apply.tsx";
import { AttachButton, AttachmentTray, DropZone, useAttachments } from "../attach.tsx";
import { fitBand, recommended } from "../jobs.ts";
import { COMMAND_LABEL } from "../labels.ts";
import { panel } from "../panel.ts";
import { Card, CommandButton, Deadline, EmptyState, ErrorBox, Icon, PageHeader, StatusChip, daysUntil } from "../ui.tsx";
import { journey, untracked, type NextAction, type Stage, type StageId } from "../workflow.ts";
import { TrustCard, setupIssues, type Status } from "./Settings.tsx";

type Tracker = { exists: boolean; rows: Record<string, string>[] };
type Jobs = { exists: boolean; jobs: Record<string, unknown>[] };
type Profile = { configured: boolean };
type FileEntry = { path: string };

const STAGE_PAGE: Record<StageId, string> = {
  setup: "#/profile",
  scrape: "#/jobs",
  rank: "#/jobs",
  apply: "#/tracker",
  interview: "#/tracker",
  outcome: "#/tracker",
};

function ActionButton({ action, primary }: { action: NextAction["cta"]; primary?: boolean }) {
  const kind = primary ? "primary" : "secondary";
  const apply = action.prompt && /^\/apply\s+(https?:\/\/\S+)\s*$/.exec(action.prompt);
  if (apply) return <ApplyButton posting={apply[1]!} url={apply[1]!} title={action.task ?? "지원서 만들기"} label={action.label} kind={kind} />;
  if (action.prompt) return <CommandButton prompt={action.prompt} label={action.label} task={action.task} kind={kind} />;
  return (
    <a className={`btn ${kind}`} href={action.href}>
      {action.label}
    </a>
  );
}

function StepMark({ stage, index, running }: { stage: Stage; index: number; running: boolean }) {
  if (running) return <span className="jmark run"><span className="spinner" /></span>;
  if (stage.state === "done") return <span className="jmark done"><Icon name="check" size={14} /></span>;
  return <span className="jmark">{index + 1}</span>;
}

function Journey({ stages, next, doneCount, active }: ReturnType<typeof journey> & { active: SessionSummary[] }) {
  const runningFor = (id: StageId) => active.find((s) => s.kind === id && s.state === "running");
  const nextRun = runningFor(next.stage);
  const pct = Math.round((doneCount / stages.length) * 100);
  return (
    <section className="card journey-card">
      <header className="card-head">
        <div>
          <div className="eyebrow">나의 구직 여정</div>
          <h2>
            {stages.length}단계 중 {doneCount}단계 완료
          </h2>
        </div>
        <div className="journey-pct" aria-label={`진행률 ${pct}%`}>
          <div className="progress-bar"><span style={{ width: `${pct}%` }} /></div>
          <span className="muted small">{pct}%</span>
        </div>
      </header>

      <ol className="journey">
        {stages.map((s, i) => (
          <li key={s.id} className={`jstep ${s.state}`}>
            <a href={STAGE_PAGE[s.id]} className="jstep-link">
              <StepMark stage={s} index={i} running={Boolean(runningFor(s.id))} />
              <span className="jstep-text">
                <b>{s.title}</b>
                <span className="muted small">{s.summary}</span>
                {s.metric && <span className={`jmetric ${s.state}`}>{s.metric}</span>}
              </span>
            </a>
          </li>
        ))}
      </ol>

      <div className="next-step">
        <div className="next-body">
          <div className="eyebrow accent">다음 할 일 · {stages.find((s) => s.id === next.stage)?.title}</div>
          <h3 className="next-title">{next.headline}</h3>
          <p className="muted">{next.detail}</p>
        </div>
        <div className="next-actions">
          {nextRun ? (
            <button className="btn primary" onClick={() => panel.show(nextRun.id)}>
              <span className="spinner light" /> AI가 진행 중이에요 · 보기
            </button>
          ) : (
            <>
              <ActionButton action={next.cta} primary />
              {next.secondary && <ActionButton action={next.secondary} />}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function applyTitle(input: string): string {
  const url = safeHttpUrl(input.split(/\s/)[0]);
  if (url) return `지원서 만들기 · ${new URL(url).hostname.replace(/^www\./, "")}`;
  return input ? "지원서 만들기 · 붙여넣은 공고" : "지원서 만들기 · 첨부한 공고";
}

function NewApplication() {
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const files = useAttachments();
  const ready = (text.trim() !== "" || files.paths.length > 0) && !files.uploading;
  const t = text.trim();
  const url = safeHttpUrl(t);
  return (
    <Card title="지원할 공고가 있나요?">
      <p className="muted">
        공고 링크를 붙여넣으면 AI가 나와 잘 맞는지 먼저 평가하고, 공고에 맞춘 이력서와 커버레터를 만들어 드려요. 링크가 열리지 않는 사이트라면 공고 내용을
        붙여넣거나 공고 캡처·PDF를 첨부해도 돼요.
      </p>
      <DropZone className="new-app" onFiles={files.add}>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} onPaste={files.onPaste} placeholder="https://… 공고 링크 또는 공고 내용" />
        <AttachmentTray attachments={files} />
      </DropZone>
      <div className="row wrap">
        <AttachButton onFiles={files.add} label="공고 캡처·PDF 첨부" />
        <span className="grow" />
        <button className="btn primary" disabled={!ready} onClick={() => setAsking(true)}>
          지원서 만들기 <Icon name="arrow" size={14} />
        </button>
      </div>
      {asking && (
        <ApplyDialog
          posting={t}
          url={url ?? undefined}
          title={applyTitle(t)}
          attachments={files.paths}
          onClose={() => setAsking(false)}
          onStarted={() => {
            setText("");
            files.clear();
          }}
        />
      )}
    </Card>
  );
}

const PIPELINE: { label: string; statuses: string[]; tone: string }[] = [
  { label: "작성됨", statuses: ["drafted"], tone: "draft" },
  { label: "지원함", statuses: ["applied"], tone: "applied" },
  { label: "면접", statuses: ["interview"], tone: "interview" },
  { label: "오퍼·합격", statuses: ["offer", "hired"], tone: "offer" },
  { label: "종료", statuses: ["rejected", "no_response", "no response", "withdrawn", "offer_declined", "offer declined"], tone: "closed" },
];

function Pipeline({ rows }: { rows: Record<string, string>[] }) {
  const max = Math.max(1, ...PIPELINE.map((p) => rows.filter((r) => p.statuses.includes((r.status ?? "").trim())).length));
  return (
    <ul className="pipeline">
      {PIPELINE.map((p) => {
        const n = rows.filter((r) => p.statuses.includes((r.status ?? "").trim())).length;
        return (
          <li key={p.label}>
            <a href="#/tracker" className="pipe-row">
              <span className="pipe-label">{p.label}</span>
              <span className="pipe-bar"><span className={`tone-${p.tone}`} style={{ width: `${(n / max) * 100}%` }} /></span>
              <b className="pipe-n">{n}</b>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

const MORE_TOOLS: [prompt: string, name: string, task?: string][] = [
  ["/expand", "expand"],
  ["/outcome followup", "followup", "후속 연락 메일 쓰기"],
  ["/upskill", "upskill"],
  ["/html-report", "html-report"],
];

const TOOL_TEXT: Record<string, { label: string; description: string }> = {
  ...COMMAND_LABEL,
  followup: { label: "후속 연락 메일 쓰기", description: "답이 없는 지원에 보낼 정중한 확인 메일 초안을 써요" },
};

export function Dashboard() {
  const status = useFetch<Status>("/api/status");
  const tracker = useFetch<Tracker>("/api/tracker", { live: true });
  const jobs = useFetch<Jobs>("/api/jobs", { live: true });
  const profile = useFetch<Profile>("/api/profile", { live: true });
  const files = useFetch<FileEntry[]>("/api/files", { live: true });
  const active = useActiveSessions();

  const rows = tracker.data?.rows ?? [];
  const jobList = jobs.data?.jobs ?? [];
  const loaded = profile.data !== null && tracker.data !== null && jobs.data !== null;
  const path = loaded
    ? journey({
        profileConfigured: profile.data?.configured ?? false,
        resumeUploaded: (files.data ?? []).some((f) => f.path.startsWith("documents/cv/")),
        jobs: jobList,
        rows,
      })
    : null;

  const open = rows.filter((r) => r._open === "1");
  const soon = open
    .filter((r) => {
      const d = daysUntil(r.deadline);
      return d !== null && d <= 7;
    })
    .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""));
  const ranked = recommended(untracked(jobList, rows));
  const issues = status.data ? setupIssues(status.data).filter((i) => i.code !== "untrusted") : [];

  return (
    <div className="stack home">
      <PageHeader title="홈" description="지금 어디까지 왔는지, 다음에 무엇을 하면 되는지 한눈에 보여 드려요." />
      <ErrorBox error={status.error ?? tracker.error ?? jobs.error} />

      {issues.length > 0 && (
        <div className="notice">
          <b>확인이 필요해요:</b> {issues.map((i) => i.text).join(" · ")} <a href="#/settings">설정에서 확인하기</a>
        </div>
      )}

      {status.data && !status.data.trusted && <TrustCard status={status.data} onDone={status.reload} />}

      {path ? <Journey {...path} active={active} /> : <section className="card journey-card skeleton" aria-busy="true" />}

      <NewApplication />

      <div className="grid2">
        <Card title="내 지원 현황" actions={<a href="#/tracker">전체 보기</a>}>
          {rows.length === 0 ? (
            <EmptyState icon="clipboard" title="아직 지원한 곳이 없어요">
              위에 공고 링크를 넣거나 추천 공고에서 첫 지원서를 만들어 보세요.
            </EmptyState>
          ) : (
            <Pipeline rows={rows} />
          )}
          {soon.length > 0 && (
            <>
              <h3>마감이 다가와요 (7일 이내)</h3>
              <ul className="plain">
                {soon.map((r, i) => (
                  <li key={i}>
                    <b>{r.company}</b> · {r.role} — <Deadline date={r.deadline} /> <StatusChip status={r.status} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="추천 공고" actions={<a href="#/jobs">전체 보기</a>}>
          {ranked.length === 0 ? (
            <EmptyState icon="briefcase" title="아직 추천할 공고가 없어요">
              공고를 모으고 평가하면 내 프로필과 잘 맞는 순서로 보여 드려요.
            </EmptyState>
          ) : (
            <ul className="plain">
              {ranked.map((j) => (
                <li key={String(j.key)} className="row job-row">
                  <span className={`score-badge sm ${fitBand(j.rank_score as number).tone}`} title={fitBand(j.rank_score as number).label}>
                    <b>{String(j.rank_score)}</b>
                  </span>
                  <span className="grow job-row-text">
                    <span className="job-company">{String(j.company ?? "")}</span>
                    <span className="ellipsis">{String(j.title ?? "")}</span>
                  </span>
                  {typeof j.url === "string" && (
                    <ApplyButton posting={j.url} url={j.url} jobKey={String(j.key)} title={`지원서 만들기 · ${String(j.company ?? "")} / ${String(j.title ?? "")}`} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="더 많은 AI 도구">
        <div className="tiles">
          {MORE_TOOLS.map(([prompt, name, task]) => (
            <div key={name} className="tile">
              <div>
                <b>{TOOL_TEXT[name]!.label}</b>
                <div className="muted small">{TOOL_TEXT[name]!.description}</div>
              </div>
              <CommandButton prompt={prompt} label="시작" task={task} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

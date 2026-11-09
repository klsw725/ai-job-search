import { useEffect, useState } from "react";
import { fileUrl, runCommand, safeHttpUrl, useFetch, useRuns, type ApplyRun } from "../api.ts";
import { RUN_STATE_TEXT, RunResult, runStateKey } from "../apply.tsx";
import { COLUMNS, applicationId, canonicalStatus, columnOf, movedRow, parseApplicationId, planMove, runForRow, type ColumnId } from "../pipeline.ts";
import { SelfIntroCard } from "../selfIntro.tsx";
import { CommandButton, Deadline, EmptyState, ErrorBox, Icon, PageHeader, StatusChip } from "../ui.tsx";
import { MoveDialog, move, pdfFor, type Pending } from "./Tracker.tsx";

type Row = Record<string, string>;
type FileEntry = { path: string };

function EditRequest({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        <Icon name="sparkle" size={14} /> 이 부분 고쳐 줘
      </button>
    );
  }
  return (
    <div className="edit-box grow">
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="예: 자기소개서 첫 문단을 더 짧게, 프로젝트 순서를 RAG 플랫폼 먼저" autoFocus />
      <div className="row">
        <button
          className="btn primary small-btn"
          disabled={!text.trim()}
          onClick={() =>
            runCommand(
              `${row.company} ${row.role} 지원서(이력서 ${row.cv_file || "-"}, 커버레터 ${row.cover_letter_file || "-"})를 다음 요청대로 고쳐 줘. 사실은 프로필에 있는 것만 쓰고, 고친 뒤 PDF를 다시 만들어 레이아웃을 검사해 줘.\n\n${text.trim()}`,
              { title: `지원서 수정 · ${row.company} / ${row.role}`, kind: "apply-edit" },
            )
              .then(() => {
                setText("");
                setOpen(false);
              })
              .catch((e: Error) => setErr(e.message))
          }
        >
          AI에게 수정 요청
        </button>
        <button className="btn ghost small-btn" onClick={() => setOpen(false)}>
          취소
        </button>
        <ErrorBox error={err} />
      </div>
    </div>
  );
}

function RowDocuments({ row, files }: { row: Row; files: Set<string> }) {
  const docs = [
    { label: "이력서", path: pdfFor(row.cv_file, files) },
    { label: "커버레터", path: pdfFor(row.cover_letter_file, files) },
  ].filter((d): d is { label: string; path: string } => Boolean(d.path));
  const [tab, setTab] = useState(0);
  const current = docs[tab];
  if (!current) return <p className="muted">이 지원의 PDF 서류를 찾지 못했어요.</p>;
  return (
    <div className="run-previews">
      <div className="seg" role="group" aria-label="서류">
        {docs.map((d, i) => (
          <button key={d.path} aria-pressed={i === tab} className={i === tab ? "on" : ""} onClick={() => setTab(i)}>
            {d.label}
          </button>
        ))}
        <a className="btn ghost small-btn" href={fileUrl(current.path, true)} download>
          <Icon name="download" size={14} /> 받기
        </a>
      </div>
      <iframe className="pdf" src={fileUrl(current.path)} title={current.label} />
    </div>
  );
}

export function Application({ id }: { id: string }) {
  const tracker = useFetch<{ rows: Row[] }>("/api/tracker", { live: true });
  const files = useFetch<FileEntry[]>("/api/files", { live: true });
  const runs = useRuns();
  const [pending, setPending] = useState<Pending | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = parseApplicationId(id);
  const row = key ? (tracker.data?.rows ?? []).find((r) => r.date === key.date && r.company === key.company && r.role === key.role) : undefined;
  const moved = key && tracker.data && !row ? movedRow(tracker.data.rows, key) : undefined;
  const movedId = moved ? applicationId(moved) : null;
  useEffect(() => {
    if (movedId) location.replace(`#/applications/${movedId}`);
  }, [movedId]);
  const reload = () => {
    tracker.reload();
    runs.reload();
  };

  if (!key) return <EmptyState icon="clipboard" title="지원을 찾을 수 없어요" action={<a className="btn" href="#/tracker">내 지원으로</a>} />;
  if (movedId) return null;
  if (tracker.data && !row) {
    return <EmptyState icon="clipboard" title="지원 기록에서 이 지원을 찾을 수 없어요" action={<a className="btn" href="#/tracker">내 지원으로</a>} />;
  }
  if (!row) return <section className="card journey-card skeleton" aria-busy="true" />;

  const fileSet = new Set((files.data ?? []).map((f) => f.path));
  const applyRuns = (runs.data ?? []).filter((r): r is ApplyRun => r.kind === "apply");
  const run = runForRow(applyRuns, row);
  const column = columnOf(row.status);
  const source = safeHttpUrl(row.source);
  const follow = (next: Row) => {
    reload();
    if (next.date !== row.date) location.replace(`#/applications/${applicationId(next)}`);
  };
  const onMove = (to: ColumnId) => {
    const plan = planMove(row.status, to);
    if (!plan) return;
    setErr(null);
    if (plan.kind === "direct") move(row, plan.status).then(follow).catch((e: Error) => setErr(e.message));
    else setPending({ row, to, plan });
  };

  return (
    <div className="stack">
      <a className="back-link small" href="#/tracker">
        ← 내 지원
      </a>
      <PageHeader
        title={row.company ?? ""}
        description={row.role}
        actions={
          <label className="row small">
            <span className="muted">단계</span>
            <select value={column} onChange={(e) => onMove(e.target.value as ColumnId)}>
              {COLUMNS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <div className="app-facts">
        <StatusChip status={canonicalStatus(row.status)} />
        {row.fit_rating && <span>적합도 {row.fit_rating}</span>}
        {row.date && <span>{column === "drafted" ? "작성일" : "지원일"} {row.date}</span>}
        {row.deadline && (
          <span>
            마감 <Deadline date={row.deadline} />
          </span>
        )}
        {source && (
          <a href={source} target="_blank" rel="noopener noreferrer">
            <Icon name="open" size={13} /> 공고 원문
          </a>
        )}
      </div>
      <ErrorBox error={err} />
      {run ? (
        <RunResult
          run={run}
          onChange={reload}
          actions={
            <>
              {column === "drafted" && (
                <button className="btn primary" onClick={() => onMove("applied")}>
                  지원했어요
                </button>
              )}
              <EditRequest row={row} />
            </>
          }
        />
      ) : (
        <section className="card">
          <header className="card-head">
            <h2>지원 서류</h2>
          </header>
          <RowDocuments row={row} files={fileSet} />
          <div className="row wrap">
            {column === "drafted" && (
              <button className="btn primary" onClick={() => onMove("applied")}>
                지원했어요
              </button>
            )}
            <EditRequest row={row} />
          </div>
        </section>
      )}
      <SelfIntroCard row={row} runs={runs.data ?? []} applyRun={run} onChange={reload} />
      <section className="card">
        <header className="card-head">
          <h2>다음 할 일</h2>
        </header>
        {row.notes && (
          <p className="small">
            <b>메모</b> <span className="muted">{row.notes}</span>
          </p>
        )}
        <div className="row wrap">
          <CommandButton prompt={`/interview ${row.company} ${row.role}`} label="면접 준비" task={`면접 준비 · ${row.company} / ${row.role}`} />
          {column !== "drafted" && column !== "closed" && (
            <CommandButton prompt={`/outcome followup ${row.company} ${row.role}`} label="후속 연락 메일 쓰기" task={`후속 연락 메일 · ${row.company} / ${row.role}`} />
          )}
          <CommandButton prompt={`/outcome ${row.company} ${row.role}`} label="면접 단계·피드백 기록" task={`결과 기록 · ${row.company} / ${row.role}`} />
        </div>
      </section>
      {pending && (
        <MoveDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={(next) => {
            setPending(null);
            follow(next);
          }}
        />
      )}
    </div>
  );
}

export function RunPage({ id }: { id: string }) {
  const runs = useRuns();
  const run = runs.data?.find((r) => r.id === id);
  if (runs.data && !run) return <EmptyState icon="sparkle" title="작업을 찾을 수 없어요" action={<a className="btn" href="#/jobs">공고 찾기로</a>} />;
  if (!run) return <section className="card journey-card skeleton" aria-busy="true" />;
  const row = run.checks?.row;
  if (run.kind === "self-intro") {
    return (
      <EmptyState
        icon="clipboard"
        title={run.title}
        action={row ? <a className="btn primary" href={`#/applications/${applicationId(row)}`}>지원 상세에서 답변 보기</a> : <a className="btn" href="#/tracker">내 지원으로</a>}
      >
        자기소개서 답변은 지원 상세 화면에서 보고 고칠 수 있어요.
      </EmptyState>
    );
  }
  return (
    <div className="stack">
      <a className="back-link small" href="#/jobs">
        ← 공고 찾기
      </a>
      <PageHeader title={run.result ? `${run.result.company}` : run.title.replace(/^지원서 만들기 · /, "")} description={run.result?.role ?? RUN_STATE_TEXT[runStateKey(run)]} />
      {row && (
        <a className="btn" href={`#/applications/${applicationId(row)}`}>
          지원 상세 보기
        </a>
      )}
      <RunResult run={run} onChange={runs.reload} />
    </div>
  );
}

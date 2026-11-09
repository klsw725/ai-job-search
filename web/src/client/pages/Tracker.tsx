import { Fragment, useState, type DragEvent } from "react";
import { fileUrl, safeHttpUrl, sendJSON, useFetch } from "../api.ts";
import { COLUMNS, FINAL_LABEL, FINAL_STATUSES, applicationId, canonicalStatus, columnOf, planMove, rowKey, type ColumnId } from "../pipeline.ts";
import { STATUS_LABEL } from "../labels.ts";
import { Card, CommandButton, Deadline, EmptyState, ErrorBox, Icon, Modal, PageHeader, StatusChip } from "../ui.tsx";

type Row = Record<string, string>;
type FileEntry = { path: string };
export type Pending = { row: Row; to: ColumnId; plan: NonNullable<ReturnType<typeof planMove>> };

export function pdfFor(source: string | undefined, files: Set<string>): string | null {
  if (!source) return null;
  const pdf = source.replace(/\.(typ|tex)$/i, ".pdf");
  return files.has(pdf) ? pdf : null;
}

function today() {
  const d = new Date();
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// Resolves to the row as the tool wrote it: its date changes when a draft is submitted.
export async function move(row: Row, status: string, note?: string): Promise<Row> {
  const out = await sendJSON<{ row?: Row }>("/api/tracker/row", "PATCH", {
    company: row.company,
    role: row.role,
    date: row.date,
    expect: canonicalStatus(row.status),
    status,
    note: note?.trim() || undefined,
  });
  return out.row ?? row;
}

function Docs({ row, files }: { row: Row; files: Set<string> }) {
  const cv = pdfFor(row.cv_file, files);
  const cover = pdfFor(row.cover_letter_file, files);
  if (!cv && !cover) return null;
  return (
    <span className="app-docs" onClick={(e) => e.stopPropagation()}>
      {cv && (
        <a href={fileUrl(cv)} target="_blank" rel="noopener noreferrer">
          <Icon name="file" size={12} /> 이력서
        </a>
      )}
      {cover && (
        <a href={fileUrl(cover)} target="_blank" rel="noopener noreferrer">
          <Icon name="file" size={12} /> 커버레터
        </a>
      )}
    </span>
  );
}

function AppCard({ row, files, onMove }: { row: Row; files: Set<string>; onMove: (row: Row, to: ColumnId) => void }) {
  const column = columnOf(row.status);
  return (
    <li
      className="app-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-application", rowKey(row));
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <a className="app-card-link" href={`#/applications/${applicationId(row)}`}>
        <span className="job-company">{row.company}</span>
        <b className="app-role">{row.role}</b>
      </a>
      <div className="app-meta">
        {column === "closed" && <StatusChip status={canonicalStatus(row.status)} />}
        {row.fit_rating && <span>적합도 {row.fit_rating}</span>}
        {row.deadline && column === "drafted" && <Deadline date={row.deadline} />}
        {row.date && <span>{column === "drafted" ? "작성" : "지원"} {row.date.slice(5).replace("-", "/")}</span>}
      </div>
      <div className="app-foot">
        <Docs row={row} files={files} />
        <label className="app-move">
          <span className="sr-only">상태 바꾸기</span>
          <select
            value={column}
            onChange={(e) => onMove(row, e.target.value as ColumnId)}
            aria-label={`${row.company} ${row.role} 상태 바꾸기`}
          >
            {COLUMNS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id === column ? `${c.label} (지금)` : `${c.label}(으)로`}
              </option>
            ))}
          </select>
        </label>
      </div>
    </li>
  );
}

function Board({ rows, files, onMove }: { rows: Row[]; files: Set<string>; onMove: (row: Row, to: ColumnId) => void }) {
  const [over, setOver] = useState<ColumnId | null>(null);
  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  const drop = (to: ColumnId) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const row = byKey.get(e.dataTransfer.getData("text/x-application"));
    if (row) onMove(row, to);
  };
  return (
    <div className="board">
      {COLUMNS.map((c) => {
        const items = rows.filter((r) => columnOf(r.status) === c.id);
        return (
          <section
            key={c.id}
            className={`board-col col-${c.id}${over === c.id ? " over" : ""}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("text/x-application")) return;
              e.preventDefault();
              setOver(c.id);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={drop(c.id)}
            aria-label={`${c.label} ${items.length}건`}
          >
            <header className="board-col-head" title={c.hint}>
              <span className={`col-dot dot-${c.id}`} />
              <b>{c.label}</b>
              <span className="n">{items.length}</span>
            </header>
            <ul className="board-list">
              {items.map((r) => (
                <AppCard key={rowKey(r)} row={r} files={files} onMove={onMove} />
              ))}
              {items.length === 0 && <li className="board-empty muted small">{c.hint}</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function MoveDialog({ pending, onDone, onClose }: { pending: Pending; onDone: (row: Row) => void; onClose: () => void }) {
  const { row, plan } = pending;
  const [final, setFinal] = useState<string>("rejected");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const status = plan.kind === "choose-final" ? final : plan.status;
  const target = STATUS_LABEL[status] ?? status;
  return (
    <Modal title={plan.kind === "choose-final" ? "어떻게 끝났나요?" : `${target}(으)로 옮길까요?`} onClose={onClose}>
      <p className="muted">
        <b>{row.company}</b> · {row.role}
      </p>
      {plan.kind === "choose-final" && (
        <fieldset className="final-choice">
          <legend className="sr-only">결과</legend>
          {FINAL_STATUSES.map((s) => (
            <label key={s} className={`option${final === s ? " on" : ""}`}>
              <input type="radio" name="final" value={s} checked={final === s} onChange={() => setFinal(s)} />
              {FINAL_LABEL[s]}
            </label>
          ))}
        </fieldset>
      )}
      {plan.kind === "confirm-submit" && <p className="notice small">지원 날짜가 오늘({today()})로 기록돼요. 작성한 날짜 대신 실제로 낸 날짜를 남기기 위해서예요.</p>}
      {(plan.kind === "choose-final" || status === "interview" || status === "offer") && (
        <p className="muted small">지원 서류 사본과 결과 기록(outcome)이 지원 보관함에 함께 저장돼요.</p>
      )}
      <label className="stack-tight">
        <span className="small muted">메모 (선택)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 1차 기술 면접 금요일" maxLength={300} />
      </label>
      <ErrorBox error={err} />
      <div className="row modal-actions">
        <button className="btn ghost" onClick={onClose}>
          취소
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            move(row, status, note)
              .then(onDone)
              .catch((e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy && <span className="spinner" />} {target}(으)로 옮기기
        </button>
      </div>
    </Modal>
  );
}

function Table({ rows, files }: { rows: Row[]; files: Set<string> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title={`지원 ${rows.length}건`}>
      <table>
        <thead>
          <tr>
            <th>날짜</th>
            <th>회사</th>
            <th>직무</th>
            <th>상태</th>
            <th>적합도</th>
            <th>마감</th>
            <th>서류</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = rowKey(r);
            const source = safeHttpUrl(r.source);
            return (
              <Fragment key={key}>
                <tr className="clickable" onClick={() => setOpen(open === key ? null : key)}>
                  <td>{r.date}</td>
                  <td>{r.company}</td>
                  <td>{r.role}</td>
                  <td>
                    <StatusChip status={canonicalStatus(r.status)} />
                  </td>
                  <td>{r.fit_rating}</td>
                  <td>
                    <Deadline date={r.deadline} />
                  </td>
                  <td>
                    <Docs row={r} files={files} />
                  </td>
                </tr>
                {open === key && (
                  <tr className="detail">
                    <td colSpan={7}>
                      <div className="stack">
                        {r.notes && (
                          <div>
                            <b>메모</b> {r.notes}
                          </div>
                        )}
                        {r.contact_person && (
                          <div>
                            <b>담당자</b> {r.contact_person}
                          </div>
                        )}
                        {source && (
                          <div>
                            <b>공고 원문</b>{" "}
                            <a href={source} target="_blank" rel="noopener noreferrer">
                              {source}
                            </a>
                          </div>
                        )}
                        <div className="row wrap">
                          <a className="btn" href={`#/applications/${applicationId(r)}`}>
                            지원 상세 보기
                          </a>
                          <CommandButton prompt={`/interview ${r.company} ${r.role}`} label="면접 준비" task={`면접 준비 · ${r.company} / ${r.role}`} />
                          <CommandButton prompt={`/outcome followup ${r.company} ${r.role}`} label="후속 연락 메일 쓰기" task={`후속 연락 메일 · ${r.company} / ${r.role}`} />
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

export function Tracker() {
  const { data, error, reload } = useFetch<{ exists: boolean; header: string[]; rows: Row[] }>("/api/tracker", { live: true });
  const files = useFetch<FileEntry[]>("/api/files", { live: true });
  const [view, setView] = useState<"board" | "table">("board");
  const [pending, setPending] = useState<Pending | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const fileSet = new Set((files.data ?? []).map((f) => f.path));
  const rows = [...(data?.rows ?? [])].reverse();
  const none = data !== null && rows.length === 0 && !error;

  const onMove = (row: Row, to: ColumnId) => {
    const plan = planMove(row.status, to);
    if (!plan) return;
    setMoveError(null);
    if (plan.kind === "direct") {
      move(row, plan.status)
        .then(() => reload())
        .catch((e: Error) => {
          setMoveError(e.message);
          reload();
        });
    } else {
      setPending({ row, to, plan });
    }
  };

  return (
    <div className="stack">
      <PageHeader
        title="내 지원"
        description="카드를 끌어다 놓거나 카드의 상태 메뉴로 단계를 바꿔요. 카드를 누르면 지원 상세로 가요."
        actions={
          <>
            <button className="btn ghost" onClick={reload} title="새로고침" aria-label="새로고침">
              <Icon name="refresh" size={15} />
            </button>
            {!none && (
              <CommandButton prompt="/outcome followup" label="후속 연락 메일 쓰기" hint="답이 없는 지원에 보낼 확인 메일 초안을 써요" />
            )}
          </>
        }
      />
      <ErrorBox error={error ?? moveError} />
      {none ? (
        <EmptyState
          icon="clipboard"
          title="아직 지원 기록이 없어요"
          action={
            <>
              <a className="btn primary" href="#/jobs">
                추천 공고 보기
              </a>
              <a className="btn" href="#/">
                공고 링크로 지원서 만들기
              </a>
            </>
          }
        >
          지원서를 만들면 여기에 쌓이고, 서류 결과·면접·합격 소식까지 이어서 기록할 수 있어요.
        </EmptyState>
      ) : (
        <>
          <div className="seg" role="group" aria-label="보기 방식">
            <button aria-pressed={view === "board"} className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
              보드
            </button>
            <button aria-pressed={view === "table"} className={view === "table" ? "on" : ""} onClick={() => setView("table")}>
              표
            </button>
          </div>
          {view === "board" ? <Board rows={rows} files={fileSet} onMove={onMove} /> : <Table rows={rows} files={fileSet} />}
        </>
      )}
      {pending && (
        <MoveDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

import { useState } from "react";
import {
  bindAppThread,
  deleteAppThread,
  openAppThread,
  proposalAction,
  safeHttpUrl,
  saveNote,
  startAppThread,
  stepAction,
  type AppDetail,
  type AppIdentity,
  type Proposal,
  type Step,
  type ThreadView,
} from "./api.ts";
import { panel } from "./panel.ts";
import { Deadline, ErrorBox, Icon, formatTime } from "./ui.tsx";

type Row = Record<string, string>;

export const STEP_KIND_LABEL: Record<string, string> = { coding_test: "코딩테스트", assignment: "과제", interview: "면접", document: "서류 제출", other: "기타" };

const STARTERS = ["코딩테스트·과제 준비 도와줘", "이 공고에서 확인할 점 정리해 줘", "지원 전에 챙길 일정 뽑아 줘", "이 회사 채용 전형 알려 줘", "메모 정리해 줘"];

const identity = (row: Row): AppIdentity => ({ date: row.date ?? "", company: row.company ?? "", role: row.role ?? "" });
const shortDate = (ms: number) => formatTime(ms);

function GuardLine({ guard }: { guard: AppDetail["guard"] }) {
  if (guard.verdict === "clean") return <p className="guard ok small"><Icon name="check" size={13} /> 공고 원문 검사를 통과했어요.</p>;
  if (guard.verdict === "flagged") return <p className="guard warn small">⚠ 공고 원문에 숨겨진 지시나 보이지 않는 글자가 {guard.findings}건 있었어요. AI는 그 내용을 따르지 않아요.</p>;
  if (guard.verdict === "missing") return <p className="guard small muted">보관된 공고 원문이 없어요. 물어보면 AI가 지원 기록의 공고 링크를 열어 봐요.</p>;
  return <p className="guard small muted">공고 원문 검사를 하지 못했어요. AI는 공고를 참고 자료로만 읽어요.</p>;
}

function LinkButton({ t, app, onChange }: { t: ThreadView; app: AppIdentity; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button className="btn small-btn" onClick={() => bindAppThread(t.id, app).then(onChange).catch((e: Error) => setErr(e.message))}>
        이 지원에 연결
      </button>
      <ErrorBox error={err} />
    </>
  );
}

function ThreadItem({ t, app, onChange }: { t: ThreadView; app: AppIdentity; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const open = () => (t.sessionId ? Promise.resolve(panel.show(t.sessionId)) : openAppThread(t.id)).catch((e: Error) => setErr(e.message));
  return (
    <li className="thread-item">
      <span className="grow">
        {shortDate(t.lastActivity)}
        {t.earlier && <span className="muted small"> · 이전 지원({t.application.date})</span>}
        {t.sessionId && <span className="muted small"> · 열려 있음</span>}
        {!t.linked && <span className="muted small"> · 날짜가 바뀌기 전 대화예요</span>}
      </span>
      {!t.linked && <LinkButton t={t} app={app} onChange={onChange} />}
      {(t.sessionId || t.resumable) && (
        <button className="btn ghost small-btn" onClick={() => void open()}>
          {t.sessionId ? "보기" : "이어서 대화"}
        </button>
      )}
      <button
        className="btn ghost small-btn"
        aria-label="대화 기록 지우기"
        onClick={() => {
          if (!confirm("이 대화를 목록에서 지울까요? 저장한 메모와 단계는 그대로 남아요.")) return;
          deleteAppThread(t.id).then(onChange).catch((e: Error) => setErr(e.message));
        }}
      >
        <Icon name="x" size={12} />
      </button>
      <ErrorBox error={err} />
    </li>
  );
}

function ProposalCard({ thread, p, app, onChange }: { thread: ThreadView; p: Proposal; app: AppIdentity; onChange: () => void }) {
  const [memo, setMemo] = useState(!!p.memo);
  const [picked, setPicked] = useState<number[]>(p.steps.map((_, i) => i));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = (body: Parameters<typeof proposalAction>[2]) => {
    setBusy(true);
    setErr(null);
    proposalAction(thread.id, p.id, body)
      .then(onChange)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="proposal">
      <div className="points-head">AI가 남겨 두자고 제안했어요{thread.earlier ? ` · 이전 지원(${thread.application.date})` : ""}</div>
      <ul className="plain proposal-items">
        {p.memo && (
          <li>
            <label className="check">
              <input type="checkbox" checked={memo} onChange={(e) => setMemo(e.target.checked)} />
              <span>
                <b>메모</b> <span className="pre-wrap">{p.memo}</span>
              </span>
            </label>
          </li>
        )}
        {p.steps.map((s, i) => (
          <li key={i}>
            <label className="check">
              <input type="checkbox" checked={picked.includes(i)} onChange={(e) => setPicked(e.target.checked ? [...picked, i] : picked.filter((x) => x !== i))} />
              <span>
                <b>{STEP_KIND_LABEL[s.kind] ?? s.kind}</b> {s.title}
                {s.due && <span className="muted"> · {s.due}</span>}
                {s.note && <span className="muted"> · {s.note}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorBox error={err} />
      {!thread.linked && <p className="small muted">이 대화는 지원 날짜가 바뀌기 전에 시작됐어요. 이 지원에 연결해야 저장할 수 있어요.</p>}
      <div className="row">
        {thread.linked ? (
          <button className="btn primary small-btn" disabled={busy || (!memo && !picked.length)} onClick={() => act({ save: true, memo, steps: picked })}>
            고른 항목 저장
          </button>
        ) : (
          <LinkButton t={thread} app={app} onChange={onChange} />
        )}
        <button className="btn ghost small-btn" disabled={busy} onClick={() => act({ save: false })}>
          무시
        </button>
      </div>
    </div>
  );
}

export function ApplicationChatCard({ row, detail, onChange }: { row: Row; detail: AppDetail | null; onChange: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const threads = detail?.threads ?? [];
  const mine = threads.filter((t) => !t.earlier);
  const earlier = threads.filter((t) => t.earlier);
  const pending = threads.flatMap((t) => t.proposals.filter((p) => p.state === "pending").map((p) => ({ t, p })));
  const send = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    startAppThread(identity(row), text.trim())
      .then(() => {
        setText("");
        onChange();
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <section className="card app-chat">
      <header className="card-head">
        <h2>이 공고에 대해 AI와 이야기하기</h2>
      </header>
      {detail && <GuardLine guard={detail.guard} />}
      {pending.map(({ t, p }) => (
        <ProposalCard key={p.id} thread={t} p={p} app={identity(row)} onChange={onChange} />
      ))}
      <div className="chips">
        {STARTERS.map((s) => (
          <button key={s} className="chip" onClick={() => setText(s)}>
            {s}
          </button>
        ))}
      </div>
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
        }}
        placeholder="이 공고를 보고 궁금한 점이나 준비할 일을 적어 주세요. 예: 코딩테스트 안내가 있는데 어떻게 준비하면 좋을까?"
        aria-label="AI에게 할 말"
      />
      <ErrorBox error={err} />
      <div className="row wrap">
        <button className="btn primary" disabled={!text.trim() || busy} onClick={send}>
          {busy ? <span className="spinner light" /> : <Icon name="sparkle" size={15} />} 새 대화 시작
        </button>
        <span className="muted small grow">대화는 오른쪽 AI 작업 창에서 이어져요.</span>
      </div>
      {mine.length > 0 && (
        <div>
          <div className="points-head">이 지원의 대화 {mine.length}개</div>
          <ul className="plain thread-list">
            {mine.map((t) => (
              <ThreadItem key={t.id} t={t} app={identity(row)} onChange={onChange} />
            ))}
          </ul>
        </div>
      )}
      {earlier.length > 0 && (
        <details className="small">
          <summary className="muted">같은 회사·직무의 이전 지원 대화 {earlier.length}개</summary>
          <ul className="plain thread-list">
            {earlier.map((t) => (
              <ThreadItem key={t.id} t={t} app={identity(row)} onChange={onChange} />
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">이 대화는 파일을 바꾸지 않아요. 남길 내용은 답변의 [메모로 저장]이나 AI 제안의 [고른 항목 저장]으로 남겨요.</p>
    </section>
  );
}

export function NotesCard({ row, detail, onChange }: { row: Row; detail: AppDetail | null; onChange: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const notes = detail?.notes ?? [];
  return (
    <section className="card notes-card">
      <header className="card-head">
        <h2>메모</h2>
      </header>
      {notes.length === 0 && <p className="muted small">아직 메모가 없어요. 코딩테스트 안내, 담당자 연락, 준비할 것 등을 남겨 두세요.</p>}
      <ul className="plain note-list">
        {[...notes].reverse().map((n, i) => (
          <li key={i} className="note">
            <div className="muted small">
              {n.at ?? "직접 적은 메모"}
              {n.source && ` · ${n.source}`}
              {n.application && n.application !== row.date && ` · 이전 지원(${n.application})`}
            </div>
            <div className="pre-wrap">{n.text}</div>
          </li>
        ))}
      </ul>
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="메모 추가 (예: 코딩테스트는 프로그래머스, 11/15 23:59까지)" aria-label="메모 추가" />
      <ErrorBox error={err} />
      <div className="row">
        <button
          className="btn small-btn"
          disabled={!text.trim() || busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            saveNote({ application: identity(row), text: text.trim() })
              .then(() => {
                setText("");
                onChange();
              })
              .catch((e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          메모 추가
        </button>
      </div>
    </section>
  );
}

const byDue = (a: Step, b: Step) => (a.status === "todo" ? 0 : 1) - (b.status === "todo" ? 0 : 1) || (a.due ?? "9999").localeCompare(b.due ?? "9999");

function AddStep({ row, onChange }: { row: Row; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("coding_test");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [link, setLink] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!open) {
    return (
      <button className="btn ghost small-btn" onClick={() => setOpen(true)}>
        + 단계 추가
      </button>
    );
  }
  return (
    <div className="add-step">
      <div className="row wrap">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="단계 종류">
          {Object.entries(STEP_KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="이름 (예: 코딩테스트 · 프로그래머스)" aria-label="단계 이름" />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="마감일" />
      </div>
      <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="링크 (선택)" aria-label="링크" />
      <ErrorBox error={err} />
      <div className="row">
        <button
          className="btn primary small-btn"
          disabled={!title.trim()}
          onClick={() =>
            stepAction(identity(row), { add: { kind: kind as Step["kind"], title: title.trim(), ...(due ? { due } : {}), ...(link.trim() ? { link: link.trim() } : {}) } })
              .then(() => {
                setOpen(false);
                setTitle("");
                setDue("");
                setLink("");
                onChange();
              })
              .catch((e: Error) => setErr(e.message))
          }
        >
          추가
        </button>
        <button className="btn ghost small-btn" onClick={() => setOpen(false)}>
          취소
        </button>
      </div>
    </div>
  );
}

export function StepsCard({ row, detail, column, onChange, onSuggestMove }: { row: Row; detail: AppDetail | null; column: string; onChange: () => void; onSuggestMove: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [suggest, setSuggest] = useState(false);
  const steps = [...(detail?.steps ?? [])].sort(byDue);
  const act = (op: Parameters<typeof stepAction>[1], after?: () => void) =>
    stepAction(identity(row), op)
      .then(() => {
        after?.();
        onChange();
      })
      .catch((e: Error) => setErr(e.message));
  return (
    <section className="card steps-card">
      <header className="card-head">
        <h2>전형 단계</h2>
      </header>
      {steps.length === 0 && <p className="muted small">코딩테스트, 과제, 면접 일정을 여기에 모아 둬요. 직접 넣거나 AI 대화에서 제안받아 저장할 수 있어요.</p>}
      <ul className="plain step-list">
        {steps.map((s) => {
          const link = safeHttpUrl(s.link);
          return (
            <li key={s.id} className={`step ${s.status}`}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.status === "done"}
                  aria-label={`${s.title} 완료`}
                  onChange={(e) =>
                    act({ set: { id: s.id, status: e.target.checked ? "done" : "todo" } }, () =>
                      setSuggest(e.target.checked && column === "applied" && (s.kind === "coding_test" || s.kind === "assignment")),
                    )
                  }
                />
                <span>
                  <b>{STEP_KIND_LABEL[s.kind] ?? s.kind}</b> {s.title}
                </span>
              </label>
              <span className="grow" />
              {s.due && (s.status === "todo" ? <Deadline date={s.due} /> : <span className="muted small">{s.due}</span>)}
              {link && (
                <a className="btn ghost small-btn" href={link} target="_blank" rel="noopener noreferrer">
                  <Icon name="open" size={13} /> 열기
                </a>
              )}
              <button className="btn ghost small-btn" aria-label={`${s.title} 지우기`} onClick={() => confirm(`"${s.title}" 단계를 지울까요?`) && void act({ remove: s.id })}>
                <Icon name="x" size={12} />
              </button>
              {s.note && <div className="muted small step-note">{s.note}</div>}
            </li>
          );
        })}
      </ul>
      {detail?.stepsBroken && <p className="notice small">전형 단계 파일을 읽을 수 없어서 보이는 것만 보여 드려요. 파일을 고치기 전에는 단계를 바꾸지 않아요.</p>}
      {detail?.orphans.map((o) => (
        <div key={o.date} className="notice small row wrap">
          <span className="grow">
            지원 날짜가 바뀌기 전({o.date})에 저장된 단계가 {o.count}개 있어요.
          </span>
          <button className="btn small-btn" onClick={() => void act({ adopt: o.date })}>
            이 지원으로 옮기기
          </button>
        </div>
      ))}
      {!!detail?.otherSteps && <p className="muted small">같은 회사·직무의 다른 지원에 저장된 단계 {detail.otherSteps}개는 여기 보이지 않아요.</p>}
      {suggest && (
        <div className="notice small row wrap">
          <span className="grow">단계를 마쳤어요. 면접 단계로 옮길까요?</span>
          <button
            className="btn primary small-btn"
            onClick={() => {
              setSuggest(false);
              onSuggestMove();
            }}
          >
            면접으로 옮기기
          </button>
          <button className="btn ghost small-btn" onClick={() => setSuggest(false)}>
            나중에
          </button>
        </div>
      )}
      <ErrorBox error={err} />
      <AddStep row={row} onChange={onChange} />
    </section>
  );
}

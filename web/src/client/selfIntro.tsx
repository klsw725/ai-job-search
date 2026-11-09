import { useState } from "react";
import { dismissRun, resumeRun, runCommand, startSelfIntro, type ApplyRun, type Run, type SelfIntroQuestion, type SelfIntroRun } from "./api.ts";
import { panel } from "./panel.ts";
import { columnOf, runForRow } from "./pipeline.ts";
import { parsePastedQuestions } from "./questions.ts";
import { ErrorBox, Icon, Markdown } from "./ui.tsx";
import { COUNT_LABEL, MAX_QUESTIONS, measure, type CountMode, type Counts, type SelfIntroAnswer } from "../server/selfIntro.ts";

type Row = Record<string, string>;

const blank = (): SelfIntroQuestion => ({ question: "", count: "with_spaces" });

export function QuestionsEditor({ value, onChange }: { value: SelfIntroQuestion[]; onChange: (q: SelfIntroQuestion[]) => void }) {
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const set = (i: number, patch: Partial<SelfIntroQuestion>) => onChange(value.map((q, n) => (n === i ? { ...q, ...patch } : q)));
  return (
    <div className="q-editor">
      {pasting ? (
        <div className="stack-tight">
          <textarea
            rows={6}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={"지원 사이트의 문항을 그대로 복사해 붙여넣어 주세요. 예:\n1. 지원 동기와 입사 후 포부를 작성해 주세요. (700자 이내)\n2. 직무 관련 경험을 작성해 주세요. (1000자, 공백 포함)"}
            autoFocus
          />
          <div className="row">
            <button
              className="btn primary small-btn"
              disabled={!pasted.trim()}
              onClick={() => {
                const found = parsePastedQuestions(pasted);
                if (found.length) onChange(found);
                setPasting(false);
                setPasted("");
              }}
            >
              문항 나누기
            </button>
            <button className="btn ghost small-btn" onClick={() => setPasting(false)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <button className="btn small-btn" onClick={() => setPasting(true)}>
          <Icon name="clip" size={14} /> 문항을 한 번에 붙여넣기
        </button>
      )}
      <ol className="q-list">
        {value.map((q, i) => (
          <li key={i} className="q-item">
            <div className="q-head">
              <b>문항 {i + 1}</b>
              {value.length > 1 && (
                <button className="attach-x" aria-label={`문항 ${i + 1} 빼기`} onClick={() => onChange(value.filter((_, n) => n !== i))}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            <textarea rows={2} value={q.question} onChange={(e) => set(i, { question: e.target.value })} placeholder="문항 내용 (예: 지원 동기와 입사 후 포부를 작성해 주세요)" aria-label={`문항 ${i + 1} 내용`} />
            <div className="row wrap q-limit">
              <label className="row small">
                <span className="muted">글자 수 제한</span>
                <input
                  type="number"
                  min={50}
                  max={10000}
                  value={q.limit ?? ""}
                  onChange={(e) => set(i, { limit: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="없음"
                />
              </label>
              <select value={q.count} onChange={(e) => set(i, { count: e.target.value as CountMode })} aria-label="글자 수 세는 방식">
                {(Object.keys(COUNT_LABEL) as CountMode[]).map((m) => (
                  <option key={m} value={m}>
                    {COUNT_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              rows={1}
              className="q-note"
              value={q.note ?? ""}
              onChange={(e) => set(i, { note: e.target.value || undefined })}
              placeholder="이 문항에 꼭 넣고 싶은 경험이나 사실 (선택)"
              aria-label={`문항 ${i + 1} 메모`}
            />
          </li>
        ))}
      </ol>
      {value.length < MAX_QUESTIONS && (
        <button className="btn ghost small-btn" onClick={() => onChange([...value, blank()])}>
          + 문항 추가
        </button>
      )}
    </div>
  );
}

export const filledQuestions = (q: SelfIntroQuestion[]) => q.filter((x) => x.question.trim());

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost small-btn"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      <Icon name={done ? "check" : "copy"} size={14} /> {done ? "복사했어요" : "복사"}
    </button>
  );
}

function CountLine({ q, counts }: { q: SelfIntroQuestion; counts?: Counts }) {
  if (!counts) return <span className="count-line nolimit">글자 수 확인 전</span>;
  const m = measure(q, counts);
  const unit = q.count === "bytes" ? "바이트" : "자";
  const bad = q.count === "bytes" && counts.unencodable;
  return (
    <span className={`count-line ${bad ? "over" : m.verdict}`}>
      {m.limit ? `${m.value} / ${m.limit}${unit}` : `${m.value}${unit}`} ({COUNT_LABEL[q.count]})
      {m.limit && ` · ${Math.round((m.value / m.limit) * 100)}%`}
      {m.verdict === "over" && " · 제한을 넘었어요"}
      {m.verdict === "short" && " · 조금 짧아요"}
      {bad && ` · 양식에 쓸 수 없는 글자: ${counts.unencodable}`}
    </span>
  );
}

function AnswerBlock({ q, a, row, editable }: { q: SelfIntroQuestion; a: SelfIntroAnswer; row: Row; editable: boolean }) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <li className="answer">
      <div className="answer-q">
        <b>문항 {a.index}</b> <span className="muted">{q.question}</span>
      </div>
      <p className="answer-text">{a.text}</p>
      <div className="row wrap answer-meta">
        <CountLine q={q} counts={a.counts} />
        <span className="grow" />
        <CopyButton text={a.text} />
        {editable && !revising && (
          <button className="btn ghost small-btn" onClick={() => setRevising(true)}>
            <Icon name="sparkle" size={14} /> 다시 쓰기
          </button>
        )}
      </div>
      {!!a.sources?.length && (
        <div className="answer-sources small muted">
          쓴 경험: {a.sources.join(" · ")}
        </div>
      )}
      {a.short && (
        <details className="small">
          <summary className="muted">짧은 버전{a.short_counts ? ` (${a.short_counts.with_spaces}자)` : ""}</summary>
          <p className="answer-text">{a.short}</p>
          <CopyButton text={a.short} />
        </details>
      )}
      {revising && (
        <div className="edit-box">
          <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="예: 첫 문장을 더 구체적으로, RAG 플랫폼 경험 대신 보험 문서 검증 경험으로" autoFocus />
          <div className="row">
            <button
              className="btn primary small-btn"
              disabled={!feedback.trim() || busy}
              onClick={() => {
                setBusy(true);
                setErr(null);
                startSelfIntro({ date: row.date ?? "", company: row.company ?? "", role: row.role ?? "" }, { revise: { index: a.index, feedback: feedback.trim() } })
                  .then(() => {
                    setRevising(false);
                    setFeedback("");
                  })
                  .catch((e: Error) => setErr(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? <span className="spinner" /> : <Icon name="sparkle" size={14} />} 이 답변만 다시 쓰기
            </button>
            <button className="btn ghost small-btn" onClick={() => setRevising(false)}>
              취소
            </button>
            <ErrorBox error={err} />
          </div>
        </div>
      )}
    </li>
  );
}

function NewFacts({ facts }: { facts: string[] }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="notice small">
      <b>내가 적어 준 내용 중 프로필에 없는 사실이 답변에 들어갔어요.</b>
      <ul>
        {facts.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
      <button
        className="btn small-btn"
        onClick={() =>
          runCommand(
            `내 프로필(documents/profile/01-candidate-profile.md)에 아래 사실을 추가해 줘. 내가 직접 알려 준 사실이야. 바꾸기 전에 어떤 부분을 바꿀지 먼저 보여 주고 확인을 받아 줘.\n\n${facts.map((f) => `- ${f}`).join("\n")}`,
            { title: "프로필에 사실 추가", kind: "profile-edit" },
          ).catch((e: Error) => setErr(e.message))
        }
      >
        프로필에 추가하기
      </button>
      <ErrorBox error={err} />
    </div>
  );
}

function RunStatus({ run, editable, onChange }: { run: SelfIntroRun; editable: boolean; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  if (run.state === "running") {
    return (
      <div className="run-progress">
        <span className="spinner" />
        <span className="grow">
          {run.awaiting ? "AI가 확인을 기다려요" : run.params.revise ? `문항 ${run.params.revise.index} 답변을 다시 쓰는 중이에요` : "AI가 답변을 쓰는 중이에요"}
          {!!run.fixRounds && <span className="muted small"> · 글자 수 맞추는 중 ({run.fixRounds}번째)</span>}
        </span>
        {run.sessionId && (
          <button className="btn ghost small-btn" onClick={() => panel.show(run.sessionId!)}>
            {run.awaiting ? "확인하기" : "진행 보기"}
          </button>
        )}
      </div>
    );
  }
  if (run.state !== "failed") return null;
  const act = (p: Promise<unknown>) =>
    p.then(onChange).catch((e: Error) => setErr(e.message));
  return (
    <div className="run-decision">
      <b>자기소개서 답변을 끝내지 못했어요</b>
      {run.error && <p className="small muted">{run.error}</p>}
      {run.result?.status === "failed" && <Markdown text={run.result.summary_md} />}
      <ErrorBox error={err} />
      <div className="row wrap">
        {editable && (
          <button className="btn primary small-btn" onClick={() => act(resumeRun(run.id, "retry"))}>
            이어서 하기
          </button>
        )}
        <button className="btn ghost small-btn" onClick={() => act(dismissRun(run.id))}>
          그만두기
        </button>
      </div>
    </div>
  );
}

export function SelfIntroCard({ row, runs, applyRun, onChange }: { row: Row; runs: Run[]; applyRun?: ApplyRun; onChange: () => void }) {
  const mine = runs.filter((r): r is SelfIntroRun => r.kind === "self-intro");
  const latest = runForRow(mine, row, "self-intro");
  const done = mine.find((r) => r.state === "succeeded" && r.result && runForRow([r], row, "self-intro"));
  const editable = columnOf(row.status) === "drafted";
  const busy = latest?.state === "running";
  const [editing, setEditing] = useState(false);
  // Until the user edits, the editor shows the questions last answered, or the ones given with 지원서 만들기.
  const [draft, setQuestions] = useState<SelfIntroQuestion[] | null>(null);
  const questions = draft ?? done?.params.questions ?? applyRun?.params.selfIntro ?? [blank()];
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const followUpMissed = !latest && applyRun?.followUp && applyRun.followUp.state !== "started" ? applyRun.followUp : null;
  if (!done && !latest && !editable && !followUpMissed) return null;
  const showEditor = editable && !busy && (editing || !done);
  const artifact = done?.artifact;
  const ready = filledQuestions(questions);

  return (
    <section className="card self-intro">
      <header className="card-head">
        <h2>자기소개서 문항</h2>
        <div className="row">
          {done && (
            <a className="btn ghost small-btn" href={`/api/runs/${encodeURIComponent(done.id)}/self-intro.txt`} download>
              <Icon name="download" size={14} /> 받기
            </a>
          )}
          {done && editable && !busy && !editing && (
            <button className="btn small-btn" onClick={() => setEditing(true)}>
              문항 바꾸기
            </button>
          )}
        </div>
      </header>
      {!done && !busy && editable && (
        <p className="muted small">
          지원 사이트에 자기소개서 문항이 있으면 문항과 글자 수 제한을 넣어 주세요. AI가 프로필과 이 지원서를 바탕으로 답변을 쓰고, 서버가 글자 수를 정확히
          세어 제한을 넘거나 85%에 못 미치는 답변은 최대 두 번 다시 쓰게 해요.
        </p>
      )}
      {latest && latest.state !== "succeeded" && <RunStatus run={latest} editable={editable} onChange={onChange} />}
      {followUpMissed && (
        <p className="notice small">지원서를 만든 뒤 자기소개서 답변을 바로 쓰지 못했어요: {followUpMissed.reason}{editable ? " 아래에서 다시 시작할 수 있어요." : ""}</p>
      )}
      {showEditor && (
        <>
          <QuestionsEditor value={questions} onChange={setQuestions} />
          <ErrorBox error={err} />
          <div className="row wrap">
            <button
              className="btn primary"
              disabled={!ready.length || sending}
              onClick={() => {
                setSending(true);
                setErr(null);
                startSelfIntro({ date: row.date ?? "", company: row.company ?? "", role: row.role ?? "" }, { questions: ready })
                  .then(() => {
                    setEditing(false);
                    setQuestions(null);
                    onChange();
                  })
                  .catch((e: Error) => setErr(e.message))
                  .finally(() => setSending(false));
              }}
            >
              {sending ? <span className="spinner light" /> : <Icon name="sparkle" size={15} />} {done ? "새 문항으로 다시 만들기" : "AI에게 답변 만들기"}
            </button>
            {editing && (
              <button
                className="btn ghost"
                onClick={() => {
                  setEditing(false);
                  setQuestions(null);
                }}
              >
                취소
              </button>
            )}
          </div>
        </>
      )}
      {done?.result && !showEditor && (
        <>
          {!editable && <p className="muted small">이미 낸 지원이라 답변은 보기만 할 수 있어요.</p>}
          {artifact && !artifact.written && (
            <p className="notice small">
              같은 회사·직무에 예전에 낸 지원의 답변이 보관함에 있어서 그 파일은 그대로 뒀어요. 이 지원의 답변은 [받기]로 받을 수 있어요.
            </p>
          )}
          {artifact?.coverRecorded && <p className="muted small">이 답변이 커버레터를 대신하는 서류로 지원 기록에 남았어요.</p>}
          <ol className="answers">
            {done.result.answers.map((a) => (
              <AnswerBlock key={a.index} q={done.params.questions[a.index - 1]!} a={a} row={row} editable={editable && !busy} />
            ))}
          </ol>
          {!!done.result.new_facts?.length && <NewFacts facts={done.result.new_facts} />}
          {!!done.result.assumptions?.length && (
            <div>
              <div className="points-head">AI가 이렇게 정했어요</div>
              <ul className="plain run-assumptions">
                {done.result.assumptions.map((x, i) => (
                  <li key={i}>
                    <b>{x.topic}</b> {x.assumed}
                    {x.why && <span className="muted"> · {x.why}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

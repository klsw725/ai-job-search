import { useState, type ReactNode } from "react";
import { dismissRun, fileUrl, resumeRun, startApply, type ApplyOptions, type ApplyRun, type ResumeDecision, type Run } from "./api.ts";
import { panel } from "./panel.ts";
import { ErrorBox, Icon, Markdown, Modal } from "./ui.tsx";
import { QuestionsEditor, filledQuestions } from "./selfIntro.tsx";
import type { SelfIntroQuestion } from "./api.ts";

const OPTIONS_KEY = "ajs.applyOptions";
const DEFAULTS: ApplyOptions = { fitThreshold: 60, continueBelowThreshold: false, draftFormFields: false };

const THRESHOLDS: [number, string][] = [
  [45, "보통 이상 (45점)"],
  [60, "잘 맞음 이상 (60점)"],
  [75, "아주 잘 맞음 이상 (75점)"],
];

function savedOptions(): ApplyOptions {
  try {
    const v = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null") as Partial<ApplyOptions> | null;
    const { selfIntro: _perPosting, ...saved } = v && typeof v === "object" ? v : {};
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

export function ApplyDialog({
  posting,
  title,
  jobKey,
  url,
  attachments = [],
  onClose,
  onStarted,
}: {
  posting: string;
  title: string;
  jobKey?: string;
  url?: string;
  attachments?: string[];
  onClose: () => void;
  onStarted?: (run: Run) => void;
}) {
  const [opts, setOpts] = useState<ApplyOptions>(savedOptions);
  const [hasQuestions, setHasQuestions] = useState(false);
  const [replacesCover, setReplacesCover] = useState(false);
  const [questions, setQuestions] = useState<SelfIntroQuestion[]>([{ question: "", count: "with_spaces" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="지원서 만들기" onClose={onClose}>
      <p className="muted small">{title.replace(/^지원서 만들기 · /, "")}</p>
      <div className="apply-promise">
        <b>AI가 중간에 묻지 않고 끝까지 만들어요.</b>
        <span className="muted small">
          애매한 부분은 안전한 쪽으로 정하고 결과에 적어 둬요. 다만 공고에 수상한 지시가 숨어 있거나, 적합도가 아래 기준보다 낮거나, 공고를 열 수 없으면 멈추고
          확인을 받아요.
        </span>
      </div>
      <label className="stack-tight">
        <span className="small muted">이 정도 이상 맞으면 만들기</span>
        <select value={opts.fitThreshold} onChange={(e) => setOpts({ ...opts, fitThreshold: Number(e.target.value) })}>
          {THRESHOLDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={opts.continueBelowThreshold} onChange={(e) => setOpts({ ...opts, continueBelowThreshold: e.target.checked })} />
        기준보다 낮아도 멈추지 말고 끝까지 만들기
      </label>
      <label className="check">
        <input type="checkbox" checked={opts.draftFormFields} onChange={(e) => setOpts({ ...opts, draftFormFields: e.target.checked })} />
        지원 사이트에 자기소개 같은 입력 칸이 있으면 그 초안도 만들기
      </label>
      <label className="check">
        <input type="checkbox" checked={hasQuestions} onChange={(e) => setHasQuestions(e.target.checked)} />
        자기소개서 문항이 있어요 (이력서·커버레터를 만든 뒤 바로 답변도 써요)
      </label>
      {hasQuestions && (
        <>
          <label className="check">
            <input type="checkbox" checked={replacesCover} onChange={(e) => setReplacesCover(e.target.checked)} />
            커버레터 대신 이 문항 답변만 내요 (커버레터 PDF를 만들지 않아요)
          </label>
          <QuestionsEditor value={questions} onChange={setQuestions} />
        </>
      )}
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
            localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
            const asked = hasQuestions ? filledQuestions(questions) : [];
            startApply(posting, { ...opts, ...(asked.length ? { selfIntro: asked, ...(replacesCover ? { selfIntroReplacesCover: true } : {}) } : {}) }, { title, jobKey, url }, attachments)
              .then((run) => {
                onStarted?.(run);
                onClose();
              })
              .catch((e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <span className="spinner" /> : <Icon name="sparkle" size={15} />} AI에게 맡기기
        </button>
      </div>
    </Modal>
  );
}

export function ApplyButton({
  posting,
  title,
  jobKey,
  url,
  kind = "secondary",
  label = "지원서 만들기",
  onStarted,
}: {
  posting: string;
  title: string;
  jobKey?: string;
  url?: string;
  kind?: "primary" | "secondary";
  label?: string;
  onStarted?: (run: Run) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`btn ${kind}`} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && <ApplyDialog posting={posting} title={title} jobKey={jobKey} url={url} onClose={() => setOpen(false)} onStarted={onStarted} />}
    </>
  );
}

export const RUN_STATE_TEXT: Record<string, string> = {
  running: "AI가 만드는 중",
  awaiting: "AI가 확인을 기다려요",
  succeeded: "완성",
  blocked: "확인이 필요해요",
  failed: "멈췄어요",
  cancelled: "그만뒀어요",
};

export const runStateKey = (run: Run) => (run.state === "running" && run.awaiting ? "awaiting" : run.state);

const BLOCKER_TEXT: Record<string, { title: string; go?: { decision: ResumeDecision; label: string } }> = {
  fit_below_threshold: { title: "적합도가 정한 기준보다 낮아서 멈췄어요", go: { decision: "continue_below_threshold", label: "그래도 끝까지 만들기" } },
  posting_flagged: { title: "공고에 AI에게 내리는 지시처럼 보이는 내용이 있어서 멈췄어요", go: { decision: "accept_flagged_posting", label: "확인했어요, 계속 만들기" } },
  posting_unreachable: { title: "공고 페이지를 열 수 없었어요" },
};

function PasteInstead({ run, onDone }: { run: ApplyRun; onDone: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-tight">
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="공고 페이지의 내용을 복사해서 붙여넣어 주세요" />
      <ErrorBox error={err} />
      <button
        className="btn primary small-btn"
        disabled={!text.trim() || busy}
        onClick={() => {
          setBusy(true);
          // The employer's questions go along; only the posting and its integrity decision start over.
          const { posting: _old, acceptFlaggedPosting: _flag, ...options } = run.params;
          startApply(text.trim(), options, { title: run.title, jobKey: run.subject.jobKey, url: run.subject.url })
            .then(() => dismissRun(run.id))
            .then(onDone)
            .catch((e: Error) => setErr(e.message))
            .finally(() => setBusy(false));
        }}
      >
        붙여넣은 내용으로 다시 만들기
      </button>
    </div>
  );
}

function Decisions({ run, onChange }: { run: ApplyRun; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    p.then(onChange)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  const blocker = run.state === "blocked" ? run.result?.blocker : undefined;
  const text = blocker ? BLOCKER_TEXT[blocker.type] : undefined;
  return (
    <div className="run-decision">
      {blocker && text && (
        <>
          <b>{text.title}</b>
          {run.result?.fit_score !== undefined && blocker.type === "fit_below_threshold" && (
            <span className="small">
              적합도 {run.result.fit_score}점 · 기준 {run.params.fitThreshold}점
            </span>
          )}
          {blocker.detail && <p className="small muted pre-line">{blocker.detail}</p>}
        </>
      )}
      {run.state === "failed" && (
        <>
          <b>{run.result?.status === "failed" ? "AI가 작업을 끝내지 못했어요" : "작업이 끝나기 전에 멈췄어요"}</b>
          {run.error && <p className="small muted">{run.error}</p>}
          {run.result?.status === "failed" && run.result.summary_md && <Markdown text={run.result.summary_md} />}
        </>
      )}
      {blocker?.type === "posting_unreachable" && <PasteInstead run={run} onDone={onChange} />}
      <ErrorBox error={err} />
      <div className="row wrap">
        {text?.go && (
          <button className="btn primary small-btn" disabled={busy} onClick={() => act(resumeRun(run.id, text.go!.decision))}>
            {text.go.label}
          </button>
        )}
        {run.state === "failed" && (
          <button className="btn primary small-btn" disabled={busy} onClick={() => act(resumeRun(run.id, "retry"))}>
            이어서 하기
          </button>
        )}
        <button className="btn ghost small-btn" disabled={busy} onClick={() => act(dismissRun(run.id))}>
          그만두기
        </button>
      </div>
    </div>
  );
}

export function Deliverables({ run }: { run: Run }) {
  const files = (run.checks?.files ?? []).filter((f) => f.exists);
  if (files.length === 0) return null;
  return (
    <ul className="output-list">
      {files.map((f) => (
        <li key={f.path} className="output-item">
          <span className="output-icon">
            <Icon name="file" size={16} />
          </span>
          <span className="grow ellipsis">{f.label}</span>
          <a className="btn ghost small-btn" href={fileUrl(f.path)} target="_blank" rel="noopener noreferrer">
            <Icon name="open" size={14} /> 열기
          </a>
          <a className="btn ghost small-btn" href={fileUrl(f.path, true)} download>
            <Icon name="download" size={14} /> 받기
          </a>
        </li>
      ))}
    </ul>
  );
}

function Previews({ run }: { run: Run }) {
  const pdfs = (run.checks?.files ?? []).filter((f) => f.exists && /\.pdf$/i.test(f.path));
  const [tab, setTab] = useState(0);
  const current = pdfs[tab];
  if (!current) return null;
  return (
    <div className="run-previews">
      <div className="seg" role="group" aria-label="미리보기">
        {pdfs.map((f, i) => (
          <button key={f.path} aria-pressed={i === tab} className={i === tab ? "on" : ""} onClick={() => setTab(i)}>
            {f.label}
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

export function RunResult({ run, onChange, actions }: { run: ApplyRun; onChange: () => void; actions?: ReactNode }) {
  const state = runStateKey(run);
  const r = run.result;
  const fit = run.checks?.row?.fit_rating || (r?.fit_score !== undefined ? String(r.fit_score) : "");
  const problems = (run.checks?.files ?? []).filter((f) => !f.exists || !f.fresh);
  return (
    <section className={`card run-card run-${state}`}>
      <header className="card-head">
        <div className="row">
          <span className={`run-state ${state}`}>
            {(state === "running" || state === "awaiting") && <span className="spinner" />} {RUN_STATE_TEXT[state]}
          </span>
          {fit && <span className="chip st-applied">적합도 {fit}</span>}
          {r?.fit_verdict && <span className="muted small">{r.fit_verdict}</span>}
        </div>
        {run.sessionId && (
          <button className="btn ghost small-btn" onClick={() => panel.show(run.sessionId!)}>
            {state === "running" ? "진행 보기" : state === "awaiting" ? "확인하기" : "작업 기록"}
          </button>
        )}
      </header>
      {(state === "blocked" || state === "failed") && <Decisions run={run} onChange={onChange} />}
      {state === "succeeded" && r && (
        <>
          {r.summary_md && <Markdown text={r.summary_md} />}
          {problems.length > 0 && (
            <ul className="run-warnings small">
              {problems.map((f) => (
                <li key={f.path}>
                  <Icon name="alert" size={13} /> {f.label}: {f.exists ? "이번 작업에서 새로 만든 파일이 아니에요" : "파일을 찾을 수 없어요"}
                </li>
              ))}
            </ul>
          )}
          <div className="run-notes">
          {!!r.tailoring_points?.length && (
            <div>
              <div className="points-head">이렇게 맞췄어요</div>
              <ul className="plain run-points">
                {r.tailoring_points.map((p, i) => (
                  <li key={i}>
                    <Icon name="check" size={14} /> {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!r.assumptions?.length && (
            <div>
              <div className="points-head">AI가 이렇게 정했어요</div>
              <ul className="plain run-assumptions">
                {r.assumptions.map((a, i) => (
                  <li key={i}>
                    <b>{a.topic}</b> {a.assumed}
                    {a.why && <span className="muted"> · {a.why}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          </div>
          {actions && <div className="row wrap">{actions}</div>}
          <Deliverables run={run} />
          <Previews run={run} />
        </>
      )}
    </section>
  );
}

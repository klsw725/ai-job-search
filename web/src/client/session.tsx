import { useEffect, useMemo, useState } from "react";
import { getJSON, live, useActiveSessions, useFetch, type ChatEvent, type PastSession, type RetryInfo, type SessionState } from "./api.ts";
import { describePermission, describeTool, resultErrorText } from "./labels.ts";
import type { Step } from "./progress.ts";

export type Question = Extract<ChatEvent, { kind: "question" }>["questions"][number];
type Assistant = Extract<ChatEvent, { kind: "assistant" }>;
type ToolResult = Extract<ChatEvent, { kind: "tool_result" }>;

export function useSessions() {
  const active = useActiveSessions();
  const { data } = useFetch<{ past: PastSession[] }>("/api/sessions", { live: true });
  return { active, past: data?.past ?? [] };
}

export function useSession(id: string | null) {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [state, setState] = useState<SessionState | null>(null);
  const [retry, setRetry] = useState<RetryInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEvents([]);
    setDraft("");
    setState(null);
    setRetry(null);
    setError(null);
    if (!id) return;
    const off = live.listen((m) => {
      if (m.t === "error" && m.id === id) setError(m.text);
      if (m.t === "snapshot" && m.id === id) {
        setEvents(m.events);
        setState(m.session.state);
        setRetry(m.session.retry);
        setDraft("");
      }
      if (m.t === "event" && m.id === id) {
        const ev = m.ev;
        if (ev.kind === "delta") setDraft((d) => d + ev.text);
        else if (ev.kind === "retry") setRetry(ev.retry);
        else if (ev.kind === "state") {
          setState(ev.state);
          if (ev.state !== "running") {
            setDraft("");
            setRetry(null);
          }
        } else {
          if (ev.kind === "assistant" && !ev.sub) setDraft("");
          setEvents((list) => [...list, ev]);
        }
      }
    });
    live.subscribe(id);
    return () => {
      off();
      live.unsubscribe(id);
    };
  }, [id]);

  return { events, state, retry, draft, error };
}

export function useToolResults(events: ChatEvent[]) {
  return useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const e of events) if (e.kind === "tool_result") map.set(e.toolUseId, e);
    return map;
  }, [events]);
}

export function useResolved(events: ChatEvent[]) {
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) if (e.kind === "resolved") map.set(e.requestId, e.outcome);
    return map;
  }, [events]);
}

export function Progress({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "completed").length;
  return (
    <div className="progress">
      <div className="progress-bar">
        <span style={{ width: `${Math.round((done / steps.length) * 100)}%` }} />
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={i} className={`step ${s.status}`}>
            <span className="step-mark">{s.status === "completed" ? "✓" : i + 1}</span>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ToolList({ tools, results }: { tools: Assistant["tools"]; results: Map<string, ToolResult> }) {
  const shown = tools.filter((t) => !["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"].includes(t.name));
  if (shown.length === 0) return null;
  return (
    <ul className="activity">
      {shown.map((t) => {
        const r = results.get(t.id);
        return (
          <li key={t.id}>
            <details className={`tool ${r?.isError ? "tool-error" : ""}`}>
              <summary>
                <span className={`tool-state ${r ? (r.isError ? "err" : "ok") : "run"}`}>{r ? (r.isError ? "!" : "✓") : "…"}</span>
                {describeTool(t.name, t.input)}
                {r?.isError && <span className="muted"> · 문제가 생겼어요</span>}
              </summary>
              <div className="muted small">기술 정보 · {t.name}</div>
              <pre className="pre">{t.input}</pre>
              {r && <pre className="pre result">{r.text}</pre>}
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export function QuestionForm({ questions, onSubmit }: { questions: Question[]; onSubmit: (answers: Record<string, string>) => void }) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const toggle = (qi: number, label: string, multi: boolean) =>
    setPicked((p) => {
      const cur = p[qi] ?? [];
      return { ...p, [qi]: multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] };
    });
  const answers = Object.fromEntries(
    questions.map((q, qi) => [q.question, [...(picked[qi] ?? []), other[qi]?.trim()].filter(Boolean).join(", ")]),
  );
  const complete = questions.every((q) => answers[q.question]);
  return (
    <div className="stack">
      {questions.map((q, qi) => (
        <fieldset key={qi}>
          <legend>{q.question}</legend>
          {q.multiSelect && <span className="muted small">여러 개 고를 수 있어요</span>}
          {q.options.map((o) => {
            const on = (picked[qi] ?? []).includes(o.label);
            return (
              <label key={o.label} className={`option ${on ? "on" : ""}`}>
                <input type={q.multiSelect ? "checkbox" : "radio"} name={`q${qi}`} checked={on} onChange={() => toggle(qi, o.label, q.multiSelect)} />
                <span>
                  <b>{o.label}</b>
                  {o.description && <span className="muted small option-desc">{o.description}</span>}
                </span>
              </label>
            );
          })}
          <input placeholder="다른 답이 있으면 직접 적어 주세요" value={other[qi] ?? ""} onChange={(e) => setOther((o) => ({ ...o, [qi]: e.target.value }))} />
        </fieldset>
      ))}
      <button className="btn primary" disabled={!complete} onClick={() => onSubmit(answers)}>
        답변 보내기
      </button>
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  allowed: "허용했어요",
  always: "이 작업 동안 계속 허용했어요",
  denied: "거부했어요",
  answered: "답변했어요",
  cancelled: "취소됐어요",
};

type Permission = Extract<ChatEvent, { kind: "permission" }>;
type QuestionEvent = Extract<ChatEvent, { kind: "question" }>;

let repoRoot: Promise<string | null> | null = null;

export function useRepoRoot() {
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    // A failed lookup is not cached, so the next card retries it.
    repoRoot ??= getJSON<{ repo: string }>("/api/status")
      .then((s) => s.repo)
      .catch(() => {
        repoRoot = null;
        return null;
      });
    let alive = true;
    void repoRoot.then((r) => alive && setRoot(r));
    return () => {
      alive = false;
    };
  }, []);
  return root;
}

export function PermissionCard({ sessionId, event, outcome }: { sessionId: string; event: Permission; outcome?: string }) {
  const root = useRepoRoot();
  const { title, risk, warning, shown } = describePermission(event.toolName, event.input, root);
  const answer = (allow: boolean, always = false) =>
    live.send({ t: "permission", id: sessionId, requestId: event.requestId, allow, ...(always ? { always: true } : {}) });
  return (
    <div className={`msg card-inline risk-${risk} ${outcome ? "" : "attention"}`}>
      <b>{title}</b>
      {warning && <div className="warn-line">⚠ {warning}</div>}
      {shown.map((f, n) => (
        <div key={n}>
          <div className="muted small">{f.label}</div>
          <pre className="pre">{f.text || "(비어 있음)"}</pre>
        </div>
      ))}
      <details className="small">
        <summary className="muted">기술 정보</summary>
        <div className="muted">{event.toolName}{event.reason && ` — ${event.reason}`}</div>
        <pre className="pre">{event.input}</pre>
      </details>
      {outcome ? (
        <div className="muted small">{OUTCOME_LABEL[outcome] ?? outcome}</div>
      ) : (
        <div className="row wrap">
          <button className="btn primary" onClick={() => answer(true)}>허용</button>
          {event.canAlways && (
            <button className="btn secondary" onClick={() => answer(true, true)}>
              이 작업 동안 계속 허용
            </button>
          )}
          <button className="btn danger" onClick={() => answer(false)}>거부</button>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({ sessionId, event, outcome }: { sessionId: string; event: QuestionEvent; outcome?: string }) {
  return (
    <div className={`msg card-inline ${outcome ? "" : "attention"}`}>
      {outcome ? (
        <div className="muted small">
          {event.questions.map((q) => q.question).join(" / ")} — {OUTCOME_LABEL[outcome] ?? outcome}
        </div>
      ) : (
        <>
          <b>AI가 물어봐요</b>
          <QuestionForm questions={event.questions} onSubmit={(answers) => live.send({ t: "answer", id: sessionId, requestId: event.requestId, answers })} />
        </>
      )}
    </div>
  );
}

export function ResultLine({ event }: { event: Extract<ChatEvent, { kind: "result" }> }) {
  const facts = [
    event.durationMs !== undefined ? `걸린 시간 ${(event.durationMs / 1000).toFixed(1)}초` : null,
    event.costUsd !== undefined && event.costUsd > 0 ? `이 대화 누적 비용 약 $${event.costUsd.toFixed(2)}` : null,
  ].filter(Boolean);
  return (
    <details className={`result-line ${event.ok ? "" : "error-inline"}`}>
      <summary>{event.ok ? "✓ 끝났어요" : resultErrorText(event.text)}</summary>
      {facts.length > 0 && <span>{facts.join(" · ")}</span>}
    </details>
  );
}

export function RetryNotice({ retry }: { retry: RetryInfo }) {
  return (
    <div className="error-box small">
      AI 서버에 연결하지 못해 다시 시도하고 있어요 ({retry.attempt}/{retry.maxRetries}, {Math.round(retry.delayMs / 1000)}초 뒤)
      {(retry.status === 401 || retry.status === 403) && "\n인증 정보가 맞지 않는 것 같아요. 설정 화면에서 AI 연결 상태를 확인해 주세요."}
      {retry.status === 404 && "\nAI 서버 주소가 맞지 않는 것 같아요. 설정 화면에서 확인해 주세요."}
      <details>
        <summary>기술 정보</summary>
        {retry.status !== null && `HTTP ${retry.status} · `}
        {retry.error}
      </details>
    </div>
  );
}

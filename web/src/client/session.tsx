import { useEffect, useMemo, useState } from "react";
import {
  WEB_MODES,
  downloadText,
  fileName,
  fileUrl,
  getJSON,
  live,
  saveNote,
  stamp,
  useActiveSessions,
  useFetch,
  zipUrl,
  type ChatEvent,
  type PastSession,
  type RetryInfo,
  type SessionState,
  type WebMode,
} from "./api.ts";
import { attachmentLabel } from "./attach.tsx";
import { MODE_TEXT, describePermission, describeTool, resultErrorText } from "./labels.ts";
import { sessionOutputs, type Step } from "./progress.ts";
import { Icon } from "./ui.tsx";

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
        else if (ev.kind === "mode") return;
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

type StaticStatus = { repo: string; bypassAllowed: boolean };
let staticStatus: Promise<StaticStatus | null> | null = null;

// Facts that do not change while the server runs, fetched once.
function useStaticStatus() {
  const [status, setStatus] = useState<StaticStatus | null>(null);
  useEffect(() => {
    // A failed lookup is not cached, so the next card retries it.
    staticStatus ??= getJSON<StaticStatus>("/api/status").catch(() => {
      staticStatus = null;
      return null;
    });
    let alive = true;
    void staticStatus.then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

export function useRepoRoot() {
  return useStaticStatus()?.repo ?? null;
}

export function useBypassAllowed() {
  return useStaticStatus()?.bypassAllowed ?? false;
}

// Switches one running task's permission mode; it applies from the next tool call.
export function ModeSelect({ sessionId, mode }: { sessionId: string; mode: WebMode }) {
  const bypass = useBypassAllowed();
  return (
    <label className={`mode-select risk-${MODE_TEXT[mode]?.risk ?? "low"}`} title={MODE_TEXT[mode]?.description}>
      <span className="muted small">권한</span>
      <select
        value={mode}
        onChange={(e) => {
          const next = e.target.value as WebMode;
          if (next === "bypassPermissions" && !confirm(`${MODE_TEXT[next]!.description}\n\n이 작업을 확인 없이 진행할까요?`)) return;
          live.send({ t: "mode", id: sessionId, mode: next });
        }}
      >
        {WEB_MODES.map((m) => (
          <option key={m} value={m} disabled={m === "bypassPermissions" && !bypass}>
            {MODE_TEXT[m]!.short}
            {m === "bypassPermissions" && !bypass ? " (Docker 전용)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
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
      {!outcome && (
        <div className="muted small">
          확인을 줄이려면 이 작업 제목 옆의 <b>권한</b>을 바꾸거나, <a href="#/settings">설정</a>에서 기본 권한 모드를 골라 주세요.
        </div>
      )}
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

export function useOutputs(events: ChatEvent[], since: number | null) {
  const files = useFetch<{ path: string; mtime: number }[]>("/api/files", { live: true });
  const root = useRepoRoot();
  return useMemo(
    () => (since === null || root === null ? [] : sessionOutputs(events, files.data ?? [], since, root)),
    [events, files.data, since, root],
  );
}

// Files the AI produced in this task, each viewable and downloadable, plus
// the whole set as one ZIP.
export function OutputFiles({ outputs, zipName, title = "이번 작업에서 만든 파일" }: { outputs: [string, string][]; zipName: string; title?: string }) {
  if (outputs.length === 0) return null;
  return (
    <div className="outputs">
      <div className="outputs-head">
        <b>{title}</b>
        {outputs.length > 1 && (
          <a className="btn secondary small-btn" href={zipUrl(outputs.map(([p]) => p), zipName)} download>
            <Icon name="download" size={14} /> 모두 받기 (ZIP)
          </a>
        )}
      </div>
      <ul className="output-list">
        {outputs.map(([path, label]) => (
          <li key={path} className="output-item">
            <span className="output-icon"><Icon name="file" /></span>
            <span className="grow">
              <b>{label}</b>
              <span className="muted small ellipsis block">{fileName(path)}</span>
            </span>
            <a className="btn ghost small-btn" href={fileUrl(path)} target="_blank" rel="noopener noreferrer" title="새 탭에서 열기">
              <Icon name="open" size={14} /> 열기
            </a>
            <a className="btn secondary small-btn" href={fileUrl(path, true)} download title="내 컴퓨터에 저장">
              <Icon name="download" size={14} /> 받기
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Copy or save one AI reply: much of the work (fit reviews, interview notes)
// lives only in the reply text, not in a file.
export function ReplyActions({ text, name, noteSession }: { text: string; name: string; noteSession?: string }) {
  const [copied, setCopied] = useState(false);
  // Tied to the reply it was for: a new reply in the same place starts unsaved.
  const [noteState, setNoteState] = useState<{ text: string; status: string } | null>(null);
  const noted = noteState?.text === text ? noteState.status : null;
  return (
    <div className="reply-actions">
      {noteSession && (
        <button
          type="button"
          className="btn ghost small-btn"
          disabled={noted === "saved" || noted === "saving"}
          onClick={() => {
            const forText = text;
            setNoteState({ text: forText, status: "saving" });
            void saveNote({ sessionId: noteSession, text: forText })
              .then(() => setNoteState({ text: forText, status: "saved" }))
              .catch((e: Error) => setNoteState({ text: forText, status: e.message }));
          }}
        >
          <Icon name={noted === "saved" ? "check" : "clipboard"} size={14} /> {noted === "saved" ? "메모에 저장했어요" : "메모로 저장"}
        </button>
      )}
      {noted && noted !== "saved" && noted !== "saving" && <span className="error-box small">{noted}</span>}
      <button
        type="button"
        className="btn ghost small-btn"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "복사했어요" : "복사"}
      </button>
      <button type="button" className="btn ghost small-btn" onClick={() => downloadText(`${name}-${stamp()}.md`, text)}>
        <Icon name="download" size={14} /> 저장 (.md)
      </button>
    </div>
  );
}

export function conversationMarkdown(title: string, events: ChatEvent[]): string {
  const parts = [`# ${title}`, `_${new Date().toLocaleString("ko-KR")} 내보냄_`];
  for (const e of events) {
    if (e.kind === "user") {
      const files = (e.attachments ?? []).map((p) => `- 첨부: ${attachmentLabel(p)}`).join("\n");
      parts.push(`## 나\n\n${e.text}${files ? `\n\n${files}` : ""}`);
    } else if (e.kind === "assistant" && !e.sub && e.text.trim()) {
      parts.push(`## AI\n\n${e.text}`);
    }
  }
  return `${parts.join("\n\n")}\n`;
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

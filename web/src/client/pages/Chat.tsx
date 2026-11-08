import { useEffect, useMemo, useRef, useState } from "react";
import { live, sendJSON, useFetch, type ChatEvent, type PastSession, type RetryInfo, type SessionState, type SessionSummary } from "../api.ts";
import { ErrorBox, Markdown, formatTime } from "../ui.tsx";

type Question = Extract<ChatEvent, { kind: "question" }>["questions"][number];
type Command = { name: string; description: string };

function useSessions() {
  const { data, reload } = useFetch<{ active: SessionSummary[]; past: PastSession[] }>("/api/sessions");
  useEffect(() => live.listen((m) => m.t === "sessions" && reload()), [reload]);
  return data ?? { active: [], past: [] };
}

function useSession(id: string | null) {
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

function QuestionForm({ questions, onSubmit }: { questions: Question[]; onSubmit: (answers: Record<string, string>) => void }) {
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
          <legend>
            <span className="chip">{q.header}</span> {q.question}
          </legend>
          {q.options.map((o) => (
            <label key={o.label} className="option">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={`q${qi}`}
                checked={(picked[qi] ?? []).includes(o.label)}
                onChange={() => toggle(qi, o.label, q.multiSelect)}
              />
              <span>
                <b>{o.label}</b>
                {o.description && <span className="muted"> — {o.description}</span>}
              </span>
            </label>
          ))}
          <input placeholder="직접 입력 (선택)" value={other[qi] ?? ""} onChange={(e) => setOther((o) => ({ ...o, [qi]: e.target.value }))} />
        </fieldset>
      ))}
      <button className="btn primary" disabled={!complete} onClick={() => onSubmit(answers)}>
        답변 보내기
      </button>
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  allowed: "허용함",
  always: "이 세션에서 항상 허용",
  denied: "거부함",
  answered: "답변함",
  cancelled: "취소됨",
};

function EventList({ sessionId, events, draft }: { sessionId: string; events: ChatEvent[]; draft: string }) {
  const results = useMemo(() => {
    const map = new Map<string, Extract<ChatEvent, { kind: "tool_result" }>>();
    for (const e of events) if (e.kind === "tool_result") map.set(e.toolUseId, e);
    return map;
  }, [events]);
  const resolved = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) if (e.kind === "resolved") map.set(e.requestId, e.outcome);
    return map;
  }, [events]);

  return (
    <>
      {events.map((e, i) => {
        switch (e.kind) {
          case "user":
            return <div key={i} className="msg user">{e.text}</div>;
          case "assistant":
            return (
              <div key={i} className={e.sub ? "msg sub" : "msg assistant"}>
                {e.sub && <div className="muted small">하위 에이전트</div>}
                {e.text && <Markdown text={e.text} />}
                {e.tools.map((t) => {
                  const r = results.get(t.id);
                  return (
                    <details key={t.id} className={`tool ${r?.isError ? "tool-error" : ""}`}>
                      <summary>
                        🔧 {t.name} {r ? (r.isError ? "· 오류" : "· 완료") : "· 실행 중"}
                      </summary>
                      <pre className="pre">{t.input}</pre>
                      {r && <pre className="pre result">{r.text}</pre>}
                    </details>
                  );
                })}
              </div>
            );
          case "permission": {
            const outcome = resolved.get(e.requestId);
            return (
              <div key={i} className={`msg card-inline ${outcome ? "" : "attention"}`}>
                <div>
                  <b>권한 요청: {e.toolName}</b>
                  {e.reason && <span className="muted"> — {e.reason}</span>}
                </div>
                <pre className="pre">{e.input}</pre>
                {outcome ? (
                  <div className="muted">{OUTCOME_LABEL[outcome] ?? outcome}</div>
                ) : (
                  <div className="row">
                    <button className="btn primary" onClick={() => live.send({ t: "permission", id: sessionId, requestId: e.requestId, allow: true })}>허용</button>
                    {e.canAlways && (
                      <button className="btn secondary" onClick={() => live.send({ t: "permission", id: sessionId, requestId: e.requestId, allow: true, always: true })}>
                        이 세션에서 항상 허용
                      </button>
                    )}
                    <button className="btn danger" onClick={() => live.send({ t: "permission", id: sessionId, requestId: e.requestId, allow: false })}>거부</button>
                  </div>
                )}
              </div>
            );
          }
          case "question": {
            const outcome = resolved.get(e.requestId);
            return (
              <div key={i} className={`msg card-inline ${outcome ? "" : "attention"}`}>
                <b>질문</b>
                {outcome ? (
                  <div className="muted">
                    {e.questions.map((q) => q.question).join(" / ")} — {OUTCOME_LABEL[outcome] ?? outcome}
                  </div>
                ) : (
                  <QuestionForm questions={e.questions} onSubmit={(answers) => live.send({ t: "answer", id: sessionId, requestId: e.requestId, answers })} />
                )}
              </div>
            );
          }
          case "result":
            return (
              <div key={i} className={`result-line ${e.ok ? "" : "error-inline"}`}>
                {e.ok ? "완료" : e.text ? `중단/오류: ${e.text}` : "오류"}
                {e.durationMs !== undefined && ` · ${(e.durationMs / 1000).toFixed(1)}초`}
                {e.costUsd !== undefined && e.costUsd > 0 && ` · 세션 누적 약 $${e.costUsd.toFixed(2)}`}
              </div>
            );
          case "error":
            return <div key={i} className="error-box">{e.text}</div>;
          default:
            return null;
        }
      })}
      {draft && (
        <div className="msg assistant streaming">
          <Markdown text={draft} />
        </div>
      )}
    </>
  );
}

function Composer({ sessionId, state, commands }: { sessionId: string | null; state: SessionState | null; commands: Command[] }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const hints = text.startsWith("/") && !text.includes(" ") ? commands.filter((c) => `/${c.name}`.startsWith(text)) : [];

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setErr(null);
    try {
      if (sessionId && state !== "closed") live.send({ t: "send", id: sessionId, text: t });
      else {
        const s = await sendJSON<SessionSummary>("/api/sessions", "POST", { prompt: t });
        location.hash = `#/chat/${s.id}`;
      }
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="composer">
      {hints.length > 0 && (
        <ul className="hints">
          {hints.map((c) => (
            <li key={c.name} onClick={() => setText(`/${c.name} `)}>
              <b>/{c.name}</b> <span className="muted">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      <ErrorBox error={err} />
      <div className="row">
        <textarea
          rows={3}
          value={text}
          placeholder="메시지 또는 /명령 (Enter 전송, Shift+Enter 줄바꿈)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="stack">
          <button className="btn primary" onClick={() => void submit()} disabled={!text.trim()}>
            보내기
          </button>
          {state === "running" && sessionId && (
            <button className="btn danger" onClick={() => live.send({ t: "interrupt", id: sessionId })}>
              중단
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<SessionState, string> = { idle: "대기", running: "실행 중", closed: "종료" };

export function Chat({ sessionId }: { sessionId: string | null }) {
  const sessions = useSessions();
  const commands = useFetch<Command[]>("/api/commands").data ?? [];
  const { events, state, retry, draft, error } = useSession(sessionId);
  const bottom = useRef<HTMLDivElement>(null);
  const [resumeErr, setResumeErr] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  useEffect(() => setShowList(false), [sessionId]);

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [events.length, draft]);

  const resume = async (sdkSessionId: string) => {
    try {
      const s = await sendJSON<SessionSummary>("/api/sessions", "POST", { resume: sdkSessionId });
      location.hash = `#/chat/${s.id}`;
    } catch (e) {
      setResumeErr((e as Error).message);
    }
  };

  return (
    <div className="chat">
      <aside className={`chat-list ${showList ? "show" : ""}`}>
        <button className="btn secondary list-close" onClick={() => setShowList(false)}>
          닫기
        </button>
        <a className="btn primary block" href="#/chat" onClick={() => setShowList(false)}>+ 새 대화</a>
        <h3>진행 중</h3>
        {sessions.active.length === 0 && <p className="muted small">없음</p>}
        {sessions.active.map((s) => (
          <a key={s.id} href={`#/chat/${s.id}`} className={`session ${s.id === sessionId ? "active" : ""}`} onClick={() => setShowList(false)}>
            <span>{s.title}</span>
            <span className="small">
              <span className={`dot ${s.state}`} /> {STATE_LABEL[s.state]}
              {s.pending > 0 && <span className="chip warn">응답 필요 {s.pending}</span>}
            </span>
          </a>
        ))}
        <h3>이전 대화</h3>
        <ErrorBox error={resumeErr} />
        {sessions.past.map((p) => (
          <button
            key={p.sdkSessionId}
            className="session past"
            onClick={() => {
              setShowList(false);
              void resume(p.sdkSessionId);
            }}
          >
            <span>{p.title || "(제목 없음)"}</span>
            <span className="muted small">{formatTime(p.lastModified)}</span>
          </button>
        ))}
      </aside>
      <section className="chat-body">
        <div className="chat-toolbar">
          <button className="btn secondary list-toggle" onClick={() => setShowList((v) => !v)}>
            대화 목록
          </button>
          {sessionId && state && state !== "closed" && (
            <button
              className="btn secondary"
              title="Claude Code 프로세스를 끝냅니다. 기록은 '이전 대화'에서 이어서 할 수 있습니다."
              onClick={() => {
                void sendJSON(`/api/sessions/${sessionId}`, "DELETE").then(() => (location.hash = "#/chat"));
              }}
            >
              대화 종료
            </button>
          )}
        </div>
        <div className="messages">
          {!sessionId && (
            <div className="empty">
              <h2>무엇을 할까요?</h2>
              <p className="muted">/setup, /apply &lt;공고 URL&gt;, /interview, /outcome 같은 명령이나 일반 질문을 입력하세요.</p>
            </div>
          )}
          <ErrorBox error={error} />
          {sessionId && <EventList sessionId={sessionId} events={events} draft={draft} />}
          {state === "running" && retry && (
            <div className="error-box small">
              API 요청 실패, 재시도 중 ({retry.attempt}/{retry.maxRetries})
              {retry.status !== null && ` · HTTP ${retry.status}`} · {retry.error} · {Math.round(retry.delayMs / 1000)}초 뒤 다시 시도
              {(retry.status === 401 || retry.status === 403) && "\n인증 정보나 ANTHROPIC_BASE_URL 설정을 확인하세요."}
              {retry.status === 404 && "\nANTHROPIC_BASE_URL 주소가 맞는지 확인하세요."}
            </div>
          )}
          {state === "running" && !draft && !retry && <div className="muted small typing">작업 중…</div>}
          <div ref={bottom} />
        </div>
        <Composer sessionId={sessionId} state={state} commands={commands} />
      </section>
    </div>
  );
}

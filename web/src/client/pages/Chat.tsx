import { useEffect, useRef, useState } from "react";
import { downloadText, live, sendJSON, stamp, useFetch, type ChatEvent, type SessionState, type SessionSummary } from "../api.ts";
import { AttachButton, AttachmentTray, DropZone, SentAttachments, useAttachments, type Attachments } from "../attach.tsx";
import { COMMAND_LABEL } from "../labels.ts";
import {
  ModeSelect,
  OutputFiles,
  PermissionCard,
  QuestionCard,
  ReplyActions,
  ResultLine,
  RetryNotice,
  ToolList,
  conversationMarkdown,
  useOutputs,
  useResolved,
  useSession,
  useSessions,
  useToolResults,
} from "../session.tsx";
import { ErrorBox, Icon, Markdown, formatTime } from "../ui.tsx";

type Command = { name: string; description: string };

function EventList({ sessionId, events, draft, title }: { sessionId: string; events: ChatEvent[]; draft: string; title: string }) {
  const results = useToolResults(events);
  const resolved = useResolved(events);

  return (
    <>
      {events.map((e, i) => {
        switch (e.kind) {
          case "user":
            return (
              <div key={i} className="msg user">
                {e.text}
                <SentAttachments paths={e.attachments} />
              </div>
            );
          case "assistant":
            return (
              <div key={i} className={e.sub ? "msg sub" : "msg assistant"}>
                {e.sub && <div className="muted small">보조 AI</div>}
                {e.text && <Markdown text={e.text} />}
                <ToolList tools={e.tools} results={results} />
                {!e.sub && e.text.trim().length > 200 && <ReplyActions text={e.text} name={title} />}
              </div>
            );
          case "permission":
            return <PermissionCard key={i} sessionId={sessionId} event={e} outcome={resolved.get(e.requestId)} />;
          case "question":
            return <QuestionCard key={i} sessionId={sessionId} event={e} outcome={resolved.get(e.requestId)} />;
          case "result":
            return <ResultLine key={i} event={e} />;
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

const SUGGESTIONS = [
  "내 프로필을 보고 어떤 직무가 잘 맞을지 추천해 줘",
  "이 공고가 나랑 맞는지 봐 줘: ",
  "이번 주에 챙겨야 할 지원 일정을 정리해 줘",
  "최근 만든 커버레터를 더 간결하게 다듬어 줘",
];

function Composer({
  sessionId,
  state,
  commands,
  text,
  setText,
  files,
}: {
  sessionId: string | null;
  state: SessionState | null;
  commands: Command[];
  text: string;
  setText: (t: string) => void;
  files: Attachments;
}) {
  const [err, setErr] = useState<string | null>(null);
  const hints = text.startsWith("/") && !text.includes(" ") ? commands.filter((c) => `/${c.name}`.startsWith(text)) : [];
  const canSend = (text.trim() !== "" || files.paths.length > 0) && !files.uploading;

  const submit = async () => {
    if (!canSend) return;
    const t = text.trim();
    const attachments = files.paths.length ? { attachments: files.paths } : {};
    setErr(null);
    try {
      if (sessionId && state !== "closed") live.send({ t: "send", id: sessionId, text: t, ...attachments });
      else {
        const s = await sendJSON<SessionSummary>("/api/sessions", "POST", { prompt: t, ...attachments });
        location.hash = `#/chat/${s.id}`;
      }
      setText("");
      files.clear();
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
              <b>{COMMAND_LABEL[c.name]?.label ?? c.name}</b> <span className="muted small">/{c.name}</span>
              <div className="muted small">{COMMAND_LABEL[c.name]?.description ?? c.description}</div>
            </li>
          ))}
        </ul>
      )}
      <ErrorBox error={err} />
      <div className="composer-box">
        <AttachmentTray attachments={files} />
        <textarea
          rows={3}
          value={text}
          placeholder="AI에게 부탁할 일을 적어 주세요. 이미지·파일은 끌어다 놓거나 붙여넣어도 돼요 (Enter 보내기 · Shift+Enter 줄바꿈 · / 기능 목록)"
          onChange={(e) => setText(e.target.value)}
          onPaste={files.onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-actions">
          <AttachButton onFiles={files.add} />
          <span className="grow" />
          {state === "running" && sessionId && (
            <button className="btn danger" onClick={() => live.send({ t: "interrupt", id: sessionId })}>
              멈추기
            </button>
          )}
          <button className="btn primary" onClick={() => void submit()} disabled={!canSend}>
            {files.uploading ? "올리는 중…" : "보내기"}
          </button>
        </div>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<SessionState, string> = { idle: "대기 중", running: "진행 중", closed: "종료됨" };

export function Chat({ sessionId }: { sessionId: string | null }) {
  const sessions = useSessions();
  const commands = useFetch<Command[]>("/api/commands").data ?? [];
  const { events, state, retry, draft, error } = useSession(sessionId);
  const bottom = useRef<HTMLDivElement>(null);
  const [resumeErr, setResumeErr] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [text, setText] = useState("");
  const files = useAttachments();
  const current = sessions.active.find((s) => s.id === sessionId);
  const title = current?.title ?? "AI 대화";
  const outputs = useOutputs(events, current?.createdAt ?? null);
  useEffect(() => setShowList(false), [sessionId]);
  useEffect(() => {
    setText("");
    files.clear();
  }, [sessionId]);

  // Block body on purpose: newer Chrome returns a Promise from scrollIntoView(),
  // and React would call a returned value as the effect's cleanup and crash.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, draft]);

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
        {sessions.active.length === 0 && <p className="muted small">없어요</p>}
        {sessions.active.map((s) => (
          <a key={s.id} href={`#/chat/${s.id}`} className={`session ${s.id === sessionId ? "active" : ""}`} onClick={() => setShowList(false)}>
            <span>{s.title}</span>
            <span className="small">
              <span className={`dot ${s.state}`} /> {STATE_LABEL[s.state]}
              {s.pending > 0 && <span className="chip warn">답변 필요 {s.pending}</span>}
            </span>
          </a>
        ))}
        <h3>지난 대화</h3>
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
      <DropZone className="chat-body" onFiles={files.add}>
        <div className="chat-toolbar">
          <button className="btn secondary list-toggle" onClick={() => setShowList((v) => !v)}>
            대화 목록
          </button>
          {sessionId && <b className="chat-title ellipsis">{title}</b>}
          {current && current.state !== "closed" && <ModeSelect sessionId={current.id} mode={current.mode} />}
          {sessionId && events.length > 0 && (
            <button className="btn ghost" title="대화 내용을 마크다운 파일로 저장해요" onClick={() => downloadText(`${title}-${stamp()}.md`, conversationMarkdown(title, events))}>
              <Icon name="download" size={14} /> 대화 내보내기
            </button>
          )}
          {sessionId && state && state !== "closed" && (
            <button
              className="btn secondary"
              title="AI 작업을 끝냅니다. 기록은 '지난 대화'에서 이어서 할 수 있어요."
              onClick={() => {
                void sendJSON(`/api/sessions/${sessionId}`, "DELETE").then(() => (location.hash = "#/chat"));
              }}
            >
              대화 끝내기
            </button>
          )}
        </div>
        <div className="messages">
          {!sessionId && (
            <div className="empty">
              <h2>무엇을 도와드릴까요?</h2>
              <p className="muted">궁금한 점이나 부탁할 일을 편하게 적어 주세요.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => setText(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          <ErrorBox error={error} />
          {sessionId && <EventList sessionId={sessionId} events={events} draft={draft} title={title} />}
          {state !== "running" && <OutputFiles outputs={outputs} zipName={title} title="이 대화에서 AI가 만든 파일" />}
          {state === "running" && retry && <RetryNotice retry={retry} />}
          {state === "running" && !draft && !retry && <div className="muted small typing"><span className="spinner" /> 작업 중…</div>}
          <div ref={bottom} />
        </div>
        <Composer sessionId={sessionId} state={state} commands={commands} text={text} setText={setText} files={files} />
      </DropZone>
    </div>
  );
}

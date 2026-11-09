import { useMemo, useRef, useState } from "react";
import { live, useRuns, type SessionSummary } from "./api.ts";
import { applicationId } from "./pipeline.ts";
import { AttachButton, AttachmentTray, DropZone, useAttachments } from "./attach.tsx";
import { resultErrorText } from "./labels.ts";
import { panel, usePanel } from "./panel.ts";
import { currentActivity, lastReply, progressOf } from "./progress.ts";
import { ModeSelect, OutputFiles, PermissionCard, Progress, QuestionCard, ReplyActions, RetryNotice, useOutputs, useResolved, useSession, useToolResults } from "./session.tsx";
import { ErrorBox, Markdown } from "./ui.tsx";

function TaskView({ id, since, title }: { id: string; since: number | null; title: string }) {
  const { events, state, retry, draft, error } = useSession(id);
  const results = useToolResults(events);
  const resolved = useResolved(events);
  const steps = useMemo(() => progressOf(events), [events]);
  const outputs = useOutputs(events, since);
  const [text, setText] = useState("");
  const files = useAttachments();

  const waiting = events.filter((e) => (e.kind === "permission" || e.kind === "question") && !resolved.has(e.requestId));
  const turn = events.slice(events.findLastIndex((e) => e.kind === "user") + 1);
  const failure = turn.findLast((e) => e.kind === "error");
  const result = turn.findLast((e) => e.kind === "result");
  const activity = state === "running" ? currentActivity(events, results) : null;
  const reply = draft || lastReply(events);
  const succeeded = state !== "running" && !failure && result?.kind === "result" && result.ok;

  const status =
    state === null ? "불러오는 중…" :
    waiting.length > 0 ? "답변을 기다려요" :
    state === "running" ? "진행 중" :
    failure ? "문제가 생겨 멈췄어요" :
    result?.kind === "result" && !result.ok ? resultErrorText(result.text) :
    succeeded ? "끝났어요" :
    state === "closed" ? "종료됨" :
    "대기 중";
  const statusClass = waiting.length ? "wait" : failure || (result?.kind === "result" && !result.ok) ? "fail" : (state ?? "");

  const canSend = (text.trim() !== "" || files.paths.length > 0) && !files.uploading;
  const send = () => {
    if (!canSend) return;
    live.send({ t: "send", id, text: text.trim(), ...(files.paths.length ? { attachments: files.paths } : {}) });
    setText("");
    files.clear();
  };

  return (
    <div className="task-view">
      <div className={`task-status ${statusClass}`}>{status}</div>
      <ErrorBox error={error} />
      {failure?.kind === "error" && <div className="error-box">{failure.text}</div>}
      <Progress steps={steps} />
      {activity && <div className="activity-now"><span className="spinner" /> {activity}</div>}
      {state === "running" && !activity && waiting.length === 0 && <div className="activity-now"><span className="spinner" /> 생각하는 중…</div>}
      {retry && state === "running" && <RetryNotice retry={retry} />}

      {waiting.map((e) =>
        e.kind === "permission" ? (
          <PermissionCard key={e.requestId} sessionId={id} event={e} />
        ) : e.kind === "question" ? (
          <QuestionCard key={e.requestId} sessionId={id} event={e} />
        ) : null,
      )}

      {reply && (
        <div className={`task-reply ${succeeded ? "final" : ""}`}>
          <div className="muted small">{succeeded ? "결과" : "AI 메시지"}</div>
          <Markdown text={reply} />
          {!draft && <ReplyActions text={reply} name={title} />}
        </div>
      )}

      <OutputFiles outputs={outputs} zipName={title} />

      {state && state !== "closed" && (
        <DropZone className="task-compose" onFiles={files.add}>
          <AttachmentTray attachments={files} />
          <div className="task-reply-box">
            <textarea
              rows={2}
              value={text}
              placeholder={state === "running" ? "추가로 전할 말이나 파일이 있으면 보내 주세요" : "더 부탁할 일이 있으면 적어 주세요 (예: 커버레터를 더 짧게)"}
              onChange={(e) => setText(e.target.value)}
              onPaste={files.onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </div>
          <div className="row">
            <AttachButton onFiles={files.add} />
            <span className="grow" />
            <button className="btn primary" disabled={!canSend} onClick={send}>보내기</button>
          </div>
        </DropZone>
      )}

      <div className="row wrap task-foot">
        {state === "running" && (
          <button className="btn danger" onClick={() => live.send({ t: "interrupt", id })}>멈추기</button>
        )}
        <a className="btn secondary" href={`#/chat/${id}`} onClick={() => panel.hide()}>전체 기록 보기</a>
      </div>
    </div>
  );
}

export function TaskPanel({ sessions, shownElsewhere }: { sessions: SessionSummary[]; shownElsewhere: string | null }) {
  const { open, sessionId } = usePanel();
  const runs = useRuns();
  const run = sessionId ? runs.data?.find((r) => r.sessionId === sessionId) : undefined;
  const resultHref = run && run.state !== "running" ? (run.state === "succeeded" && run.checks?.row ? `#/applications/${applicationId(run.checks.row)}` : `#/runs/${run.id}`) : null;
  const started = useRef(new Map<string, number>());
  for (const s of sessions) started.current.set(s.id, s.createdAt);
  if (!open) return null;
  const list = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  const current = sessions.find((s) => s.id === sessionId);
  return (
    <aside className="task-panel" aria-label="AI 작업">
      <header className="task-head">
        <b>AI 작업</b>
        <button className="btn secondary" onClick={() => panel.hide()} aria-label="닫기">닫기</button>
      </header>
      {list.length > 0 && (
        <ul className="task-list">
          {list.map((s) => (
            <li key={s.id}>
              <button className={`task-item ${s.id === sessionId ? "active" : ""}`} onClick={() => panel.select(s.id)}>
                <span className={`dot ${s.state}`} />
                <span className="ellipsis">{s.title}</span>
                {s.pending > 0 && <span className="chip warn">답변 필요</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sessionId && sessionId === shownElsewhere ? (
        <p className="muted">이 작업은 지금 왼쪽 대화 화면에 열려 있어요.</p>
      ) : sessionId ? (
        <>
          {current && (
            <div className="task-title-row">
              <h2 className="task-title">{current.title}</h2>
              {current.state !== "closed" && <ModeSelect sessionId={current.id} mode={current.mode} />}
            </div>
          )}
          {resultHref && (
            <a className="btn primary block" href={resultHref} onClick={() => panel.hide()}>
              {run?.state === "succeeded" ? "완성된 지원서 보기" : "결과 확인하기"}
            </a>
          )}
          <TaskView key={sessionId} id={sessionId} since={started.current.get(sessionId) ?? null} title={current?.title ?? "AI 작업"} />
        </>
      ) : (
        <p className="muted">진행 중인 작업이 없어요. 화면의 버튼을 누르면 AI가 여기서 일을 시작해요.</p>
      )}
    </aside>
  );
}

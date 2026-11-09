import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./pages/Chat.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Documents } from "./pages/Documents.tsx";
import { Jobs } from "./pages/Jobs.tsx";
import { Profile } from "./pages/Profile.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Tracker } from "./pages/Tracker.tsx";
import { useActiveSessions } from "./api.ts";
import { panel, usePanel } from "./panel.ts";
import { TaskPanel } from "./TaskPanel.tsx";

const NAV = [
  { path: "", label: "홈" },
  { path: "jobs", label: "공고 찾기" },
  { path: "tracker", label: "내 지원" },
  { path: "documents", label: "서류함" },
  { path: "profile", label: "내 프로필" },
  { path: "chat", label: "AI 비서" },
];

function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, "").split("/");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function App() {
  const [page = "", arg] = useRoute();
  const active = useActiveSessions();
  const { open, sessionId } = usePanel();
  const running = active.filter((s) => s.state === "running").length;
  const pending = active.reduce((n, s) => n + s.pending, 0);
  const onChat = page === "chat" ? (arg ?? null) : null;
  // The panel never shows the session the chat page already shows.
  const onPanel = open && sessionId !== onChat ? sessionId : null;
  const unseenWaiting = active.find((s) => s.pending > 0 && s.id !== onChat && s.id !== onPanel);

  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) 답변 필요 · AI Job Search` : "AI Job Search";
  }, [pending]);

  const body =
    page === "jobs" ? <Jobs /> :
    page === "tracker" ? <Tracker /> :
    page === "documents" ? <Documents /> :
    page === "profile" ? <Profile /> :
    page === "settings" ? <Settings /> :
    page === "chat" ? <Chat sessionId={arg ?? null} /> :
    <Dashboard />;
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">AI Job Search</div>
        {NAV.map((n) => (
          <a key={n.path} href={`#/${n.path}`} className={page === n.path ? "active" : ""}>
            {n.label}
          </a>
        ))}
        <div className="sidebar-bottom">
          <button className={`sidebar-tasks ${open ? "active" : ""}`} onClick={() => panel.toggle()}>
            AI 작업
            {running > 0 && <span className="badge run">{running}</span>}
            {pending > 0 && <span className="badge wait">답변 {pending}</span>}
          </button>
          <a href="#/settings" className={page === "settings" ? "active" : ""}>설정</a>
        </div>
      </nav>
      <main className={page === "chat" ? "main chat-main" : "main"}>{body}</main>
      <TaskPanel sessions={active} shownElsewhere={onChat} />
      {unseenWaiting && (
        <button className="toast" onClick={() => panel.show(unseenWaiting.id)}>
          {unseenWaiting.title}: AI가 답을 기다려요 <b>확인하기</b>
        </button>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

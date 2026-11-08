import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./pages/Chat.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Documents } from "./pages/Documents.tsx";
import { Jobs } from "./pages/Jobs.tsx";
import { Profile } from "./pages/Profile.tsx";
import { Tracker } from "./pages/Tracker.tsx";

const NAV = [
  { path: "", label: "대시보드" },
  { path: "jobs", label: "공고" },
  { path: "tracker", label: "지원 현황" },
  { path: "documents", label: "서류" },
  { path: "profile", label: "프로필" },
  { path: "chat", label: "대화" },
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
  const body =
    page === "jobs" ? <Jobs /> :
    page === "tracker" ? <Tracker /> :
    page === "documents" ? <Documents /> :
    page === "profile" ? <Profile /> :
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
      </nav>
      <main className={page === "chat" ? "main chat-main" : "main"}>{body}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

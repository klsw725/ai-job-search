import { useEffect, useState } from "react";
import { fileUrl, useFetch } from "../api.ts";
import { Card, ErrorBox, Markdown, formatBytes, formatTime } from "../ui.tsx";

type FileEntry = { path: string; size: number; mtime: number };

const UPLOAD_DIRS: [string, string][] = [
  ["cv", "이력서"],
  ["linkedin", "LinkedIn 프로필 (PDF)"],
  ["diplomas", "졸업·성적 증명서"],
  ["references", "추천서"],
  ["projects", "프로젝트·포트폴리오"],
  ["postings", "공고 원문"],
];

const GROUP_LABEL: Record<string, string> = {
  cv: "AI가 만든 이력서",
  cover_letters: "AI가 만든 커버레터",
  "documents/cv": "올린 이력서",
  "documents/linkedin": "올린 LinkedIn 프로필",
  "documents/diplomas": "올린 증명서",
  "documents/references": "올린 추천서",
  "documents/projects": "올린 프로젝트 자료",
  "documents/postings": "공고 원문",
  "documents/profile": "내 프로필",
  company_research: "회사 조사 자료",
  reports: "리포트",
  upskill: "역량 분석",
  templates: "서류 디자인 템플릿",
  "job_search_tracker.csv": "지원 기록 파일",
  "CLAUDE.md": "기본 설정 파일",
};

const TEXT_EXT = /\.(md|txt|csv|json|typ|tex)$/i;

function Preview({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (TEXT_EXT.test(path)) {
      fetch(fileUrl(path))
        .then((r) => r.text())
        .then(setText)
        .catch(() => setText("(읽을 수 없습니다)"));
    }
  }, [path]);

  if (/\.pdf$/i.test(path)) return <iframe className="pdf" src={fileUrl(path)} title={path} />;
  if (/\.(png|jpe?g)$/i.test(path)) return <img className="preview-img" src={fileUrl(path)} alt={path} />;
  if (/\.html$/i.test(path)) {
    return (
      <p>
        <a href={fileUrl(path)} target="_blank" rel="noopener noreferrer">새 탭에서 열기</a>
      </p>
    );
  }
  if (text === null) return <p className="muted">{TEXT_EXT.test(path) ? "불러오는 중…" : "이 형식은 미리 볼 수 없어요. 새 탭에서 열어 주세요."}</p>;
  return /\.md$/i.test(path) ? <Markdown text={text} /> : <pre className="pre">{text}</pre>;
}

function Upload({ onDone }: { onDone: () => void }) {
  const [dir, setDir] = useState("cv");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="자료 올리기">
      <p className="muted">
        이력서나 증명서를 올리면 AI가 프로필을 만들거나 보강할 때 읽어요. 올린 파일은 이 컴퓨터의 작업 폴더에만 저장되고 공개 저장소에는 올라가지
        않아요.
      </p>
      <div className="row wrap">
        <select value={dir} onChange={(e) => setDir(e.target.value)}>
          {UPLOAD_DIRS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button
          className="btn primary"
          disabled={!file}
          onClick={async () => {
            if (!file) return;
            const form = new FormData();
            form.set("dir", dir);
            form.set("file", file);
            setErr(null);
            const res = await fetch("/api/upload", { method: "POST", body: form });
            const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
            if (res.ok) {
              setMsg(`${file.name}을(를) 올렸어요`);
              onDone();
            } else setErr(body.error ?? `HTTP ${res.status}`);
          }}
        >
          올리기
        </button>
      </div>
      {msg && <p className="ok">{msg}</p>}
      <ErrorBox error={err} />
    </Card>
  );
}

export function Documents() {
  const { data, error, reload } = useFetch<FileEntry[]>("/api/files", { live: true });
  const [selected, setSelected] = useState<string | null>(null);

  const groups = new Map<string, FileEntry[]>();
  for (const f of data ?? []) {
    const parts = f.path.split("/");
    const group = parts[0] === "documents" && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
    groups.set(group, [...(groups.get(group) ?? []), f]);
  }

  return (
    <div className="stack">
      <h1>서류함</h1>
      <ErrorBox error={error} />
      <Upload onDone={reload} />
      <div className="split">
        <Card title="파일" actions={<button className="btn secondary" onClick={reload}>새로고침</button>}>
          {[...groups.entries()].map(([g, files]) => (
            <details key={g} open={g === "cv" || g === "cover_letters"}>
              <summary>{GROUP_LABEL[g] ?? g} <span className="muted">({files.length})</span></summary>
              <ul className="files">
                {files.map((f) => (
                  <li key={f.path} className={selected === f.path ? "active" : ""} onClick={() => setSelected(f.path)}>
                    <span>{f.path.slice(g.length + 1)}</span>
                    <span className="muted small">{formatBytes(f.size)} · {formatTime(f.mtime)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {data?.length === 0 && <p className="muted">아직 파일이 없어요.</p>}
        </Card>
        <Card
          title={selected?.split("/").pop() ?? "미리보기"}
          actions={selected && <a href={fileUrl(selected)} target="_blank" rel="noopener noreferrer">새 탭에서 열기</a>}
        >
          {selected ? <Preview path={selected} /> : <p className="muted">왼쪽에서 파일을 고르면 여기에서 볼 수 있어요.</p>}
        </Card>
      </div>
    </div>
  );
}

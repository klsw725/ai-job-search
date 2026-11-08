import { useEffect, useState } from "react";
import { fileUrl, useFetch } from "../api.ts";
import { Card, ErrorBox, Markdown, formatBytes, formatTime } from "../ui.tsx";

type FileEntry = { path: string; size: number; mtime: number };

const UPLOAD_DIRS: [string, string][] = [
  ["cv", "이력서 (documents/cv)"],
  ["linkedin", "LinkedIn PDF (documents/linkedin)"],
  ["diplomas", "졸업·성적 증명 (documents/diplomas)"],
  ["references", "추천서 (documents/references)"],
  ["projects", "프로젝트 자료 (documents/projects)"],
  ["postings", "공고 원문 (documents/postings)"],
];

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
  if (text === null) return <p className="muted">{TEXT_EXT.test(path) ? "불러오는 중…" : "미리보기를 지원하지 않는 형식입니다."}</p>;
  return /\.md$/i.test(path) ? <Markdown text={text} /> : <pre className="pre">{text}</pre>;
}

function Upload({ onDone }: { onDone: () => void }) {
  const [dir, setDir] = useState("cv");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="자료 올리기">
      <p className="muted">/setup과 /expand가 이 폴더들을 읽어 프로필을 만듭니다. 올린 파일은 git에 커밋되지 않습니다.</p>
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
              setMsg(`${body.path} 저장됨`);
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
  const { data, error, reload } = useFetch<FileEntry[]>("/api/files");
  const [selected, setSelected] = useState<string | null>(null);

  const groups = new Map<string, FileEntry[]>();
  for (const f of data ?? []) {
    const parts = f.path.split("/");
    const group = parts[0] === "documents" && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
    groups.set(group, [...(groups.get(group) ?? []), f]);
  }

  return (
    <div className="stack">
      <h1>서류</h1>
      <ErrorBox error={error} />
      <Upload onDone={reload} />
      <div className="split">
        <Card title="파일" actions={<button className="btn secondary" onClick={reload}>새로고침</button>}>
          {[...groups.entries()].map(([g, files]) => (
            <details key={g} open={g === "cv" || g === "cover_letters"}>
              <summary>{g} <span className="muted">({files.length})</span></summary>
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
          {data?.length === 0 && <p className="muted">아직 파일이 없습니다.</p>}
        </Card>
        <Card
          title={selected ?? "미리보기"}
          actions={selected && <a href={fileUrl(selected)} target="_blank" rel="noopener noreferrer">새 탭</a>}
        >
          {selected ? <Preview path={selected} /> : <p className="muted">왼쪽에서 파일을 고르세요.</p>}
        </Card>
      </div>
    </div>
  );
}

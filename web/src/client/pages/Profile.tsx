import { useState } from "react";
import { runCommand, useFetch } from "../api.ts";
import { Card, CommandButton, ErrorBox, Markdown } from "../ui.tsx";

type Profile = { configured: boolean; files: { path: string; exists: boolean; content: string }[] };

const FILE_LABEL: Record<string, string> = {
  "candidate.md": "기본 정보",
  "01-candidate-profile.md": "경력·기술",
  "02-behavioral-profile.md": "일하는 방식",
  "04-job-evaluation.md": "공고 평가 기준",
  "05-cv-templates.md": "이력서 작성 방식",
  "07-interview-prep.md": "면접 준비 자료",
  "search-queries.md": "공고 검색 조건",
};

function tabLabel(path: string) {
  const name = path.split("/").pop() ?? path;
  return FILE_LABEL[name] ?? (name.startsWith("master-cv.") ? "기준 이력서" : name);
}

function EditRequest() {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="고치고 싶은 내용이 있나요?">
      <p className="muted">바꿀 내용을 적으면 AI가 프로필에 반영해요. 예: "2024년 결제 시스템 개편 프로젝트를 경력에 추가해 줘", "희망 지역에 판교도 넣어 줘"</p>
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="AI에게 부탁할 프로필 수정 내용" />
      <div className="row">
        <button
          className="btn primary"
          disabled={!text.trim()}
          onClick={() =>
            runCommand(`내 프로필(documents/profile/)을 다음 요청대로 고쳐 줘. 바꾸기 전에 어떤 파일의 어떤 부분을 바꿀지 먼저 보여 주고 확인을 받아 줘.\n\n${text.trim()}`, {
              title: "프로필 수정",
              kind: "profile-edit",
            })
              .then(() => setText(""))
              .catch((e: Error) => setErr(e.message))
          }
        >
          AI에게 수정 요청
        </button>
        <ErrorBox error={err} />
      </div>
    </Card>
  );
}

export function Profile() {
  const { data, error } = useFetch<Profile>("/api/profile", { live: true });
  const [tab, setTab] = useState(0);
  const file = data?.files[tab];

  return (
    <div className="stack">
      <h1>내 프로필</h1>
      <ErrorBox error={error} />
      <Card
        title={data?.configured ? "프로필이 준비됐어요" : "아직 프로필이 없어요"}
        actions={
          <>
            <CommandButton prompt="/setup" label={data?.configured ? "프로필 다시 만들기" : "프로필 만들기"} kind={data?.configured ? "secondary" : "primary"} />
            <CommandButton prompt="/setup --section search" label="희망 조건 수정" task="희망 조건 수정" />
            <CommandButton prompt="/expand" label="프로필 보강하기" hint="올린 자료와 온라인 활동에서 빠진 역량을 찾아 채워요" />
          </>
        }
      >
        <p className="muted">
          프로필은 이 컴퓨터에만 저장되고 공개 저장소에는 올라가지 않아요. AI는 지원서를 쓸 때 이 내용을 근거로 써요. 프로필을 지우고 처음부터 다시
          하려면 <a href="#/settings">설정 &gt; 데이터 초기화</a>를 쓰세요.
        </p>
        <div className="tabs">
          {data?.files.map((f, i) => (
            <button key={f.path} className={i === tab ? "tab active" : "tab"} onClick={() => setTab(i)}>
              {tabLabel(f.path)}
              {!f.exists && <span className="muted"> (비어 있음)</span>}
            </button>
          ))}
        </div>
        {file && !file.exists && <p className="muted">아직 내용이 없어요. [프로필 만들기]를 누르면 AI가 채워요.</p>}
        {file?.exists && /\.md$/.test(file.path) && <Markdown text={file.content.replace(/<!--[\s\S]*?-->/g, "")} />}
        {file?.exists && !/\.md$/.test(file.path) && <pre className="pre">{file.content}</pre>}
      </Card>
      {data?.configured && <EditRequest />}
    </div>
  );
}

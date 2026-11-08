import { useState } from "react";
import { useFetch } from "../api.ts";
import { Card, CommandButton, ErrorBox, Markdown } from "../ui.tsx";

type Profile = { configured: boolean; files: { path: string; exists: boolean; content: string }[] };

export function Profile() {
  const { data, error } = useFetch<Profile>("/api/profile");
  const [tab, setTab] = useState(0);
  const file = data?.files[tab];

  return (
    <div className="stack">
      <h1>프로필</h1>
      <ErrorBox error={error} />
      <Card
        title={data?.configured ? "프로필 설정됨" : "프로필 미설정"}
        actions={
          <>
            <CommandButton prompt="/setup" label="/setup" kind={data?.configured ? "secondary" : "primary"} />
            <CommandButton prompt="/setup --section search" label="검색 조건 수정" />
            <CommandButton prompt="/expand" label="역량 보강 (/expand)" />
          </>
        }
      >
        <p className="muted">
          프로필은 <code>documents/profile/</code>에 저장되며 git에 올라가지 않습니다. /setup이 만들고, 고칠 내용은 대화창에서 요청하거나 파일을 직접 고쳐도 됩니다.
        </p>
        <div className="tabs">
          {data?.files.map((f, i) => (
            <button key={f.path} className={i === tab ? "tab active" : "tab"} onClick={() => setTab(i)}>
              {f.path.split("/").pop()}
              {!f.exists && " (없음)"}
            </button>
          ))}
        </div>
        {file && !file.exists && <p className="muted">아직 없습니다. /setup을 실행하면 만들어집니다.</p>}
        {file?.exists && /\.md$/.test(file.path) && <Markdown text={file.content.replace(/<!--[\s\S]*?-->/g, "")} />}
        {file?.exists && !/\.md$/.test(file.path) && <pre className="pre">{file.content}</pre>}
      </Card>
    </div>
  );
}

import { useState } from "react";
import { runCommand, useFetch } from "../api.ts";
import { keyFacts, pendingItems, plainCommands, profileView, splitSections, type Fact } from "../profile.ts";
import { Card, CommandButton, EmptyState, ErrorBox, Icon, Markdown, PageHeader } from "../ui.tsx";

type ProfileFile = { path: string; exists: boolean; content: string };
type Profile = { configured: boolean; files: ProfileFile[] };

const FILE_LABEL: Record<string, string> = {
  "candidate.md": "기본 정보",
  "01-candidate-profile.md": "경력·기술",
  "02-behavioral-profile.md": "일하는 방식",
  "04-job-evaluation.md": "공고 평가 기준",
  "05-cv-templates.md": "이력서 작성 방식",
  "07-interview-prep.md": "면접 준비 자료",
  "search-queries.md": "공고 검색 조건",
};

const fileName = (path: string) => path.split("/").pop() ?? path;

function tabLabel(path: string) {
  const name = fileName(path);
  return FILE_LABEL[name] ?? (name.startsWith("master-cv.") ? "기준 이력서" : name);
}

const CONFIRM = "바꾸기 전에 어떤 파일의 어떤 부분을 바꿀지 먼저 보여 주고 확인을 받아 줘.";

function EditBox({ placeholder, onSend, onCancel }: { placeholder: string; onSend: (text: string) => Promise<unknown>; onCancel?: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="edit-box">
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoFocus={Boolean(onCancel)} />
      <div className="row wrap">
        <button
          className="btn primary small-btn"
          disabled={!text.trim() || busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            onSend(text.trim())
              .then(() => {
                setText("");
                onCancel?.();
              })
              .catch((e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <span className="spinner" /> : <Icon name="sparkle" size={14} />} AI에게 수정 요청
        </button>
        {onCancel && (
          <button className="btn ghost small-btn" onClick={onCancel}>
            취소
          </button>
        )}
        <ErrorBox error={err} />
      </div>
    </div>
  );
}

function KeyFacts({ facts, pending }: { facts: Fact[]; pending: Fact[] }) {
  if (facts.length === 0 && pending.length === 0) return null;
  const list = pending.map((p) => `- ${p.label ? `${p.label}: ` : ""}${p.value}`).join("\n");
  return (
    <div className="grid2 profile-top">
      {facts.length > 0 && (
        <Card title="한눈에 보기">
          <dl className="facts">
            {facts.map((f) => (
              <div key={f.label} className="fact">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
      {pending.length > 0 && (
        <Card
          title={
            <span className="row">
              <Icon name="alert" size={16} /> 확인이 필요해요 <span className="chip warn">{pending.length}</span>
            </span>
          }
        >
          <p className="muted small">아직 확인되지 않았거나 비어 있는 항목이에요. 채워 두면 AI가 지원서를 더 정확하게 써요.</p>
          <ul className="pending">
            {pending.map((p, i) => (
              <li key={i}>
                {p.label && <b>{p.label}</b>}
                <span className="muted">{p.value}</span>
              </li>
            ))}
          </ul>
          <CommandButton
            prompt={`내 프로필(documents/profile/)에서 아직 확인되지 않았거나 비어 있는 아래 항목을 하나씩 물어보고 채워 줘. ${CONFIRM}\n\n${list}`}
            label="AI와 하나씩 채우기"
            task="프로필 빈 곳 채우기"
            icon="sparkle"
            kind="primary"
          />
        </Card>
      )}
    </div>
  );
}

function SectionCard({ file, heading, title, body }: { file: string; heading: string; title: string; body: string }) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="card pf-section">
      <header className="card-head">
        <h2>{title || "개요"}</h2>
        {!editing && (
          <button className="btn ghost small-btn" onClick={() => setEditing(true)}>
            <Icon name="sparkle" size={14} /> 고쳐 달라고 하기
          </button>
        )}
      </header>
      {body ? <Markdown text={plainCommands(body)} /> : <p className="muted">비어 있어요.</p>}
      {editing && (
        <EditBox
          placeholder={`'${title || "개요"}'에서 바꾸고 싶은 내용`}
          onCancel={() => setEditing(false)}
          onSend={(text) =>
            runCommand(`내 프로필 파일 ${file}의 "${heading || "첫 부분"}" 부분을 다음 요청대로 고쳐 줘. ${CONFIRM}\n\n${text}`, {
              title: `프로필 수정 · ${title || "개요"}`,
              kind: "profile-edit",
            })
          }
        />
      )}
    </section>
  );
}

function FileView({ file }: { file: ProfileFile }) {
  if (!file.exists) {
    return (
      <EmptyState icon="user" title="아직 내용이 없어요">
        [프로필 만들기]를 누르면 AI가 이력서를 읽고 채워요.
      </EmptyState>
    );
  }
  if (!/\.md$/.test(file.path)) {
    return (
      <Card title={tabLabel(file.path)}>
        <p className="muted">AI가 지원서를 만들 때 출발점으로 쓰는 기준 이력서 원본이에요. PDF는 지원서를 만들 때 공고에 맞춰 새로 만들어요.</p>
        <pre className="pre">{file.content}</pre>
      </Card>
    );
  }
  const sections = splitSections(file.content);
  return (
    <div className="stack">
      {sections.map((s, i) => (
        <SectionCard key={`${file.path}-${i}`} file={file.path} heading={s.heading} title={s.title} body={s.body} />
      ))}
    </div>
  );
}

export function Profile() {
  const { data, error } = useFetch<Profile>("/api/profile", { live: true });
  const [tab, setTab] = useState(0);
  const file = data?.files[tab];
  const summary = data?.files.find((f) => f.exists && fileName(f.path) === "candidate.md");
  const view = profileView(data);

  return (
    <div className="stack">
      <PageHeader
        title="내 프로필"
        description="AI가 공고를 평가하고 지원서를 쓸 때 근거로 삼는 내 정보예요. 이 컴퓨터에만 저장되고 공개 저장소에는 올라가지 않아요."
        actions={
          <>
            <CommandButton prompt="/setup" label={data?.configured ? "프로필 다시 만들기" : "프로필 만들기"} kind={data?.configured ? "secondary" : "primary"} />
            <CommandButton prompt="/setup --section search" label="희망 조건 수정" task="희망 조건 수정" />
            <CommandButton prompt="/expand" label="프로필 보강하기" icon="sparkle" hint="올린 자료와 온라인 활동에서 빠진 역량을 찾아 채워요" />
          </>
        }
      />
      <ErrorBox error={error} />
      {view.setupPrompt && (
        <EmptyState icon="user" title="아직 프로필이 없어요" action={<CommandButton prompt="/setup" label="프로필 만들기" kind="primary" />}>
          서류함에 이력서를 올린 뒤 [프로필 만들기]를 누르면, AI가 이력서를 읽고 궁금한 점을 물어보며 프로필을 만들어요.
        </EmptyState>
      )}
      {summary && <KeyFacts facts={keyFacts(summary.content)} pending={pendingItems(summary.content)} />}
      {data && view.files && (
        <>
          <div className="seg" role="group" aria-label="프로필 파일">
            {data.files.map((f, i) => (
              <button key={f.path} aria-pressed={i === tab} className={i === tab ? "on" : ""} onClick={() => setTab(i)}>
                {tabLabel(f.path)}
                {!f.exists && <span className="n">비어 있음</span>}
              </button>
            ))}
          </div>
          {file && <FileView file={file} />}
        </>
      )}
      {data?.configured && (
        <>
          <Card title="그 밖에 고치고 싶은 내용이 있나요?">
            <p className="muted">예: "2024년 결제 시스템 개편 프로젝트를 경력에 추가해 줘", "희망 지역에 판교도 넣어 줘". 프로필을 지우고 처음부터 다시 하려면 <a href="#/settings">설정 &gt; 데이터 초기화</a>를 쓰세요.</p>
            <EditBox
              placeholder="AI에게 부탁할 프로필 수정 내용"
              onSend={(text) => runCommand(`내 프로필(documents/profile/)을 다음 요청대로 고쳐 줘. ${CONFIRM}\n\n${text}`, { title: "프로필 수정", kind: "profile-edit" })}
            />
          </Card>
        </>
      )}
    </div>
  );
}

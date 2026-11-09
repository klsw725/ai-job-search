import { useState } from "react";
import { runCommand, safeHttpUrl, useFetch } from "../api.ts";
import { recommended } from "../jobs.ts";
import { COMMAND_LABEL } from "../labels.ts";
import { Card, CommandButton, Deadline, ErrorBox, StatusChip, daysUntil } from "../ui.tsx";
import { TrustCard, setupIssues, type Status } from "./Settings.tsx";

type Tracker = { exists: boolean; rows: Record<string, string>[] };
type Jobs = { exists: boolean; jobs: Record<string, unknown>[] };
type Profile = { configured: boolean };

function applyTitle(input: string): string {
  const url = safeHttpUrl(input.split(/\s/)[0]);
  return url ? `지원서 만들기 · ${new URL(url).hostname.replace(/^www\./, "")}` : "지원서 만들기 · 붙여넣은 공고";
}

function NewApplication() {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="지원할 공고가 있나요?">
      <p className="muted">
        공고 링크를 붙여넣으면 AI가 나와 잘 맞는지 먼저 평가하고, 공고에 맞춘 이력서와 커버레터를 만들어 드려요. 링크가 열리지 않는 사이트라면 공고 내용을
        통째로 붙여넣어도 돼요.
      </p>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="https://… 공고 링크 또는 공고 내용" />
      <div className="row">
        <button
          className="btn primary"
          disabled={!text.trim() || busy}
          onClick={() => {
            const t = text.trim();
            setBusy(true);
            setErr(null);
            runCommand(`/apply ${t}`, { title: applyTitle(t) })
              .then(() => setText(""))
              .catch((e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          지원서 만들기
        </button>
        <ErrorBox error={err} />
      </div>
    </Card>
  );
}

const QUICK_ACTIONS: [prompt: string, name: string][] = [
  ["/scrape", "scrape"],
  ["/rank", "rank"],
  ["/outcome", "outcome"],
  ["/upskill", "upskill"],
  ["/html-report", "html-report"],
];

export function Dashboard() {
  const status = useFetch<Status>("/api/status");
  const tracker = useFetch<Tracker>("/api/tracker", { live: true });
  const jobs = useFetch<Jobs>("/api/jobs", { live: true });
  const profile = useFetch<Profile>("/api/profile", { live: true });

  const rows = tracker.data?.rows ?? [];
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const s = r.status || "unknown";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const open = rows.filter((r) => r._open === "1");
  const soon = open
    .filter((r) => {
      const d = daysUntil(r.deadline);
      return d !== null && d <= 7;
    })
    .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""));
  const ranked = recommended(jobs.data?.jobs ?? []);
  const issues = status.data ? setupIssues(status.data).filter((i) => i.code !== "untrusted") : [];

  return (
    <div className="stack">
      <h1>홈</h1>
      <ErrorBox error={status.error ?? tracker.error ?? jobs.error} />

      {issues.length > 0 && (
        <div className="notice">
          <b>확인이 필요해요:</b> {issues.map((i) => i.text).join(" · ")} <a href="#/settings">설정에서 확인하기</a>
        </div>
      )}

      {status.data && !status.data.trusted && <TrustCard status={status.data} onDone={status.reload} />}

      {profile.data && !profile.data.configured && (
        <Card title="먼저 내 프로필을 만들어 주세요">
          <p>
            AI가 지원서를 쓰려면 내 경력과 희망 조건을 알아야 해요. <a href="#/documents">서류함</a>에 이력서를 올린 뒤 시작하면 AI가 내용을 읽고 프로필을
            채워요. 이력서가 없으면 질문에 답하면서 만들 수도 있어요.
          </p>
          <CommandButton prompt="/setup" label="프로필 만들기" kind="primary" />
        </Card>
      )}

      <NewApplication />

      <div className="grid2">
        <Card title="내 지원" actions={<a href="#/tracker">전체 보기</a>}>
          {rows.length === 0 ? (
            <p className="muted">아직 지원한 곳이 없어요. 위에 공고 링크를 넣어 첫 지원서를 만들어 보세요.</p>
          ) : (
            <div className="row wrap">
              {Object.entries(counts).map(([s, n]) => (
                <span key={s} className="count">
                  <StatusChip status={s} /> {n}
                </span>
              ))}
            </div>
          )}
          {soon.length > 0 && (
            <>
              <h3>마감이 다가와요 (7일 이내)</h3>
              <ul className="plain">
                {soon.map((r, i) => (
                  <li key={i}>
                    <b>{r.company}</b> · {r.role} — <Deadline date={r.deadline} /> <StatusChip status={r.status} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="추천 공고" actions={<a href="#/jobs">전체 보기</a>}>
          {ranked.length === 0 ? (
            <>
              <p className="muted">아직 추천할 공고가 없어요. 채용 사이트에서 공고를 모으면 AI가 내 프로필과 비교해 점수를 매겨요.</p>
              <CommandButton prompt="/scrape" label="새 공고 찾기" />
            </>
          ) : (
            <ul className="plain">
              {ranked.map((j) => (
                <li key={String(j.key)} className="row">
                  <span className="score">{String(j.rank_score)}점</span>
                  <span className="grow">
                    <b>{String(j.company ?? "")}</b> · {String(j.title ?? "")}
                  </span>
                  {typeof j.url === "string" && (
                    <CommandButton prompt={`/apply ${j.url}`} label="지원서 만들기" task={`지원서 만들기 · ${String(j.company ?? "")} / ${String(j.title ?? "")}`} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="AI에게 맡기기">
        <div className="tiles">
          {QUICK_ACTIONS.map(([prompt, name]) => (
            <div key={name} className="tile">
              <div>
                <b>{COMMAND_LABEL[name]!.label}</b>
                <div className="muted small">{COMMAND_LABEL[name]!.description}</div>
              </div>
              <CommandButton prompt={prompt} label="시작" />
            </div>
          ))}
          <div className="tile">
            <div>
              <b>후속 연락 메일 쓰기</b>
              <div className="muted small">답이 없는 지원에 보낼 정중한 확인 메일 초안을 써요</div>
            </div>
            <CommandButton prompt="/outcome followup" label="시작" task="후속 연락 메일 쓰기" />
          </div>
        </div>
      </Card>
    </div>
  );
}

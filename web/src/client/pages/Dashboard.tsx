import { useState } from "react";
import { runCommand, sendJSON, useFetch } from "../api.ts";
import { recommended } from "../jobs.ts";
import { Card, CommandButton, Deadline, ErrorBox, StatusChip, daysUntil } from "../ui.tsx";

type Status = {
  auth: string | null;
  baseUrl: string | null;
  model: string | null;
  typst: boolean;
  lualatex: boolean;
  activeTemplate: string | null;
  repo: string;
  trusted: boolean;
  fileAccess: "secure" | "insecure" | "blocked";
};
type Tracker = { exists: boolean; rows: Record<string, string>[] };
type Jobs = { exists: boolean; jobs: Record<string, unknown>[] };
type Profile = { configured: boolean };

const AUTH_LABEL: Record<string, string> = { subscription: "구독 토큰", api_key: "API 키", auth_token: "게이트웨이 토큰", login: "로그인 세션" };

function NewApplication() {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="새 공고 지원">
      <p className="muted">공고 URL을 넣거나, 사이트가 막혀 있으면 공고 본문을 통째로 붙여넣으세요. /apply가 적합도 평가부터 시작합니다.</p>
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="https://... 또는 공고 본문" />
      <div className="row">
        <button
          className="btn primary"
          disabled={!text.trim()}
          onClick={() => runCommand(`/apply ${text.trim()}`).catch((e: Error) => setErr(e.message))}
        >
          /apply 실행
        </button>
        <ErrorBox error={err} />
      </div>
    </Card>
  );
}

export function Dashboard() {
  const status = useFetch<Status>("/api/status");
  const tracker = useFetch<Tracker>("/api/tracker");
  const jobs = useFetch<Jobs>("/api/jobs");
  const profile = useFetch<Profile>("/api/profile");

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

  return (
    <div className="stack">
      <h1>대시보드</h1>
      <ErrorBox error={status.error ?? tracker.error ?? jobs.error} />

      {status.data && (
        <div className="stats">
          <div className={`stat ${status.data.auth ? "" : "warn"}`}>
            <span>Claude 인증</span>
            <b>{status.data.auth ? AUTH_LABEL[status.data.auth] : "확인 안 됨"}</b>
          </div>
          <div className="stat" title={status.data.baseUrl ?? "https://api.anthropic.com"}>
            <span>API 엔드포인트</span>
            <b className="ellipsis">{status.data.baseUrl ?? "Anthropic 기본"}</b>
            {status.data.model && <span>모델: {status.data.model}</span>}
          </div>
          <div className={`stat ${status.data.typst ? "" : "warn"}`}>
            <span>Typst</span>
            <b>{status.data.typst ? "설치됨" : "없음"}</b>
          </div>
          <div className="stat">
            <span>서류 템플릿</span>
            <b>{status.data.activeTemplate ?? "기본(LaTeX)"}</b>
          </div>
          <div className={`stat ${profile.data?.configured ? "" : "warn"}`}>
            <span>프로필</span>
            <b>{profile.data?.configured ? "설정됨" : "미설정"}</b>
          </div>
        </div>
      )}

      {status.data?.fileAccess === "blocked" && (
        <div className="error-box">
          이 환경(macOS 등)에서는 저장소 파일을 안전하게 열 방법이 없어서 웹 UI의 파일 읽기·업로드를 막아 두었습니다. 그래서 지원 현황·프로필·서류가 비어 보입니다.
          Docker로 실행하세요(<code>docker compose up -d</code>). 저장소에 쓸 수 있는 프로그램을 모두 신뢰한다면 <code>AJS_INSECURE_PATH_CHECKS=1</code>로 실행할 수도 있습니다.
        </div>
      )}
      {status.data?.fileAccess === "insecure" && (
        <div className="error-box">
          <code>AJS_INSECURE_PATH_CHECKS=1</code>로 실행 중입니다. 파일 경로 검사를 다른 로컬 프로그램이 우회할 수 있습니다. 평소에는 Docker로 실행하세요.
        </div>
      )}

      {status.data && !status.data.auth && (
        <div className="error-box">
          컨테이너에서 Claude 인증 정보를 찾지 못했습니다. <code>.env</code>에 <code>CLAUDE_CODE_OAUTH_TOKEN</code>, <code>ANTHROPIC_API_KEY</code>,{" "}
          <code>ANTHROPIC_AUTH_TOKEN</code>(사용자 엔드포인트용) 중 하나를 넣고 다시 시작하세요.
        </div>
      )}

      {status.data && !status.data.trusted && (
        <Card title="작업 공간 신뢰가 필요합니다">
          <p>
            Claude Code는 신뢰하지 않은 폴더에서 <code>.claude/settings.json</code>의 허용 목록을 무시합니다. 그래서 지금은 검색 도구나 PDF 검사처럼
            미리 허용된 작업도 매번 승인 카드가 뜹니다. 이 저장소(<code>{status.data.repo}</code>)를 직접 받은 게 맞다면 신뢰하세요. 그러면 웹 UI가
            이 저장소의 허용·거부 규칙을 직접 적용합니다. 동의는 웹 UI 전용 파일(<code>ai-job-search-web.json</code>)에만 기록되고 Claude Code
            설정 파일은 건드리지 않습니다. 새로 시작하는 대화부터 적용됩니다.
          </p>
          <button className="btn primary" onClick={() => sendJSON("/api/trust", "POST").then(status.reload)}>
            이 작업 공간 신뢰하기
          </button>
        </Card>
      )}

      {profile.data && !profile.data.configured && (
        <Card title="프로필부터 설정하세요">
          <p>
            이력서 PDF를 <a href="#/documents">서류</a>에서 <code>documents/cv</code>에 올린 뒤 /setup을 실행하면 프로필이 자동으로 채워집니다.
          </p>
          <CommandButton prompt="/setup" label="/setup 시작" kind="primary" />
        </Card>
      )}

      <NewApplication />

      <div className="grid2">
        <Card title="지원 현황" actions={<a href="#/tracker">전체 보기</a>}>
          {rows.length === 0 ? (
            <p className="muted">아직 기록된 지원이 없습니다.</p>
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
              <h3>마감 임박 (7일 이내)</h3>
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

        <Card title="추천 공고 Top 5" actions={<a href="#/jobs">전체 보기</a>}>
          {ranked.length === 0 ? (
            <p className="muted">/scrape 후 /rank를 실행하면 점수순 추천이 여기 나옵니다.</p>
          ) : (
            <ul className="plain">
              {ranked.map((j) => (
                <li key={String(j.key)}>
                  <b>{String(j.rank_score)}</b> · {String(j.company ?? "")} — {String(j.title ?? "")}{" "}
                  {typeof j.url === "string" && <CommandButton prompt={`/apply ${j.url}`} label="지원" />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="자주 쓰는 명령">
        <div className="row wrap">
          <CommandButton prompt="/scrape" label="공고 검색 (/scrape)" />
          <CommandButton prompt="/rank" label="공고 순위 (/rank)" />
          <CommandButton prompt="/outcome" label="결과 기록 (/outcome)" />
          <CommandButton prompt="/outcome followup" label="후속 연락 (/outcome followup)" />
          <CommandButton prompt="/upskill" label="역량 분석 (/upskill)" />
          <CommandButton prompt="/html-report" label="리포트 생성 (/html-report)" />
        </div>
      </Card>
    </div>
  );
}

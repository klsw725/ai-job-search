import { useState } from "react";
import { WEB_MODES, sendJSON, useFetch, type WebMode } from "../api.ts";
import { MODE_TEXT } from "../labels.ts";
import { Card, CommandButton, ErrorBox, PageHeader } from "../ui.tsx";

export type Status = {
  auth: string | null;
  baseUrl: string | null;
  model: string | null;
  typst: boolean;
  lualatex: boolean;
  activeTemplate: string | null;
  repo: string;
  trusted: boolean;
  fileAccess: "secure" | "insecure" | "blocked";
  permissionMode: WebMode;
  bypassAllowed: boolean;
  connection: "env" | "account";
  login: LoginStatus;
  accountConflicts: string[];
  envAuth: string | null;
  envBaseUrl: string | null;
};

type LoginStatus = {
  supported: boolean;
  loggedIn: boolean;
  subscriptionType: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
};

const AUTH_LABEL: Record<string, string> = {
  subscription: "구독 토큰",
  api_key: "API 키",
  auth_token: "게이트웨이 토큰",
  login: "로그인 세션",
  account: "내 Claude 계정",
};

const PLAN_LABEL: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };

function daysLeft(at: number | null): number | null {
  return at === null ? null : Math.ceil((at - Date.now()) / 86_400_000);
}

function ClaudeConnectionCard({ status, onDone }: { status: Status; onDone: () => void }) {
  const { login } = status;
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const renewIn = daysLeft(login.refreshTokenExpiresAt);
  const blocked = status.accountConflicts.length > 0;

  const run = (p: Promise<unknown>, done?: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    p.then(() => {
      if (done) setMsg(done);
      onDone();
    })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const start = () => run(sendJSON<{ authorizeUrl: string }>("/api/claude-login/start", "POST").then((r) => setAuthorizeUrl(r.authorizeUrl)));
  const complete = () =>
    run(
      sendJSON("/api/claude-login/complete", "POST", { code }).then(async () => {
        setAuthorizeUrl(null);
        setCode("");
        if (status.connection !== "account" && !blocked) await sendJSON("/api/connection", "POST", { connection: "account" });
      }),
      "로그인했어요. 새로 시작하는 작업부터 내 Claude 계정으로 연결돼요.",
    );
  const choose = (connection: "env" | "account") => run(sendJSON("/api/connection", "POST", { connection }), "바꿨어요. 새로 시작하는 작업부터 적용돼요.");

  return (
    <Card title="Claude 연결">
      <p className="muted">AI 작업이 Claude에 어떻게 연결할지 골라요. 바꾼 연결은 새로 시작하는 작업부터 적용돼요.</p>

      <label className={`option ${status.connection === "account" ? "on" : ""} ${login.loggedIn && !blocked ? "" : "disabled"}`}>
        <input type="radio" name="connection" checked={status.connection === "account"} disabled={!login.loggedIn || blocked || busy} onChange={() => choose("account")} />
        <span>
          <b>내 Claude 계정으로 직접 연결</b>
          {login.loggedIn && <span className="chip st-applied">로그인됨{login.subscriptionType ? ` · ${PLAN_LABEL[login.subscriptionType] ?? login.subscriptionType}` : ""}</span>}
          <span className="muted small option-desc">
            Pro/Max 구독 계정으로 로그인해요. 로그인 정보는 Claude Code가 스스로 갱신하고, 프록시를 거치지 않아 웹 검색도 쓸 수 있어요.
          </span>
          {blocked && (
            <span className="small option-desc warn-text">
              다음 설정이 다른 연결을 지정하고 있어 쓸 수 없어요. 해당 항목을 지우면 쓸 수 있어요: {status.accountConflicts.join(", ")}
            </span>
          )}
          {login.loggedIn && renewIn !== null && (
            <span className={`small option-desc ${renewIn <= 3 ? "warn-text" : "muted"}`}>
              {renewIn <= 0 ? "로그인이 만료됐어요. 다시 로그인해 주세요." : `${renewIn}일 뒤에 다시 로그인해야 해요.`}
            </span>
          )}
        </span>
      </label>

      <label className={`option ${status.connection === "env" ? "on" : ""}`}>
        <input type="radio" name="connection" checked={status.connection === "env"} disabled={busy} onChange={() => choose("env")} />
        <span>
          <b>.env 설정 사용</b>
          <span className="muted small option-desc">
            {status.envBaseUrl
              ? `${status.envBaseUrl}을(를) 거쳐 연결해요. Meridian 같은 프록시를 거치면 웹 검색이 안 될 수 있어요.`
              : status.envAuth
                ? `${AUTH_LABEL[status.envAuth] ?? status.envAuth}(으)로 Anthropic에 바로 연결해요.`
                : ".env에 인증 정보가 없어요."}
          </span>
        </span>
      </label>

      {!login.supported ? (
        <div className="notice small">macOS에서 직접 실행하면 Claude Code가 로그인을 키체인에 보관해서 여기서 로그인할 수 없어요. Docker로 실행해 주세요.</div>
      ) : authorizeUrl ? (
        <div className="login-steps">
          <ol>
            <li>
              <a className="btn primary" href={authorizeUrl} target="_blank" rel="noopener noreferrer">
                Claude 로그인 페이지 열기
              </a>
              <span className="muted small"> 구독 계정으로 로그인하고 승인해 주세요.</span>
            </li>
            <li>
              <span>화면에 나온 코드를 복사해 붙여넣어 주세요.</span>
              <div className="row wrap">
                <input className="grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder="인증 코드 (또는 주소창의 전체 주소)" autoComplete="off" spellCheck={false} />
                <button className="btn primary" disabled={!code.trim() || busy} onClick={complete}>
                  {busy ? "확인하는 중…" : "로그인 완료"}
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => setAuthorizeUrl(null)}>
                  취소
                </button>
              </div>
            </li>
          </ol>
        </div>
      ) : (
        <div className="row wrap">
          <button className={`btn ${login.loggedIn ? "secondary" : "primary"}`} disabled={busy} onClick={start}>
            {login.loggedIn ? "다시 로그인" : "Claude 계정으로 로그인"}
          </button>
          {login.loggedIn && (
            <button className="btn danger" disabled={busy} onClick={() => run(sendJSON("/api/claude-login/logout", "POST"), "로그아웃했어요.")}>
              로그아웃
            </button>
          )}
        </div>
      )}
      {msg && <p className="ok small">{msg}</p>}
      <ErrorBox error={err} />
    </Card>
  );
}

export type SetupIssue = { code: "auth" | "file-blocked" | "file-insecure" | "untrusted" | "no-pdf"; text: string };

export function setupIssues(s: Status): SetupIssue[] {
  const issues: SetupIssue[] = [];
  if (!s.auth) issues.push({ code: "auth", text: "AI에 연결할 인증 정보가 없어요" });
  if (s.fileAccess === "blocked") issues.push({ code: "file-blocked", text: "이 실행 환경에서는 파일을 열 수 없어요" });
  if (s.fileAccess === "insecure") issues.push({ code: "file-insecure", text: "파일 경로 안전 검사가 약한 모드(AJS_INSECURE_PATH_CHECKS=1)로 실행 중이에요" });
  if (!s.trusted) issues.push({ code: "untrusted", text: "작업 폴더를 아직 신뢰하지 않았어요" });
  if (!s.typst && !s.lualatex) issues.push({ code: "no-pdf", text: "PDF를 만들 프로그램이 없어요" });
  return issues;
}

export function TrustCard({ status, onDone }: { status: Status; onDone: () => void }) {
  return (
    <Card title="이 작업 폴더를 신뢰할까요?">
      <p>
        신뢰하면 공고 검색이나 PDF 검사처럼 미리 정해 둔 안전한 작업은 AI가 매번 묻지 않고 바로 진행해요. 직접 내려받은 이 프로젝트라면 신뢰해도
        괜찮아요.
      </p>
      <details className="small">
        <summary className="muted">자세히</summary>
        <p className="muted">
          Claude Code는 신뢰하지 않은 폴더에서 <code>.claude/settings.json</code>의 허용 목록을 무시합니다. 신뢰하면 웹 UI가 이 저장소(
          <code>{status.repo}</code>)의 허용·거부 규칙을 직접 적용합니다. 동의는 웹 UI 전용 파일(<code>ai-job-search-web.json</code>)에만 기록되고
          Claude Code 설정 파일은 건드리지 않습니다. 새로 시작하는 작업부터 적용됩니다.
        </p>
      </details>
      <button className="btn primary" onClick={() => sendJSON("/api/trust", "POST").then(onDone)}>
        신뢰하기
      </button>
    </Card>
  );
}

function PermissionModeCard({ status, onDone }: { status: Status; onDone: () => void }) {
  const [picked, setPicked] = useState<WebMode>(status.permissionMode);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = picked !== status.permissionMode;
  const blocked = picked === "bypassPermissions" && !understood;

  const save = () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    sendJSON("/api/permission-mode", "POST", { mode: picked })
      .then(() => {
        setSaved(true);
        setUnderstood(false);
        onDone();
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <Card title="AI 권한 모드">
      <p className="muted">
        AI가 작업 중에 얼마나 자주 확인을 받을지 정해요. 여기서 고른 모드는 <b>새로 시작하는 작업</b>에 적용돼요. 진행 중인 작업은 작업 제목 옆의 ‘권한’에서
        바로 바꿀 수 있어요. 작업 폴더를 신뢰했다면 어느 모드에서도 설정 파일의 거부 규칙(예: <code>.env</code> 읽기 금지)은 지켜져요.
      </p>
      {WEB_MODES.map((m) => {
        const t = MODE_TEXT[m]!;
        const disabled = m === "bypassPermissions" && !status.bypassAllowed;
        return (
          <label key={m} className={`option risk-${t.risk} ${picked === m ? "on" : ""} ${disabled ? "disabled" : ""}`}>
            <input type="radio" name="permission-mode" checked={picked === m} disabled={disabled} onChange={() => setPicked(m)} />
            <span>
              <b>{t.label}</b>
              {m === status.permissionMode && <span className="chip">현재 기본값</span>}
              {m === "acceptEdits" && <span className="chip st-applied">추천</span>}
              <span className="muted small option-desc">{t.description}</span>
              {disabled && (
                <span className="small option-desc warn-text">
                  Docker로 실행할 때만 쓸 수 있어요. 컨테이너 밖에서는 AI가 이 컴퓨터의 다른 파일까지 건드릴 수 있어서 막아 두었어요.
                </span>
              )}
            </span>
          </label>
        );
      })}
      {picked === "bypassPermissions" && changed && (
        <label className={`option ${understood ? "on" : ""}`}>
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>
            <b>위험을 이해했어요</b>
            <span className="muted small option-desc">
              채용 공고는 누구나 쓸 수 있는 외부 텍스트예요. 확인을 생략하면 공고에 숨겨진 지시가 AI를 움직여 파일을 지우거나 내용을 밖으로 보낼 수 있어요.
            </span>
          </span>
        </label>
      )}
      <div className="row wrap">
        <button className={`btn ${picked === "bypassPermissions" ? "danger" : "primary"}`} disabled={!changed || blocked || busy} onClick={save}>
          {busy ? "저장하는 중…" : "기본 모드로 저장"}
        </button>
        {saved && !changed && <span className="ok small">저장했어요. 새 작업부터 적용돼요.</span>}
      </div>
      <ErrorBox error={err} />
    </Card>
  );
}

type ResetPreview = {
  profile: { entries: string[] } | { error: string };
  chats: { ids: string[]; ours: number } | { error: string };
  busy: number;
};
type ResetResult = {
  profile?: { deleted: string[]; partial?: boolean; remaining?: string[] | null; error?: string; changed?: boolean };
  chats?: { deleted: number; failed: number; kept: number; unconfirmed: number; stillRunning: number; error?: string };
};
type Line = { level: "ok" | "warn" | "error"; text: string };

const CONFIRM_WORD = "초기화";

function resultLines(r: ResetResult): Line[] {
  const lines: Line[] = [];
  const p = r.profile;
  if (p) {
    if (p.changed) lines.push({ level: "warn", text: p.error ?? "프로필 목록이 바뀌어 지우지 않았어요" });
    else if (p.error && (p.deleted.length || p.partial)) lines.push({ level: "error", text: `프로필을 일부 지운 뒤 멈췄어요 (끝까지 지운 항목 ${p.deleted.length}개): ${p.error}` });
    else if (p.error) lines.push({ level: "error", text: `프로필을 지우지 않았어요: ${p.error}` });
    else lines.push({ level: "ok", text: `프로필 항목 ${p.deleted.length}개를 지웠어요` });
    if (p.remaining && p.remaining.length) lines.push({ level: "warn", text: `프로필 폴더에 아직 남은 항목: ${p.remaining.join(", ")}` });
    if (p.remaining === null && (p.error || p.deleted.length)) lines.push({ level: "warn", text: "지운 뒤 프로필 폴더를 다시 확인하지 못했어요" });
  }
  const c = r.chats;
  if (c) {
    if (c.error) lines.push({ level: "error", text: `대화 기록을 다 확인하지 못했어요: ${c.error}` });
    lines.push({ level: c.deleted || !c.error ? "ok" : "error", text: `대화 기록 ${c.deleted}개를 지웠어요` });
    if (c.failed) lines.push({ level: "error", text: `${c.failed}개는 지우는 중 문제가 생겼어요. 일부 파일만 지워졌을 수 있어요` });
    if (c.kept) lines.push({ level: "warn", text: `다른 프로그램(터미널 등)이 쓰고 있을 수 있는 대화 ${c.kept}개는 남겨 뒀어요` });
    if (c.unconfirmed) lines.push({ level: "warn", text: `확인한 뒤에 새로 생긴 대화 ${c.unconfirmed}개는 지우지 않았어요` });
    if (c.stillRunning) lines.push({ level: "warn", text: `끝나지 않은 AI 작업 ${c.stillRunning}개가 있어 그 대화는 남겨 뒀어요. 잠시 뒤 다시 시도하세요` });
  }
  return lines;
}

function ResetCard() {
  const preview = useFetch<ResetPreview>("/api/reset", { live: true });
  const [profile, setProfile] = useState(false);
  const [chats, setChats] = useState(false);
  const [externalStopped, setExternalStopped] = useState(false);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const p = preview.data?.profile;
  const entries = p && "entries" in p ? p.entries : null;
  const c = preview.data?.chats;
  const chatIds = c && "ids" in c ? c.ids : null;
  const ours = c && "ours" in c ? c.ours : 0;
  const others = (chatIds?.length ?? 0) - ours;
  const profileBlocked = profile && !chats && (preview.data?.busy ?? 0) > 0;
  const ready = (profile || chats) && !profileBlocked && word.trim() === CONFIRM_WORD && !busy;

  const run = () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    sendJSON<ResetResult>("/api/reset", "POST", {
      targets: [...(profile ? ["profile"] : []), ...(chats ? ["chats"] : [])],
      confirm: word.trim(),
      externalStopped: chats && externalStopped,
      expected: { profile: entries ?? [], chats: chatIds ?? [] },
    })
      .then((r) => {
        setResult(r);
        setProfile(false);
        setChats(false);
        setExternalStopped(false);
        setWord("");
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => {
        setBusy(false);
        preview.reload();
      });
  };

  return (
    <Card title="데이터 초기화">
      <p className="muted">테스트하면서 쌓인 데이터를 지우고 처음부터 다시 시작할 수 있어요. 지운 내용은 되돌릴 수 없어요.</p>

      <label className={`option ${profile ? "on" : ""}`}>
        <input type="checkbox" checked={profile} disabled={!entries?.length} onChange={(e) => setProfile(e.target.checked)} />
        <span>
          <b>내 프로필</b>
          <span className="muted small option-desc">
            {p && "error" in p ? p.error : entries?.length ? `documents/profile 안의 ${entries.length}개: ${entries.join(", ")}` : "지울 프로필이 없어요"}
          </span>
          <span className="muted small option-desc">올린 서류, 지원 기록, 만든 이력서·커버레터는 지우지 않아요.</span>
          {profileBlocked && (
            <span className="small option-desc warn-text">AI 작업이 진행 중이에요. 작업이 끝난 뒤에 하거나, 대화 기록도 함께 선택하면 작업을 멈춘 뒤 지워요.</span>
          )}
        </span>
      </label>

      <label className={`option ${chats ? "on" : ""}`}>
        <input type="checkbox" checked={chats} disabled={!chatIds?.length} onChange={(e) => setChats(e.target.checked)} />
        <span>
          <b>AI 대화 기록</b>
          <span className="muted small option-desc">
            {c && "error" in c
              ? `대화 기록을 확인하지 못했어요: ${c.error}`
              : `이 폴더에 저장된 대화 ${chatIds?.length ?? 0}개 (같은 저장소의 다른 git worktree는 제외).`}
          </span>
          <span className="muted small option-desc">
            이 화면에서 시작한 AI 작업을 멈추고, 그 프로세스가 끝난 것을 확인한 뒤 지워요. 끝나지 않은 작업이 있으면 그 대화와 프로필은 지우지 않아요.
          </span>
        </span>
      </label>
      {chats && others > 0 && (
        <label className={`option ${externalStopped ? "on" : ""}`}>
          <input type="checkbox" checked={externalStopped} onChange={(e) => setExternalStopped(e.target.checked)} />
          <span>
            <b>터미널 등 다른 곳에서 이 폴더로 실행 중인 Claude Code가 없어요</b>
            <span className="muted small option-desc">
              대화 {others}개는 이 화면이 아닌 곳(터미널 등)에서 쓰였거나, 이 화면이 멈춘 뒤 다른 곳에서 이어 쓴 기록이에요. 실행 중인 프로그램이 없다고 확인해야
              함께 지워요. 확인하지 않으면 이 화면이 멈춘 대화 {ours}개만 지워요. 실행 중이면 먼저 종료하세요.
            </span>
          </span>
        </label>
      )}

      <div className="row wrap">
        <input value={word} onChange={(e) => setWord(e.target.value)} placeholder={`확인하려면 '${CONFIRM_WORD}'를 입력하세요`} />
        <button className="btn danger" disabled={!ready} onClick={run}>
          {busy ? "지우는 중… (진행 중인 작업이 끝나기를 기다려요)" : "선택한 데이터 지우기"}
        </button>
      </div>
      <ErrorBox error={err ?? preview.error} />
      {result && (
        <ul className="plain">
          {resultLines(result).map((l) => (
            <li key={l.text} className={l.level === "ok" ? "ok" : l.level === "warn" ? "warn-text" : "error-inline"}>{l.text}</li>
          ))}
        </ul>
      )}

      <details className="small">
        <summary className="muted">예전 버전이 저장소 파일에 써 둔 개인정보까지 정리하려면</summary>
        <p className="muted">
          예전 버전의 프로필 만들기는 개인정보를 프로젝트의 지침 파일에 직접 썼어요. 위 초기화는 그 파일들을 건드리지 않아요. AI가 지침 파일을 검사하고 자리표시
          값으로 되돌리게 하려면 아래 버튼을 누르세요. 지우기 전에 무엇을 바꿀지 보여 주고 확인을 받아요.
        </p>
        <CommandButton prompt="/reset profile" label="AI로 꼼꼼하게 초기화" task="프로필 초기화 (지침 파일 포함)" />
      </details>
    </Card>
  );
}

export function Settings() {
  const status = useFetch<Status>("/api/status");
  const s = status.data;

  return (
    <div className="stack">
      <PageHeader title="설정" description="AI 연결과 PDF 도구 상태를 확인하고, 작업 방식과 내 데이터를 관리해요." />
      <ErrorBox error={status.error} />
      {s && (
        <>
          <div className="stats">
            <div className={`stat ${s.auth ? "" : "warn"}`}>
              <span>AI 인증</span>
              <b>{s.auth ? `설정됨 (${AUTH_LABEL[s.auth]})` : "인증 정보 없음"}</b>
            </div>
            <div className="stat" title={s.baseUrl ?? "https://api.anthropic.com"}>
              <span>AI 서버</span>
              <b className="ellipsis">{s.baseUrl ?? "Anthropic 기본"}</b>
              {s.model && <span>모델: {s.model}</span>}
            </div>
            <div className={`stat ${s.typst || s.lualatex ? "" : "warn"}`}>
              <span>PDF 만들기</span>
              <b>{s.typst ? "Typst 사용 가능" : s.lualatex ? "LaTeX 사용 가능" : "프로그램 없음"}</b>
            </div>
            <div className="stat">
              <span>서류 디자인</span>
              <b>{s.activeTemplate ?? "기본 (LaTeX)"}</b>
            </div>
            <div className={`stat ${s.trusted ? "" : "warn"}`}>
              <span>작업 폴더</span>
              <b>{s.trusted ? "신뢰함" : "신뢰 전"}</b>
            </div>
            <div className={`stat ${s.permissionMode === "bypassPermissions" ? "warn" : ""}`}>
              <span>AI 권한</span>
              <b>{MODE_TEXT[s.permissionMode]?.label ?? s.permissionMode}</b>
            </div>
            <div className={`stat ${s.fileAccess === "secure" ? "" : "warn"}`}>
              <span>파일 열기</span>
              <b>{s.fileAccess === "secure" ? "사용 가능" : s.fileAccess === "insecure" ? "사용 가능 (안전 검사 약함)" : "막힘"}</b>
            </div>
          </div>

          <ClaudeConnectionCard status={s} onDone={status.reload} />

          {!s.auth && s.connection === "env" && (
            <Card title="AI에 연결하지 못했어요">
              <p>
                저장소 폴더의 <code>.env</code> 파일에 <code>CLAUDE_CODE_OAUTH_TOKEN</code>(Pro/Max 구독), <code>ANTHROPIC_API_KEY</code>(API 키),{" "}
                <code>ANTHROPIC_AUTH_TOKEN</code>(사용자 엔드포인트용) 중 하나를 넣고 다시 시작하세요. 자세한 방법은 <code>web/README.md</code>에 있어요.
              </p>
            </Card>
          )}

          {s.fileAccess === "blocked" && (
            <Card title="이 환경에서는 파일을 열 수 없어요">
              <p>
                macOS 등에서는 저장소 파일을 안전하게 열 방법이 없어서 파일 읽기·업로드를 막아 두었어요. 그래서 내 지원·프로필·서류함이 비어 보여요. Docker로
                실행하세요(<code>docker compose up -d</code>). 저장소에 쓸 수 있는 프로그램을 모두 신뢰한다면 <code>AJS_INSECURE_PATH_CHECKS=1</code>로
                실행할 수도 있어요.
              </p>
            </Card>
          )}
          {s.fileAccess === "insecure" && (
            <div className="error-box">
              <code>AJS_INSECURE_PATH_CHECKS=1</code>로 실행 중이에요. 파일 경로 검사를 다른 로컬 프로그램이 우회할 수 있어요. 평소에는 Docker로 실행하세요.
            </div>
          )}

          {!s.trusted && <TrustCard status={s} onDone={status.reload} />}

          <PermissionModeCard status={s} onDone={status.reload} />

          <ResetCard />

          <p className="muted small">저장소 위치: <code>{s.repo}</code></p>
        </>
      )}
    </div>
  );
}

import { useState, type ReactNode } from "react";
import { runCommand } from "./api.ts";
import { renderMarkdown } from "./markdown.ts";

export function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <h2>{title}</h2>
          <div className="row">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error-box">{error}</div> : null;
}

export function CommandButton({ prompt, label, kind = "secondary", disabled }: { prompt: string; label?: string; kind?: "primary" | "secondary"; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        className={`btn ${kind}`}
        disabled={busy || disabled}
        title={prompt}
        onClick={() => {
          setBusy(true);
          runCommand(prompt)
            .catch((e: Error) => setErr(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {label ?? prompt}
      </button>
      {err && <span className="error-inline">{err}</span>}
    </>
  );
}

const STATUS_LABEL: Record<string, string> = {
  drafted: "작성됨",
  applied: "지원함",
  interview: "면접",
  offer: "오퍼",
  hired: "합격",
  rejected: "불합격",
  no_response: "무응답",
  "no response": "무응답",
  offer_declined: "오퍼 거절",
  "offer declined": "오퍼 거절",
  withdrawn: "지원 철회",
  new: "신규",
  ranked: "평가됨",
  expired: "마감",
  unreachable: "접근 불가",
  skipped: "제외",
};

export function StatusChip({ status }: { status: string | undefined }) {
  const s = (status ?? "").trim();
  return <span className={`chip st-${s.replaceAll(" ", "_") || "none"}`}>{STATUS_LABEL[s] ?? (s || "-")}</span>;
}

export function daysUntil(date: string | undefined | null): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const d = new Date(`${date.slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export function Deadline({ date }: { date: string | undefined | null }) {
  const n = daysUntil(date);
  if (!date) return <span className="muted">-</span>;
  if (n === null) return <span>{date}</span>;
  const cls = n < 0 ? "dl-past" : n <= 7 ? "dl-soon" : "";
  return (
    <span className={cls}>
      {date.slice(0, 10)} {n < 0 ? "(마감)" : n === 0 ? "(오늘)" : `(D-${n})`}
    </span>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ms: number) {
  return new Date(ms).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

import { useState, type ReactNode } from "react";
import { runCommand } from "./api.ts";
import { STATUS_LABEL, commandLabel } from "./labels.ts";
import { renderMarkdown } from "./markdown.ts";

const ICON_PATHS = {
  clip: "M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
  download: "M12 3v12m0 0-5-5m5 5 5-5M4 19h16",
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6",
  open: "M14 4h6v6m0-6L10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12M18 6 6 18",
  arrow: "M5 12h14m-6-6 6 6-6 6",
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

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

export function CommandButton({
  prompt,
  label,
  task,
  hint,
  kind = "secondary",
  disabled,
}: {
  prompt: string;
  label: string;
  task?: string;
  hint?: string;
  kind?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        className={`btn ${kind}`}
        disabled={busy || disabled}
        title={hint}
        onClick={() => {
          setBusy(true);
          setErr(null);
          runCommand(prompt, { title: task ?? commandLabel(prompt) ?? label })
            .catch((e: Error) => setErr(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {label}
      </button>
      {err && <span className="error-inline">{err}</span>}
    </>
  );
}

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

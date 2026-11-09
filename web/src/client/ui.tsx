import { useEffect, useRef, useState, type ReactNode } from "react";
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
  home: "M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6",
  briefcase: "M3 8h18v12H3zM8 8V5h8v3M3 13h18",
  clipboard: "M9 3h6v4H9zM7 5H5v16h14V5h-2M9 12h6M9 16h4",
  folder: "M3 6h6l2 2h10v11H3z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  chat: "M4 5h16v11H9l-5 4z",
  sparkle: "M12 3l2 5.5L19.5 11 14 13.5 12 19l-2-5.5L4.5 11 10 8.5z",
  sliders: "M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1M15 4v4M9 10v4M17 16v4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  upload: "M12 16V4m0 0-5 5m5-5 5 5M4 20h16",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  pin: "M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
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

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

// A native modal dialog: the browser keeps focus inside, makes the page behind
// inert and returns focus on close. Escape and a backdrop click both close it.
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = box.current;
    if (!dialog) return;
    const before = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>(".modal-body :is(input, select, textarea, button)")?.focus();
    return () => {
      if (dialog.open) dialog.close();
      before?.focus();
    };
  }, []);
  return (
    <dialog
      ref={box}
      className="modal"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => e.target === e.currentTarget && close.current()}
    >
      <div className="modal-inner">
        <header className="card-head">
          <h2>{title}</h2>
          <button className="btn ghost small-btn" onClick={() => close.current()} aria-label="닫기">
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </dialog>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <b>{title}</b>
      {children && <p className="muted">{children}</p>}
      {action && <div className="row wrap empty-actions">{action}</div>}
    </div>
  );
}

export function CommandButton({
  prompt,
  label,
  task,
  hint,
  icon,
  kind = "secondary",
  disabled,
}: {
  prompt: string;
  label: string;
  task?: string;
  hint?: string;
  icon?: IconName;
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
        {busy ? <span className="spinner" /> : icon && <Icon name={icon} size={15} />}
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

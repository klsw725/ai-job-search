import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_DIR } from "./config.ts";
import { readTracker } from "./data.ts";
import type { ApplyParams, ApplyResult } from "./results.ts";
import { archiveName, type SelfIntroAnswer, type SelfIntroParams, type SelfIntroResult } from "./selfIntro.ts";
import { resolveReadable } from "./security.ts";

export type AppIdentity = { date: string; company: string; role: string };

export type RunState = "running" | "succeeded" | "blocked" | "failed" | "cancelled";

export type RunFile = { key: string; label: string; path: string; exists: boolean; fresh: boolean };

// What the server confirmed on disk, independent of what the agent claimed.
export type RunChecks = {
  row: { date: string; company: string; role: string; status: string; fit_rating: string } | null;
  files: RunFile[];
};

type RunBase = {
  id: string;
  title: string;
  subject: { jobKey?: string; url?: string };
  // Uploaded posting files sent with the first message, so a fresh restart can send them again.
  attachments?: string[];
  // The tracker row this run produced or updated, recorded once it is found
  // and moved along when the web changes that row's date.
  application?: AppIdentity;
  sessionId: string | null;
  sdkSessionId: string | null;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  costUsd?: number;
  checks?: RunChecks;
  error?: string;
  // Times the server sent answers back because their counts were out of range.
  fixRounds?: number;
};

// What happened to the 자기소개서 questions given with 지원서 만들기.
export type FollowUp = { state: "started" | "skipped" | "failed"; runId?: string; reason?: string };
// What the server saved: the archive file, or why it left an existing one alone.
export type SelfIntroArtifact = { path: string; written: boolean; reason?: "owned_by_other"; sha256?: string; coverRecorded?: boolean };

export type ApplyRun = RunBase & { kind: "apply"; params: ApplyParams; result?: ApplyResult; followUp?: FollowUp };
export type SelfIntroRun = RunBase & {
  kind: "self-intro";
  params: SelfIntroParams;
  result?: SelfIntroResult;
  // The counted answers of the last pass while the server sends some back.
  draft?: SelfIntroAnswer[];
  fixIndices?: number[];
  artifact?: SelfIntroArtifact;
};
export type RunRecord = ApplyRun | SelfIntroRun;
export const RUN_KINDS: RunRecord["kind"][] = ["apply", "self-intro"];

const RUN_ID = /^[\w-]{1,64}$/;
// A PDF written just before the run started (clock skew, a fast first step)
// still counts as this run's output.
const FRESH_SLACK_MS = 5_000;

export const INTERRUPTED = "서버가 다시 시작되면서 작업이 멈췄어요. 이미 만든 파일은 남아 있어요.";

const FILE_LABEL: Record<string, string> = {
  cv_pdf: "이력서 PDF",
  cover_pdf: "커버레터 PDF",
  cv_source: "이력서 원본",
  cover_source: "커버레터 원본",
  posting: "공고 원문",
  form_fields: "지원서 입력 칸 초안",
  self_intro: "자기소개서 답변",
};

const pdfOf = (source: string) => source.replace(/\.(typ|tex)$/i, ".pdf");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function fileCheck(key: string, rel: string, since: number, repo: string): Promise<RunFile> {
  const label = FILE_LABEL[key]!;
  const abs = await resolveReadable(rel, repo).catch(() => null);
  if (!abs) return { key, label, path: rel, exists: false, fresh: false };
  try {
    const s = await stat(abs);
    // A compiled document must really be a PDF, not a source file the agent labelled as one.
    const pdf = !key.endsWith("_pdf") || (/\.pdf$/i.test(abs) && (await Bun.file(abs).slice(0, 5).text()) === "%PDF-");
    return { key, label, path: rel, exists: s.isFile() && pdf, fresh: s.mtimeMs >= since - FRESH_SLACK_MS };
  } catch {
    return { key, label, path: rel, exists: false, fresh: false };
  }
}

const FINAL = new Set(["hired", "rejected", "no_response", "no response", "offer_declined", "offer declined", "withdrawn"]);
const isOpen = (row: Record<string, string>) => !FINAL.has((row.status ?? "").trim().toLowerCase());
const one = <T>(list: T[]) => (list.length === 1 ? list[0]! : null);

// The row a finished /apply left: /apply updates the open row for the role or,
// when every earlier one is closed, appends a new one, so the run's row is the
// single open match. Rows with the posting URL as source come first; the
// result's company and role are the fallback (/apply may record the employer's
// own posting URL instead). Two open matches are ambiguous and bind nothing.
export function matchRow<T extends Record<string, string>>(run: ApplyRun, rows: T[]): T | null {
  const url = /^https?:\/\//.test(run.params.posting) ? run.params.posting.trim() : null;
  const r = run.result;
  const byUrl = url ? rows.filter((row) => isOpen(row) && (row.source ?? "").trim() === url) : [];
  if (byUrl.length) return one(byUrl);
  return r ? one(rows.filter((row) => isOpen(row) && same(row.company ?? "", r.company) && same(row.role ?? "", r.role))) : null;
}

// A bound run keeps its row even after it closes and a newer application to
// the same role appears. If the date changed outside the web (an /outcome in
// a terminal moving it off drafted), the single later row for the role is it.
export function boundRow<T extends Record<string, string>>(app: AppIdentity, rows: T[]): T | null {
  const role = rows.filter((row) => same(row.company ?? "", app.company) && same(row.role ?? "", app.role));
  // Several exact matches are ambiguous; only a missing row may fall back to a later one.
  const exact = role.filter((row) => (row.date ?? "").trim() === app.date);
  if (exact.length > 0) return one(exact);
  return one(role.filter((row) => (row.date ?? "").trim() > app.date));
}

export function runRow<T extends Record<string, string>>(run: RunRecord, rows: T[]): T | null {
  if (run.application) return boundRow(run.application, rows);
  return run.kind === "apply" ? matchRow(run, rows) : null;
}

// Re-reads the tracker and the files a run produced. The tracker row is the
// one runRow binds to the run; the files are the result's, else the row's.
// What a finished /apply must have left behind before the UI calls it done:
// its tracker row and a CV PDF written during this run. A cover letter is not
// required, since some postings take a self-introduction text instead.
export function missingEvidence(checks: RunChecks, run?: RunRecord): string | null {
  if (!checks.row) return "지원 기록에서 이 지원을 찾지 못했어요";
  if (run?.kind === "self-intro") {
    if ((run.result?.answers.length ?? 0) !== run.params.questions.length) return "답변하지 않은 문항이 있어요";
    if (!run.artifact) return "답변을 저장하지 못했어요";
    return null;
  }
  const cv = checks.files.find((f) => f.key === "cv_pdf");
  if (!cv?.exists) return "이력서 PDF를 찾지 못했어요";
  if (!cv.fresh) return "이력서 PDF가 이번 작업에서 새로 만들어지지 않았어요";
  return null;
}

export async function reconcile(run: RunRecord, repo = REPO_DIR, trackerRows?: Record<string, string>[]): Promise<RunChecks> {
  const rows = trackerRows ?? (await readTracker(repo)).rows;
  const match = runRow(run, rows);
  const claimed: Record<string, string> =
    run.kind === "apply" ? { ...(run.result?.files ?? {}) } : run.artifact?.written ? { self_intro: run.artifact.path } : {};
  if (run.kind === "apply" && match?.cv_file) {
    claimed.cv_source ??= match.cv_file;
    claimed.cv_pdf ??= pdfOf(match.cv_file);
  }
  if (run.kind === "apply" && match?.cover_letter_file) {
    claimed.cover_source ??= match.cover_letter_file;
    claimed.cover_pdf ??= pdfOf(match.cover_letter_file);
  }
  const files = await Promise.all(
    Object.entries(claimed)
      .filter(([k]) => k in FILE_LABEL)
      .map(([k, rel]) => fileCheck(k, rel, run.startedAt, repo)),
  );
  const row = match
    ? { date: match.date ?? "", company: match.company ?? "", role: match.role ?? "", status: match.status ?? "", fit_rating: match.fit_rating ?? "" }
    : null;
  return { row, files };
}

// The derived archive folder, or an existing one whose outcome.md names this
// exact application (tools/tracker_state.py find_archive). Symlinks are not followed.
export async function archiveFolder(company: string, role: string, repo = REPO_DIR): Promise<string | null> {
  const name = archiveName(company, role);
  if (!name) return null;
  const apps = join(repo, "documents", "applications");
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(apps, { withFileTypes: true });
  } catch {
    return `documents/applications/${name}`;
  }
  if (!entries.some((e) => e.isDirectory() && e.name === name)) {
    const title = `# Outcome: ${company} — ${role}`.toLowerCase();
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const first = (await readFile(join(apps, e.name, "outcome.md"), "utf8").catch(() => "")).split("\n")[0]?.trim().toLowerCase();
      if (first === title) return `documents/applications/${e.name}`;
    }
  }
  return `documents/applications/${name}`;
}

// The application a run is about: its binding, else what it was started for.
export function runApplication(run: RunRecord): AppIdentity | undefined {
  return run.application ?? (run.kind === "self-intro" ? run.params.application : undefined);
}

export const appKey = (app: { company: string; role: string }) => `${app.company.trim().toLowerCase()}\u0000${app.role.trim().toLowerCase()}`;

// Work for one key runs strictly one after another; later calls wait their turn.
export function serialized() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, act: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(act);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => tails.get(key) === tail && tails.delete(key));
    return next;
  };
}

// Runs act for one key at a time; a call while one is in flight gets busy().
export function oneAtATime<T>(busy: () => T) {
  const inFlight = new Set<string>();
  return async (key: string, act: () => Promise<T>): Promise<T> => {
    if (inFlight.has(key)) return busy();
    inFlight.add(key);
    try {
      return await act();
    } finally {
      inFlight.delete(key);
    }
  };
}

export class RunStore {
  private runs = new Map<string, RunRecord>();
  private writes = new Map<string, Promise<void>>();

  constructor(private dir = join(REPO_DIR, ".ajs", "runs")) {}

  // Records left `running` belong to a server that is gone: their session and
  // its agent process died with it.
  // The web moved a bound row to a new date (a draft was submitted).
  async rebind(from: AppIdentity, to: AppIdentity) {
    for (const rec of this.runs.values()) {
      const app = rec.application;
      if (app && app.date === from.date && same(app.company, from.company) && same(app.role, from.role)) {
        rec.application = { ...to };
        await this.save(rec);
      }
    }
  }

  async load(reconcileRun: (r: RunRecord) => Promise<RunChecks> = (r) => reconcile(r)) {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const rec = JSON.parse(await readFile(join(this.dir, name), "utf8")) as RunRecord;
        if (!rec || typeof rec.id !== "string" || !RUN_ID.test(rec.id) || !RUN_KINDS.includes(rec.kind)) continue;
        if (rec.state === "running") {
          rec.state = "failed";
          rec.error = INTERRUPTED;
          rec.endedAt = Date.now();
          rec.sessionId = null;
          rec.checks = await reconcileRun(rec).catch(() => rec.checks);
          await this.save(rec);
        }
        this.runs.set(rec.id, rec);
      } catch {
        // An unreadable record is skipped, never fatal to the server.
      }
    }
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string) {
    return RUN_ID.test(id) ? this.runs.get(id) : undefined;
  }

  bySession(sessionId: string) {
    return [...this.runs.values()].find((r) => r.sessionId === sessionId && r.state === "running");
  }

  // Writes for one record are serialized and each is an atomic replace.
  save(rec: RunRecord): Promise<void> {
    this.runs.set(rec.id, rec);
    const prev = this.writes.get(rec.id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const file = join(this.dir, `${rec.id}.json`);
        const tmp = `${file}.${crypto.randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
        await rename(tmp, file);
      });
    this.writes.set(rec.id, next);
    return next;
  }
}

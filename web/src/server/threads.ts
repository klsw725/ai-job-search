import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_DIR } from "./config.ts";
import { boundRow, type AppIdentity } from "./runs.ts";

export const STEP_KINDS = ["coding_test", "assignment", "interview", "document", "other"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

// A step as the AI proposes or the user adds it; the server gives it an id,
// a status and the application it belongs to when it is saved.
export type StepDraft = { kind: StepKind; title: string; due?: string; link?: string; note?: string };

export type Proposal = {
  id: string;
  createdAt: number;
  memo?: string;
  steps: StepDraft[];
  state: "pending" | "saved" | "dismissed";
  // What the user kept when saving: the memo or not, and which steps by index.
  saved?: { memo: boolean; steps: number[] };
};

// A conversation opened from one application's page. It is bound to the
// exact tracker row it was opened for; the web moves that binding when it
// changes the row's date (RunStore.rebind does the same for runs).
export type ThreadRecord = {
  id: string;
  kind: "app-chat";
  title: string;
  application: AppIdentity;
  sdkSessionId: string | null;
  sessionId: string | null;
  createdAt: number;
  lastActivity: number;
  proposals: Proposal[];
  // Removed from the application's list. The record stays so its transcript,
  // reopened from 지난 대화, still resumes without write tools.
  hidden?: boolean;
};

const ID = /^[\w-]{1,64}$/;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const sameApplication = (a: AppIdentity, b: AppIdentity) => a.date === b.date && same(a.company, b.company) && same(a.role, b.role);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function parseStepDraft(v: unknown): StepDraft | string {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const kind = (STEP_KINDS as readonly string[]).includes(s.kind as string) ? (s.kind as StepKind) : "other";
  const title = str(s.title, 200);
  if (!title) return "단계 이름을 넣어 주세요";
  const due = str(s.due, 10);
  if (due && !DATE.test(due)) return "날짜는 YYYY-MM-DD 형식으로 넣어 주세요";
  const link = str(s.link, 2000);
  if (link && !/^https?:\/\/\S+$/.test(link)) return "링크는 http(s) 주소만 넣을 수 있어요";
  const note = str(s.note, 1000);
  return { kind, title, ...(due ? { due } : {}), ...(link ? { link } : {}), ...(note ? { note } : {}) };
}

// What the AI's propose_items call may carry. Invalid steps are dropped, not
// fatal: the user sees what remains and decides.
export function parseProposal(v: unknown): { memo?: string; steps: StepDraft[] } | null {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const memo = str(p.memo, 4000);
  const steps = (Array.isArray(p.steps) ? p.steps.slice(0, 10) : []).map(parseStepDraft).filter((s): s is StepDraft => typeof s !== "string");
  return memo || steps.length ? { ...(memo ? { memo } : {}), steps } : null;
}

export class ThreadStore {
  private threads = new Map<string, ThreadRecord>();
  private writes = new Map<string, Promise<void>>();

  constructor(private dir = join(REPO_DIR, ".ajs", "threads")) {}

  async load() {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const rec = JSON.parse(await readFile(join(this.dir, name), "utf8")) as ThreadRecord;
        if (!rec || typeof rec.id !== "string" || !ID.test(rec.id) || rec.kind !== "app-chat" || !rec.application) continue;
        // The session it had died with the previous server; the transcript remains.
        rec.sessionId = null;
        rec.proposals = Array.isArray(rec.proposals) ? rec.proposals : [];
        this.threads.set(rec.id, rec);
      } catch {
        // An unreadable record is skipped, never fatal to the server.
      }
    }
  }

  list(): ThreadRecord[] {
    return [...this.threads.values()].filter((t) => !t.hidden).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  // Listed threads only; bySdk also finds hidden ones.
  get(id: string) {
    const t = ID.test(id) ? this.threads.get(id) : undefined;
    return t?.hidden ? undefined : t;
  }

  async hide(id: string) {
    const t = this.get(id);
    if (!t) return;
    t.hidden = true;
    t.proposals = t.proposals.map((p) => (p.state === "pending" ? { ...p, state: "dismissed" as const } : p));
    await this.save(t);
  }

  bySession(sessionId: string) {
    return [...this.threads.values()].find((t) => t.sessionId === sessionId);
  }

  bySdk(sdkId: string) {
    return [...this.threads.values()].find((t) => t.sdkSessionId === sdkId);
  }

  // Threads for an application: bound to it, or (display only, as runs.ts
  // boundRow decides for runs) bound to a row whose date changed outside the web.
  forApplication(app: AppIdentity, rows: Record<string, string>[]) {
    return this.list().filter((t) => {
      if (sameApplication(t.application, app)) return true;
      const row = boundRow(t.application, rows);
      return !!row && sameApplication({ date: (row.date ?? "").trim(), company: row.company ?? "", role: row.role ?? "" }, app);
    });
  }

  async bind(id: string, to: AppIdentity) {
    const t = this.get(id);
    if (!t) return;
    t.application = { ...to };
    await this.save(t);
  }

  async rebind(from: AppIdentity, to: AppIdentity) {
    for (const t of this.threads.values()) {
      if (sameApplication(t.application, from)) {
        t.application = { ...to };
        await this.save(t);
      }
    }
  }

  // A data reset deleted this transcript; its thread goes with it.
  async forgetTranscript(sdkId: string) {
    for (const t of [...this.threads.values()]) if (t.sdkSessionId === sdkId) await this.remove(t.id);
  }

  async remove(id: string) {
    const t = ID.test(id) ? this.threads.get(id) : undefined;
    if (!t) return;
    this.threads.delete(id);
    await (this.writes.get(id) ?? Promise.resolve()).catch(() => undefined);
    this.writes.delete(id);
    await rm(join(this.dir, `${id}.json`), { force: true });
  }

  // Writes for one record are serialized and each is an atomic replace.
  save(rec: ThreadRecord): Promise<void> {
    this.threads.set(rec.id, rec);
    const prev = this.writes.get(rec.id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        if (this.threads.get(rec.id) !== rec) return;
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

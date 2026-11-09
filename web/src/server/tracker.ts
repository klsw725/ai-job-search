import { join } from "node:path";
import { REPO_DIR } from "./config.ts";
import type { Counts } from "./selfIntro.ts";

// The web changes tracker rows only through tools/tracker_state.py, the same
// validated writer /outcome's rules are pinned to, never with its own edits.
const TOOL = join(REPO_DIR, "tools", "tracker_state.py");
const TIMEOUT_MS = 30_000;
const EXIT_CONFLICT = 3;

export const TRACKER_STATUSES = ["drafted", "applied", "interview", "offer", "hired", "rejected", "no_response", "offer_declined", "withdrawn"] as const;

export type Transition = { company: string; role: string; date: string; expect: string; status: string; note?: string };

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v : null);

export function parseTransition(body: unknown): Transition | string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const company = text(b.company, 200);
  const role = text(b.role, 300);
  const date = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  const expect = text(b.expect, 40);
  const status = typeof b.status === "string" && (TRACKER_STATUSES as readonly string[]).includes(b.status) ? b.status : null;
  if (!company || !role || !date || !expect) return "어떤 지원 기록인지 알 수 없어요";
  if (!status) return "알 수 없는 상태예요";
  const note = typeof b.note === "string" ? b.note.slice(0, 300) : undefined;
  return { company, role, date, expect, status, note };
}

export async function transitionRow(t: Transition, opts: { repo?: string; tool?: string; today?: string; python?: string } = {}) {
  const repo = opts.repo ?? REPO_DIR;
  const args = [opts.tool ?? TOOL, "transition", "--company", t.company, "--role", t.role, "--date", t.date, "--expect", t.expect, "--status", t.status, "--root", repo];
  if (t.note) args.push("--note", t.note);
  if (opts.today) args.push("--today", opts.today);
  const proc = Bun.spawn([opts.python ?? "python3", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(out) as Record<string, unknown>;
  } catch {
    return { status: 500, body: { error: `지원 기록을 바꾸지 못했어요: ${err.trim() || `종료 코드 ${code}`}` } };
  }
  if (code === 0) return { status: 200, body: result };
  if (code === EXIT_CONFLICT) {
    return { status: 409, body: { error: "그사이 다른 곳에서 이 지원의 상태가 바뀌었어요. 화면을 새로고침한 뒤 다시 옮겨 주세요.", current: result.current } };
  }
  return { status: 400, body: { error: `지원 기록을 바꾸지 못했어요: ${String(result.error ?? (err.trim() || code))}` } };
}

const COUNT_TOOL = join(REPO_DIR, "tools", "self_intro_count.py");

async function runTool(args: string[], input: string, opts: { repo?: string; python?: string }) {
  const repo = opts.repo ?? REPO_DIR;
  const proc = Bun.spawn([opts.python ?? "python3", ...args], { cwd: repo, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let body: Record<string, unknown> | unknown[];
  try {
    body = JSON.parse(out) as Record<string, unknown> | unknown[];
  } catch {
    throw new Error(err.trim() || `종료 코드 ${code}`);
  }
  return { code, body };
}

// Exact counts, as 10-korea-market.md section 4 defines them (Python's strip,
// whitespace and EUC-KR encoder), so the web never approximates them.
export async function countTexts(texts: string[], opts: { repo?: string; tool?: string; python?: string } = {}): Promise<Counts[]> {
  const { code, body } = await runTool([opts.tool ?? COUNT_TOOL], JSON.stringify(texts), opts);
  if (code !== 0 || !Array.isArray(body) || body.length !== texts.length) throw new Error("글자 수를 세지 못했어요");
  return body as Counts[];
}

export type SavedSelfIntro = { ok: true; written: boolean; path: string; sha256: string; reason?: "owned_by_other"; cover_recorded?: boolean } | { ok: false; error: string; current?: string };

// Saves the answers through tools/tracker_state.py, which writes only while the
// row is a draft and never replaces another application's answers.
export async function saveSelfIntro(
  app: { date: string; company: string; role: string },
  content: string,
  owners: string[],
  recordCover: boolean,
  opts: { repo?: string; tool?: string; python?: string } = {},
): Promise<SavedSelfIntro> {
  const repo = opts.repo ?? REPO_DIR;
  const args = [opts.tool ?? TOOL, "write-self-intro", "--company", app.company, "--role", app.role, "--date", app.date, "--root", repo];
  for (const o of owners) args.push("--owner", o);
  if (recordCover) args.push("--record-cover");
  const { code, body } = await runTool(args, content, opts);
  if (Array.isArray(body)) throw new Error("답변을 저장하지 못했어요");
  if (code === EXIT_CONFLICT) return { ok: false, error: "not_drafted", current: String(body.current ?? "") };
  if (code !== 0) return { ok: false, error: String(body.error ?? `종료 코드 ${code}`) };
  return body as SavedSelfIntro;
}

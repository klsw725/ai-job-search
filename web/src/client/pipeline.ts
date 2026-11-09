// Board columns over the tracker status vocabulary (outcome.md). Legacy space
// spellings read as their underscore forms.

export type ColumnId = "drafted" | "applied" | "interview" | "offer" | "closed";

export const FINAL_STATUSES = ["hired", "rejected", "no_response", "offer_declined", "withdrawn"] as const;

export const COLUMNS: { id: ColumnId; label: string; hint: string }[] = [
  { id: "drafted", label: "작성됨", hint: "서류는 만들었지만 아직 내지 않았어요" },
  { id: "applied", label: "지원함", hint: "답을 기다리는 중이에요" },
  { id: "interview", label: "면접", hint: "면접이 잡혔거나 진행 중이에요" },
  { id: "offer", label: "오퍼", hint: "제안을 받았어요" },
  { id: "closed", label: "종료", hint: "합격, 불합격, 무응답 등으로 끝난 지원" },
];

export const FINAL_LABEL: Record<(typeof FINAL_STATUSES)[number], string> = {
  hired: "합격",
  rejected: "불합격",
  no_response: "무응답",
  offer_declined: "오퍼 거절",
  withdrawn: "지원 철회",
};

export function canonicalStatus(status: string | undefined): string {
  const s = (status ?? "").trim().toLowerCase();
  return s === "no response" ? "no_response" : s === "offer declined" ? "offer_declined" : s;
}

export function columnOf(status: string | undefined): ColumnId {
  const s = canonicalStatus(status);
  if ((FINAL_STATUSES as readonly string[]).includes(s)) return "closed";
  if (s === "applied" || s === "interview" || s === "offer") return s;
  return "drafted";
}

export type MovePlan =
  | { kind: "direct"; status: string }
  | { kind: "confirm-submit"; status: string }
  | { kind: "choose-final" };

// What dropping a card on a column means. Leaving `drafted` records today as
// the submission date, so the user confirms it; the closed column needs a
// final status picked; anything else moves at once.
export function planMove(from: string | undefined, to: ColumnId): MovePlan | null {
  const current = canonicalStatus(from);
  if (columnOf(current) === to) return null;
  if (to === "closed") return { kind: "choose-final" };
  if (current === "drafted") return { kind: "confirm-submit", status: to };
  return { kind: "direct", status: to };
}

export function rowKey(row: Record<string, string>): string {
  return [row.date ?? "", row.company ?? "", row.role ?? ""].join("\u0000");
}

export function applicationId(row: Record<string, string>): string {
  return encodeURIComponent(JSON.stringify([row.date ?? "", row.company ?? "", row.role ?? ""]));
}

export function parseApplicationId(id: string): { date: string; company: string; role: string } | null {
  try {
    const v = JSON.parse(decodeURIComponent(id)) as unknown;
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "string" && x)) return null;
    const [date, company, role] = v as string[];
    return { date: date!, company: company!, role: role! };
  } catch {
    return null;
  }
}

type Row = Record<string, string>;
type Identity = { date: string; company: string; role: string };
type BoundRun = { kind?: string; state: string; application?: Identity; checks?: { row: Identity | null } };

const same = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

// The newest run bound to exactly this row. The server binds each run to one
// row (runs.ts runRow), so an earlier application to the same role never
// shows a later run's result.
export function runForRow<R extends BoundRun>(runs: R[], row: Row, kind = "apply"): R | undefined {
  return runs.find((r) => {
    // A running run has no checks yet; its binding is what it was started for.
    // A finished one is where reconcile finds it now, which follows a row whose
    // date changed outside the web and rejects an ambiguous one.
    const bound = r.state === "running" ? (r.application ?? r.checks?.row) : r.checks?.row;
    return (r.kind ?? "apply") === kind && r.state !== "cancelled" && !!bound && bound.date === row.date && same(bound.company, row.company) && same(bound.role, row.role);
  });
}

// After a submit changes a row's date, an old link still names the old date.
// It is followed only when exactly one row has that company and role; with
// several applications to the role, guessing could open the wrong one.
export function movedRow(rows: Row[], key: { company: string; role: string }): Row | undefined {
  const matches = rows.filter((r) => r.company === key.company && r.role === key.role);
  return matches.length === 1 ? matches[0] : undefined;
}


// The same veto /rank applies (tools/rank_state.py): a FAIL on any gate keeps
// a job off the shortlist no matter its score, though it stays "ranked".
export const GATES = [
  ["location_verdict", "위치", null],
  ["language_gate", "언어", "language_note"],
  ["eligibility_gate", "자격 요건", "eligibility_note"],
] as const;

export function isVetoed(job: Record<string, unknown>): boolean {
  return GATES.some(([field]) => job[field] === "FAIL");
}

export type JobTab = "recommended" | "unranked" | "excluded" | "closed";

// The tab a job is listed under on the jobs page. "recommended" is the same
// set recommended() draws from, before its limit.
export function jobTab(job: Record<string, unknown>): JobTab {
  const status = String(job.status ?? "");
  if (status === "expired" || status === "unreachable") return "closed";
  if (status === "skipped" || isVetoed(job)) return "excluded";
  if (status === "ranked" && typeof job.rank_score === "number") return "recommended";
  return "unranked";
}

// Same floors as BANDS in tools/rank_state.py.
const BANDS = [
  [75, "strong", "아주 잘 맞아요"],
  [60, "good", "잘 맞아요"],
  [45, "moderate", "보통이에요"],
  [30, "weak", "조금 맞아요"],
  [0, "poor", "잘 맞지 않아요"],
] as const;

export function fitBand(score: number): { tone: string; label: string } {
  const [, tone, label] = BANDS.find(([floor]) => score >= floor) ?? BANDS[BANDS.length - 1]!;
  return { tone, label };
}

export function recommended(jobs: Record<string, unknown>[], limit = 5) {
  return jobs
    .filter((j) => j.status === "ranked" && typeof j.rank_score === "number" && !isVetoed(j))
    .sort((a, b) => (b.rank_score as number) - (a.rank_score as number))
    .slice(0, limit);
}

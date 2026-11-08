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

export function recommended(jobs: Record<string, unknown>[], limit = 5) {
  return jobs
    .filter((j) => j.status === "ranked" && typeof j.rank_score === "number" && !isVetoed(j))
    .sort((a, b) => (b.rank_score as number) - (a.rank_score as number))
    .slice(0, limit);
}

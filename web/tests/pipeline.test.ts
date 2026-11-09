import { describe, expect, test } from "bun:test";
import { applicationId, columnOf, movedRow, parseApplicationId, planMove, runForRow } from "../src/client/pipeline.ts";

describe("tracker board", () => {
  test("statuses land in their column, legacy spellings included", () => {
    expect(columnOf("drafted")).toBe("drafted");
    expect(columnOf("Applied ")).toBe("applied");
    expect(columnOf("interview")).toBe("interview");
    expect(columnOf("offer")).toBe("offer");
    for (const s of ["hired", "rejected", "no_response", "no response", "offer declined", "withdrawn"]) expect(columnOf(s)).toBe("closed");
    expect(columnOf("")).toBe("drafted");
  });

  test("a drop decides between moving at once, confirming the submission date and picking a result", () => {
    expect(planMove("applied", "applied")).toBeNull();
    expect(planMove("rejected", "closed")).toBeNull();
    expect(planMove("applied", "interview")).toEqual({ kind: "direct", status: "interview" });
    expect(planMove("drafted", "applied")).toEqual({ kind: "confirm-submit", status: "applied" });
    expect(planMove("drafted", "interview")).toEqual({ kind: "confirm-submit", status: "interview" });
    expect(planMove("interview", "closed")).toEqual({ kind: "choose-final" });
    expect(planMove("drafted", "closed")).toEqual({ kind: "choose-final" });
    expect(planMove("no response", "applied")).toEqual({ kind: "direct", status: "applied" });
  });

  test("each application shows only the run bound to it", () => {
    const jan = { date: "2026-01-10", company: "Acme", role: "Engineer" };
    const nov = { date: "2026-11-12", company: "Acme", role: "Engineer" };
    const runs = [
      { id: "new", state: "succeeded", checks: { row: nov } },
      { id: "old", state: "succeeded", checks: { row: jan } },
      { id: "gone", state: "cancelled", checks: { row: jan } },
    ];
    expect(runForRow(runs, jan)?.id).toBe("old");
    expect(runForRow(runs, nov)?.id).toBe("new");
    expect(runForRow([{ id: "x", state: "failed", checks: { row: null } }], nov)).toBeUndefined();
  });

  test("a running run, which has no checks yet, is found by the application it was started for", () => {
    const row = { date: "2026-11-09", company: "Acme", role: "Engineer" };
    const runs = [{ kind: "self-intro", state: "running", application: row }, { kind: "apply", state: "running", application: row }];
    expect(runForRow(runs, row, "self-intro")).toBe(runs[0]);
    expect(runForRow(runs, row)).toBe(runs[1]);
    expect(runForRow(runs, { ...row, date: "2026-01-01" }, "self-intro")).toBeUndefined();
  });

  test("a finished run is shown where reconcile finds it now, even when its stored binding is older", () => {
    const moved = { date: "2026-11-09", company: "Acme", role: "Engineer" };
    const run = { kind: "self-intro", state: "succeeded", application: { ...moved, date: "2026-11-01" }, checks: { row: moved } };
    expect(runForRow([run], moved, "self-intro")).toBe(run);
    expect(runForRow([run], { ...moved, date: "2026-11-01" }, "self-intro")).toBeUndefined();
    expect(runForRow([{ ...run, checks: { row: null } }], moved, "self-intro")).toBeUndefined();
  });

  test("an old link follows a moved row only when the role has one application", () => {
    const key = { company: "Acme", role: "Engineer" };
    expect(movedRow([{ date: "2026-11-12", ...key }], key)?.date).toBe("2026-11-12");
    expect(movedRow([{ date: "2026-01-10", ...key }, { date: "2026-11-12", ...key }], key)).toBeUndefined();
  });

  test("an application id round-trips company and role with separators in them", () => {
    const row = { date: "2026-11-09", company: "Acme | Labs", role: "Engineer, AI/ML (Platform)" };
    expect(parseApplicationId(applicationId(row))).toEqual(row);
    const plain = { date: "2026-11-09", company: "Toss", role: "AI 엔지니어 (Ads)" };
    expect(parseApplicationId(applicationId(plain))).toEqual(plain);
    expect(parseApplicationId("%E0%A4%A")).toBeNull();
    expect(parseApplicationId(encodeURIComponent('["2026-11-09","Acme"]'))).toBeNull();
    expect(parseApplicationId(encodeURIComponent('{"date":1}'))).toBeNull();
  });
});

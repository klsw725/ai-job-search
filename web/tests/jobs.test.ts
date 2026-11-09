import { describe, expect, test } from "bun:test";
import { fitBand, jobTab, recommended } from "../src/client/jobs.ts";
import { portalName } from "../src/client/labels.ts";

describe("jobs page", () => {
  test("jobs sort into tabs", () => {
    expect(jobTab({ status: "ranked", rank_score: 80, location_verdict: "PASS" })).toBe("recommended");
    expect(jobTab({ status: "ranked", rank_score: 80, language_gate: "FLAG" })).toBe("recommended");
    expect(jobTab({ status: "ranked", rank_score: 80, location_verdict: "FAIL" })).toBe("excluded");
    expect(jobTab({ status: "skipped" })).toBe("excluded");
    expect(jobTab({ status: "new" })).toBe("unranked");
    expect(jobTab({ status: "ranked" })).toBe("unranked");
    expect(jobTab({ status: "expired", rank_score: 90 })).toBe("closed");
    expect(jobTab({ status: "unreachable" })).toBe("closed");
  });

  test("the recommended tab holds what the home page recommends", () => {
    const jobs = [
      { key: "a", status: "ranked", rank_score: 50 },
      { key: "b", status: "ranked", rank_score: 90, eligibility_gate: "FAIL" },
      { key: "c", status: "skipped", rank_score: 95 },
      { key: "d", status: "ranked", rank_score: 70, location_verdict: "FLAG" },
      { key: "e", status: "expired", rank_score: 99 },
      { key: "f", status: "ranked" },
    ];
    const keys = (list: { key: string }[]) => list.map((j) => j.key).sort();
    expect(keys(recommended(jobs, 10) as { key: string }[])).toEqual(keys(jobs.filter((j) => jobTab(j) === "recommended")));
    expect(keys(jobs.filter((j) => jobTab(j) === "recommended"))).toEqual(["a", "d"]);
  });

  test("score bands follow rank_state.py", () => {
    expect(fitBand(75).tone).toBe("strong");
    expect(fitBand(74).tone).toBe("good");
    expect(fitBand(60).tone).toBe("good");
    expect(fitBand(45).tone).toBe("moderate");
    expect(fitBand(30).tone).toBe("weak");
    expect(fitBand(0).tone).toBe("poor");
  });

  test("portal ids read as site names", () => {
    expect(portalName("linkedin-search")).toBe("LinkedIn");
    expect(portalName("wanted")).toBe("원티드");
    expect(portalName("remember")).toBe("리멤버");
    expect(portalName("some-new-portal")).toBe("some-new-portal");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTransition, transitionRow } from "../src/server/tracker.ts";

const TOOL = join(import.meta.dir, "../../tools/tracker_state.py");
const HEADER = "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ajs-tracker-"));
  await writeFile(join(repo, "job_search_tracker.csv"), `${HEADER}\n2026-11-01,Acme,,Engineer,,portal,drafted,,77,,,,,\n`);
});

afterEach(() => rm(repo, { recursive: true, force: true }));

describe("tracker transitions from the web", () => {
  test("requests are validated before anything runs", () => {
    expect(parseTransition({ company: "Acme", role: "Engineer", date: "2026-11-01", expect: "drafted", status: "applied" })).toEqual({
      company: "Acme",
      role: "Engineer",
      date: "2026-11-01",
      expect: "drafted",
      status: "applied",
      note: undefined,
    });
    expect(parseTransition({ company: "Acme", role: "Engineer", date: "11/01", expect: "drafted", status: "applied" })).toBeString();
    expect(parseTransition({ company: "Acme", role: "Engineer", date: "2026-11-01", expect: "drafted", status: "ghosted" })).toBe("알 수 없는 상태예요");
    expect(parseTransition(null)).toBeString();
  });

  test("a move goes through the shared tool and returns the new row", async () => {
    const t = parseTransition({ company: "Acme", role: "Engineer", date: "2026-11-01", expect: "drafted", status: "applied" });
    if (typeof t === "string") throw new Error(t);
    const res = await transitionRow(t, { repo, tool: TOOL, today: "2026-11-10" });
    expect(res.status).toBe(200);
    expect((res.body as { row: Record<string, string> }).row).toMatchObject({ status: "applied", date: "2026-11-10" });
    expect(await readFile(join(repo, "job_search_tracker.csv"), "utf8")).toContain("2026-11-10,Acme,,Engineer,,portal,applied");
  });

  test("a stale move is refused with 409 and the file is untouched", async () => {
    const before = await readFile(join(repo, "job_search_tracker.csv"), "utf8");
    const res = await transitionRow({ company: "Acme", role: "Engineer", date: "2026-11-01", expect: "applied", status: "rejected" }, { repo, tool: TOOL });
    expect(res.status).toBe(409);
    expect((res.body as { current: string }).current).toBe("drafted");
    expect(await readFile(join(repo, "job_search_tracker.csv"), "utf8")).toBe(before);
  });

  test("an unknown row is a 400 with the reason", async () => {
    const res = await transitionRow({ company: "Nobody", role: "Engineer", date: "2026-11-01", expect: "drafted", status: "applied" }, { repo, tool: TOOL });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("no tracker row");
  });
});

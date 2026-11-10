import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore, parseProposal, parseStepDraft, type ThreadRecord } from "../src/server/threads.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ajs-threads-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const APP = { date: "2026-11-01", company: "Acme", role: "Engineer" };
const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: "th_1",
  kind: "app-chat",
  title: "공고 대화",
  application: APP,
  sdkSessionId: "sdk-1",
  sessionId: "live-1",
  createdAt: 1,
  lastActivity: 1,
  proposals: [],
  ...over,
});
const row = (date: string, company = "Acme") => ({ date, company, role: "Engineer" });

describe("steps and proposals", () => {
  test("a step needs a name; dates, links and kinds are checked", () => {
    expect(parseStepDraft({ kind: "coding_test", title: " 코테 ", due: "2026-11-15", link: "https://p.io/x", note: " " })).toEqual({ kind: "coding_test", title: "코테", due: "2026-11-15", link: "https://p.io/x" });
    expect(parseStepDraft({ kind: "party", title: "x" })).toEqual({ kind: "other", title: "x" });
    expect(parseStepDraft({ title: "" })).toBeString();
    expect(parseStepDraft({ title: "x", due: "11/15" })).toBeString();
    expect(parseStepDraft({ title: "x", link: "javascript:alert(1)" })).toBeString();
  });

  test("a proposal keeps its memo and valid steps, and is nothing without either", () => {
    expect(parseProposal({ memo: " 메모 ", steps: [{ kind: "interview", title: "면접" }, { title: "" }] })).toEqual({ memo: "메모", steps: [{ kind: "interview", title: "면접" }] });
    expect(parseProposal({ steps: [{ title: " " }] })).toBeNull();
    expect(parseProposal(null)).toBeNull();
  });
});

describe("ThreadStore", () => {
  test("records survive a restart without their dead session, and bad files are skipped", async () => {
    const a = new ThreadStore(dir);
    await a.save(thread());
    await writeFile(join(dir, "junk.json"), "{");
    await writeFile(join(dir, "other.json"), JSON.stringify({ id: "x", kind: "apply" }));
    const b = new ThreadStore(dir);
    await b.load();
    expect(b.list().map((t) => [t.id, t.sessionId, t.sdkSessionId])).toEqual([["th_1", null, "sdk-1"]]);
    expect(b.bySdk("sdk-1")?.id).toBe("th_1");
  });

  test("a web move rebinds; an external move shows the thread on the single later row only", async () => {
    const s = new ThreadStore(dir);
    await s.save(thread());
    expect(s.forApplication(row("2026-11-05"), [row("2026-11-05")]).map((t) => t.id)).toEqual(["th_1"]);
    expect(s.forApplication(row("2026-11-05"), [row("2026-11-05"), row("2026-11-07")])).toEqual([]);
    expect(s.forApplication(row("2026-11-05"), [row("2026-11-01"), row("2026-11-05")])).toEqual([]);
    expect(s.get("th_1")!.application.date).toBe("2026-11-01");
    await s.rebind(APP, row("2026-11-09"));
    expect(s.get("th_1")!.application.date).toBe("2026-11-09");
    expect(s.forApplication(row("2026-11-09"), []).map((t) => t.id)).toEqual(["th_1"]);
  });

  test("a deleted transcript takes its thread record along", async () => {
    const s = new ThreadStore(dir);
    await s.save(thread());
    await s.save(thread({ id: "th_2", sdkSessionId: "sdk-2" }));
    await s.forgetTranscript("sdk-1");
    expect(s.list().map((t) => t.id)).toEqual(["th_2"]);
    expect(await readdir(dir)).toEqual(["th_2.json"]);
  });
});

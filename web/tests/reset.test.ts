import { describe, expect, test } from "bun:test";
import { createReset, type ResetDeps } from "../src/server/reset.ts";
import { PartialDeleteError } from "../src/server/security.ts";

type Info = { sessionId: string; lastModified: number };

function fixture(over: Partial<{ busy: number; profile: string[]; history: Info[]; live: string[]; ours: string[]; stillRunning: number }> = {}) {
  const log: string[] = [];
  const state = { frozen: false, profile: [...(over.profile ?? ["candidate.md"])], deleted: [] as string[] };
  const deps: ResetDeps = {
    listProfile: async () => [...state.profile],
    clearProfile: async () => {
      log.push("clearProfile");
      const gone = state.profile;
      state.profile = [];
      return gone;
    },
    sessions: {
      freeze: () => ((state.frozen = true), log.push("freeze")),
      thaw: () => ((state.frozen = false), log.push("thaw")),
      busy: () => over.busy ?? 0,
      history: async () => over.history ?? [],
      hasLiveProcess: (id: string) => (over.live ?? []).includes(id),
      stoppedByUs: (id: string) => (over.ours ?? []).includes(id),
      stopAll: async () => (log.push("stopAll"), { stillRunning: over.stillRunning ?? 0 }),
      deleteTranscript: async (id: string) => {
        if (id === "boom") throw new Error("subdir");
        state.deleted.push(id);
      },
    },
  };
  return { deps, log, state };
}

const body = (targets: string[], expected: { profile?: string[]; chats?: string[] }, externalStopped = false) => ({ targets, confirm: "초기화", expected, externalStopped });
const h = (...ids: string[]) => ids.map((sessionId) => ({ sessionId, lastModified: 0 }));

describe("reset endpoint logic", () => {
  test("nothing happens without the typed word or without the inventory the user saw", async () => {
    const { deps, log } = fixture();
    const r = createReset(deps);
    expect((await r.run({ targets: ["profile"], confirm: "reset", expected: { profile: ["candidate.md"] } })).status).toBe(400);
    expect((await r.run({ targets: ["profile"], confirm: "초기화" })).status).toBe(400);
    expect((await r.run({ targets: ["../etc"], confirm: "초기화", expected: {} })).status).toBe(400);
    expect(log).toEqual([]);
  });

  test("profile-only reset is refused while an AI task runs or is being created", async () => {
    const { deps, log } = fixture({ busy: 1 });
    const out = await createReset(deps).run(body(["profile"], { profile: ["candidate.md"] }));
    expect(out.body).toMatchObject({ profile: { deleted: [], error: expect.any(String) } });
    expect(log).not.toContain("clearProfile");
  });

  test("profile-only reset is refused while a process that outlived its session may still write", async () => {
    // busy() counts such orphans (see agent.test.ts); here only its effect.
    const { deps, log } = fixture({ busy: 1 });
    await createReset(deps).run(body(["profile"], { profile: ["candidate.md"] }));
    expect(log).toEqual(["freeze", "thaw"]);
  });

  test("the profile is not touched when stopping the AI work did not finish", async () => {
    const { deps, log } = fixture({ stillRunning: 1 });
    const out = await createReset(deps).run(body(["profile", "chats"], { profile: ["candidate.md"], chats: [] }));
    expect(log).toEqual(["freeze", "stopAll", "thaw"]);
    expect(out.body).toMatchObject({ profile: { deleted: [], error: expect.any(String) }, chats: { stillRunning: 1 } });
  });

  test("a profile that changed since the preview is left alone", async () => {
    const { deps, log } = fixture({ profile: ["candidate.md", "new.md"] });
    const out = await createReset(deps).run(body(["profile"], { profile: ["candidate.md"] }));
    expect(out.body).toMatchObject({ profile: { changed: true, deleted: [] } });
    expect(log).not.toContain("clearProfile");
  });

  test("writers are stopped before the profile is cleared, and the freeze is always released", async () => {
    const { deps, log, state } = fixture();
    const out = await createReset(deps).run(body(["profile", "chats"], { profile: ["candidate.md"], chats: [] }));
    expect(log).toEqual(["freeze", "stopAll", "clearProfile", "thaw"]);
    expect(out.body).toMatchObject({ profile: { deleted: ["candidate.md"], remaining: [] } });
    expect(state.frozen).toBe(false);
  });

  test("a deletion that stopped deep inside an entry is reported as partial", async () => {
    const { deps } = fixture({ profile: ["a", "b"] });
    deps.clearProfile = async () => {
      throw new PartialDeleteError("EACCES", [], true);
    };
    const out = await createReset(deps).run(body(["profile"], { profile: ["a", "b"] }));
    expect(out.body).toMatchObject({ profile: { deleted: [], partial: true, error: "EACCES", remaining: ["a", "b"] } });
  });

  test("without the user's word about other programs only transcripts we saw stop are deleted", async () => {
    const { deps, state } = fixture({ history: h("ours", "terminal", "live-ours", "new", "boom"), ours: ["ours", "boom"], live: ["live-ours"] });
    const out = await createReset(deps).run(body(["chats"], { chats: ["ours", "terminal", "live-ours", "boom"] }));
    expect(state.deleted).toEqual(["ours"]);
    expect(out.body).toMatchObject({ chats: { deleted: 1, failed: 1, kept: 2, unconfirmed: 1 } });
  });

  test("with it, other transcripts go too, but never one whose process is still running", async () => {
    const { deps, state } = fixture({ history: h("ours", "terminal", "live-ours"), ours: ["ours"], live: ["live-ours"] });
    const out = await createReset(deps).run(body(["chats"], { chats: ["ours", "terminal", "live-ours"] }, true));
    expect(state.deleted).toEqual(["ours", "terminal"]);
    expect(out.body).toMatchObject({ chats: { deleted: 2, kept: 1 } });
  });

  test("the preview separates our transcripts and reports a failed listing as an error", async () => {
    const ok = await createReset(fixture({ history: h("live", "ours", "terminal"), live: ["live"], ours: ["ours"] }).deps).preview();
    expect(ok.chats).toEqual({ ids: ["live", "ours", "terminal"], ours: 2 });
    const { deps } = fixture();
    deps.sessions.history = async () => {
      throw new Error("disk");
    };
    expect((await createReset(deps).preview()).chats).toEqual({ error: "disk" });
  });

  test("a second reset while one runs is refused", async () => {
    const { deps } = fixture();
    let release!: () => void;
    deps.sessions.stopAll = () => new Promise((r) => (release = () => r({ stillRunning: 0 })));
    const r = createReset(deps);
    const first = r.run(body(["chats"], { chats: [] }));
    await new Promise((x) => setTimeout(x, 5));
    expect((await r.run(body(["chats"], { chats: [] }))).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});

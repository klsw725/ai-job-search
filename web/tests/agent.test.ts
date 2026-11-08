import { describe, expect, mock, test } from "bun:test";

type Fake = {
  options: Record<string, any>;
  emit: (m: unknown) => void;
  end: () => void;
  inputs: unknown[];
};
const fakes: Fake[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) => {
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const fake: Fake = {
      options,
      inputs: [],
      emit: (m) => {
        queue.push(m);
        wake?.();
      },
      end: () => {
        done = true;
        wake?.();
      },
    };
    fakes.push(fake);
    void (async () => {
      for await (const m of prompt) fake.inputs.push(m);
    })();
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) yield queue.shift();
          else if (done) return;
          else await new Promise<void>((r) => (wake = r));
        }
      },
      interrupt: async () => undefined,
      close: () => fake.end(),
    };
  },
  listSessions: async () => [{ sessionId: "sdk-1", summary: "old", lastModified: 1 }],
  getSessionMessages: async () => [],
}));

const { ChatSession, SessionManager } = await import("../src/server/agent.ts");

const tick = () => new Promise((r) => setTimeout(r, 5));
const result = (queued?: number, uuids?: string[]) => ({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0, duration_ms: 1, queued_turn_count: queued, user_message_uuids: uuids, user_message_uuid: uuids?.at(-1) });

describe("ChatSession", () => {
  test("a send queued behind a running turn keeps the session running", async () => {
    const s = new ChatSession(() => {}, () => {});
    const fake = fakes.at(-1)!;
    s.send("first");
    s.send("second");
    await tick();
    const [u1, u2] = fake.inputs.map((m: any) => m.uuid);
    fake.emit(result(1, [u1]));
    await tick();
    expect(s.state).toBe("running");
    fake.emit(result(0, [u2]));
    await tick();
    expect(s.state).toBe("idle");
    s.close();
  });

  test("a result produced before a later send does not mark that send done", async () => {
    const s = new ChatSession(() => {}, () => {});
    const fake = fakes.at(-1)!;
    s.send("first");
    await tick();
    const u1 = (fake.inputs[0] as any).uuid;
    s.send("second");
    fake.emit(result(0, [u1]));
    await tick();
    expect(s.state).toBe("running");
    s.close();
  });

  test("a result naming no send leaves outstanding sends running", async () => {
    const s = new ChatSession(() => {}, () => {});
    const fake = fakes.at(-1)!;
    s.send("first");
    await tick();
    fake.emit(result(1));
    await tick();
    expect(s.state).toBe("running");
    fake.emit(result(0, [(fake.inputs[0] as any).uuid]));
    await tick();
    expect(s.state).toBe("idle");
    s.close();
  });

  test("a coalesced batch longer than the SDK's 64-uuid list still goes idle", async () => {
    const s = new ChatSession(() => {}, () => {});
    const fake = fakes.at(-1)!;
    for (let i = 0; i < 65; i++) s.send(`m${i}`);
    await tick();
    const uuids = fake.inputs.map((m: any) => m.uuid);
    fake.emit(result(0, uuids.slice(-64)));
    await tick();
    expect(s.state).toBe("idle");
    s.close();
  });

  test("suppressAlwaysAllowRule hides and refuses 'always allow'", async () => {
    const events: any[] = [];
    const s = new ChatSession((_, ev) => events.push(ev), () => {});
    const canUseTool = fakes.at(-1)!.options.canUseTool;
    const suggestion = { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "localSettings" };
    const pending = canUseTool("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal, suggestions: [suggestion], suppressAlwaysAllowRule: true });
    const card = events.find((e) => e.kind === "permission");
    expect(card.canAlways).toBe(false);
    expect(card.input).toContain("rm -rf build");
    s.answerPermission(card.requestId, true, true);
    const decision = await pending;
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedPermissions).toBeUndefined();
    s.close();
  });

  test("'always allow' is downgraded to this session only", async () => {
    const events: any[] = [];
    const s = new ChatSession((_, ev) => events.push(ev), () => {});
    const canUseTool = fakes.at(-1)!.options.canUseTool;
    const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "localSettings" };
    const pending = canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, suggestions: [suggestion] });
    const card = events.find((e) => e.kind === "permission");
    expect(card.canAlways).toBe(true);
    s.answerPermission(card.requestId, true, true);
    expect((await pending).updatedPermissions).toEqual([{ ...suggestion, destination: "session" }]);
    s.close();
  });

  test("an already-aborted request is denied without a card", async () => {
    const events: any[] = [];
    const s = new ChatSession((_, ev) => events.push(ev), () => {});
    const ac = new AbortController();
    ac.abort();
    const decision = await fakes.at(-1)!.options.canUseTool("Write", {}, { signal: ac.signal });
    expect(decision.behavior).toBe("deny");
    expect(events.some((e) => e.kind === "permission")).toBe(false);
    expect(s.summary().pending).toBe(0);
    s.close();
  });

  test("trusted rules are passed to the SDK as allowed/disallowed tools", async () => {
    const s = new ChatSession(() => {}, () => {}, { rules: { allow: ["Bash(ls:*)"], deny: ["Read(.env)"] } });
    expect(fakes.at(-1)!.options.allowedTools).toEqual(["Bash(ls:*)"]);
    expect(fakes.at(-1)!.options.disallowedTools).toEqual(["Read(.env)"]);
    s.close();
  });
});

describe("API retries", () => {
  test("retry notices are shown live and cleared when the turn ends", async () => {
    const events: any[] = [];
    const s = new ChatSession((_, ev) => events.push(ev), () => {});
    const fake = fakes.at(-1)!;
    s.send("hi");
    fake.emit({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 401, error: "authentication_failed" });
    await tick();
    expect(s.summary().retry).toEqual({ attempt: 2, maxRetries: 10, status: 401, error: "authentication_failed", delayMs: 4000 });
    expect(s.events.some((e: any) => e.kind === "retry")).toBe(false);
    fake.emit(result(0, [(fake.inputs[0] as any).uuid]));
    await tick();
    expect(s.summary().retry).toBeNull();
    expect(events.filter((e) => e.kind === "retry").map((e) => e.retry)).toEqual([expect.any(Object), null]);
    s.close();
  });
});

describe("SessionManager", () => {
  test("concurrent resumes of one transcript share a single session", async () => {
    const m = new SessionManager(() => {}, async () => null);
    const [a, b] = await Promise.all([m.resume("sdk-1"), m.resume("sdk-1")]);
    expect(a).toBe(b);
    expect(m.active()).toHaveLength(1);
    m.closeAll();
  });

  test("a closed session leaves the active list and reappears under past", async () => {
    const m = new SessionManager(() => {}, async () => null);
    const s = await m.resume("sdk-1");
    expect(await m.past()).toEqual([]);
    m.remove(s.id);
    await tick();
    expect(m.active()).toEqual([]);
    expect((await m.past()).map((p) => p.sdkSessionId)).toEqual(["sdk-1"]);
    m.closeAll();
  });
});

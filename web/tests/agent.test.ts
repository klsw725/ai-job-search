import { describe, expect, mock, test } from "bun:test";

type Fake = {
  options: Record<string, any>;
  emit: (m: unknown) => void;
  end: () => void;
  inputs: unknown[];
  modes: string[];
};
const fakes: Fake[] = [];
const deleted: string[] = [];
const listCalls: unknown[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) => {
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const fake: Fake = {
      options,
      inputs: [],
      modes: [],
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
      setPermissionMode: async (mode: string) => {
        fake.modes.push(mode);
      },
      close: () => fake.end(),
    };
  },
  listSessions: async (opts: unknown) => {
    listCalls.push(opts);
    return [{ sessionId: "sdk-1", summary: "old", lastModified: 1 }];
  },
  deleteSession: async (id: string) => {
    deleted.push(id);
  },
  getSessionMessages: async () => [],
}));

const { ChatSession, SessionManager, messageToEvents } = await import("../src/server/agent.ts");

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

describe("permission modes", () => {
  test("a session starts in the mode it was given and can switch while it runs", async () => {
    const s = new ChatSession(() => {}, () => {}, { mode: "acceptEdits" });
    const fake = fakes.at(-1)!;
    expect(fake.options.permissionMode).toBe("acceptEdits");
    expect(s.summary().mode).toBe("acceptEdits");
    await s.setMode("auto");
    expect(fake.modes).toEqual(["auto"]);
    expect(s.summary().mode).toBe("auto");
    s.close();
  });

  test("skipping every check is refused outside a container unless opted in", async () => {
    const prev = process.env.AJS_ALLOW_BYPASS;
    delete process.env.AJS_ALLOW_BYPASS;
    try {
      const { bypassAllowed } = await import("../src/server/modes.ts");
      if (bypassAllowed()) return; // running inside Docker
      const s = new ChatSession(() => {}, () => {}, { mode: "bypassPermissions" });
      const fake = fakes.at(-1)!;
      expect(fake.options.permissionMode).toBe("default");
      expect(fake.options.allowDangerouslySkipPermissions).toBe(false);
      await expect(s.setMode("bypassPermissions")).rejects.toThrow("Docker");
      expect(fake.modes).toEqual([]);
      s.close();

      process.env.AJS_ALLOW_BYPASS = "1";
      const t = new ChatSession(() => {}, () => {}, { mode: "bypassPermissions" });
      expect(fakes.at(-1)!.options.permissionMode).toBe("bypassPermissions");
      expect(fakes.at(-1)!.options.allowDangerouslySkipPermissions).toBe(true);
      t.close();
    } finally {
      if (prev === undefined) delete process.env.AJS_ALLOW_BYPASS;
      else process.env.AJS_ALLOW_BYPASS = prev;
    }
  });

  test("the mode the SDK reports wins over the one that was asked for", async () => {
    const events: any[] = [];
    const s = new ChatSession((_, ev) => events.push(ev), () => {}, { mode: "auto" });
    const fake = fakes.at(-1)!;
    fake.emit({ type: "system", subtype: "init", session_id: "x", permissionMode: "default" });
    await tick();
    expect(s.mode).toBe("default");
    fake.emit({ type: "system", subtype: "status", status: null, permissionMode: "acceptEdits" });
    await tick();
    expect(s.summary().mode).toBe("acceptEdits");
    expect(events.filter((e) => e.kind === "mode").map((e) => e.mode)).toEqual(["default", "acceptEdits"]);
    s.close();
  });

  test("new sessions take the saved default mode", async () => {
    const m = new SessionManager(() => {}, async () => null, () => {}, async () => "auto");
    const s = await m.create();
    expect(fakes.at(-1)!.options.permissionMode).toBe("auto");
    expect(s.mode).toBe("auto");
    m.closeAll();
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

describe("task metadata", () => {
  test("a session keeps the title and kind it was started with, and a first send does not rename it", async () => {
    const s = new ChatSession(() => {}, () => {}, { title: "지원서 만들기 · 토스 / 백엔드", kind: "apply" });
    s.send("/apply https://example.com/job");
    expect(s.summary()).toMatchObject({ title: "지원서 만들기 · 토스 / 백엔드", kind: "apply" });
    s.close();
  });

  test("an untitled session is named after its first message and is a plain chat", async () => {
    const s = new ChatSession(() => {}, () => {});
    s.send("안녕");
    expect(s.summary()).toMatchObject({ title: "안녕", kind: "chat" });
    s.close();
  });
});

describe("transcript", () => {
  test("progress tool inputs are kept whole so the checklist still parses, other inputs are clipped", () => {
    const todos = Array.from({ length: 40 }, (_, i) => ({ content: `단계 ${i}`.padEnd(60, "·"), status: "pending", activeForm: "진행 중" }));
    const long = "x".repeat(5000);
    const [ev] = messageToEvents("assistant", { content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos } }, { type: "tool_use", id: "b", name: "Bash", input: { command: long } }] }, false) as any[];
    expect(JSON.parse(ev.tools[0].input).todos).toHaveLength(40);
    expect(ev.tools[1].input.length).toBeLessThan(2100);
  });

  test("a clipped write keeps the target path, and a task's long description is dropped", () => {
    const [ev] = messageToEvents("assistant", { content: [
      { type: "tool_use", id: "w", name: "Write", input: { file_path: "/repo/cv/a.typ", content: "y".repeat(5000) } },
      { type: "tool_use", id: "c", name: "TaskCreate", input: { subject: "적합도 평가", description: "z".repeat(30000) } },
    ] }, false) as any[];
    expect(ev.tools[0].path).toBe("/repo/cv/a.typ");
    expect(() => JSON.parse(ev.tools[0].input)).toThrow();
    expect(JSON.parse(ev.tools[1].input)).toEqual({ subject: "적합도 평가" });
  });
});

describe("chat history reset", () => {
  const spawnVia = (cmd: string) =>
    fakes.at(-1)!.options.spawnClaudeCodeProcess({ command: "sh", args: ["-c", cmd], env: process.env, signal: new AbortController().signal });
  const exited = (child: any) => new Promise((r) => (child.exitCode !== null || child.signalCode ? r(null) : child.once("exit", r)));

  test("history covers this checkout only, never sibling worktrees", async () => {
    const m = new SessionManager(() => {}, async () => null);
    listCalls.length = 0;
    await m.history();
    await m.past();
    expect(listCalls).toEqual([expect.objectContaining({ includeWorktrees: false }), expect.objectContaining({ includeWorktrees: false })]);
    m.closeAll();
  });

  test("a freeze blocks new sessions, resumes and input, including a create already waiting on the rules", async () => {
    let releaseRules!: () => void;
    const m = new SessionManager(() => {}, () => new Promise((r) => (releaseRules = () => r(null))));
    const pending = m.create();
    await tick();
    expect(m.busy()).toBe(1);
    m.freeze();
    releaseRules();
    await expect(pending).rejects.toThrow();
    await expect(m.resume("sdk-1")).rejects.toThrow();
    m.thaw();
    const ok = new SessionManager(() => {}, async () => null);
    const s = await ok.create();
    ok.freeze();
    expect(() => s.send("hi")).toThrow();
    ok.thaw();
    ok.closeAll();
    m.closeAll();
  });

  test("a transcript counts as stopped by us only after its process is seen to exit, and only if nothing wrote it later", async () => {
    const m = new SessionManager(() => {}, async () => null);
    await m.create();
    fakes.at(-1)!.emit({ type: "system", subtype: "init", session_id: "sdk-p" });
    await tick();
    const before = Date.now();
    const child = spawnVia("sleep 0.2");
    expect(m.hasLiveProcess("sdk-p")).toBe(true);
    expect(m.stoppedByUs("sdk-p", before)).toBe(false);
    await exited(child);
    expect(m.hasLiveProcess("sdk-p")).toBe(false);
    expect(m.stoppedByUs("sdk-p", before)).toBe(true);
    // A terminal resuming the transcript after our exit writes it later.
    expect(m.stoppedByUs("sdk-p", Date.now() + 5000)).toBe(false);
    expect(m.stoppedByUs("sdk-never-ours", before)).toBe(false);
    m.closeAll();
  });

  test("stopAll waits for observed process exits and reports a process that outlives the timeout", async () => {
    const m = new SessionManager(() => {}, async () => null);
    await m.create();
    const quick = spawnVia("sleep 0.2");
    const started = Date.now();
    expect(await m.stopAll(5000)).toEqual({ stillRunning: 0 });
    expect(quick.exitCode !== null || quick.signalCode !== null).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);

    const m2 = new SessionManager(() => {}, async () => null);
    await m2.create();
    const stubborn = spawnVia("sleep 5");
    expect(await m2.stopAll(200)).toEqual({ stillRunning: 1 });
    stubborn.kill("SIGKILL");
    await exited(stubborn);
    expect(m2.hasLiveProcess("anything")).toBe(false);
  });

  test("a process that outlives its session still counts as busy", async () => {
    const m = new SessionManager(() => {}, async () => null);
    await m.create();
    const fake = fakes.at(-1)!;
    const child = spawnVia("sleep 0.4");
    fake.end();
    await tick();
    expect(m.active()).toHaveLength(0);
    expect(m.busy()).toBe(1);
    await exited(child);
    expect(m.busy()).toBe(0);
  });

  test("a spawn that never started a process does not make a resumed transcript ours", async () => {
    const m = new SessionManager(() => {}, async () => null);
    const s = await m.create({ resume: "sdk-terminal" });
    expect(s.sdkSessionId).toBe("sdk-terminal");
    let child: any = null;
    try {
      child = fakes.at(-1)!.options.spawnClaudeCodeProcess({ command: "/nonexistent/claude-xyz", args: [], env: process.env, signal: new AbortController().signal });
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      // Some runtimes throw synchronously instead of emitting 'error'.
    }
    expect(child === null || child.pid === undefined).toBe(true);
    expect(m.hasLiveProcess("sdk-terminal")).toBe(false);
    expect(m.busy()).toBe(0);
    expect(m.stoppedByUs("sdk-terminal", 0)).toBe(false);
    m.closeAll();
  });
});

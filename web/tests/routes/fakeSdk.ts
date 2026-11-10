// The Agent SDK as the route harnesses see it: every query is recorded with
// its options and inputs, and the test emits the messages the SDK would.
import { mock } from "bun:test";

export type FakeTool = { name: string; description: string; inputSchema: unknown; handler: (args: any, extra?: unknown) => Promise<any> };
export type Fake = { options: Record<string, any>; inputs: any[]; emit: (m: unknown) => void; end: () => void };
export const fakes: Fake[] = [];
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
      setPermissionMode: async () => undefined,
      close: () => fake.end(),
    };
  },
  createSdkMcpServer: (o: { name: string; tools: FakeTool[] }) => ({ type: "sdk", name: o.name, instance: o }),
  tool: (name: string, description: string, inputSchema: unknown, handler: FakeTool["handler"]): FakeTool => ({ name, description, inputSchema, handler }),
  listSessions: async () => [],
  getSessionMessages: async () => [],
  deleteSession: async () => undefined,
}));


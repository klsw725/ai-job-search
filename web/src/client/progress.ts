import type { ChatEvent } from "../server/agent.ts";
import { describePath, describeTool, pathOutsideRepo } from "./labels.ts";

type ToolResult = Extract<ChatEvent, { kind: "tool_result" }>;

export type Step = { text: string; status: "pending" | "in_progress" | "completed" };

const STEP_STATUS = new Set(["pending", "in_progress", "completed"]);

function parse(input: string): Record<string, unknown> | null {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The agent is asked (WEB_APPEND) to keep a todo list; its latest state is the
// task's progress checklist. Both the TodoWrite tool and the newer
// TaskCreate/TaskUpdate pair are understood. Sub-agent lists are ignored.
export function progressOf(events: ChatEvent[]): Step[] {
  let steps: (Step & { id: string })[] = [];
  const results = new Map<string, ToolResult>();
  for (const e of events) if (e.kind === "tool_result") results.set(e.toolUseId, e);
  for (const e of events) {
    if (e.kind !== "assistant" || e.sub) continue;
    for (const t of e.tools) {
      const input = parse(t.input);
      if (!input || results.get(t.id)?.isError) continue;
      if (t.name === "TodoWrite" && Array.isArray(input.todos)) {
        steps = (input.todos as Record<string, unknown>[]).map((todo, i) => {
          const status = STEP_STATUS.has(String(todo.status)) ? (String(todo.status) as Step["status"]) : "pending";
          const text = String(status === "in_progress" && todo.activeForm ? todo.activeForm : (todo.content ?? ""));
          return { id: String(i), text, status };
        });
      } else if (t.name === "TaskCreate" && typeof input.subject === "string") {
        // Only a confirmed creation carries the id later updates refer to. A
        // failed one adds nothing; one in flight or in an unknown result format
        // keeps a private id that no update can hit by accident.
        const r = results.get(t.id);
        const id = (r && /\bTask #(\d+) created\b/i.exec(r.text)?.[1]) ?? `local:${t.id}`;
        steps.push({ id, text: input.subject, status: "pending" });
      } else if (t.name === "TaskUpdate" && input.taskId !== undefined) {
        const id = String(input.taskId);
        if (input.status === "deleted") steps = steps.filter((st) => st.id !== id);
        else {
          steps = steps.map((st) =>
            st.id !== id
              ? st
              : {
                  ...st,
                  text: typeof input.subject === "string" ? input.subject : st.text,
                  status: STEP_STATUS.has(String(input.status)) ? (String(input.status) as Step["status"]) : st.status,
                },
          );
        }
      }
    }
  }
  return steps.map(({ text, status }) => ({ text, status }));
}

export function currentActivity(events: ChatEvent[], results: Map<string, ToolResult>): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "assistant") continue;
    for (let j = e.tools.length - 1; j >= 0; j--) {
      const t = e.tools[j]!;
      if (!results.has(t.id) && !["TodoWrite", "TaskCreate", "TaskUpdate", "AskUserQuestion"].includes(t.name)) {
        return describeTool(t.name, t.input);
      }
    }
  }
  return null;
}

const OUTPUT_DIRS = /^(cv|cover_letters|reports|upskill|company_research)\//;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
// File times and the session clock come from the same server; the slack only
// absorbs filesystem timestamp rounding.
const MTIME_SLACK_MS = 2000;

// A file counts as this task's output only if a write or edit to it (or to the
// .typ/.tex source it compiles from) succeeded here inside the repo, it changed
// after the task began, and a compiled PDF is not older than its source (a
// later edit whose build failed leaves a stale PDF behind).
export function sessionOutputs(
  events: ChatEvent[],
  files: { path: string; mtime: number }[],
  since: number,
  repoRoot: string,
): [path: string, label: string][] {
  const root = repoRoot.replace(/\/+$/, "");
  const mtime = new Map(files.map((f) => [f.path, f.mtime]));
  const time = (p: string) => mtime.get(p) ?? -Infinity;
  const results = new Map<string, ToolResult>();
  for (const e of events) if (e.kind === "tool_result") results.set(e.toolUseId, e);
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== "assistant") continue;
    for (const t of e.tools) {
      const r = results.get(t.id);
      if (!WRITE_TOOLS.has(t.name) || !r || r.isError || !t.path || pathOutsideRepo(t.path, root)) continue;
      const rel = t.path.startsWith("/") ? t.path.slice(root.length + 1) : t.path;
      if (!OUTPUT_DIRS.test(rel)) continue;
      const pdf = rel.replace(/\.(typ|tex)$/i, ".pdf");
      const shown = pdf === rel ? rel : pdf;
      if (time(shown) < since - MTIME_SLACK_MS) continue;
      if (shown !== rel && time(shown) < time(rel) - MTIME_SLACK_MS) continue;
      out.set(shown, describePath(shown));
    }
  }
  return [...out.entries()];
}

export function lastReply(events: ChatEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "user") return "";
    if (e.kind === "assistant" && !e.sub && e.text.trim()) return e.text;
  }
  return "";
}

import { existsSync } from "node:fs";

// Permission modes the UI offers. plan and dontAsk are left out: plan needs an
// ExitPlanMode flow the UI does not have, dontAsk silently refuses instead of asking.
export const WEB_MODES = ["default", "acceptEdits", "auto", "bypassPermissions"] as const;
export type WebMode = (typeof WEB_MODES)[number];

export function isWebMode(v: unknown): v is WebMode {
  return typeof v === "string" && (WEB_MODES as readonly string[]).includes(v);
}

// Skipping every check lets text inside a fetched posting drive tool calls
// with no human in the loop, so it is only offered inside a container, where
// the agent can reach the mounted repo but not the rest of the machine.
// AJS_ALLOW_BYPASS=1 is the explicit opt-in elsewhere.
export function bypassAllowed(): boolean {
  return process.env.AJS_ALLOW_BYPASS === "1" || existsSync("/.dockerenv");
}

export const BYPASS_REFUSED = "모든 확인 생략은 Docker로 실행할 때만 쓸 수 있어요 (다른 환경에서는 AJS_ALLOW_BYPASS=1)";

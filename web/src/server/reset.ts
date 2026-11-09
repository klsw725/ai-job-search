import { PartialDeleteError } from "./security.ts";

export const RESET_CONFIRM = "초기화";

type Info = { sessionId: string; lastModified: number };

export type ResetSessions = {
  freeze(): void;
  thaw(): void;
  busy(): number;
  history(): Promise<Info[]>;
  hasLiveProcess(sdkId: string): boolean;
  stoppedByUs(sdkId: string, lastModified: number): boolean;
  stopAll(): Promise<{ stillRunning: number }>;
  deleteTranscript(sdkId: string): Promise<void>;
};

export type ResetDeps = {
  sessions: ResetSessions;
  listProfile(): Promise<string[]>;
  clearProfile(): Promise<string[]>;
};

export type ProfileOutcome = { deleted: string[]; partial?: boolean; remaining?: string[] | null; error?: string; changed?: boolean };
export type ChatsOutcome = { deleted: number; failed: number; kept: number; unconfirmed: number; stillRunning: number; error?: string };

function message(e: unknown) {
  if ((e as NodeJS.ErrnoException)?.code === "ENOTSUP") return "이 환경에서는 파일을 안전하게 다룰 수 없습니다. Docker로 실행하세요.";
  return e instanceof Error ? e.message : String(e);
}

const sameSet = (a: string[], b: string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

export function createReset(d: ResetDeps) {
  const s = d.sessions;
  let busy = false;

  async function preview() {
    const profile = await d.listProfile().then(
      (entries) => ({ entries }),
      (e) => ({ error: message(e) }),
    );
    const chats = await s.history().then(
      (list) => ({
        ids: list.map((i) => i.sessionId),
        // Deletable without the user vouching for other programs: ours, and
        // either still running (the reset stops it) or seen to exit.
        ours: list.filter((i) => s.hasLiveProcess(i.sessionId) || s.stoppedByUs(i.sessionId, i.lastModified)).length,
      }),
      (e) => ({ error: message(e) }),
    );
    return { profile, chats, busy: s.busy() };
  }

  async function run(body: { targets?: unknown; confirm?: unknown; externalStopped?: unknown; expected?: { profile?: unknown; chats?: unknown } }) {
    const targets = Array.isArray(body.targets) ? body.targets.filter((t) => t === "profile" || t === "chats") : [];
    if (body.confirm !== RESET_CONFIRM) return { status: 400, body: { error: `확인 문구 '${RESET_CONFIRM}'가 맞지 않습니다` } };
    if (targets.length === 0) return { status: 400, body: { error: "초기화할 항목을 고르세요" } };
    const wantProfile = targets.includes("profile");
    const wantChats = targets.includes("chats");
    // Only what the user saw in the preview may be deleted.
    const expectedProfile = strings(body.expected?.profile);
    const expectedChats = strings(body.expected?.chats);
    if ((wantProfile && !expectedProfile) || (wantChats && !expectedChats)) return { status: 400, body: { error: "확인한 목록이 함께 와야 합니다. 화면을 새로고침하세요." } };
    // The user's statement that no other Claude Code (a terminal) is running
    // in this folder; without it only transcripts we saw stop are deleted.
    const externalStopped = body.externalStopped === true;
    if (busy) return { status: 409, body: { error: "이미 초기화하는 중이에요" } };

    busy = true;
    s.freeze();
    const out: { profile?: ProfileOutcome; chats?: ChatsOutcome } = {};
    try {
      // Stop every writer this server owns before touching either target.
      const stop = wantChats ? await s.stopAll() : { stillRunning: 0 };
      if (wantProfile && stop.stillRunning > 0) {
        out.profile = { deleted: [], error: "AI 작업이 아직 끝나지 않아 프로필을 지우지 않았어요. 잠시 뒤 다시 시도하세요." };
      } else if (wantProfile && !wantChats && s.busy() > 0) {
        out.profile = { deleted: [], error: "AI 작업이 진행 중이라 프로필을 지우지 않았어요. 작업이 끝난 뒤에 하거나 대화 기록도 함께 선택하세요." };
      } else if (wantProfile) {
        try {
          const current = await d.listProfile();
          if (!sameSet(current, expectedProfile!)) {
            out.profile = { deleted: [], changed: true, error: "확인한 뒤로 프로필 목록이 바뀌어 지우지 않았어요. 목록을 다시 확인하세요." };
          } else {
            const deleted = await d.clearProfile();
            out.profile = { deleted, remaining: await d.listProfile().catch(() => null) };
          }
        } catch (e) {
          const partial = e instanceof PartialDeleteError && e.removedAny;
          out.profile = { deleted: e instanceof PartialDeleteError ? e.deleted : [], partial, error: message(e), remaining: await d.listProfile().catch(() => null) };
        }
      }
      if (wantChats) {
        const confirmed = new Set(expectedChats);
        const res: ChatsOutcome = { deleted: 0, failed: 0, kept: 0, unconfirmed: 0, stillRunning: stop.stillRunning };
        try {
          for (const info of await s.history()) {
            const id = info.sessionId;
            if (!confirmed.has(id)) res.unconfirmed += 1;
            else if (s.hasLiveProcess(id) || !(externalStopped || s.stoppedByUs(id, info.lastModified))) res.kept += 1;
            else {
              try {
                await s.deleteTranscript(id);
                res.deleted += 1;
              } catch {
                res.failed += 1;
              }
            }
          }
        } catch (e) {
          res.error = message(e);
        }
        out.chats = res;
      }
    } finally {
      s.thaw();
      busy = false;
    }
    return { status: 200, body: out };
  }

  return { preview, run };
}

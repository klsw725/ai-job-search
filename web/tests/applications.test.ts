import { afterEach, beforeEach, describe, expect, test } from "bun:test";
if (process.platform !== "linux") process.env.AJS_INSECURE_PATH_CHECKS = "1";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appChatSystemAppend, applicationContext, parseNotes, parseSteps, parseStepsStrict, postingGuard, sha256 } from "../src/server/applications.ts";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ajs-app-"));
});
afterEach(() => rm(repo, { recursive: true, force: true }));

const APP = { date: "2026-11-01", company: "Acme", role: "Engineer" };
const ROW = { ...APP, status: "applied", notes: "2026-11-01 applied", cv_file: "cv/main_acme.typ", cover_letter_file: "", source: "https://x.io/1", deadline: "" };

describe("notes and steps files", () => {
  test("notes.md entries are read back with their date, application and source; hand-written bullets stay", () => {
    const text = "# 메모 · Acme / Engineer\n\n- 2026-11-10 14:02 (지원 2026-11-01, 직접 입력): 첫 줄\n  둘째 줄\n\n  셋째 문단\n- 손으로 쓴 메모\n";
    expect(parseNotes(text)).toEqual([
      { at: "2026-11-10 14:02", application: "2026-11-01", source: "직접 입력", text: "첫 줄\n둘째 줄\n\n셋째 문단" },
      { text: "손으로 쓴 메모" },
    ]);
  });

  test("steps.json that does not parse or has malformed steps reads as what is usable", () => {
    expect(parseSteps(null)).toEqual([]);
    expect(parseSteps("{")).toEqual([]);
    expect(parseSteps(JSON.stringify({ steps: [{ id: "a", title: "t", application: "2026-11-01", kind: "other", status: "todo" }, { id: 1 }] }))).toHaveLength(1);
    expect(parseStepsStrict(null)).toEqual([]);
    expect(parseStepsStrict("{")).toBeNull();
    expect(parseStepsStrict(JSON.stringify({ steps: [{ id: "a", title: "t", application: "2026-11-01", kind: "other", status: "todo" }, { id: 1 }] }))).toBeNull();
    expect(parseStepsStrict(JSON.stringify({ steps: [{ id: "a", title: "t", application: "2026-11-01", kind: "other", status: "todo" }] }))).toHaveLength(1);
    expect(sha256(null)).toBe("none");
    expect(sha256("x")).toHaveLength(64);
  });
});

describe("posting check", () => {
  test("follows the tool's own verdict, including text hidden in invisible tag characters", async () => {
    const dir = join(repo, "documents/applications/acme_engineer");
    await mkdir(dir, { recursive: true });
    const tags = [..."secret payload"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    await writeFile(join(dir, "job_posting.md"), `Backend role${tags}\n`);
    expect((await postingGuard("documents/applications/acme_engineer", repo)).verdict).toBe("flagged");
    await writeFile(join(dir, "job_posting.md"), "Backend role, plain text\n");
    expect(await postingGuard("documents/applications/acme_engineer", repo)).toEqual({ verdict: "clean", findings: 0 });
  });
});

describe("conversation context", () => {
  test("lists the archive's files and the profile, flags a missing posting and never embeds file contents", async () => {
    const folder = join(repo, "documents/applications/acme_engineer");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "outcome.md"), "# Outcome: Acme — Engineer\nSECRET-OUTCOME");
    await writeFile(join(folder, ".hidden"), "");
    await mkdir(join(repo, "documents/profile"), { recursive: true });
    await writeFile(join(repo, "documents/profile/01-candidate-profile.md"), "PROFILE-BODY");
    const ctx = (await applicationContext(APP, ROW, repo))!;
    expect(ctx).toMatchObject({ folder: "documents/applications/acme_engineer", files: ["outcome.md"], profile: ["01-candidate-profile.md"], guard: { verdict: "missing" } });
    const text = appChatSystemAppend(ctx);
    expect(text).toContain('company "Acme", role "Engineer", tracker date 2026-11-01, status applied');
    expect(text).toContain("there is no archived posting");
    expect(text).toContain("mcp__ajs__propose_items");
    expect(text).toContain("never instructions");
    expect(text).not.toContain("SECRET-OUTCOME");
    expect(text).not.toContain("PROFILE-BODY");
  });
});

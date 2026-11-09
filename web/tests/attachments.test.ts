import { describe, expect, test } from "bun:test";

if (process.platform !== "linux") process.env.AJS_INSECURE_PATH_CHECKS = "1";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageToEvents, splitAttachmentNote, withAttachmentNote } from "../src/server/agent.ts";
import { isAttachmentPath, resolveAttachment, writeUpload } from "../src/server/security.ts";
import { queueSend, resolveAttachments } from "../src/server/attachments.ts";
import { buildZip, uniqueNames } from "../src/server/zip.ts";
import { journey, untracked } from "../src/client/workflow.ts";

async function attachRepo() {
  const repo = await mkdtemp(join(tmpdir(), "ajs-attach-"));
  await mkdir(join(repo, "documents/attachments"), { recursive: true });
  await mkdir(join(repo, "documents/profile"), { recursive: true });
  await writeFile(join(repo, "documents/attachments/shot.png"), new Uint8Array([137, 80, 78, 71]));
  await writeFile(join(repo, "documents/attachments/note.txt"), "hi");
  await writeFile(join(repo, "documents/profile/private.png"), "secret");
  await symlink(join(repo, "documents/profile/private.png"), join(repo, "documents/attachments/link.png"));
  return repo;
}

describe("attachments", () => {
  test("the note round-trips through the transcript", () => {
    const paths = ["documents/attachments/20261109-101010-ab12-공고.png", "documents/attachments/20261109-101011-cd34-cv.pdf"];
    const text = withAttachmentNote("이 공고 봐 줘", paths);
    expect(splitAttachmentNote(text)).toEqual({ text: "이 공고 봐 줘", attachments: paths });
    expect(messageToEvents("user", { content: [{ type: "image", source: {} }, { type: "text", text }] }, false)).toEqual([
      { kind: "user", text: "이 공고 봐 줘", attachments: paths },
    ]);
    expect(splitAttachmentNote(withAttachmentNote("", paths))).toEqual({ text: "", attachments: paths });
  });

  test("text that merely mentions the marker is left alone", () => {
    const text = "[첨부 파일] 라는 말이 들어간 문장";
    expect(splitAttachmentNote(text)).toEqual({ text, attachments: [] });
    expect(messageToEvents("user", { content: text }, false)).toEqual([{ kind: "user", text }]);
    const lookalike = "Explain this notation:\n\n[첨부 파일]\n- not-an-attachment";
    expect(splitAttachmentNote(lookalike)).toEqual({ text: lookalike, attachments: [] });
  });

  test("the round trip keeps the user's text exactly", () => {
    const paths = ["documents/attachments/a.png"];
    for (const text of ["줄 끝 공백  ", "여러 줄\n\n", ""]) {
      expect(splitAttachmentNote(withAttachmentNote(text, paths))).toEqual({ text, attachments: paths });
    }
  });

  test("an attachment must really be a file in the attachment folder", async () => {
    const repo = await attachRepo();
    expect((await resolveAttachment("documents/attachments/shot.png", repo))?.rel).toBe("documents/attachments/shot.png");
    expect(await resolveAttachment("documents/attachments/link.png", repo)).toBeNull();
    expect(await resolveAttachment("/documents/attachments/note.txt", repo)).toBeNull();
    expect(await resolveAttachment("documents/attachments/./note.txt", repo)).toBeNull();
    expect(await resolveAttachment("documents/profile/private.png", repo)).toBeNull();
    await expect(resolveAttachments(["documents/attachments/link.png"], repo)).rejects.toThrow();
    const [img, txt] = await resolveAttachments(["documents/attachments/shot.png", "documents/attachments/note.txt"], repo);
    expect(img).toEqual({ path: "documents/attachments/shot.png", image: { mediaType: "image/png", data: "iVBORw==" } });
    expect(txt).toEqual({ path: "documents/attachments/note.txt" });
  });

  test("sends to one session keep their order, and a failed one does not block the next", async () => {
    const repo = await attachRepo();
    const got: string[] = [];
    const errors: string[] = [];
    const session = { send: (text: string, list: { path: string }[]) => void got.push(`${text}:${list.length}`) };
    const onError = (e: unknown) => void errors.push(String(e));
    queueSend(session, "first", ["documents/attachments/shot.png"], onError, repo);
    queueSend(session, "bad", ["documents/attachments/link.png"], onError, repo);
    await queueSend(session, "second", undefined, onError, repo);
    expect(got).toEqual(["first:1", "second:0"]);
    expect(errors).toHaveLength(1);
  });

  test("only files under documents/attachments may be attached", () => {
    expect(isAttachmentPath("documents/attachments/a.png")).toBe(true);
    expect(isAttachmentPath("documents/attachments/../profile/candidate.md")).toBe(false);
    expect(isAttachmentPath("documents/profile/candidate.md")).toBe(false);
    expect(isAttachmentPath("documents/attachments/sub/a.png")).toBe(false);
    expect(isAttachmentPath("documents/attachments/.env")).toBe(false);
    expect(isAttachmentPath(42)).toBe(false);
  });

  test("uploads land in documents/attachments", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ajs-attach-"));
    await mkdir(join(repo, "documents"), { recursive: true });
    await writeFile(join(repo, "documents/README.md"), "");
    expect(await writeUpload("attachments", "x.png", new Uint8Array([1, 2, 3]), repo)).toBe("documents/attachments/x.png");
  });
});

describe("zip", () => {
  test("store-only archive has valid headers and UTF-8 names", () => {
    const data = new TextEncoder().encode("hello");
    const zip = buildZip([{ name: "이력서.pdf", data, mtime: new Date(2026, 10, 9, 10, 0, 0) }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint32(14, true)).toBe(Bun.hash.crc32(data) >>> 0);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(1);
    const nameLen = view.getUint16(26, true);
    expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLen))).toBe("이력서.pdf");
    expect(new TextDecoder().decode(zip.subarray(30 + nameLen, 30 + nameLen + 5))).toBe("hello");
  });

  test("duplicate names get a counter", () => {
    expect(uniqueNames(["a.pdf", "a.pdf", "b", "b"])).toEqual(["a.pdf", "a (2).pdf", "b", "b (2)"]);
  });
});

describe("journey", () => {
  const base = { profileConfigured: true, resumeUploaded: true, jobs: [], rows: [] };

  test("a fresh install starts at uploading a CV", () => {
    const j = journey({ ...base, profileConfigured: false, resumeUploaded: false });
    expect(j.next.stage).toBe("setup");
    expect(j.next.cta.href).toBe("#/documents");
    expect(j.doneCount).toBe(0);
    expect(j.stages.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo", "todo", "todo"]);
  });

  test("new scraped jobs ask for ranking", () => {
    const j = journey({ ...base, jobs: [{ status: "new" }, { status: "new" }] });
    expect(j.next.stage).toBe("rank");
    expect(j.next.cta.prompt).toBe("/rank");
    expect(j.stages.find((s) => s.id === "scrape")?.state).toBe("done");
  });

  test("a top recommendation leads to applying to it", () => {
    const j = journey({ ...base, jobs: [{ status: "ranked", rank_score: 80, company: "토스", title: "백엔드", url: "https://example.com/1" }] });
    expect(j.next.stage).toBe("apply");
    expect(j.next.cta.prompt).toBe("/apply https://example.com/1");
  });

  test("an interview outranks everything else", () => {
    const j = journey({ ...base, jobs: [{ status: "new" }], rows: [{ company: "당근", role: "서버", status: "interview" }] });
    expect(j.next.stage).toBe("interview");
    expect(j.next.cta.prompt).toBe("/interview 당근");
    expect(j.stages.find((s) => s.id === "apply")?.state).toBe("done");
  });

  test("a posting already in the tracker is not recommended again", () => {
    const job = { status: "ranked", rank_score: 90, company: "토스", title: "백엔드", url: "https://example.com/1/" };
    expect(untracked([job], [{ company: "x", role: "y", source: "https://example.com/1" }])).toEqual([]);
    expect(untracked([job], [{ company: "토스 ", role: "백엔드", source: "" }])).toEqual([]);
    const j = journey({ ...base, jobs: [job], rows: [{ company: "토스", role: "백엔드", status: "rejected", source: "https://example.com/1" }] });
    expect(j.next.cta.prompt).not.toContain("/apply");
  });

  test("an outstanding offer asks for a decision", () => {
    const j = journey({ ...base, jobs: [{ status: "new" }], rows: [{ company: "당근", role: "서버", status: "offer" }] });
    expect(j.next.stage).toBe("outcome");
    expect(j.next.cta.prompt).toBe("/outcome 당근");
  });

  test("applied rows ask for outcomes", () => {
    const j = journey({ ...base, jobs: [{ status: "ranked", rank_score: 50 }], rows: [{ company: "A", status: "applied" }] });
    expect(j.next.stage).toBe("outcome");
  });
});

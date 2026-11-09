import { extname } from "node:path";
import type { OutgoingAttachment } from "./agent.ts";
import { INLINE_IMAGE_LIMIT_BYTES, MAX_ATTACHMENTS, REPO_DIR } from "./config.ts";
import { readChecked, resolveAttachment } from "./security.ts";

const INLINE_IMAGE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Attachments must be files the user uploaded for chat; images small enough
// for the API also go inline so the model sees them without a Read call.
export async function resolveAttachments(raw: unknown, repo = REPO_DIR): Promise<OutgoingAttachment[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw new Error(`첨부 파일은 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다`);
  const out: OutgoingAttachment[] = [];
  for (const entry of new Set(raw)) {
    const found = await resolveAttachment(entry, repo);
    if (!found) throw new Error("첨부 파일을 찾을 수 없습니다. 다시 올려 주세요.");
    const attachment: OutgoingAttachment = { path: found.rel };
    const mediaType = INLINE_IMAGE[extname(found.abs).toLowerCase()];
    if (mediaType) {
      const data = await readChecked(found.abs, repo, INLINE_IMAGE_LIMIT_BYTES).catch(() => null);
      if (data) attachment.image = { mediaType, data: data.toString("base64") };
    }
    out.push(attachment);
  }
  return out;
}

type Sendable = { send: (text: string, attachments: OutgoingAttachment[]) => void };

// Sends to one session run in arrival order even though reading attached
// images is async: a quick follow-up must not overtake the message it follows.
// A failed send reports its error and does not block the ones after it.
const queues = new WeakMap<Sendable, Promise<void>>();

export function queueSend(session: Sendable, text: string, attachments: unknown, onError: (e: unknown) => void, repo = REPO_DIR): Promise<void> {
  const next = (queues.get(session) ?? Promise.resolve())
    .then(() => resolveAttachments(attachments, repo))
    .then((list) => session.send(text, list))
    .catch(onError);
  queues.set(session, next);
  return next;
}

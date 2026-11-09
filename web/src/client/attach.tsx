import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { fileName, fileUrl, uploadFile } from "./api.ts";
import { Icon, formatBytes } from "./ui.tsx";

// Same caps the server enforces (config.ts); checked here to fail fast.
const UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export type Attachment = { id: string; name: string; size: number; preview?: string; path?: string; error?: string };

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// The server prefixes every chat upload with a timestamp so pasted
// "image.png" files never collide; the prefix is noise to the user.
export function attachmentLabel(path: string): string {
  return fileName(path).replace(/^\d{8}-\d{6}-[0-9a-f]{4}-/, "");
}

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const update = (id: string, patch: Partial<Attachment>) => setItems((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const add = (files: FileList | File[]) => {
    const room = MAX_ATTACHMENTS - items.length;
    for (const [n, file] of Array.from(files).entries()) {
      const id = crypto.randomUUID();
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      const item: Attachment = { id, name: file.name || "붙여넣은 이미지.png", size: file.size, preview };
      if (n >= room) item.error = `한 번에 ${MAX_ATTACHMENTS}개까지 보낼 수 있어요`;
      else if (file.size > UPLOAD_LIMIT_BYTES) item.error = "20MB보다 커서 올릴 수 없어요";
      setItems((list) => [...list, item]);
      if (item.error) continue;
      uploadFile("attachments", file)
        .then((r) => update(id, { path: r.path }))
        .catch((e: Error) => update(id, { error: e.message }));
    }
  };

  const remove = (id: string) =>
    setItems((list) => {
      const gone = list.find((a) => a.id === id);
      if (gone?.preview) {
        URL.revokeObjectURL(gone.preview);
        previews.current.delete(gone.preview);
      }
      return list.filter((a) => a.id !== id);
    });

  const clear = () =>
    setItems((list) => {
      for (const a of list) if (a.preview) URL.revokeObjectURL(a.preview);
      previews.current.clear();
      return [];
    });

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    add(files);
  };

  return {
    items,
    add,
    remove,
    clear,
    onPaste,
    paths: items.flatMap((a) => (a.path ? [a.path] : [])),
    uploading: items.some((a) => !a.path && !a.error),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

export function AttachButton({ onFiles, label = "파일 첨부", disabled }: { onFiles: (f: FileList) => void; label?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn ghost icon-btn" title={`${label} (이미지·PDF·문서, 끌어다 놓거나 붙여넣어도 돼요)`} disabled={disabled} onClick={() => input.current?.click()}>
        <Icon name="clip" /> <span className="icon-label">{label}</span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function AttachmentTray({ attachments }: { attachments: Attachments }) {
  if (attachments.items.length === 0) return null;
  return (
    <ul className="attach-tray">
      {attachments.items.map((a) => (
        <li key={a.id} className={`attach-chip ${a.error ? "bad" : ""}`} title={a.error ?? a.name}>
          {a.preview ? <img src={a.preview} alt="" /> : <span className="attach-icon"><Icon name="file" /></span>}
          <span className="attach-meta">
            <span className="ellipsis">{a.name}</span>
            <span className="small muted">
              {a.error ? <span className="error-inline">{a.error}</span> : a.path ? formatBytes(a.size) : <><span className="spinner" /> 올리는 중</>}
            </span>
          </span>
          <button type="button" className="attach-x" aria-label={`${a.name} 빼기`} onClick={() => attachments.remove(a.id)}>
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SentAttachments({ paths }: { paths?: string[] }) {
  if (!paths?.length) return null;
  return (
    <ul className="sent-attachments">
      {paths.map((p) =>
        IMAGE.test(p) ? (
          <li key={p}>
            <a href={fileUrl(p)} target="_blank" rel="noopener noreferrer" title={attachmentLabel(p)}>
              <img className="sent-thumb" src={fileUrl(p)} alt={attachmentLabel(p)} />
            </a>
          </li>
        ) : (
          <li key={p}>
            <a className="sent-file" href={fileUrl(p)} target="_blank" rel="noopener noreferrer" title={attachmentLabel(p)}>
              <Icon name="file" size={14} /> <span className="ellipsis">{attachmentLabel(p)}</span>
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

export function DropZone({ onFiles, className, children }: { onFiles: (f: FileList) => void; className?: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  return (
    <div
      className={`${className ?? ""} dropzone ${over ? "over" : ""}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        depth.current -= 1;
        if (depth.current <= 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      }}
    >
      {children}
      {over && <div className="drop-hint">여기에 놓으면 첨부돼요</div>}
    </div>
  );
}

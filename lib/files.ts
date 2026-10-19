// Pure helpers shared by the server and the app. No Node or DOM imports.

/** bb's own prompt-attachment caps (server-enforced): images 10 MB, others 25 MB. */
export const IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Raw bytes per chunk sent to the server for large files (base64 on the wire). */
export const CHUNK_BYTES = 2 * 1024 * 1024;

export function isImageMime(mimeType: string | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

/** The largest file bb's attachment upload accepts for this MIME type. */
export function attachmentLimitFor(mimeType: string | undefined): number {
  return isImageMime(mimeType) ? IMAGE_ATTACHMENT_MAX_BYTES : FILE_ATTACHMENT_MAX_BYTES;
}

const UNSAFE_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
const MAX_NAME_LENGTH = 120;

/**
 * A safe single path segment for a dropped file name: no separators, control
 * characters or leading dots, at most 120 characters with the extension kept.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  let clean = base.replace(UNSAFE_CHARS, "_").replace(/^[.\s]+/, "").trim();
  if (clean === "") clean = "file";
  if (clean.length <= MAX_NAME_LENGTH) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
  return clean.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// Pure helpers shared by the server and the app. No Node or DOM imports.

/** Images up to this size are attached as images; larger ones as plain files. */
export const IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Raw bytes per chunk sent to the server for temporary copies (base64 on the wire). */
export const CHUNK_BYTES = 2 * 1024 * 1024;

export function isImageMime(mimeType: string | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** `localImage` for common raster images bb can show inline, otherwise `localFile`. */
export function attachmentTypeFor(mimeType: string | undefined, sizeBytes: number): "localImage" | "localFile" {
  return mimeType !== undefined && INLINE_IMAGE_TYPES.has(mimeType) && sizeBytes <= IMAGE_ATTACHMENT_MAX_BYTES
    ? "localImage"
    : "localFile";
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

/** A MIME type guessed from a file name, for files sent from Finder. */
export function mimeFromName(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()];
}

/** The last segment of a POSIX path. */
export function basenameOf(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * Absolute paths from a `text/uri-list` payload: `file://` entries only
 * (local host or none), percent-decoded. Comments and other schemes are
 * dropped; so is anything that doesn't decode to an absolute path.
 */
export function pathsFromUriList(uriList: string): string[] {
  const out: string[] = [];
  for (const raw of uriList.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^file:\/\/(localhost)?(\/[^?#]*)$/i.exec(line);
    if (match === null) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[2]!);
    } catch {
      continue;
    }
    if (decoded.startsWith("/") && !decoded.includes("\0")) out.push(decoded);
  }
  return out;
}

/** Hint paths whose file name equals `name` (Unicode-normalized). */
export function hintsForName(name: string, candidates: readonly string[]): string[] {
  const want = name.normalize("NFC");
  return Array.from(new Set(candidates.filter((p) => basenameOf(p).normalize("NFC") === want))).slice(0, 8);
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

/** "~/Projects/a.txt" for display; the full path otherwise. */
export function displayPath(p: string, home: string | null): string {
  if (home !== null && home !== "" && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p;
}

export function daysLabel(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

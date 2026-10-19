// Validation for files sent explicitly from Finder (`bb composer-dropzone send`).
import { promises as fs } from "node:fs";
import { basenameOf, mimeFromName } from "./files.ts";
import { statRegularFile } from "./locate.ts";
import { sendRejection } from "./paths.ts";

export interface SendItem {
  path: string;
  name: string;
  sizeBytes: number;
  mimeType?: string;
}

/** Validate one path given to `send`. Returns the item to deliver or a refusal. */
export async function validateSendPath(
  input: string,
  home: string,
): Promise<{ ok: true; item: SendItem } | { ok: false; reason: string }> {
  const lexical = sendRejection(input, home);
  if (lexical !== null) return { ok: false, reason: lexical };
  const link = await fs.lstat(input).catch(() => null);
  if (link === null) return { ok: false, reason: "file not found" };
  if (link.isDirectory()) return { ok: false, reason: "folders aren't supported yet; send the files inside" };
  const stat = await statRegularFile(input);
  if (stat === null) return { ok: false, reason: "not a regular file" };
  const real = sendRejection(stat.realPath, home);
  if (real !== null) return { ok: false, reason: `link target refused: ${real}` };
  if (stat.sizeBytes === 0) return { ok: false, reason: "empty file" };
  const name = basenameOf(stat.realPath);
  return { ok: true, item: { path: stat.realPath, name, sizeBytes: stat.sizeBytes, mimeType: mimeFromName(name) } };
}


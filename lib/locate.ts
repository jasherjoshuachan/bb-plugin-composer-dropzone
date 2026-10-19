// Find the original of a dropped file on this Mac, proven by content.
//
// A candidate is linked only when its size and content fingerprint equal what
// the app computed from the dropped bytes. Candidates come from drag path
// hints, then from Spotlight (`mdfind`, run with argv only, never a shell).
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fingerprintSamples, samplesEqual } from "./fingerprint.ts";
import { candidateRejection } from "./paths.ts";

export const MDFIND_PATH = "/usr/bin/mdfind";
export const MDFIND_TIMEOUT_MS = 4000;
export const MDFIND_MAX_RESULTS = 200;
export const MTIME_TOLERANCE_MS = 2000;
export const MAX_NAME_BYTES = 255;
export const MAX_HINTS = 8;

/** Runs a program with an argv array and returns its stdout. Injectable for tests. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; maxBuffer: number },
) => Promise<string>;

export const execFileRunner: CommandRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer, encoding: "utf8", shell: false, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

/** Why a dropped file name can't be searched for, or null. */
export function nameRejection(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return "empty name";
  if (name.includes("\0")) return "name contains NUL";
  if (name.includes("/")) return "name contains a slash";
  if (name === "." || name === "..") return "not a file name";
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return "name too long";
  return null;
}

/**
 * The Spotlight query for an exact file name. `"` and `\` are escaped, and so
 * is `*` (Spotlight's wildcard), so the name is matched literally. Throws for
 * names that can't be a file name.
 */
export function spotlightQuery(name: string, modifiers: "" | "cd" = "", sizeBytes?: number): string {
  const rejection = nameRejection(name);
  if (rejection !== null) throw new Error(`Can't search for this file: ${rejection}.`);
  // The name's bytes pass through untouched (macOS screenshot names carry
  // U+202F before AM/PM; normalizing whitespace would miss them).
  const escaped = name.replace(/[\\"*]/g, (ch) => `\\${ch}`);
  const query = `kMDItemFSName == "${escaped}"${modifiers}`;
  if (sizeBytes === undefined) return query;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error("Bad file size.");
  return `${query} && kMDItemFSSize == ${sizeBytes}`;
}

/**
 * The Spotlight queries to try, in order: the exact name, its NFC and NFD
 * forms when they differ, then a case- and diacritic-insensitive match, all
 * narrowed to the exact size (common names like README.md have thousands of
 * copies), and last the exact name alone in case the size isn't indexed yet.
 * Every hit is still verified by size and fingerprint, so looser queries can't
 * link the wrong file.
 */
export function spotlightQueries(name: string, sizeBytes: number): string[] {
  const names = [name, name.normalize("NFC"), name.normalize("NFD")];
  const unique = names.filter((value, index) => names.indexOf(value) === index);
  return [
    ...unique.map((value) => spotlightQuery(value, "", sizeBytes)),
    spotlightQuery(name, "cd", sizeBytes),
    spotlightQuery(name),
  ];
}

/** Splits `mdfind -0` output, dropping empties, capped at MDFIND_MAX_RESULTS. */
export function parseMdfindOutput(stdout: string): string[] {
  return stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .slice(0, MDFIND_MAX_RESULTS);
}

export interface StatResult {
  realPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * The real path, size and mtime of `p` when it is an absolute path to a
 * regular file, or to a symlink that resolves to one. Null otherwise.
 */
export async function statRegularFile(p: string): Promise<StatResult | null> {
  if (!path.isAbsolute(p) || p.includes("\0")) return null;
  try {
    const link = await fs.lstat(p);
    let realPath = p;
    if (link.isSymbolicLink()) realPath = await fs.realpath(p);
    else if (!link.isFile()) return null;
    else realPath = await fs.realpath(p);
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) return null;
    return { realPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Fingerprint samples of a file on disk, read with the shared sampler. */
export async function fingerprintFile(p: string, sizeBytes: number): Promise<string[]> {
  const handle = await fs.open(p, "r");
  try {
    return await fingerprintSamples(sizeBytes, async (offset, length) => {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buffer.subarray(0, read);
    });
  } finally {
    await handle.close();
  }
}

export interface LocateRequest {
  name: string;
  sizeBytes: number;
  lastModified: number;
  samples: string[];
  hints: string[];
}

export type LocateOutcome =
  | { found: true; path: string; via: "hint" | "spotlight" }
  | { found: false; reason: string };

export interface LocateContext {
  home: string;
  dropsDir: string;
  runner?: CommandRunner;
}

interface Verified extends StatResult {
  mtimeMatches: boolean;
}

/** Order verified candidates: mtime match first, then most recently modified, then shortest path. */
export function rankCandidates<T extends { realPath: string; mtimeMs: number; mtimeMatches: boolean }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.mtimeMatches !== b.mtimeMatches) return a.mtimeMatches ? -1 : 1;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.realPath.length - b.realPath.length;
  });
}

async function verify(candidate: string, req: LocateRequest, ctx: LocateContext): Promise<Verified | null> {
  const stat = await statRegularFile(candidate);
  if (stat === null) return null;
  if (candidateRejection(stat.realPath, ctx) !== null) return null;
  if (stat.sizeBytes !== req.sizeBytes) return null;
  let samples: string[];
  try {
    samples = await fingerprintFile(stat.realPath, stat.sizeBytes);
  } catch {
    return null;
  }
  if (!samplesEqual(samples, req.samples)) return null;
  const mtimeMatches = req.lastModified > 0 && Math.abs(stat.mtimeMs - req.lastModified) <= MTIME_TOLERANCE_MS;
  return { ...stat, mtimeMatches };
}

function sameName(p: string, name: string): boolean {
  return path.basename(p).normalize("NFC") === name.normalize("NFC");
}

/** Case- and diacritic-insensitive name match, for the loosest Spotlight query. */
export function looseName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export async function locateOriginal(req: LocateRequest, ctx: LocateContext): Promise<LocateOutcome> {
  const rejection = nameRejection(req.name);
  if (rejection !== null) return { found: false, reason: `Unusable file name (${rejection}).` };
  if (req.sizeBytes <= 0 || req.samples.length === 0) return { found: false, reason: "Empty file." };

  // a. Path hints from the drag: only exact-name, absolute paths.
  const hints = req.hints.filter((hint) => path.isAbsolute(hint) && sameName(hint, req.name)).slice(0, MAX_HINTS);
  for (const hint of hints) {
    const hit = await verify(hint, req, ctx);
    if (hit !== null) return { found: true, path: hit.realPath, via: "hint" };
  }

  // b. Spotlight: exact name first, looser forms only if nothing verified.
  const runner = ctx.runner ?? execFileRunner;
  const seen = new Set<string>();
  let anySearchWorked = false;
  for (const query of spotlightQueries(req.name, req.sizeBytes)) {
    const loose = query.includes('"cd');
    let stdout: string;
    try {
      stdout = await runner(MDFIND_PATH, ["-0", query], { timeoutMs: MDFIND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      anySearchWorked = true;
    } catch {
      continue;
    }
    const verified: Verified[] = [];
    for (const candidate of parseMdfindOutput(stdout)) {
      if (!path.isAbsolute(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      const nameOk = loose
        ? looseName(path.basename(candidate)) === looseName(req.name)
        : sameName(candidate, req.name);
      if (!nameOk) continue;
      const hit = await verify(candidate, req, ctx);
      if (hit !== null && !verified.some((v) => v.realPath === hit.realPath)) verified.push(hit);
    }
    const best = rankCandidates(verified)[0];
    if (best !== undefined) return { found: true, path: best.realPath, via: "spotlight" };
  }
  if (!anySearchWorked) return { found: false, reason: "Spotlight search failed." };

  // c. No filesystem walk fallback in v0.2 (see README, "Limitations").
  return { found: false, reason: "No matching file found on this Mac." };
}

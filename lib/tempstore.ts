// Temporary copies of dropped items that are not files on this Mac.
//
// Layout under the plugin's drops folder:
//   drops/temp/<YYYY-MM-DD>/<id>-<name>   temporary copies (v0.2)
//   drops/<YYYY-MM-DD>/<id>-<name>        large-file copies left by v0.1
//   drops/.partial/<uploadId>             uploads in progress
// Both dated layouts follow the same retention and cap.
import { promises as fs } from "node:fs";
import path from "node:path";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Copies younger than this are never evicted for the size cap. */
export const CAP_PROTECTION_MS = DAY_MS;

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

export interface TempEntry {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface SweepPolicy {
  now: number;
  retentionMs: number;
  capBytes: number;
}

/**
 * Which copies to delete: everything at or past retention, then (oldest
 * first) whatever keeps the total over the cap, never touching a copy younger
 * than 24 hours. Ties in age break on path for a stable order.
 */
export function planSweep(entries: readonly TempEntry[], policy: SweepPolicy): string[] {
  const { now, retentionMs, capBytes } = policy;
  const remove: string[] = [];
  const kept: TempEntry[] = [];
  for (const entry of entries) {
    if (now - entry.mtimeMs >= retentionMs) remove.push(entry.path);
    else kept.push(entry);
  }
  let total = kept.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const oldestFirst = [...kept].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  for (const entry of oldestFirst) {
    if (total <= capBytes) break;
    if (now - entry.mtimeMs < CAP_PROTECTION_MS) break;
    remove.push(entry.path);
    total -= entry.sizeBytes;
  }
  return remove;
}

export interface TempStats {
  count: number;
  totalBytes: number;
  oldestMtimeMs: number | null;
}

export function summarize(entries: readonly TempEntry[]): TempStats {
  let totalBytes = 0;
  let oldest: number | null = null;
  for (const entry of entries) {
    totalBytes += entry.sizeBytes;
    if (oldest === null || entry.mtimeMs < oldest) oldest = entry.mtimeMs;
  }
  return { count: entries.length, totalBytes, oldestMtimeMs: oldest };
}

async function listDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [] as string[]);
}

/** The dated folders that hold copies (v0.2 temp and v0.1 legacy). */
export async function datedDirs(dropsDir: string): Promise<string[]> {
  const dirs: string[] = [];
  const tempDir = path.join(dropsDir, "temp");
  for (const day of await listDir(tempDir)) if (DATE_DIR.test(day)) dirs.push(path.join(tempDir, day));
  for (const day of await listDir(dropsDir)) if (DATE_DIR.test(day)) dirs.push(path.join(dropsDir, day));
  return dirs;
}

/** Every regular file in the dated folders. Symlinks and folders are ignored. */
export async function scanTempStore(dropsDir: string): Promise<TempEntry[]> {
  const entries: TempEntry[] = [];
  for (const dir of await datedDirs(dropsDir)) {
    for (const name of await listDir(dir)) {
      const full = path.join(dir, name);
      const stat = await fs.lstat(full).catch(() => null);
      if (stat === null || !stat.isFile()) continue;
      entries.push({ path: full, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return entries;
}

/** Apply retention and the cap, then remove empty dated folders. Returns what was deleted. */
export async function sweepTempStore(dropsDir: string, policy: SweepPolicy): Promise<string[]> {
  const entries = await scanTempStore(dropsDir);
  const remove = planSweep(entries, policy);
  for (const file of remove) await fs.rm(file, { force: true });
  for (const dir of await datedDirs(dropsDir)) {
    if ((await listDir(dir)).length === 0) await fs.rmdir(dir).catch(() => undefined);
  }
  return remove;
}

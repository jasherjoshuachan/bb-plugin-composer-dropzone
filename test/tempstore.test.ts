import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DAY_MS, HOUR_MS, planSweep, scanTempStore, summarize, sweepTempStore, type TempEntry } from "../lib/tempstore.ts";

const MB = 1024 * 1024;
const now = Date.parse("2026-10-19T12:00:00Z");
const entry = (name: string, ageMs: number, sizeMb: number): TempEntry => ({
  path: `/d/${name}`,
  sizeBytes: sizeMb * MB,
  mtimeMs: now - ageMs,
});

test("planSweep: retention deletes copies at or past the limit", () => {
  const plan = planSweep(
    [entry("a", 2 * DAY_MS, 1), entry("b", 2 * DAY_MS - 1, 1), entry("c", 5 * DAY_MS, 1)],
    { now, retentionMs: 2 * DAY_MS, capBytes: 1024 * MB },
  );
  assert.deepEqual(plan.sort(), ["/d/a", "/d/c"]);
});

test("planSweep: over the cap, oldest go first until under", () => {
  const plan = planSweep(
    [entry("new", 30 * HOUR_MS, 400), entry("oldest", 47 * HOUR_MS, 400), entry("mid", 40 * HOUR_MS, 400)],
    { now, retentionMs: 2 * DAY_MS, capBytes: 900 * MB },
  );
  assert.deepEqual(plan, ["/d/oldest"]);
});

test("planSweep: copies younger than 24 h are never evicted for the cap", () => {
  const plan = planSweep(
    [entry("young1", 23 * HOUR_MS, 800), entry("young2", 1 * HOUR_MS, 800), entry("old", 25 * HOUR_MS, 10)],
    { now, retentionMs: 2 * DAY_MS, capBytes: 100 * MB },
  );
  assert.deepEqual(plan, ["/d/old"]);
});

test("planSweep: under the cap nothing young-enough is touched", () => {
  assert.deepEqual(planSweep([entry("a", 30 * HOUR_MS, 1)], { now, retentionMs: 2 * DAY_MS, capBytes: 10 * MB }), []);
});

test("summarize counts, totals and finds the oldest", () => {
  assert.deepEqual(summarize([]), { count: 0, totalBytes: 0, oldestMtimeMs: null });
  const s = summarize([entry("a", HOUR_MS, 1), entry("b", DAY_MS, 2)]);
  assert.deepEqual(s, { count: 2, totalBytes: 3 * MB, oldestMtimeMs: now - DAY_MS });
});

test("sweepTempStore handles v0.2 temp and v0.1 legacy folders, and removes empty days", async () => {
  const drops = await fs.mkdtemp(path.join(os.tmpdir(), "dz-drops-"));
  try {
    const write = async (rel: string, ageMs: number) => {
      const full = path.join(drops, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, "x");
      const t = new Date(Date.now() - ageMs);
      await fs.utimes(full, t, t);
      return full;
    };
    await write("temp/2026-10-10/a-old.png", 3 * DAY_MS);
    const fresh = await write("temp/2026-10-19/b-new.png", HOUR_MS);
    await write("2026-09-01/c-legacy.mov", 40 * DAY_MS);
    await write(".partial/ignored", 40 * DAY_MS);
    await write("notadate/ignored.txt", 40 * DAY_MS);
    assert.equal((await scanTempStore(drops)).length, 3);
    const removed = await sweepTempStore(drops, { now: Date.now(), retentionMs: 2 * DAY_MS, capBytes: 1024 * MB });
    assert.equal(removed.length, 2);
    const left = await scanTempStore(drops);
    assert.deepEqual(left.map((e) => e.path), [fresh]);
    await assert.rejects(fs.stat(path.join(drops, "temp/2026-10-10")));
    await assert.rejects(fs.stat(path.join(drops, "2026-09-01")));
    await fs.stat(path.join(drops, "notadate/ignored.txt"));
    await fs.stat(path.join(drops, ".partial/ignored"));
  } finally {
    await fs.rm(drops, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fingerprintSamples, sampleRanges, SAMPLE_BYTES, WHOLE_FILE_MAX_BYTES } from "../lib/fingerprint.ts";
import { fingerprintFile } from "../lib/locate.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const KiB = 1024;

test("sampleRanges: empty and invalid sizes have no samples", () => {
  assert.deepEqual(sampleRanges(0), []);
  assert.deepEqual(sampleRanges(-1), []);
  assert.deepEqual(sampleRanges(1.5), []);
});

test("sampleRanges: files up to 192 KiB are one whole-file sample", () => {
  assert.equal(WHOLE_FILE_MAX_BYTES, 192 * KiB);
  assert.deepEqual(sampleRanges(1), [{ offset: 0, length: 1 }]);
  assert.deepEqual(sampleRanges(192 * KiB), [{ offset: 0, length: 192 * KiB }]);
});

test("sampleRanges: larger files take start, middle and end at exact offsets", () => {
  const size = 192 * KiB + 1;
  assert.deepEqual(sampleRanges(size), [
    { offset: 0, length: SAMPLE_BYTES },
    { offset: Math.floor((size - SAMPLE_BYTES) / 2), length: SAMPLE_BYTES },
    { offset: size - SAMPLE_BYTES, length: SAMPLE_BYTES },
  ]);
  const big = 5_000_000_001;
  const ranges = sampleRanges(big);
  assert.equal(ranges[1]!.offset, 2_499_967_232);
  assert.equal(ranges[2]!.offset, big - 64 * KiB);
});

test("fingerprintSamples hashes each range (matches node:crypto)", async () => {
  const data = randomBytes(300 * KiB);
  const read = async (offset: number, length: number) => data.subarray(offset, offset + length);
  const samples = await fingerprintSamples(data.length, read);
  const mid = Math.floor((data.length - SAMPLE_BYTES) / 2);
  assert.deepEqual(samples, [
    sha(data.subarray(0, SAMPLE_BYTES)),
    sha(data.subarray(mid, mid + SAMPLE_BYTES)),
    sha(data.subarray(data.length - SAMPLE_BYTES)),
  ]);
});

test("fingerprintSamples rejects short reads", async () => {
  await assert.rejects(fingerprintSamples(10, async () => new Uint8Array(5)), /Short read/);
});

test("app (Blob) and server (file) fingerprints agree, small and large", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dz-fp-"));
  try {
    for (const size of [1, 100 * KiB, 192 * KiB, 192 * KiB + 7, 3 * 1024 * KiB + 3]) {
      const data = randomBytes(size);
      const file = path.join(dir, `f-${size}`);
      await fs.writeFile(file, data);
      const blob = new Blob([data]);
      const fromBlob = await fingerprintSamples(size, async (offset, length) =>
        new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
      );
      assert.deepEqual(await fingerprintFile(file, size), fromBlob, `size ${size}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

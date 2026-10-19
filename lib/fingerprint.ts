// Content fingerprint shared by the app (browser) and the server (Node).
// Pure: uses only the Web Crypto API on globalThis, which both have.
//
// A fingerprint is the size plus the sha256 of up to three 64 KiB samples:
// the start, the middle and the end of the file. Files of 192 KiB or less are
// hashed whole, as a single sample.

export const SAMPLE_BYTES = 64 * 1024;
export const WHOLE_FILE_MAX_BYTES = 3 * SAMPLE_BYTES;

export interface SampleRange {
  offset: number;
  length: number;
}

/** The byte ranges to hash for a file of `size` bytes. Empty files have none. */
export function sampleRanges(size: number): SampleRange[] {
  if (!Number.isSafeInteger(size) || size <= 0) return [];
  if (size <= WHOLE_FILE_MAX_BYTES) return [{ offset: 0, length: size }];
  return [
    { offset: 0, length: SAMPLE_BYTES },
    { offset: Math.floor((size - SAMPLE_BYTES) / 2), length: SAMPLE_BYTES },
    { offset: size - SAMPLE_BYTES, length: SAMPLE_BYTES },
  ];
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/**
 * Hex sha256 of each sample of a file, read through `read(offset, length)`.
 * Throws when a read comes back short (the file changed or is unreadable).
 */
export async function fingerprintSamples(
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<string[]> {
  const out: string[] = [];
  for (const range of sampleRanges(size)) {
    const bytes = await read(range.offset, range.length);
    if (bytes.length !== range.length) throw new Error("Short read while fingerprinting.");
    out.push(await sha256Hex(bytes));
  }
  return out;
}

export function samplesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

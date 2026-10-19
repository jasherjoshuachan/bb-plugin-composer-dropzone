import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fingerprintSamples } from "../lib/fingerprint.ts";
import {
  locateOriginal,
  MDFIND_MAX_RESULTS,
  MDFIND_PATH,
  nameRejection,
  parseMdfindOutput,
  rankCandidates,
  spotlightQueries,
  spotlightQuery,
  type CommandRunner,
} from "../lib/locate.ts";

test("spotlightQuery escapes quotes, backslashes and wildcards", () => {
  assert.equal(spotlightQuery("a.txt"), 'kMDItemFSName == "a.txt"');
  assert.equal(spotlightQuery('say "hi".txt'), 'kMDItemFSName == "say \\"hi\\".txt"');
  assert.equal(spotlightQuery("back\\slash.txt"), 'kMDItemFSName == "back\\\\slash.txt"');
  assert.equal(spotlightQuery("a*b.txt"), 'kMDItemFSName == "a\\*b.txt"');
  // A name can't close the string early and append a clause.
  assert.equal(
    spotlightQuery('x" || kMDItemFSName == "*'),
    'kMDItemFSName == "x\\" || kMDItemFSName == \\"\\*"',
  );
});

test("spotlightQuery keeps unicode and leading dashes inside the quoted query", () => {
  assert.equal(spotlightQuery("Café 日本.png"), 'kMDItemFSName == "Café 日本.png"');
  const q = spotlightQuery("-0 --help");
  assert.equal(q, 'kMDItemFSName == "-0 --help"');
  assert.ok(!q.startsWith("-"));
});

test("spotlightQuery rejects NUL, slashes, dot names, empty and over-long names", () => {
  assert.throws(() => spotlightQuery("a\0b"), /NUL/);
  assert.throws(() => spotlightQuery("a/b"), /slash/);
  assert.throws(() => spotlightQuery(".."), /not a file name/);
  assert.throws(() => spotlightQuery(""), /empty/);
  assert.throws(() => spotlightQuery("é".repeat(128)), /too long/);
  assert.equal(nameRejection("é".repeat(127)), null);
});

test("parseMdfindOutput splits on NUL and caps results", () => {
  assert.deepEqual(parseMdfindOutput("/a\0/b c\0\0"), ["/a", "/b c"]);
  const many = Array.from({ length: 500 }, (_, i) => `/p/${i}`).join("\0");
  assert.equal(parseMdfindOutput(many).length, MDFIND_MAX_RESULTS);
});

test("rankCandidates: mtime match, then newest, then shortest path", () => {
  const ranked = rankCandidates([
    { realPath: "/a/long/path/x", mtimeMs: 10, mtimeMatches: false },
    { realPath: "/a/x", mtimeMs: 5, mtimeMatches: true },
    { realPath: "/b/xx", mtimeMs: 20, mtimeMatches: false },
    { realPath: "/b/x", mtimeMs: 20, mtimeMatches: false },
  ]);
  assert.deepEqual(
    ranked.map((c) => c.realPath),
    ["/a/x", "/b/x", "/b/xx", "/a/long/path/x"],
  );
});

// Filesystem-backed locate tests in a fake home under the temp folder.
let home = "";
let dropsDir = "";
const data = randomBytes(400 * 1024);
let samples: string[] = [];

async function put(rel: string, bytes: Uint8Array = data, mtime?: Date): Promise<string> {
  const full = path.join(home, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, bytes);
  if (mtime) await fs.utimes(full, mtime, mtime);
  return full;
}

function runnerReturning(paths: string[], calls: string[][] = []): CommandRunner {
  return async (file, args) => {
    calls.push([file, ...args]);
    return paths.join("\0") + (paths.length ? "\0" : "");
  };
}

before(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dz-home-")));
  dropsDir = path.join(home, ".bb", "plugins", "composer-dropzone", "drops");
  samples = await fingerprintSamples(data.length, async (o, l) => data.subarray(o, o + l));
});
after(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const request = (over: Partial<Parameters<typeof locateOriginal>[0]> = {}) => ({
  name: "clip.mov",
  sizeBytes: data.length,
  lastModified: 0,
  samples,
  hints: [],
  ...over,
});

test("locate: a verified hint wins without running Spotlight", async () => {
  const file = await put("Projects/a/clip.mov");
  const calls: string[][] = [];
  const out = await locateOriginal(request({ hints: [file] }), { home, dropsDir, runner: runnerReturning([], calls) });
  assert.deepEqual(out, { found: true, path: file, via: "hint" });
  assert.equal(calls.length, 0);
});

test("locate: hints with another name, relative or mismatched content are ignored", async () => {
  const other = await put("Projects/b/other.mov");
  const wrong = await put("Projects/b/clip.mov", randomBytes(data.length));
  const out = await locateOriginal(request({ hints: [other, "clip.mov", wrong] }), {
    home,
    dropsDir,
    runner: runnerReturning([]),
  });
  assert.equal(out.found, false);
});

test("locate: runs mdfind with argv only and a literal query", async () => {
  const calls: string[][] = [];
  await locateOriginal(request({ name: 'we"ird*.mov' }), { home, dropsDir, runner: runnerReturning([], calls) });
  const n = data.length;
  assert.deepEqual(calls, [
    [MDFIND_PATH, "-0", `kMDItemFSName == "we\\"ird\\*.mov" && kMDItemFSSize == ${n}`],
    [MDFIND_PATH, "-0", `kMDItemFSName == "we\\"ird\\*.mov"cd && kMDItemFSSize == ${n}`],
    [MDFIND_PATH, "-0", 'kMDItemFSName == "we\\"ird\\*.mov"'],
  ]);
});

const SCREENSHOT = "Screenshot 2026-09-30 at 10.57.50\u202fPM.png";

test("spotlightQuery passes U+202F (macOS screenshot names) through untouched", () => {
  const q = spotlightQuery(SCREENSHOT);
  assert.equal(q, `kMDItemFSName == "${SCREENSHOT}"`);
  assert.ok(q.includes("\u202f"));
  assert.ok(!q.includes("50 PM"));
  assert.deepEqual(spotlightQueries(SCREENSHOT, 48502), [
    `${q} && kMDItemFSSize == 48502`,
    `${q}cd && kMDItemFSSize == 48502`,
    q,
  ]);
  assert.throws(() => spotlightQuery(SCREENSHOT, "", -1), /size/);
});

test("spotlightQueries: exact, then NFC/NFD variants when different, then cd", () => {
  const nfc = "caf\u00e9 \"1\".txt";
  const nfd = "cafe\u0301 \"1\".txt";
  const sz = " && kMDItemFSSize == 9";
  assert.deepEqual(spotlightQueries(nfd, 9), [
    `kMDItemFSName == "cafe\u0301 \\"1\\".txt"${sz}`,
    `kMDItemFSName == "caf\u00e9 \\"1\\".txt"${sz}`,
    `kMDItemFSName == "cafe\u0301 \\"1\\".txt"cd${sz}`,
    'kMDItemFSName == "cafe\u0301 \\"1\\".txt"',
  ]);
  assert.deepEqual(spotlightQueries(nfc, 9), [
    `kMDItemFSName == "caf\u00e9 \\"1\\".txt"${sz}`,
    `kMDItemFSName == "cafe\u0301 \\"1\\".txt"${sz}`,
    `kMDItemFSName == "caf\u00e9 \\"1\\".txt"cd${sz}`,
    'kMDItemFSName == "caf\u00e9 \\"1\\".txt"',
  ]);
});

test("locate: finds a screenshot whose name has U+202F, verified by content", async () => {
  const shot = await put(`Desktop/${SCREENSHOT}`);
  const calls: string[][] = [];
  const runner: CommandRunner = async (file, args) => {
    calls.push([file, ...args]);
    return args[1] === `kMDItemFSName == "${SCREENSHOT}" && kMDItemFSSize == ${data.length}` ? `${shot}\0` : "";
  };
  const out = await locateOriginal(request({ name: SCREENSHOT }), { home, dropsDir, runner });
  assert.deepEqual(out, { found: true, path: shot, via: "spotlight" });
  assert.equal(calls.length, 1);
});

test("locate: a decomposed name on disk matches a composed dropped name via the NFD query", async () => {
  const onDisk = await put("Docs/cafe\u0301.mov");
  const runner: CommandRunner = async (_file, args) =>
    args[1]!.startsWith('kMDItemFSName == "cafe\u0301.mov" ') ? `${onDisk}\0` : "";
  const out = await locateOriginal(request({ name: "caf\u00e9.mov" }), { home, dropsDir, runner });
  assert.deepEqual(out, { found: true, path: onDisk, via: "spotlight" });
});

test("locate: the cd query accepts case differences but still requires the fingerprint", async () => {
  const upper = await put("Docs/CLIP.MOV");
  const wrong = await put("Docs2/Clip.Mov", randomBytes(data.length));
  const runner: CommandRunner = async (_file, args) => (args[1]!.includes('"cd') ? `${wrong}\0${upper}\0` : "");
  const out = await locateOriginal(request(), { home, dropsDir, runner });
  assert.deepEqual(out, { found: true, path: upper, via: "spotlight" });
});

test("locate: Spotlight candidates are verified by size and fingerprint", async () => {
  const good = await put("Downloads/clip.mov");
  const sameSizeDifferent = await put("Desktop/clip.mov", randomBytes(data.length));
  const smaller = await put("Documents/clip.mov", data.subarray(1));
  const out = await locateOriginal(request(), {
    home,
    dropsDir,
    runner: runnerReturning([sameSizeDifferent, smaller, good, "/nonexistent/clip.mov"]),
  });
  assert.deepEqual(out, { found: true, path: good, via: "spotlight" });
});

test("locate: excluded folders, outside home and other names are never returned", async () => {
  const lib = await put("Library/Caches/clip.mov");
  const trash = await put(".Trash/clip.mov");
  const drop = await put(".bb/plugins/composer-dropzone/drops/temp/2026-01-01/x-clip.mov");
  const renamed = await put("Projects/c/clip-copy.mov");
  const out = await locateOriginal(request(), {
    home,
    dropsDir,
    runner: runnerReturning([lib, trash, drop, renamed]),
  });
  assert.equal(out.found, false);
});

test("locate: symlinks resolve to the real file, which must itself be allowed", async () => {
  const hidden = await put("Library/Caches/real/clip.mov");
  const linkDir = path.join(home, "Projects", "links");
  await fs.mkdir(linkDir, { recursive: true });
  const link = path.join(linkDir, "clip.mov");
  await fs.symlink(hidden, link);
  const refused = await locateOriginal(request(), { home, dropsDir, runner: runnerReturning([link]) });
  assert.equal(refused.found, false);

  const real = await put("Projects/real/clip.mov");
  const link2Dir = path.join(home, "Projects", "links2");
  await fs.mkdir(link2Dir, { recursive: true });
  const link2 = path.join(link2Dir, "clip.mov");
  await fs.symlink(real, link2);
  const ok = await locateOriginal(request({ hints: [link2] }), { home, dropsDir, runner: runnerReturning([]) });
  assert.deepEqual(ok, { found: true, path: real, via: "hint" });
});

test("locate: several matches prefer mtime match, then newest", async () => {
  const when = new Date("2026-03-01T10:00:00Z");
  const older = await put("M/old/clip.mov", data, new Date("2025-01-01T00:00:00Z"));
  const exact = await put("M/exact/clip.mov", data, when);
  const newer = await put("M/newer/clip.mov", data, new Date("2026-06-01T00:00:00Z"));
  const runner = runnerReturning([older, newer, exact]);
  const withTime = await locateOriginal(request({ lastModified: when.getTime() + 1500 }), { home, dropsDir, runner });
  assert.equal(withTime.found && withTime.path, exact);
  const noTime = await locateOriginal(request({ lastModified: 0 }), { home, dropsDir, runner });
  assert.equal(noTime.found && noTime.path, newer);
});

test("locate: a failing or empty Spotlight returns not-found with a reason", async () => {
  const failing: CommandRunner = async () => {
    throw new Error("timeout");
  };
  assert.deepEqual(await locateOriginal(request(), { home, dropsDir, runner: failing }), {
    found: false,
    reason: "Spotlight search failed.",
  });
  const empty = await locateOriginal(request({ name: "nothing.bin" }), { home, dropsDir, runner: runnerReturning([]) });
  assert.equal(empty.found, false);
});

test("locate: bad names are refused before any search", async () => {
  const calls: string[][] = [];
  const out = await locateOriginal(request({ name: "a\0b" }), { home, dropsDir, runner: runnerReturning([], calls) });
  assert.equal(out.found, false);
  assert.equal(calls.length, 0);
});

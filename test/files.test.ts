import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentTypeFor,
  basenameOf,
  displayPath,
  formatBytes,
  hintsForName,
  IMAGE_ATTACHMENT_MAX_BYTES,
  mimeFromName,
  pathsFromUriList,
  safeFileName,
} from "../lib/files.ts";

test("safeFileName keeps ordinary names", () => {
  assert.equal(safeFileName("clip 01.mp4"), "clip 01.mp4");
});

test("safeFileName strips directories and traversal", () => {
  assert.equal(safeFileName("../../.ssh/authorized_keys"), "authorized_keys");
  assert.equal(safeFileName("C:\\Users\\x\\a.txt"), "a.txt");
  assert.equal(safeFileName(".."), "file");
});

test("safeFileName removes leading dots and unsafe characters", () => {
  assert.equal(safeFileName(".zshrc"), "zshrc");
  assert.equal(safeFileName("a\u0000b:c*d?.png"), "a_b_c_d_.png");
  assert.equal(safeFileName("   "), "file");
});

test("safeFileName caps length and keeps the extension", () => {
  const name = safeFileName(`${"x".repeat(300)}.mov`);
  assert.equal(name.length, 120);
  assert.ok(name.endsWith(".mov"));
});

test("attachmentTypeFor: small common images inline, everything else a file", () => {
  assert.equal(attachmentTypeFor("image/png", 1000), "localImage");
  assert.equal(attachmentTypeFor("image/jpeg", IMAGE_ATTACHMENT_MAX_BYTES), "localImage");
  assert.equal(attachmentTypeFor("image/png", IMAGE_ATTACHMENT_MAX_BYTES + 1), "localFile");
  assert.equal(attachmentTypeFor("image/heic", 1000), "localFile");
  assert.equal(attachmentTypeFor("video/mp4", 1000), "localFile");
  assert.equal(attachmentTypeFor(undefined, 1000), "localFile");
});

test("mimeFromName", () => {
  assert.equal(mimeFromName("Clip.MOV"), "video/quicktime");
  assert.equal(mimeFromName("a.png"), "image/png");
  assert.equal(mimeFromName(".png"), undefined);
  assert.equal(mimeFromName("noext"), undefined);
});

test("pathsFromUriList keeps local file URLs only, decoded", () => {
  const list = [
    "# comment",
    "file:///Users/me/My%20Docs/a%22b.txt",
    "file://localhost/Volumes/Disk/c.mov",
    "file://otherhost/x.txt",
    "https://example.com/a.png",
    "file:///bad%E0%A4%A",
    "",
  ].join("\r\n");
  assert.deepEqual(pathsFromUriList(list), ["/Users/me/My Docs/a\"b.txt", "/Volumes/Disk/c.mov"]);
});

test("hintsForName matches by basename, Unicode-normalized, deduped", () => {
  const nfd = "Cafe\u0301.txt";
  const nfc = "Caf\u00e9.txt";
  const hints = hintsForName(nfc, [`/u/${nfd}`, `/u/${nfd}`, "/u/other.txt", `/v/${nfc}`]);
  assert.deepEqual(hints, [`/u/${nfd}`, `/v/${nfc}`]);
  assert.equal(basenameOf("/a/b/c.txt"), "c.txt");
});

test("displayPath shortens the home folder only", () => {
  assert.equal(displayPath("/Users/me/a.txt", "/Users/me"), "~/a.txt");
  assert.equal(displayPath("/Users/meg/a.txt", "/Users/me"), "/Users/meg/a.txt");
  assert.equal(displayPath("/Volumes/X/a", null), "/Volumes/X/a");
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(30 * 1024 * 1024), "30 MB");
});

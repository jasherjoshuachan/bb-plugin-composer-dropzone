import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentLimitFor,
  FILE_ATTACHMENT_MAX_BYTES,
  formatBytes,
  IMAGE_ATTACHMENT_MAX_BYTES,
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

test("attachment limits follow bb's caps", () => {
  assert.equal(attachmentLimitFor("image/png"), IMAGE_ATTACHMENT_MAX_BYTES);
  assert.equal(attachmentLimitFor("video/mp4"), FILE_ATTACHMENT_MAX_BYTES);
  assert.equal(attachmentLimitFor(undefined), FILE_ATTACHMENT_MAX_BYTES);
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(30 * 1024 * 1024), "30 MB");
});

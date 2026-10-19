import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateRejection, isCleanAbsolute, isProtectedPath, sendRejection } from "../lib/paths.ts";

const home = "/Users/me";
const dropsDir = "/Users/me/.bb/plugins/composer-dropzone/drops";
const ctx = { home, dropsDir };

test("candidates: ordinary home files and /Volumes are allowed", () => {
  assert.equal(candidateRejection("/Users/me/Projects/a.txt", ctx), null);
  assert.equal(candidateRejection("/Users/me/Downloads/Telegram Desktop/v.mp4", ctx), null);
  assert.equal(candidateRejection("/Volumes/Backup/clips/a.mov", ctx), null);
});

test("candidates: iCloud Drive and cloud storage under ~/Library are allowed", () => {
  assert.equal(candidateRejection("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/a.pdf", ctx), null);
  assert.equal(candidateRejection("/Users/me/Library/CloudStorage/Dropbox/a.pdf", ctx), null);
});

test("candidates: excluded folders are refused", () => {
  for (const p of [
    "/Users/me/Library/Caches/x.png",
    "/Users/me/Library/Group Containers/tg/x.mp4",
    "/Users/me/library/caches/x.png",
    "/Users/me/.Trash/a.txt",
    "/Users/me/.bb/attachments/a.txt",
    "/Users/me/.bb-file-manager/uploads/a.txt",
    `${dropsDir}/temp/2026-01-01/abc-a.txt`,
  ]) {
    assert.notEqual(candidateRejection(p, ctx), null, p);
  }
});

test("candidates: outside home and bare /Volumes are refused", () => {
  assert.notEqual(candidateRejection("/tmp/a.txt", ctx), null);
  assert.notEqual(candidateRejection("/Users/meg/a.txt", ctx), null);
  assert.notEqual(candidateRejection("/Users/me", ctx), null);
  assert.notEqual(candidateRejection("/Volumes/a.txt", ctx), null);
  assert.notEqual(candidateRejection("/etc/passwd", ctx), null);
});

test("candidates: unclean paths are refused", () => {
  assert.notEqual(candidateRejection("/Users/me/../me/a.txt", ctx), null);
  assert.notEqual(candidateRejection("Users/me/a.txt", ctx), null);
  assert.notEqual(candidateRejection("/Users/me//a.txt", ctx), null);
  assert.notEqual(candidateRejection("/Users/me/a\0.txt", ctx), null);
  assert.equal(isCleanAbsolute("/Users/me/a.txt"), true);
});

test("protected locations", () => {
  for (const p of [
    "/Users/me/.ssh/id_ed25519",
    "/Users/me/.SSH/id_ed25519",
    "/Users/me/.gnupg/a",
    "/Users/me/.aws/credentials",
    "/Users/me/.config/gh/hosts.yml",
    "/Users/me/.claude/settings.json",
    "/Users/me/.claude-work/x.md",
    "/Users/me/.claude.json",
    "/Users/me/.codex/auth.json",
    "/Users/me/.bb/auth.json",
    "/Users/me/.bbrc",
    "/Users/me/.netrc",
    "/Users/me/.npmrc",
    "/Users/me/.git-credentials",
    "/Users/me/Library/Keychains/login.keychain-db",
  ]) {
    assert.equal(isProtectedPath(p, home), true, p);
    assert.notEqual(sendRejection(p, home), null, p);
    assert.notEqual(candidateRejection(p, ctx), null, p);
  }
  assert.equal(isProtectedPath("/Users/me/.config/other/a", home), false);
  assert.equal(isProtectedPath("/Users/me/Projects/.ssh-notes.md", home), false);
  assert.equal(isProtectedPath("/Users/me/Projects/claude.md", home), false);
});

test("sendRejection: absolute paths under home or /Volumes only", () => {
  assert.equal(sendRejection("/Users/me/Desktop/a.png", home), null);
  assert.equal(sendRejection("/Users/me/Library/Application Support/x.txt", home), null);
  assert.equal(sendRejection("/Volumes/Disk/a.mov", home), null);
  assert.match(sendRejection("a.png", home)!, /absolute/);
  assert.match(sendRejection("./a.png", home)!, /absolute/);
  assert.match(sendRejection("/Users/me/x/../.ssh/id", home)!, /absolute/);
  assert.match(sendRejection("/private/etc/hosts", home)!, /home folder/);
});

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { validateSendPath } from "../lib/send.ts";

let home = "";
let outside = "";

before(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dz-send-home-")));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dz-send-out-")));
  await fs.mkdir(path.join(home, "Desktop"), { recursive: true });
  await fs.writeFile(path.join(home, "Desktop", "shot.png"), "png");
  await fs.writeFile(path.join(home, "Desktop", "empty.txt"), "");
  await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
  await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "secret");
  await fs.writeFile(path.join(outside, "x.txt"), "x");
});
after(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test("send: a regular file in home is accepted with size and MIME", async () => {
  const p = path.join(home, "Desktop", "shot.png");
  assert.deepEqual(await validateSendPath(p, home), {
    ok: true,
    item: { path: p, name: "shot.png", sizeBytes: 3, mimeType: "image/png" },
  });
});

test("send: relative paths are refused", async () => {
  const out = await validateSendPath("Desktop/shot.png", home);
  assert.equal(out.ok, false);
});

test("send: missing files, folders and empty files are refused", async () => {
  const missing = await validateSendPath(path.join(home, "Desktop", "nope.png"), home);
  assert.deepEqual(missing, { ok: false, reason: "file not found" });
  const folder = await validateSendPath(path.join(home, "Desktop"), home);
  assert.equal(folder.ok, false);
  assert.match(!folder.ok ? folder.reason : "", /folders/);
  const empty = await validateSendPath(path.join(home, "Desktop", "empty.txt"), home);
  assert.deepEqual(empty, { ok: false, reason: "empty file" });
});

test("send: protected locations and paths outside home are refused", async () => {
  const ssh = await validateSendPath(path.join(home, ".ssh", "id_ed25519"), home);
  assert.equal(ssh.ok, false);
  assert.match(!ssh.ok ? ssh.reason : "", /protected/);
  const out = await validateSendPath(path.join(outside, "x.txt"), home);
  assert.equal(out.ok, false);
});

test("send: a symlink into a protected location is refused", async () => {
  const link = path.join(home, "Desktop", "key-link");
  await fs.symlink(path.join(home, ".ssh", "id_ed25519"), link);
  const out = await validateSendPath(link, home);
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.reason : "", /link target refused/);
  const outLink = path.join(home, "Desktop", "out-link");
  await fs.symlink(path.join(outside, "x.txt"), outLink);
  assert.equal((await validateSendPath(outLink, home)).ok, false);
});

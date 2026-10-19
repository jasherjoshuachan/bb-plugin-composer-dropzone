import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  documentWflow,
  infoPlist,
  quickActionScript,
  QUICK_ACTION_BUNDLE,
  removeQuickAction,
  shellQuote,
  writeQuickAction,
} from "../lib/quickaction.ts";

const isMac = process.platform === "darwin";
const CLI = "/Users/someone/.bb/bin/bb";

test("shellQuote survives quotes and spaces", () => {
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
  const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(`/x y/'$(id)'"\`z\``)}`], { encoding: "utf8" });
  assert.equal(out, `/x y/'$(id)'"\`z\``);
});

test("script passes files as arguments to the absolute CLI and never evals them", () => {
  const script = quickActionScript("/Apps/b b/bb's");
  assert.match(script, /^# composer-dropzone quick action\n/);
  assert.ok(script.includes(`BB='/Apps/b b/bb'\\''s'`));
  assert.ok(script.includes(`"$BB" composer-dropzone send "$@"`));
  assert.throws(() => quickActionScript("bb"), /absolute/);
  assert.throws(() => quickActionScript("/a\nb"), /control/);
});

test("script runs: arguments reach the CLI verbatim; failures notify via argv", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dz-qa-run-"));
  try {
    const fake = path.join(dir, "fake bb");
    const log = path.join(dir, "log");
    await fs.writeFile(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n`, { mode: 0o755 });
    const files = ["/Users/x/a b.txt", "/Users/x/$(touch pwned).png", "/Users/x/-n"];
    const result = spawnSync("/bin/sh", ["-c", quickActionScript(fake), "sh", ...files], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.deepEqual((await fs.readFile(log, "utf8")).trim().split("\n"), ["composer-dropzone", "send", ...files]);
    await assert.rejects(fs.stat(path.join(process.cwd(), "pwned")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("generated plists are XML-escaped", () => {
  const doc = documentWflow("/Apps/<b>&bb");
  assert.ok(doc.includes("/Apps/&lt;b&gt;&amp;bb"));
  assert.ok(doc.includes("&quot;$BB&quot; composer-dropzone send &quot;$@&quot;"));
  assert.ok(infoPlist().includes("<string>Send to bb</string>"));
});

test("Quick Action bundle lints with plutil and installs/removes in a temp Services folder", { skip: !isMac }, async () => {
  const services = await fs.mkdtemp(path.join(os.tmpdir(), "dz-services-"));
  try {
    const bundle = await writeQuickAction(services, CLI);
    assert.equal(bundle, path.join(services, QUICK_ACTION_BUNDLE));
    for (const file of ["Info.plist", "document.wflow"]) {
      const out = execFileSync("/usr/bin/plutil", ["-lint", path.join(bundle, "Contents", file)], { encoding: "utf8" });
      assert.match(out, /OK/);
    }
    const json = execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", path.join(bundle, "Contents", "document.wflow")],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(json);
    const params = parsed.actions[0].action.ActionParameters;
    assert.equal(params.inputMethod, 1);
    assert.equal(params.shell, "/bin/sh");
    assert.equal(params.COMMAND_STRING, quickActionScript(CLI));
    assert.equal(parsed.workflowMetaData.workflowTypeIdentifier, "com.apple.Automator.servicesMenu");
    const info = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(bundle, "Contents", "Info.plist")], {
        encoding: "utf8",
      }),
    );
    assert.equal(info.NSServices[0].NSMenuItem.default, "Send to bb");
    assert.deepEqual(info.NSServices[0].NSSendFileTypes, ["public.item"]);

    // Reinstall replaces our own bundle; a foreign bundle is left alone.
    await writeQuickAction(services, "/other/bb");
    assert.ok((await fs.readFile(path.join(bundle, "Contents", "document.wflow"), "utf8")).includes("/other/bb"));
    assert.equal(await removeQuickAction(services), true);
    assert.equal(await removeQuickAction(services), false);
    await fs.mkdir(path.join(bundle, "Contents"), { recursive: true });
    await fs.writeFile(path.join(bundle, "Contents", "document.wflow"), "<plist/>");
    await assert.rejects(removeQuickAction(services), /wasn't made by Composer Dropzone/);
    await assert.rejects(writeQuickAction(services, CLI), /wasn't made by Composer Dropzone/);
    assert.deepEqual(await fs.readdir(services), [QUICK_ACTION_BUNDLE]);
  } finally {
    await fs.rm(services, { recursive: true, force: true });
  }
});

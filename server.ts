// Composer Dropzone — backend.
//
// Rule: a dropped file that already exists on this Mac takes no extra space.
// - `locate` finds the original by name (drag path hints, then Spotlight) and
//   proves it by size and content fingerprint; the app attaches it by path.
// - Anything else (file promises from chat apps, Photos, Mail, browsers, and
//   pasted screenshots) streams here once in base64 chunks and is kept as one
//   temporary copy under <plugin dir>/drops/temp/<date>/, deleted after
//   `tempRetentionDays` and held under `tempCapMb`.
// - `bb composer-dropzone send <path>…` (and the Finder Quick Action that
//   calls it) hands explicit files to the open composer.
//
// Writes happen only inside the plugin's drops folder and, when the user runs
// `install-quick-action`, ~/Library/Services/Send to bb.workflow. Reads touch
// only candidate files whose name matches the dropped file, and files the user
// sends. No network calls; child processes run with argv only, never a shell.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliCommand, defineCli, defineRpcContract, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHUNK_BYTES, daysLabel, displayPath, formatBytes, safeFileName } from "./lib/files";
import { locateOriginal } from "./lib/locate";
import { removeQuickAction, writeQuickAction } from "./lib/quickaction";
import { validateSendPath } from "./lib/send";
import { DAY_MS, HOUR_MS, scanTempStore, summarize, sweepTempStore } from "./lib/tempstore";

const MB = 1024 * 1024;
const SESSION_IDLE_MS = HOUR_MS;
const PENDING_KEY = "pendingSends";
const PENDING_MAX = 50;
const PENDING_TTL_MS = HOUR_MS;
const SEND_CHANNEL = "send";
const HEX64 = /^[0-9a-f]{64}$/;

const sendItem = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  sizeBytes: z.number(),
  mimeType: z.string().optional(),
  at: z.number(),
});
type PendingSend = z.infer<typeof sendItem>;

export const rpcContract = defineRpcContract({
  config: {
    input: z.null(),
    output: z.object({
      hostId: z.string().nullable(),
      home: z.string(),
      tempRetentionDays: z.number(),
      maxTempFileBytes: z.number(),
    }),
  },
  locate: {
    input: z
      .object({
        name: z.string().min(1).max(1024),
        sizeBytes: z.number().int().positive(),
        lastModified: z.number().nonnegative(),
        samples: z.array(z.string().regex(HEX64)).min(1).max(3),
        hints: z.array(z.string().max(4096)).max(8),
      })
      .strict(),
    output: z.union([
      z.object({ found: z.literal(true), path: z.string(), hostId: z.string(), via: z.enum(["hint", "spotlight"]) }),
      z.object({ found: z.literal(false), reason: z.string() }),
    ]),
  },
  begin: {
    input: z
      .object({
        name: z.string().min(1).max(1024),
        sizeBytes: z.number().int().positive(),
      })
      .strict(),
    output: z.object({ uploadId: z.string() }),
  },
  chunk: {
    input: z
      .object({
        uploadId: z.string().uuid(),
        offset: z.number().int().nonnegative(),
        data: z.string().max(Math.ceil(CHUNK_BYTES / 3) * 4 + 4),
      })
      .strict(),
    output: z.object({ received: z.number() }),
  },
  finish: {
    input: z.object({ uploadId: z.string().uuid() }).strict(),
    output: z.object({
      path: z.string(),
      name: z.string(),
      sizeBytes: z.number(),
      hostId: z.string().nullable(),
      retentionDays: z.number(),
    }),
  },
  abort: {
    input: z.object({ uploadId: z.string().uuid() }).strict(),
    output: z.object({ aborted: z.boolean() }),
  },
  claimSends: {
    input: z.null(),
    output: z.object({ hostId: z.string().nullable(), items: z.array(sendItem) }),
  },
});

interface UploadSession {
  handle: fs.FileHandle;
  tempPath: string;
  name: string;
  expected: number;
  received: number;
  touchedAt: number;
  busy: boolean;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    tempRetentionDays: {
      type: "number",
      label: "Delete temporary copies after (days)",
      description:
        "Items that aren't files on this Mac (chat-app drags, pasted screenshots) are copied once and deleted after this many days.",
      default: 2,
      experimental_schema: z.number().int().min(1).max(30),
    },
    tempCapMb: {
      type: "number",
      label: "Temporary copies size cap (MB)",
      description: "Over this total, the oldest copies are deleted first. Copies younger than 24 hours are always kept.",
      default: 1024,
      experimental_schema: z.number().int().min(64).max(102400),
    },
    maxTempFileMb: {
      type: "number",
      label: "Largest item to copy (MB)",
      description: "Files that exist on this Mac are linked, not copied, and have no size limit.",
      default: 4096,
      experimental_schema: z.number().int().min(1).max(20480),
    },
  });

  // The plugin's own folder (<dataDir>/plugins/<id>/) is where bb keeps its
  // SQLite file, so drops live beside it and go away with `bb plugin remove`.
  const pluginDir = path.dirname(bb.storage.database().name);
  const dataDir = path.dirname(path.dirname(pluginDir));
  const dropsDir = path.join(pluginDir, "drops");
  const partialDir = path.join(dropsDir, ".partial");
  const home = os.homedir();
  const sessions = new Map<string, UploadSession>();

  async function hostId(): Promise<string | null> {
    try {
      return (await bb.sdk.system.config()).primaryHostId ?? null;
    } catch {
      return null;
    }
  }

  async function policy() {
    const { tempRetentionDays, tempCapMb } = await settings.get();
    return { now: Date.now(), retentionMs: tempRetentionDays * DAY_MS, capBytes: tempCapMb * MB };
  }

  async function closeSession(id: string, removeTemp: boolean): Promise<void> {
    const session = sessions.get(id);
    if (session === undefined) return;
    sessions.delete(id);
    await session.handle.close().catch(() => undefined);
    if (removeTemp) await fs.rm(session.tempPath, { force: true });
  }

  function sessionFor(id: string): UploadSession {
    const session = sessions.get(id);
    if (session === undefined) throw new Error("Upload not found or expired. Drop the file again.");
    return session;
  }

  // Pending Finder sends: one lock so a claim and a send never interleave.
  let pendingLock: Promise<unknown> = Promise.resolve();
  function withPending<T>(fn: (items: PendingSend[]) => Promise<{ next: PendingSend[]; result: T }>): Promise<T> {
    const run = pendingLock.then(async () => {
      const stored = (await bb.storage.kv.get<PendingSend[]>(PENDING_KEY)) ?? [];
      const fresh = stored.filter((item) => Date.now() - item.at < PENDING_TTL_MS);
      const { next, result } = await fn(fresh);
      if (next.length === 0) await bb.storage.kv.delete(PENDING_KEY);
      else await bb.storage.kv.set(PENDING_KEY, next.slice(-PENDING_MAX));
      return result;
    });
    pendingLock = run.catch(() => undefined);
    return run;
  }

  bb.rpc.register(rpcContract, {
    config: async () => {
      const { tempRetentionDays, maxTempFileMb } = await settings.get();
      return { hostId: await hostId(), home, tempRetentionDays, maxTempFileBytes: maxTempFileMb * MB };
    },

    locate: async (input) => {
      const outcome = await locateOriginal(input, { home, dropsDir });
      if (!outcome.found) return outcome;
      const host = await hostId();
      if (host === null) return { found: false as const, reason: "This bb server has no local machine to link files on." };
      return { found: true as const, path: outcome.path, hostId: host, via: outcome.via };
    },

    begin: async ({ name, sizeBytes }) => {
      const { maxTempFileMb } = await settings.get();
      if (sizeBytes > maxTempFileMb * MB) {
        throw new Error(
          `${formatBytes(sizeBytes)} is over the ${formatBytes(maxTempFileMb * MB)} limit for temporary copies (setting maxTempFileMb).`,
        );
      }
      await fs.mkdir(partialDir, { recursive: true, mode: 0o700 });
      const uploadId = randomUUID();
      const tempPath = path.join(partialDir, uploadId);
      const handle = await fs.open(tempPath, "wx", 0o600);
      sessions.set(uploadId, {
        handle,
        tempPath,
        name: safeFileName(name),
        expected: sizeBytes,
        received: 0,
        touchedAt: Date.now(),
        busy: false,
      });
      return { uploadId };
    },

    chunk: async ({ uploadId, offset, data }) => {
      const session = sessionFor(uploadId);
      if (session.busy) throw new Error("Chunks must be sent one at a time.");
      if (offset !== session.received) {
        throw new Error(`Expected offset ${session.received}, got ${offset}.`);
      }
      const bytes = Buffer.from(data, "base64");
      if (bytes.length === 0 || bytes.length > CHUNK_BYTES) throw new Error("Bad chunk size.");
      if (session.received + bytes.length > session.expected) {
        await closeSession(uploadId, true);
        throw new Error("File is larger than announced.");
      }
      session.busy = true;
      try {
        await session.handle.write(bytes, 0, bytes.length, offset);
      } finally {
        session.busy = false;
      }
      session.received += bytes.length;
      session.touchedAt = Date.now();
      return { received: session.received };
    },

    finish: async ({ uploadId }) => {
      const session = sessionFor(uploadId);
      if (session.received !== session.expected) {
        throw new Error(`Upload incomplete: ${session.received} of ${session.expected} bytes.`);
      }
      await session.handle.sync();
      await session.handle.close();
      sessions.delete(uploadId);
      const day = new Date().toISOString().slice(0, 10);
      const dayDir = path.join(dropsDir, "temp", day);
      await fs.mkdir(dayDir, { recursive: true, mode: 0o700 });
      // A short unique prefix keeps two drops of the same name apart.
      const finalPath = path.join(dayDir, `${uploadId.slice(0, 8)}-${session.name}`);
      await fs.rename(session.tempPath, finalPath);
      bb.log.info(`saved ${formatBytes(session.expected)} temporary copy`);
      // Enforce the cap now; the new copy is younger than 24 h, so it stays.
      void policy()
        .then((p) => sweepTempStore(dropsDir, p))
        .catch((cause) => bb.log.warn(`cap sweep failed: ${String(cause)}`));
      const { tempRetentionDays } = await settings.get();
      return {
        path: finalPath,
        name: session.name,
        sizeBytes: session.expected,
        hostId: await hostId(),
        retentionDays: tempRetentionDays,
      };
    },

    abort: async ({ uploadId }) => {
      const existed = sessions.has(uploadId);
      await closeSession(uploadId, true);
      return { aborted: existed };
    },

    claimSends: async () => {
      const items = await withPending(async (pending) => {
        const ready: PendingSend[] = [];
        for (const item of pending) {
          // Re-check: the file may have moved since it was sent.
          const checked = await validateSendPath(item.path, home);
          if (checked.ok) ready.push({ ...item, ...checked.item });
        }
        return { next: [], result: ready };
      });
      return { hostId: await hostId(), items };
    },
  });

  async function resolveCli(override: string | undefined): Promise<string> {
    const candidates = [
      override,
      process.env.BB_CLI?.trim(),
      path.join(process.env.BB_DATA_DIR?.trim() || dataDir, "bin", "bb"),
    ].filter((value): value is string => typeof value === "string" && value !== "");
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) continue;
      const ok = await fs.access(candidate, fsConstants.X_OK).then(
        () => true,
        () => false,
      );
      if (ok) return candidate;
    }
    throw new PluginCliError("Couldn't find the bb command on this Mac.", {
      hint: "Pass its absolute path with --cli, or set BB_CLI.",
    });
  }

  function refreshServices(): Promise<void> {
    return new Promise((resolve) => {
      execFile("/System/Library/CoreServices/pbs", ["-update"], { timeout: 5000, shell: false }, () => resolve());
    });
  }

  const servicesDir = path.join(home, "Library", "Services");

  bb.cli.register(
    defineCli({
      name: "composer-dropzone",
      summary: "Attach files to the open bb composer, and manage temporary copies.",
      commands: {
        send: cliCommand({
          summary: "Attach files from this Mac to the open composer by path (no copy).",
          positionals: [{ name: "paths", description: "Absolute file paths", required: true, variadic: true }],
          run: async ({ positionals }) => {
            const inputs = positionals.paths as string[];
            if ((await hostId()) === null) {
              throw new PluginCliError("This bb server has no local machine to attach files from.");
            }
            const accepted: PendingSend[] = [];
            const refused: string[] = [];
            for (const input of inputs) {
              const checked = await validateSendPath(input, home);
              if (checked.ok) accepted.push({ id: randomUUID(), at: Date.now(), ...checked.item });
              else refused.push(`${input}: ${checked.reason}`);
            }
            if (accepted.length > 0) {
              await withPending(async (pending) => ({ next: [...pending, ...accepted], result: null }));
              bb.realtime.publish(SEND_CHANNEL, { count: accepted.length });
            }
            const lines: string[] = [];
            if (accepted.length > 0) {
              lines.push(
                `Sent ${accepted.length === 1 ? "1 file" : `${accepted.length} files`} to bb. ` +
                  "They attach to the active composer, or wait up to 1 hour for a bb window.",
              );
            }
            const stderr = refused.length > 0 ? `Refused:\n${refused.map((line) => `  ${line}`).join("\n")}\n` : "";
            return {
              exitCode: refused.length > 0 ? 1 : 0,
              stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
              stderr,
            };
          },
        }),
        status: cliCommand({
          summary: "Show temporary copy storage: size, count, oldest.",
          run: async () => {
            const { tempRetentionDays, tempCapMb } = await settings.get();
            const stats = summarize(await scanTempStore(dropsDir));
            const pending = ((await bb.storage.kv.get<PendingSend[]>(PENDING_KEY)) ?? []).filter(
              (item) => Date.now() - item.at < PENDING_TTL_MS,
            );
            const oldest =
              stats.oldestMtimeMs === null
                ? "none"
                : `${Math.max(0, Math.round((Date.now() - stats.oldestMtimeMs) / HOUR_MS))} h old`;
            return {
              exitCode: 0,
              stdout:
                [
                  `Temporary copies: ${stats.count} (${formatBytes(stats.totalBytes)} of ${formatBytes(tempCapMb * MB)} cap)`,
                  `Oldest: ${oldest}; deleted after ${daysLabel(tempRetentionDays)}`,
                  `Folder: ${displayPath(dropsDir, home)}`,
                  `Finder sends waiting for a bb window: ${pending.length}`,
                ].join("\n") + "\n",
            };
          },
        }),
        "install-quick-action": cliCommand({
          summary: 'Add a "Send to bb" Quick Action to Finder (~/Library/Services).',
          options: { cli: { type: "string", description: "Absolute path of the bb command to call" } },
          run: async ({ options }) => {
            const cli = await resolveCli(options.cli as string | undefined);
            const target = await writeQuickAction(servicesDir, cli);
            await refreshServices();
            return {
              exitCode: 0,
              stdout:
                `Installed ${displayPath(target, home)} (calls ${cli}).\n` +
                'In Finder, right-click files > Quick Actions > Send to bb. If it is missing, enable it in System Settings > Keyboard > Keyboard Shortcuts > Services.\n',
            };
          },
        }),
        "uninstall-quick-action": cliCommand({
          summary: 'Remove the "Send to bb" Quick Action.',
          run: async () => {
            const removed = await removeQuickAction(servicesDir).catch((cause: unknown) => {
              throw new PluginCliError(cause instanceof Error ? cause.message : String(cause));
            });
            if (removed) await refreshServices();
            return { exitCode: 0, stdout: removed ? "Removed the Send to bb Quick Action.\n" : "Not installed.\n" };
          },
        }),
      },
    }),
  );

  async function sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (!session.busy && now - session.touchedAt > SESSION_IDLE_MS) await closeSession(id, true);
    }
    // Orphaned partial files from a crash or reload.
    const partials = await fs.readdir(partialDir).catch(() => [] as string[]);
    for (const entry of partials) {
      if (!sessions.has(entry)) await fs.rm(path.join(partialDir, entry), { force: true });
    }
    const removed = await sweepTempStore(dropsDir, await policy());
    if (removed.length > 0) bb.log.info(`deleted ${removed.length} temporary copies`);
    // Expired Finder sends.
    await withPending(async (pending) => ({ next: pending, result: null }));
  }

  bb.background.schedule("sweep", "23 * * * *", sweep);
  void sweep().catch((cause) => bb.log.warn(`initial sweep failed: ${String(cause)}`));
  bb.onDispose(async () => {
    for (const id of Array.from(sessions.keys())) await closeSession(id, true);
  });
  bb.log.info("loaded");
}

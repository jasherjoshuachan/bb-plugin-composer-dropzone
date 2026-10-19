// Composer Dropzone — backend.
//
// Files under bb's attachment caps go through bb's own upload from the app and
// never touch this server. Larger files (videos, archives) stream here in
// sequential base64 chunks and are written under this plugin's data folder;
// the app then attaches them by absolute path on this machine.
//
// The server only ever writes inside <plugin data dir>/drops, never reads or
// lists anything else, and makes no network calls.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHUNK_BYTES, formatBytes, safeFileName } from "./lib/files";

const MB = 1024 * 1024;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const rpcContract = defineRpcContract({
  config: {
    input: z.null(),
    output: z.object({
      largeFiles: z.boolean(),
      maxFileBytes: z.number(),
      hostId: z.string().nullable(),
    }),
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
    }),
  },
  abort: {
    input: z.object({ uploadId: z.string().uuid() }).strict(),
    output: z.object({ aborted: z.boolean() }),
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
    largeFiles: {
      type: "boolean",
      label: "Accept files larger than bb's attachment limit",
      description:
        "Files over 10 MB (images) or 25 MB (other files) are saved on this machine and attached by path.",
      default: true,
    },
    maxFileMb: {
      type: "number",
      label: "Largest file to accept (MB)",
      default: 2048,
      experimental_schema: z.number().int().min(25).max(20480),
    },
    retentionDays: {
      type: "number",
      label: "Delete saved large files after (days)",
      default: 14,
      experimental_schema: z.number().int().min(1).max(365),
    },
  });

  // The plugin's own folder (<dataDir>/plugins/<id>/) is where bb keeps its
  // SQLite file, so drops live beside it and go away with `bb plugin remove`.
  const pluginDir = path.dirname(bb.storage.database().name);
  const dropsDir = path.join(pluginDir, "drops");
  const partialDir = path.join(dropsDir, ".partial");
  const sessions = new Map<string, UploadSession>();

  async function hostId(): Promise<string | null> {
    try {
      return (await bb.sdk.system.config()).primaryHostId ?? null;
    } catch {
      return null;
    }
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

  bb.rpc.register(rpcContract, {
    config: async () => {
      const { largeFiles, maxFileMb } = await settings.get();
      return { largeFiles, maxFileBytes: maxFileMb * MB, hostId: await hostId() };
    },

    begin: async ({ name, sizeBytes }) => {
      const { largeFiles, maxFileMb } = await settings.get();
      if (!largeFiles) throw new Error("Large-file drops are turned off in Composer Dropzone settings.");
      if (sizeBytes > maxFileMb * MB) {
        throw new Error(
          `${formatBytes(sizeBytes)} is over the ${formatBytes(maxFileMb * MB)} limit set in Composer Dropzone settings.`,
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
      const dayDir = path.join(dropsDir, day);
      await fs.mkdir(dayDir, { recursive: true, mode: 0o700 });
      // A short unique prefix keeps two drops of the same name apart.
      const finalPath = path.join(dayDir, `${uploadId.slice(0, 8)}-${session.name}`);
      await fs.rename(session.tempPath, finalPath);
      bb.log.info(`saved ${formatBytes(session.expected)} drop`);
      return { path: finalPath, name: session.name, sizeBytes: session.expected, hostId: await hostId() };
    },

    abort: async ({ uploadId }) => {
      const existed = sessions.has(uploadId);
      await closeSession(uploadId, true);
      return { aborted: existed };
    },
  });

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
    const { retentionDays } = await settings.get();
    const cutoff = now - retentionDays * DAY_MS;
    const days = await fs.readdir(dropsDir).catch(() => [] as string[]);
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (Date.parse(`${day}T23:59:59Z`) < cutoff) {
        await fs.rm(path.join(dropsDir, day), { recursive: true, force: true });
      }
    }
  }

  bb.background.schedule("sweep", "23 * * * *", sweep);
  bb.onDispose(async () => {
    for (const id of Array.from(sessions.keys())) await closeSession(id, true);
  });
  bb.log.info("loaded");
}

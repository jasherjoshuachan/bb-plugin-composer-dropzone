// Composer Dropzone — frontend.
//
// A content script listens for OS file drags and file pastes:
// - a drop on a composer is taken over in the capture phase, so bb's own
//   handler (which uploads permanent copies and hides errors) never sees it;
// - a drop anywhere else in the panel that holds the main composer (the
//   thread timeline, the new-thread page) goes to that composer, unless
//   another drop zone already handled the event;
// - a paste into a composer that carries files is taken over the same way.
//   Plain text pastes are left alone.
// Each composer mounts a hidden bridge banner that registers a receiver with
// its own composer handle, so files always land in the right draft.
//
// For every file the bridge first asks the server to find the original on this
// Mac (proven by a content fingerprint) and attaches it by path: no copy. Only
// when there is no original does it stream one temporary copy to the server.
import { useEffect, useRef } from "react";
import {
  definePluginApp,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type ComposerAttachment,
  type PluginComposerApi,
  type PluginContentScriptContext,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import {
  attachmentTypeFor,
  CHUNK_BYTES,
  daysLabel,
  displayPath,
  formatBytes,
  hintsForName,
  pathsFromUriList,
} from "./lib/files";
import { fingerprintSamples } from "./lib/fingerprint";

type Rpc = PluginRpcClient<typeof rpcContract>;

interface DroppedItem {
  file: File;
  isDirectory: boolean;
  /** Absolute paths the drag offered whose name matches this file. */
  hints: string[];
  source: "drop" | "paste";
}

interface DropReceiver {
  marker: HTMLElement;
  composer: PluginComposerApi;
  focusedAt: number;
  rpc: Rpc;
  receive(items: DroppedItem[], text?: string): void;
}

const receivers = new Set<DropReceiver>();
const ACTIVE_ATTR = "data-composer-dropzone-active";
const STYLE_ID = "composer-dropzone-style";
const PROMPTBOX = "form[data-promptbox]";

function shellOf(marker: Element): Element {
  return marker.closest("[data-promptbox-shell]") ?? marker.parentElement ?? marker;
}

function receiverForForm(form: Element): DropReceiver | null {
  // Banners render beside the form, inside the composer's shell.
  const shell = form.closest("[data-promptbox-shell]") ?? form;
  for (const receiver of receivers) {
    if (receiver.marker.isConnected && shell.contains(receiver.marker)) return receiver;
  }
  return null;
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/** The composer form a drag over `target` belongs to, and whether it is directly over it. */
function targetComposer(target: EventTarget | null): { form: Element; direct: boolean } | null {
  if (!(target instanceof Element)) return null;
  const direct = target.closest(PROMPTBOX);
  if (direct !== null) return { form: direct, direct: true };
  const panel = target.closest("[data-panel]");
  if (panel === null) return null;
  const form = panel.querySelector(`[data-app-composer-role="primary"] ${PROMPTBOX}`);
  if (form === null) return null;
  // Only when the composer belongs to this panel, not a nested one.
  if (form.closest("[data-panel]") !== panel) return null;
  return { form, direct: false };
}

/** Path hints a drag may carry: `text/uri-list` file URLs and Electron's non-standard `File.path`. */
function dragHints(transfer: DataTransfer, files: File[]): string[] {
  const hints: string[] = [];
  try {
    hints.push(...pathsFromUriList(transfer.getData("text/uri-list") ?? ""));
  } catch {
    // Not readable outside a drop; hints are optional.
  }
  for (const file of files) {
    const legacy = (file as File & { path?: unknown }).path;
    if (typeof legacy === "string" && legacy.startsWith("/")) hints.push(legacy);
  }
  return hints;
}

function collectItems(transfer: DataTransfer | null, source: DroppedItem["source"]): DroppedItem[] {
  if (transfer === null) return [];
  const entries = Array.from(transfer.items ?? []).filter((item) => item.kind === "file");
  const files = Array.from(transfer.files ?? []);
  const hints = source === "drop" ? dragHints(transfer, files) : [];
  return files.map((file, index) => {
    const entry = entries[index]?.webkitGetAsEntry?.() ?? null;
    return { file, isDirectory: entry?.isDirectory === true, hints: hintsForName(file.name, hints), source };
  });
}

/** Text that came with pasted files, unless it is just their names (Finder copies put names on the clipboard). */
function pastedText(transfer: DataTransfer, files: File[]): string {
  const text = transfer.getData("text/plain") ?? "";
  if (text.trim() === "") return "";
  const names = new Set(files.map((file) => file.name));
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.every((line) => names.has(line) || names.has(line.split("/").pop() ?? "")) ? "" : text;
}

function mountDropzone({ signal }: PluginContentScriptContext): () => void {
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `${PROMPTBOX}[${ACTIVE_ATTR}]{outline:2px dashed color-mix(in oklab, currentColor 55%, transparent);outline-offset:3px;}`;
    document.head.appendChild(style);
  }

  let highlighted: Element | null = null;
  let clearTimer: number | undefined;
  const highlight = (form: Element | null) => {
    window.clearTimeout(clearTimer);
    if (highlighted !== form) {
      highlighted?.removeAttribute(ACTIVE_ATTR);
      form?.setAttribute(ACTIVE_ATTR, "");
      highlighted = form;
    }
    // dragleave is unreliable across nested elements; expire instead.
    if (form !== null) clearTimer = window.setTimeout(() => highlight(null), 200);
  };

  const deliver = (event: DragEvent, form: Element) => {
    const receiver = receiverForForm(form);
    if (receiver === null) return false;
    event.preventDefault();
    event.stopPropagation();
    highlight(null);
    const items = collectItems(event.dataTransfer, "drop");
    if (items.length === 0) {
      toast.error("No file came through", {
        description: "The app you dragged from didn't hand over a file. Save it to disk, then drop it from Finder.",
      });
      return true;
    }
    receiver.focusedAt = Date.now();
    receiver.receive(items);
    return true;
  };

  // Capture phase: drags and drops directly on a composer.
  const onCaptureDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    const hit = targetComposer(event.target);
    if (hit === null || !hit.direct || receiverForForm(hit.form) === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    highlight(hit.form);
  };
  const onCaptureDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    const hit = targetComposer(event.target);
    if (hit === null || !hit.direct) return;
    deliver(event, hit.form);
  };

  // Bubble phase on window: the rest of the composer's panel, if unclaimed.
  const onBubbleDragOver = (event: DragEvent) => {
    if (!isFileDrag(event) || event.defaultPrevented) return;
    const hit = targetComposer(event.target);
    if (hit === null || receiverForForm(hit.form) === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    highlight(hit.form);
  };
  const onBubbleDrop = (event: DragEvent) => {
    if (!isFileDrag(event) || event.defaultPrevented) return;
    const hit = targetComposer(event.target);
    if (hit === null) return;
    deliver(event, hit.form);
  };

  // Capture phase: pastes into a composer that carry files.
  const onCapturePaste = (event: ClipboardEvent) => {
    const transfer = event.clipboardData;
    if (transfer === null || (transfer.files?.length ?? 0) === 0) return;
    if (!(event.target instanceof Element)) return;
    const form = event.target.closest(PROMPTBOX);
    if (form === null) return;
    const receiver = receiverForForm(form);
    if (receiver === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const items = collectItems(transfer, "paste");
    receiver.focusedAt = Date.now();
    receiver.receive(items, pastedText(transfer, Array.from(transfer.files)));
  };

  // Remember which composer was used last, for Finder sends.
  const onFocusIn = (event: FocusEvent) => {
    if (!(event.target instanceof Element)) return;
    const form = event.target.closest(PROMPTBOX);
    if (form === null) return;
    const receiver = receiverForForm(form);
    if (receiver !== null) receiver.focusedAt = Date.now();
  };

  document.addEventListener("dragover", onCaptureDragOver, true);
  document.addEventListener("drop", onCaptureDrop, true);
  document.addEventListener("paste", onCapturePaste, true);
  document.addEventListener("focusin", onFocusIn, true);
  window.addEventListener("dragover", onBubbleDragOver);
  window.addEventListener("drop", onBubbleDrop);

  const cleanup = () => {
    document.removeEventListener("dragover", onCaptureDragOver, true);
    document.removeEventListener("drop", onCaptureDrop, true);
    document.removeEventListener("paste", onCapturePaste, true);
    document.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("dragover", onBubbleDragOver);
    window.removeEventListener("drop", onBubbleDrop);
    highlight(null);
    window.clearTimeout(clearTimer);
    document.getElementById(STYLE_ID)?.remove();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}

/** base64 of a Blob without building a giant string by hand. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fingerprintBlob(file: File): Promise<string[]> {
  return fingerprintSamples(file.size, async (offset, length) =>
    new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  );
}

function addAttachments(composer: PluginComposerApi, attached: ComposerAttachment[]): void {
  composer.replace((current) => {
    const known = new Set(current.attachments.map((item) => item.path));
    const added = attached.filter((item) => !known.has(item.path));
    if (added.length === 0) return current;
    return { text: current.text, mentions: current.mentions, attachments: [...current.attachments, ...added] };
  });
}

function isVisible(element: Element): boolean {
  const shell = shellOf(element);
  return shell.isConnected && shell.getClientRects().length > 0;
}

/** Where Finder sends go: the most recently used visible composer, else the primary one, else any. */
function sendTarget(): DropReceiver | null {
  const live = Array.from(receivers).filter((receiver) => receiver.marker.isConnected);
  const visible = live.filter((receiver) => isVisible(receiver.marker));
  const pool = visible.length > 0 ? visible : live;
  const focused = pool.filter((receiver) => receiver.focusedAt > 0).sort((a, b) => b.focusedAt - a.focusedAt)[0];
  if (focused !== undefined) return focused;
  const primary = pool.find(
    (receiver) => shellOf(receiver.marker).closest('[data-app-composer-role="primary"]') !== null,
  );
  return primary ?? pool[0] ?? null;
}

let claiming: Promise<void> | null = null;

/** Take pending Finder sends from the server (once per window) and attach them. */
function claimFinderSends(): void {
  if (claiming !== null || document.visibilityState !== "visible") return;
  const target = sendTarget();
  if (target === null) return;
  claiming = (async () => {
    try {
      const { hostId, items } = await target.rpc.call("claimSends", null);
      if (items.length === 0) return;
      if (hostId === null) {
        toast.error("Couldn't attach files sent from Finder", { description: "This bb server has no local machine." });
        return;
      }
      const config = await target.rpc.call("config", null).catch(() => null);
      const attachments: ComposerAttachment[] = items.map((item) => ({
        type: attachmentTypeFor(item.mimeType, item.sizeBytes),
        path: item.path,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        hostId,
      }));
      const into = sendTarget() ?? target;
      try {
        addAttachments(into.composer, attachments);
        into.composer.focus();
      } catch (cause) {
        toast.error("Couldn't add files sent from Finder", {
          description: `${items.map((item) => item.name).join(", ")}: ${errorMessage(cause)}`,
        });
        return;
      }
      for (const item of items) {
        toast.success("Linked original", {
          description: `${item.name} (sent from Finder): ${displayPath(item.path, config?.home ?? null)}`,
        });
      }
    } catch (cause) {
      toast.error("Couldn't fetch files sent from Finder", { description: errorMessage(cause) });
    } finally {
      claiming = null;
    }
  })();
}

function DropzoneBridge() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const markerRef = useRef<HTMLSpanElement>(null);

  useRealtime("send", () => claimFinderSends());
  useEffect(() => {
    if (connection === "connected") claimFinderSends();
  }, [connection]);

  useEffect(() => {
    const marker = markerRef.current;
    if (marker === null) return;

    const tempCopy = async (
      file: File,
      toastId: string | number,
      config: { maxTempFileBytes: number; hostId: string | null },
    ): Promise<{ attachment: ComposerAttachment; retentionDays: number }> => {
      if (config.hostId === null) throw new Error("This bb server has no local machine to save files on.");
      if (file.size > config.maxTempFileBytes) {
        throw new Error(
          `${formatBytes(file.size)} is over the ${formatBytes(config.maxTempFileBytes)} limit for temporary copies in settings.`,
        );
      }
      const { uploadId } = await rpc.call("begin", { name: file.name, sizeBytes: file.size });
      try {
        for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
          const data = await blobToBase64(file.slice(offset, offset + CHUNK_BYTES));
          await rpc.call("chunk", { uploadId, offset, data });
          const done = Math.min(offset + CHUNK_BYTES, file.size);
          toast.loading(`Copying ${file.name}`, {
            id: toastId,
            description: `${formatBytes(done)} of ${formatBytes(file.size)}`,
          });
        }
        const saved = await rpc.call("finish", { uploadId });
        const mimeType = file.type || undefined;
        return {
          attachment: {
            type: attachmentTypeFor(mimeType, saved.sizeBytes),
            path: saved.path,
            name: file.name,
            mimeType,
            sizeBytes: saved.sizeBytes,
            hostId: saved.hostId ?? config.hostId,
          },
          retentionDays: saved.retentionDays,
        };
      } catch (cause) {
        await rpc.call("abort", { uploadId }).catch(() => undefined);
        throw cause;
      }
    };

    const attachOne = async (
      item: DroppedItem,
      config: { hostId: string | null; home: string; maxTempFileBytes: number },
    ): Promise<ComposerAttachment | null> => {
      const { file } = item;
      const mimeType = file.type || undefined;
      const toastId = toast.loading(`Looking for ${file.name} on this Mac`, { description: formatBytes(file.size) });
      let reason: string;
      try {
        const samples = await fingerprintBlob(file);
        const found = await rpc.call("locate", {
          name: file.name,
          sizeBytes: file.size,
          lastModified: Math.max(0, file.lastModified || 0),
          samples,
          hints: item.hints,
        });
        if (found.found) {
          toast.success("Linked original", {
            id: toastId,
            description: `${file.name}: ${displayPath(found.path, config.home)}. No copy made.`,
          });
          return {
            type: attachmentTypeFor(mimeType, file.size),
            path: found.path,
            name: file.name,
            mimeType,
            sizeBytes: file.size,
            hostId: found.hostId,
          };
        }
        reason = found.reason;
      } catch (cause) {
        reason = `Couldn't check for a local file (${errorMessage(cause)}).`;
      }
      if (item.source === "paste") reason = `Pasted item. ${reason}`;
      try {
        const { attachment, retentionDays } = await tempCopy(file, toastId, config);
        toast.success(`Temporary copy — deleted in ${daysLabel(retentionDays)}`, {
          id: toastId,
          description: `${file.name}. ${reason}`,
        });
        return attachment;
      } catch (cause) {
        toast.error(`Couldn't attach ${file.name}`, { id: toastId, description: errorMessage(cause) });
        return null;
      }
    };

    const attachAll = async (items: DroppedItem[], text?: string) => {
      const attached: ComposerAttachment[] = [];
      const skipped: string[] = [];
      let config: { hostId: string | null; home: string; maxTempFileBytes: number };
      try {
        config = await rpc.call("config", null);
      } catch (cause) {
        toast.error("Composer Dropzone isn't reachable", { description: errorMessage(cause) });
        return;
      }
      if (text !== undefined && text !== "") {
        try {
          composer.insert(text);
        } catch {
          composer.insert(text, { at: "end" });
        }
      }
      for (const item of items) {
        if (item.isDirectory) {
          skipped.push(`${item.file.name} (folder)`);
          continue;
        }
        if (item.file.size === 0) {
          skipped.push(`${item.file.name} (empty)`);
          continue;
        }
        const attachment = await attachOne(item, config);
        if (attachment !== null) attached.push(attachment);
      }
      if (attached.length > 0) {
        try {
          addAttachments(composer, attached);
          composer.focus();
        } catch (cause) {
          toast.error("Couldn't add the files to this message", { description: errorMessage(cause) });
        }
      }
      if (skipped.length > 0) {
        toast.warning(`Skipped ${skipped.length === 1 ? "1 item" : `${skipped.length} items`}`, {
          description: skipped.join(", "),
        });
      }
    };

    const receiver: DropReceiver = {
      marker,
      composer,
      focusedAt: 0,
      rpc,
      receive: (items, text) => {
        void attachAll(items, text);
      },
    };
    receivers.add(receiver);
    // Deliver Finder sends that arrived while no bb window was open.
    const onVisible = () => claimFinderSends();
    document.addEventListener("visibilitychange", onVisible);
    claimFinderSends();
    return () => {
      receivers.delete(receiver);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [composer, rpc]);

  return <span ref={markerRef} hidden aria-hidden="true" data-composer-dropzone-bridge="" />;
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "composer-dropzone", mount: mountDropzone });
  app.composer.customize({
    id: "composer-dropzone-bridge",
    banners: [{ id: "composer-dropzone-bridge", chrome: "bare", component: DropzoneBridge }],
  });
});

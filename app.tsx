// Composer Dropzone — frontend.
//
// A content script listens for OS file drags on the whole document:
// - a drop on a composer is taken over in the capture phase, so bb's own
//   handler (which hides upload errors) and the editor never see it;
// - a drop anywhere else in the panel that holds the main composer (the
//   thread timeline, the new-thread page) goes to that composer, unless
//   another drop zone already handled the event.
// Each composer mounts a hidden bridge banner that registers a receiver with
// its own composer handle, so files always land in the right draft.
import { useEffect, useRef } from "react";
import {
  definePluginApp,
  useComposer,
  useRpc,
  useSdk,
  type ComposerAttachment,
  type PluginComposerApi,
  type PluginContentScriptContext,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { attachmentLimitFor, CHUNK_BYTES, formatBytes } from "./lib/files";

interface DroppedItem {
  file: File;
  isDirectory: boolean;
}

interface DropReceiver {
  marker: HTMLElement;
  composer: PluginComposerApi;
  receive(items: DroppedItem[]): void;
}

const receivers = new Set<DropReceiver>();
const ACTIVE_ATTR = "data-composer-dropzone-active";
const STYLE_ID = "composer-dropzone-style";
const PROMPTBOX = "form[data-promptbox]";

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

function collectItems(event: DragEvent): DroppedItem[] {
  const transfer = event.dataTransfer;
  if (transfer === null) return [];
  const entries = Array.from(transfer.items ?? []).filter((item) => item.kind === "file");
  const files = Array.from(transfer.files ?? []);
  return files.map((file, index) => {
    const entry = entries[index]?.webkitGetAsEntry?.() ?? null;
    return { file, isDirectory: entry?.isDirectory === true };
  });
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
    const items = collectItems(event);
    if (items.length === 0) {
      toast.error("No file came through", {
        description: "The app you dragged from didn't hand over a file. Save it to disk, then drop it from Finder.",
      });
      return true;
    }
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

  document.addEventListener("dragover", onCaptureDragOver, true);
  document.addEventListener("drop", onCaptureDrop, true);
  window.addEventListener("dragover", onBubbleDragOver);
  window.addEventListener("drop", onBubbleDrop);

  const cleanup = () => {
    document.removeEventListener("dragover", onCaptureDragOver, true);
    document.removeEventListener("drop", onCaptureDrop, true);
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

function DropzoneBridge() {
  const composer = useComposer();
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (marker === null) return;

    const projectId = async (): Promise<string> => {
      const scope = composer.scope;
      if (scope.kind === "new-thread") {
        if (scope.projectId === null) throw new Error("Pick a project first, then drop again.");
        return scope.projectId;
      }
      const thread = await sdk.threads.get({ threadId: scope.threadId });
      return thread.projectId;
    };

    const uploadSmall = async (file: File): Promise<ComposerAttachment> => {
      const uploaded = await sdk.projects.attachments.upload({
        projectId: await projectId(),
        clientFile: file,
        mimeType: file.type || undefined,
      });
      return uploaded as ComposerAttachment;
    };

    const uploadLarge = async (file: File, toastId: string | number): Promise<ComposerAttachment> => {
      const config = await rpc.call("config");
      if (!config.largeFiles) {
        throw new Error(
          `${formatBytes(file.size)} is over bb's ${formatBytes(attachmentLimitFor(file.type))} attachment limit, and large-file drops are off.`,
        );
      }
      if (config.hostId === null) throw new Error("This bb server has no local machine to save large files on.");
      if (file.size > config.maxFileBytes) {
        throw new Error(`${formatBytes(file.size)} is over the ${formatBytes(config.maxFileBytes)} limit in settings.`);
      }
      const { uploadId } = await rpc.call("begin", { name: file.name, sizeBytes: file.size });
      try {
        for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
          const data = await blobToBase64(file.slice(offset, offset + CHUNK_BYTES));
          await rpc.call("chunk", { uploadId, offset, data });
          const done = Math.min(offset + CHUNK_BYTES, file.size);
          toast.loading(`Saving ${file.name}`, {
            id: toastId,
            description: `${formatBytes(done)} of ${formatBytes(file.size)}`,
          });
        }
        const saved = await rpc.call("finish", { uploadId });
        return {
          type: "localFile",
          path: saved.path,
          name: file.name,
          mimeType: file.type || undefined,
          sizeBytes: saved.sizeBytes,
          hostId: saved.hostId ?? config.hostId,
        };
      } catch (cause) {
        await rpc.call("abort", { uploadId }).catch(() => undefined);
        throw cause;
      }
    };

    const attachAll = async (items: DroppedItem[]) => {
      const attached: ComposerAttachment[] = [];
      const skipped: string[] = [];
      for (const { file, isDirectory } of items) {
        if (isDirectory) {
          skipped.push(`${file.name} (folder)`);
          continue;
        }
        if (file.size === 0) {
          skipped.push(`${file.name} (empty)`);
          continue;
        }
        const large = file.size > attachmentLimitFor(file.type);
        const toastId = toast.loading(`${large ? "Saving" : "Attaching"} ${file.name}`, {
          description: formatBytes(file.size),
        });
        try {
          const attachment = large ? await uploadLarge(file, toastId) : await uploadSmall(file);
          attached.push(attachment);
          toast.dismiss(toastId);
        } catch (cause) {
          toast.error(`Couldn't attach ${file.name}`, { id: toastId, description: errorMessage(cause) });
        }
      }
      if (attached.length > 0) {
        try {
          composer.replace((current) => {
            const known = new Set(current.attachments.map((item) => item.path));
            const added = attached.filter((item) => !known.has(item.path));
            if (added.length === 0) return current;
            return {
              text: current.text,
              mentions: current.mentions,
              attachments: [...current.attachments, ...added],
            };
          });
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
      receive: (items) => {
        void attachAll(items);
      },
    };
    receivers.add(receiver);
    return () => {
      receivers.delete(receiver);
    };
  }, [composer, sdk, rpc]);

  return <span ref={markerRef} hidden aria-hidden="true" data-composer-dropzone-bridge="" />;
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "composer-dropzone", mount: mountDropzone });
  app.composer.customize({
    id: "composer-dropzone-bridge",
    banners: [{ id: "composer-dropzone-bridge", chrome: "bare", component: DropzoneBridge }],
  });
});


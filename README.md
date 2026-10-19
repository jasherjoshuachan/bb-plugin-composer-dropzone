# bb-plugin-composer-dropzone

Drop files anywhere on a [bb](https://getbb.app) thread to attach them.

bb's composer accepts dropped files, but only when you hit the composer box exactly. If an upload fails, it says nothing. Files over bb's attachment limit (10 MB for images, 25 MB for other files) are rejected silently, and that covers most videos. This plugin fixes those cases:

- **Bigger target.** Drop on the composer, or anywhere in the thread or new-thread page. The composer outlines while you drag.
- **Clear errors.** Every failed or skipped file gets a toast that says why: too large, a folder, an empty file, or an app that didn't hand over a file (Photos and some chat apps drag "file promises").
- **Large files.** Files over bb's limit are saved on this machine under the plugin's data folder and attached by path, up to 2 GB by default. Saved files are deleted after 14 days.

## Install

```sh
bb plugin install git:https://github.com/jasherjoshuachan/bb-plugin-composer-dropzone.git@v0.1.0
```

## Settings

`bb plugin config composer-dropzone`:

| Key | Default | Meaning |
|---|---|---|
| `largeFiles` | `true` | Accept files over bb's attachment limit |
| `maxFileMb` | `2048` | Largest file to accept |
| `retentionDays` | `14` | Delete saved large files after this many days |

## How it works

- `app.tsx`: a content script handles OS file drags. Drops on a composer are taken in the capture phase, so bb's own handler doesn't also attach them. Drops elsewhere in the composer's panel are taken only if no other drop zone handled them first. A hidden banner in each composer registers that composer's handle, so files land in the right draft.
- Small files go through bb's own `projects.attachments.upload`, exactly as the paperclip does.
- Large files stream to `server.ts` in 2 MB chunks over plugin RPC and are written to `<bb data dir>/plugins/composer-dropzone/drops/<date>/`. They're attached as `{ type: "localFile", path, hostId }`.

## Security

- The server writes only inside its own `drops/` folder, with sanitized file names, `0600` files and `0700` folders. It never reads or lists anything else.
- It makes no network calls, runs no shell commands and collects no telemetry. The only runtime dependency is `zod`.
- Files are only ones you dropped. The browser never exposes other paths.

## Develop

```sh
npm install
npm run typecheck
npm test
bb plugin install path:$PWD
```

## License

MIT

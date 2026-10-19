# bb-plugin-composer-dropzone

Drop or paste files anywhere on a [bb](https://getbb.app) thread to attach them, without filling your disk with copies.

## The rule

- **A file that already exists on this Mac takes zero extra storage.** The plugin finds the original and attaches it by its absolute path. bb doesn't copy attachments that point at a path on this machine.
- **Anything that isn't a file on this Mac gets exactly one temporary copy.** That covers drags from Telegram, Photos, Mail and browsers (file promises), and pasted screenshots. The copy lives in the plugin's own folder and is deleted after 2 days. The plugin never calls bb's own attachment upload, which keeps two permanent copies.
- **Nothing happens silently.** Every file gets a toast: **Linked original** (with its path) or **Temporary copy — deleted in 2 days** (with the reason no original was found).

Also:

- **Bigger target.** Drop on the composer or anywhere in the thread or new-thread page. The composer outlines while you drag.
- **Paste.** Pasting files into a composer goes through the same path. Plain text pastes are left alone.
- **Send to bb.** A Finder Quick Action attaches selected files by path, even ones Spotlight can't see.
- **Clear errors.** Folders, empty files and failed copies each get a toast saying why.

## Install

```sh
bb plugin install git:https://github.com/jasherjoshuachan/bb-plugin-composer-dropzone.git@v0.2.0
```

## How linking works

A browser drop hands over the file's bytes, name, size and modified time, but not its path. For each dropped file:

1. The app computes a fingerprint: the sha256 of up to three 64 KiB samples (start, middle and end; the whole file if it is 192 KiB or less), plus the size.
2. The server looks for candidates. Drag path hints come first, when the app that started the drag provides any (`text/uri-list` file URLs or Electron's `File.path`; bb desktop currently provides neither). Then it asks Spotlight: `mdfind -0 'kMDItemFSName == "<name>" && kMDItemFSSize == <size>'`. It tries the exact name, then its NFC and NFD Unicode forms, then a case- and diacritic-insensitive match, then the name without the size. Names pass through byte for byte, so macOS screenshot names with a narrow no-break space before AM/PM still match.
3. Each candidate must be a regular file in an allowed place (see Security) with the same size and the same fingerprint, read from disk with the same sampler. If several match, the one whose modified time is within 2 seconds of the dropped file wins, then the most recently modified, then the shortest path.
4. A match is attached as `{ type: "localFile" | "localImage", path, hostId, sizeBytes }`. Otherwise the file streams to the server in 2 MB chunks and is attached from `drops/temp/<date>/`.

There is no filesystem walk if Spotlight finds nothing. Walking the home folder would be slow and would read many unrelated files. Use the Quick Action for files Spotlight doesn't index.

## Send to bb (Finder Quick Action)

```sh
bb composer-dropzone install-quick-action      # writes ~/Library/Services/Send to bb.workflow
bb composer-dropzone uninstall-quick-action
```

Select files in Finder, right-click, then choose **Quick Actions > Send to bb**. If it doesn't show, turn it on in System Settings > Keyboard > Keyboard Shortcuts > Services. The Quick Action runs `"$BB" composer-dropzone send "$@"`, where `$BB` is the absolute path of your `bb` command (from `BB_CLI`, or `<bb data dir>/bin/bb`; override it with `--cli <path>`). If a send fails, a notification shows the reason.

You can also run it directly: `bb composer-dropzone send /absolute/path/file.mov`. Files go to the composer you used last in a visible bb window. If no bb window is open, they wait for up to 1 hour (at most 50) and attach when a composer appears. Folders are refused; send the files inside them. The plugin installs the Quick Action only when you run the install command.

## Settings

`bb plugin config composer-dropzone`:

| Key | Default | Meaning |
|---|---|---|
| `tempRetentionDays` | `2` | Delete temporary copies after this many days |
| `tempCapMb` | `1024` | Total size cap for temporary copies. Over it, the oldest copies go first, but never one younger than 24 hours |
| `maxTempFileMb` | `4096` | Largest item to copy. Linked originals have no limit |

`bb composer-dropzone status` shows the space used by temporary copies, how many there are, the oldest, and any Finder sends still waiting.

Upgrading from v0.1: the `largeFiles`, `maxFileMb` and `retentionDays` settings are gone. Large files saved by v0.1 in `drops/<date>/` follow the new retention and cap.

## Security

- **Proof before linking.** `locate` returns a path only after the caller proves it has the same bytes: same size and same fingerprint. `send` accepts only paths you hand it explicitly from Finder or the CLI.
- **Allowed places.** Candidates must resolve (after following symlinks) to a regular file under your home folder or `/Volumes/<disk>/`. These are excluded: `~/Library` (except iCloud Drive in `~/Library/Mobile Documents` and cloud folders in `~/Library/CloudStorage`), `~/.Trash`, `~/.bb*`, and the plugin's own drops folder.
- **Protected locations are never linked or sent:** `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.claude*`, `~/.codex`, `~/.bb*`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials` and `~/Library/Keychains`. Agents can run `bb` commands, so `send` refuses these even when asked directly. Matching ignores case.
- **Limited reads.** The server reads only candidate files whose name and size already match the dropped file, and only to fingerprint them.
- **No shell.** Spotlight runs as `execFile("/usr/bin/mdfind", ["-0", query])` with no shell, a 4 second timeout and a 200-result cap. The query escapes `"`, `\` and `*`, and names containing NUL or `/` are refused. The Quick Action passes Finder's selection as shell arguments (`"$@"`), never as script text.
- **Limited writes.** The server writes only inside its own `drops/` folder (sanitized names, `0600` files, `0700` folders). The one exception is `~/Library/Services/Send to bb.workflow`, written only when you run the install command. Uninstall removes that bundle only if this plugin made it.
- No network calls and no telemetry. The only runtime dependency is `zod`.

## Limitations

- **Links break if the original moves.** Moving, renaming or deleting an original breaks the attachment in old threads.
- **Edits show up.** Changes to the original after sending are visible to the agent, because the attachment is the live file.
- **This machine only.** Path attachments work only for threads on this machine. bb rejects them for threads on a remote machine.
- **Spotlight blind spots.** Files in places Spotlight doesn't index (excluded folders, some network volumes, brand-new files not indexed yet) get a 2-day copy. The Quick Action avoids that.
- **Temporary copies expire.** A thread that used a temporary copy loses access to it after the retention period.

## How it's built

- `app.tsx`: a content script handles OS file drags and file pastes in the capture phase, so bb's own handler doesn't also attach them. A hidden banner in each composer registers that composer's handle, so files land in the right draft. It also receives Finder sends (`useRealtime`) and claims them once per window.
- `server.ts`: RPC (`config`, `locate`, `begin`/`chunk`/`finish`/`abort`, `claimSends`), the `bb composer-dropzone` CLI, and an hourly sweep (also at load) that applies retention and the cap.
- `lib/`: logic shared and tested in isolation. `fingerprint.ts` is the sampler, used by both the browser and Node. `locate.ts` handles the Spotlight query and verification. `paths.ts` holds the allow, exclude and protect rules. `tempstore.ts` handles retention and the cap. `send.ts` validates sent paths. `quickaction.ts` generates the workflow.

## Develop

```sh
npm install
npm run typecheck
npm test
bb plugin build
bb plugin install path:$PWD
```

## License

MIT

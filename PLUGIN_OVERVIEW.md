Drop or paste files anywhere on a bb thread to attach them, without duplicating them on disk.

## What you get

- Files that already exist on this Mac are attached by path: no copy, no extra storage. The plugin finds the original with Spotlight and checks it by content before linking it.
- Items that aren't files on this Mac (Telegram, Photos, Mail, browser images, pasted screenshots) get one temporary copy, deleted after 2 days, with a size cap.
- A toast for every file: "Linked original" or "Temporary copy — deleted in 2 days", plus the reason.
- Drop on the composer or anywhere in the thread or new-thread page. Pasting files into the composer works too.
- An optional Finder Quick Action, "Send to bb", attaches selected files by path: `bb composer-dropzone install-quick-action`.

## How it works

The app fingerprints each dropped file (sha256 of start, middle and end samples, plus size). The server searches Spotlight for that name and size and links a file only when its fingerprint matches. Anything else streams once into the plugin's own folder. Nothing leaves the machine, and the plugin needs no account, API key or external service.

// Path rules: which files the plugin may link to or accept from Finder.
// Pure string logic (POSIX paths), so it can be tested without a filesystem.
// Callers pass real paths (symlinks already resolved).
import path from "node:path";

/**
 * Credential and agent-state locations, relative to the home folder, that are
 * never linked or sent, whatever the caller proves. A trailing `*` matches any
 * name with that prefix (`.claude*` covers `.claude`, `.claude-work`,
 * `.claude.json`).
 */
export const PROTECTED_HOME_PATHS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gh",
  ".claude*",
  ".codex",
  ".bb*",
  ".netrc",
  ".npmrc",
  ".git-credentials",
  "Library/Keychains",
];

/** Folders under ~/Library that hold user documents (iCloud Drive, File Provider clouds). */
export const LIBRARY_DOCUMENT_FOLDERS: readonly string[] = ["Library/Mobile Documents", "Library/CloudStorage"];

/** Folders excluded from linking besides the protected ones. */
export const EXCLUDED_HOME_PATHS: readonly string[] = ["Library", ".Trash"];

/** `child` is `parent` or inside it. Case-insensitive, as APFS is by default. */
export function isWithin(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase().replace(/\/+$/, "");
  return c === p || c.startsWith(`${p}/`);
}

/** A clean absolute POSIX path: starts with `/`, no `.`/`..` segments, no NUL, no doubled or trailing slash. */
export function isCleanAbsolute(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return false;
  if (!p.startsWith("/") || p.includes("\0")) return false;
  return path.posix.normalize(p) === p && (p === "/" || !p.endsWith("/"));
}

function matchesHomeEntry(p: string, home: string, entry: string): boolean {
  if (!entry.endsWith("*")) return isWithin(p, path.posix.join(home, entry));
  const rel = relativeToHome(p, home);
  if (rel === null) return false;
  const prefix = entry.slice(0, -1).toLowerCase();
  const head = entry.includes("/") ? rel : rel.split("/")[0]!;
  return head.toLowerCase().startsWith(prefix);
}

function relativeToHome(p: string, home: string): string | null {
  if (!isWithin(p, home) || p.length === home.length) return null;
  return p.slice(home.replace(/\/+$/, "").length + 1);
}

export function isProtectedPath(p: string, home: string): boolean {
  return PROTECTED_HOME_PATHS.some((entry) => matchesHomeEntry(p, home, entry));
}

/** Under the home folder or on a mounted volume (`/Volumes/<name>/…`). */
export function isUnderAllowedRoot(p: string, home: string): boolean {
  if (relativeToHome(p, home) !== null) return true;
  return /^\/Volumes\/[^/]+\/.+/.test(p);
}

/**
 * Why a real path may not be linked as the original of a dropped file, or
 * null when it may. Used for Spotlight results and drag path hints.
 */
export function candidateRejection(p: string, opts: { home: string; dropsDir: string }): string | null {
  const { home, dropsDir } = opts;
  if (!isCleanAbsolute(p)) return "not a clean absolute path";
  if (!isUnderAllowedRoot(p, home)) return "outside the home folder and /Volumes";
  if (isProtectedPath(p, home)) return "protected location";
  if (isWithin(p, dropsDir)) return "the plugin's own temporary copies";
  const inLibraryDocs = LIBRARY_DOCUMENT_FOLDERS.some((entry) => isWithin(p, path.posix.join(home, entry)));
  if (!inLibraryDocs && EXCLUDED_HOME_PATHS.some((entry) => isWithin(p, path.posix.join(home, entry)))) {
    return "excluded folder";
  }
  return null;
}

/** Why a path sent from Finder (Quick Action / CLI) is refused, or null when it is accepted. */
export function sendRejection(p: string, home: string): string | null {
  if (!isCleanAbsolute(p)) return "use an absolute path";
  if (!isUnderAllowedRoot(p, home)) return "only files in your home folder or on /Volumes can be sent";
  if (isProtectedPath(p, home)) return "this location is protected (credentials or agent state)";
  return null;
}

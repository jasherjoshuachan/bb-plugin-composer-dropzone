// The "Send to bb" Finder Quick Action: an Automator service bundle that runs
// `"$BB" composer-dropzone send "$@"` with the selected files as arguments.
// Written only when the user runs `bb composer-dropzone install-quick-action`.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const QUICK_ACTION_NAME = "Send to bb";
export const QUICK_ACTION_BUNDLE = `${QUICK_ACTION_NAME}.workflow`;
/** Marker in the generated script, so uninstall only removes our own bundle. */
export const QUICK_ACTION_MARKER = "# composer-dropzone quick action";

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A POSIX shell single-quoted literal. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Rejects CLI paths that can't be embedded safely. */
export function validateCliPath(cli: string): void {
  if (!path.isAbsolute(cli)) throw new Error("The bb CLI path must be absolute.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(cli)) throw new Error("The bb CLI path contains control characters.");
}

/**
 * The shell script the Quick Action runs (/bin/sh, input as arguments). On a
 * failure the CLI's message is shown as a notification; it reaches osascript
 * as an argument, never as script text.
 */
export function quickActionScript(cli: string): string {
  validateCliPath(cli);
  return [
    QUICK_ACTION_MARKER,
    `BB=${shellQuote(cli)}`,
    `out=$("$BB" composer-dropzone send "$@" 2>&1) || /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Send to bb"' -e 'end run' "Not sent: $out"`,
    "",
  ].join("\n");
}

export function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSBackgroundColorName</key>
			<string>background</string>
			<key>NSIconName</key>
			<string>NSActionTemplate</string>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>${xmlEscape(QUICK_ACTION_NAME)}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.item</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`;
}

function argument(index: number, name: string, value: string): string {
  return `				<key>${index}</key>
				<dict>
					<key>default value</key>
					${value}
					<key>name</key>
					<string>${name}</string>
					<key>required</key>
					<string>0</string>
					<key>type</key>
					<string>0</string>
					<key>uuid</key>
					<string>${index}</string>
				</dict>`;
}

export function documentWflow(cli: string, uuid: () => string = () => randomUUID().toUpperCase()): string {
  const script = xmlEscape(quickActionScript(cli));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>534</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>${script}</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/sh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>${uuid()}</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>${uuid()}</string>
				<key>UUID</key>
				<string>${uuid()}</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
${argument(0, "inputMethod", "<integer>0</integer>")}
${argument(1, "CheckedForUserDefaultShell", "<false/>")}
${argument(2, "source", "<string></string>")}
${argument(3, "COMMAND_STRING", "<string></string>")}
${argument(4, "shell", "<string>/bin/sh</string>")}
				</dict>
				<key>conversionLabel</key>
				<integer>0</integer>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:305.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key>
		<dict>
			<key>/System/Library/CoreServices/Finder.app</key>
			<string>com.apple.finder</string>
		</dict>
		<key>applicationPaths</key>
		<array>
			<string>/System/Library/CoreServices/Finder.app</string>
		</array>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<false/>
		<key>serviceApplicationBundleID</key>
		<string>com.apple.finder</string>
		<key>serviceApplicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<false/>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<false/>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`;
}

/** Write the bundle into `servicesDir` (atomically: build beside it, then rename). Returns its path. */
export async function writeQuickAction(servicesDir: string, cli: string): Promise<string> {
  const target = path.join(servicesDir, QUICK_ACTION_BUNDLE);
  const staging = path.join(servicesDir, `.${QUICK_ACTION_BUNDLE}.${process.pid}.tmp`);
  await fs.mkdir(servicesDir, { recursive: true });
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(path.join(staging, "Contents"), { recursive: true });
  await fs.writeFile(path.join(staging, "Contents", "Info.plist"), infoPlist(), { mode: 0o644 });
  await fs.writeFile(path.join(staging, "Contents", "document.wflow"), documentWflow(cli), { mode: 0o644 });
  if (await isOurQuickAction(target)) await fs.rm(target, { recursive: true, force: true });
  else if (await exists(target)) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new Error(`${target} exists and wasn't made by Composer Dropzone. Remove it first.`);
  }
  await fs.rename(staging, target);
  return target;
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

export async function isOurQuickAction(bundle: string): Promise<boolean> {
  const doc = await fs.readFile(path.join(bundle, "Contents", "document.wflow"), "utf8").catch(() => "");
  return doc.includes(xmlEscape(QUICK_ACTION_MARKER));
}

/** Remove our bundle from `servicesDir`. Returns false when it wasn't there; throws if it isn't ours. */
export async function removeQuickAction(servicesDir: string): Promise<boolean> {
  const target = path.join(servicesDir, QUICK_ACTION_BUNDLE);
  if (!(await exists(target))) return false;
  if (!(await isOurQuickAction(target))) {
    throw new Error(`${target} wasn't made by Composer Dropzone; leaving it alone.`);
  }
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

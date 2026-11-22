import { statSync } from "node:fs";
import { win32 } from "node:path";

// npm installs CLI commands as `.cmd` shims on Windows, and Node cannot spawn
// those without a shell. Resolving the package's JS entry keeps every argument
// literal, so user text never reaches a command line.
const PACKAGE = win32.join("@colbymchenry", "codegraph");
const ENTRY = "npm-shim.js";

export type CodegraphLaunch = { command: string; args: string[]; error?: undefined } | { error: string; command?: undefined; args?: undefined };

export interface LaunchOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	isFile?: (path: string) => boolean;
}

// Only a missing path counts as "not there". A permission or device error must
// surface instead of silently reporting CodeGraph as uninstalled.
function defaultIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

// The shim needs a Node it can spawn: the one npm installed beside it, or any
// `node.exe` earlier on PATH.
function findNode(binDir: string, packageDir: string, entries: string[], isFile: (path: string) => boolean): string | undefined {
	for (const candidate of [win32.join(binDir, "node.exe"), win32.join(packageDir, "node.exe"), ...entries.map((entry) => win32.join(entry, "node.exe"))]) {
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

export function resolveCodegraphLaunch(options: LaunchOptions = {}): CodegraphLaunch {
	if ((options.platform ?? process.platform) !== "win32") return { command: "codegraph", args: [] };
	const env = options.env ?? process.env;
	const isFile = options.isFile ?? defaultIsFile;
	const entries = (Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "").split(";").filter(Boolean);
	for (const binDir of entries) {
		const exe = win32.join(binDir, "codegraph.exe");
		if (isFile(exe)) return { command: exe, args: [] };
		// A global install keeps the package under the bin directory; `npm i -D`
		// puts the shim in `node_modules/.bin`, one level below the package.
		if (![win32.join(binDir, "codegraph.cmd"), win32.join(binDir, "codegraph")].some(isFile)) continue;
		const packageDir = [win32.join(binDir, "node_modules", PACKAGE), win32.join(binDir, "..", PACKAGE)].find((dir) => isFile(win32.join(dir, ENTRY)));
		if (!packageDir) return { error: `codegraph is on PATH at ${binDir}, but ${PACKAGE} is not installed. Reinstall: npm install -g @colbymchenry/codegraph` };
		const command = findNode(binDir, packageDir, entries, isFile);
		if (!command) return { error: `No node.exe can run ${win32.join(packageDir, ENTRY)}. Add Node.js to PATH, then restart Pi or /reload.` };
		return { command, args: [win32.join(packageDir, ENTRY)] };
	}
	return { error: "codegraph is not on PATH. Install CodeGraph: npm install -g @colbymchenry/codegraph" };
}

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_COMMAND = "code";
const configPath = () => join(getAgentDir(), "config", "pi-open-in.json");

function loadCommand(): string {
	let raw: string;
	try {
		raw = readFileSync(configPath(), "utf8");
	} catch (error) {
		// Only a missing file falls back to the default command.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_COMMAND;
		throw error;
	}
	let config: unknown;
	try {
		config = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid ${configPath()}: not valid JSON`);
	}
	const isObject = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	if (!isObject(config) || Object.keys(config).length !== 1 || typeof config.command !== "string" || !config.command.trim()) {
		throw new Error(`Invalid ${configPath()}: expected exactly one non-empty string "command" property`);
	}
	return config.command.trim();
}

export function configuredOpenUri(path: string): string | undefined {
	try {
		if (loadCommand() !== "code") return undefined;
	} catch {
		// Invalid config must not break footer render; just omit the URI.
		return undefined;
	}
	if (path.startsWith("\\\\")) {
		const [host, ...parts] = path.slice(2).split("\\");
		const uri = new URL(`file://${host}`);
		uri.pathname = `/${parts.join("/")}`;
		return `vscode://file//${uri.host}${uri.pathname}`;
	}
	return `vscode://file${pathToFileURL(path).pathname}`;
}

export default function openInExtension(pi: ExtensionAPI): void {
	// ponytail: static description so it never goes stale after /set-open-in
	// (handler re-reads config per invocation); per-token whitespace splitting,
	// tokens with spaces not supported.
	pi.registerCommand("open", {
		description: "Open the current path with the configured command",
		handler: async (_args, ctx) => {
			const [executable, ...args] = loadCommand().split(/\s+/);
			const result = await pi.exec(executable, [...args, ctx.cwd]);
			if (result.code !== 0) {
				throw new Error(`Open command failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
			}
		},
	});

	pi.registerCommand("set-open-in", {
		description: "Set command used by /open",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) throw new Error("Usage: /set-open-in <command>");
			const path = configPath();
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify({ command }, null, 2)}\n`, "utf8");
			ctx.ui.notify(`Saved open-in command: ${command}`, "info");
		},
	});
}

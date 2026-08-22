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

function configuredCommand(): string {
	try {
		const config: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
		if (config && typeof config === "object" && !Array.isArray(config)) {
			const command = (config as { command?: unknown }).command;
			if (typeof command === "string" && command.trim()) return command.trim();
		}
	} catch {
		// Missing or malformed config uses default command.
	}
	return DEFAULT_COMMAND;
}

export function configuredOpenUri(path: string): string | undefined {
	if (configuredCommand() !== "code") return undefined;
	if (path.startsWith("\\\\")) {
		const [host, ...parts] = path.slice(2).split("\\");
		const uri = new URL(`file://${host}`);
		uri.pathname = `/${parts.join("/")}`;
		return `vscode://file//${uri.host}${uri.pathname}`;
	}
	return `vscode://file${pathToFileURL(path).pathname}`;
}

async function saveCommand(command: string): Promise<void> {
	const path = configPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ command }, null, 2)}\n`, "utf8");
}

export default function openInExtension(pi: ExtensionAPI): void {
	const command = configuredCommand();

	pi.registerCommand("open", {
		description: `Open the current path with \`${command} <current-path>\``,
		handler: async (_args, ctx) => {
			const [executable, ...args] = configuredCommand().split(/\s+/);
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
			await saveCommand(command);
			ctx.ui.notify(`Saved open-in command: ${command}`, "info");
		},
	});
}

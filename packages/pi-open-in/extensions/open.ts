import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
			await pi.exec(configuredCommand(), [ctx.cwd]);
		},
	});

	pi.registerCommand("set-open-in", {
		description: "Set command used by /open",
		handler: async (args) => {
			const command = args.trim();
			if (!command) throw new Error("Usage: /set-open-in <command>");
			await saveCommand(command);
		},
	});
}

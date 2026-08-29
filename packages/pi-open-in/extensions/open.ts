import { pathToFileURL } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConfigStore } from "@henryqw/pi-config-store";

const DEFAULT_COMMAND = "code";

export type OpenInConfig = { command: string };

function parseOpenInConfig(value: unknown): OpenInConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error('Invalid open-in config: expected exactly one non-empty string "command" property');
	}
	const config = value as Record<string, unknown>;
	if (Object.keys(config).length !== 1 || typeof config.command !== "string" || !config.command.trim()) {
		throw new Error('Invalid open-in config: expected exactly one non-empty string "command" property');
	}
	return { command: config.command.trim() };
}

function createOpenInConfigStore(agentDir?: string) {
	return createConfigStore<OpenInConfig>({
		extensionId: "pi-open-in",
		agentDir,
		defaults: () => ({ command: DEFAULT_COMMAND }),
		parse: parseOpenInConfig,
	});
}

export function loadOpenInConfig(agentDir?: string): { source: "file" | "missing"; value: OpenInConfig } {
	return createOpenInConfigStore(agentDir).loadSync();
}

export function configuredOpenUri(path: string): string | undefined {
	try {
		if (loadOpenInConfig().value.command !== "code") return undefined;
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
	const configStore = createOpenInConfigStore();
	pi.on("session_start", (_event, ctx) => {
		if (configStore.loadSync().source === "missing") {
			ctx.ui.notify(`Open-in config is missing: ${configStore.path}; defaults are used.`, "warning");
		}
	});

	// ponytail: static description so it never goes stale after /set-open-in
	// (handler re-reads config per invocation); per-token whitespace splitting,
	// tokens with spaces not supported.
	pi.registerCommand("open", {
		description: "Open the current path with the configured command",
		handler: async (_args, ctx) => {
			const [executable, ...args] = configStore.loadSync().value.command.split(/\s+/);
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
			await configStore.save({ command });
			ctx.ui.notify(`Saved open-in command: ${command}`, "info");
		},
	});
}

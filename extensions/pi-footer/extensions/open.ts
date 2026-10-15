import { pathToFileURL } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ConfigLoad, registerConfigReporting } from "@henryqw/pi-config-store";
import { createOpenInConfigStore } from "./open-in-config.ts";

export type OpenInConfig = { command: string };

/** An invalid or unknown key is an issue; an invalid `command` falls back to `code`. */
export function loadOpenInConfig(agentDir?: string): ConfigLoad<OpenInConfig> {
	return createOpenInConfigStore(agentDir).loadSync();
}

/** Runs on every footer render, so it never notifies; the footer and open extensions report issues at session start. */
export function configuredOpenUri(path: string): string | undefined {
	const loaded = loadOpenInConfig();
	if (loaded.status === "disabled") return undefined;
	const [executable, ...args] = loaded.value.command.split(/\s+/);
	if (executable !== "code") return undefined;
	const query = args.includes("-n") || args.includes("--new-window") ? "?windowId=_blank" : "";
	if (path.startsWith("\\\\")) {
		const [host, ...parts] = path.slice(2).split("\\");
		const uri = new URL(`file://${host}`);
		uri.pathname = `/${parts.join("/")}`;
		return `vscode://file//${uri.host}${uri.pathname}${query}`;
	}
	return `vscode://file${pathToFileURL(path).pathname}${query}`;
}

export default function openInExtension(pi: ExtensionAPI): void {
	const configStore = createOpenInConfigStore();
	const reporter = registerConfigReporting(pi, [configStore]);

	// Reload config on each call; split the command on whitespace (no quoted tokens).
	pi.registerCommand("open", {
		description: "Open the current path with the configured command",
		handler: async (_args, ctx) => {
			const loaded = configStore.loadSync();
			reporter.report(ctx, configStore, loaded);
			if (loaded.status === "disabled") return;
			const [executable, ...args] = loaded.value.command.split(/\s+/);
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
			// The new command replaces the whole file, so first show any problem in the file that it removes.
			reporter.report(ctx, configStore, configStore.loadSync());
			await configStore.save({ command });
			ctx.ui.notify(`Saved open-in command: ${command}`, "info");
		},
	});
}

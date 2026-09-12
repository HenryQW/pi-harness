import { resolve } from "node:path";
import { copyToClipboard, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	createBarkConfigStore,
	DEFAULT_SERVER_URL,
	parseDeviceKey,
	parseServerUrl,
	statusNotificationsEnabled,
	type BarkConfig,
} from "../src/config.ts";
import { encryptPushContent } from "../src/encryption.ts";

const REQUEST_TIMEOUT_MS = 15_000;

type BarkPushContent = { body: string } & Record<string, string>;

type BarkExtensionOptions = {
	agentDir?: string;
	copy?: (text: string) => Promise<void>;
	fetch?: typeof globalThis.fetch;
};

export function lastAssistantText(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (message.stopReason === "aborted" && message.content.length === 0) continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		return text || undefined;
	}
	return undefined;
}

async function sendPush(
	config: BarkConfig,
	content: BarkPushContent,
	fetchImpl: typeof globalThis.fetch,
): Promise<void> {
	if (!config.deviceKey) throw new Error("Bark Device Key is required.");
	const payload = config.encryption ? encryptPushContent(content, config.encryption) : content;
	let response: Response;
	try {
		response = await fetchImpl(`${config.serverUrl}/push`, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({ device_key: config.deviceKey, ...payload }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`Bark push request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`Bark push request failed with HTTP ${response.status}.`);
}

export default function barkExtension(pi: ExtensionAPI, options: BarkExtensionOptions = {}): void {
	const configStore = createBarkConfigStore(options.agentDir);
	const copy = options.copy ?? copyToClipboard;
	const fetchImpl = options.fetch ?? globalThis.fetch;

	const sendStatus = async (title: string, cwd: string): Promise<void> => {
		const config = configStore.loadSync().value;
		if (!config.deviceKey || !statusNotificationsEnabled(config, cwd)) return;
		const sessionName = pi.getSessionName()?.trim() || "Unnamed";
		await sendPush(config, { title, body: `Pi session: ${sessionName}` }, fetchImpl);
	};

	pi.on("ui_prompt_start", (_event, ctx) => {
		void sendStatus("Pi needs input", ctx.cwd).catch((error) => {
			console.error(`[pi-bark] ${error instanceof Error ? error.message : String(error)}`);
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.isIdle()) return;
		try {
			await sendStatus("Pi finished", ctx.cwd);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});

	pi.registerCommand("bark-notifications", {
		description: "Configure automatic Bark status notifications",
		handler: async (args, ctx) => {
			const [first, second, extra] = args.trim().split(/\s+/);
			if (extra || (first === "default" ? !["on", "off"].includes(second) : second)) {
				throw new Error("Usage: /bark-notifications <on|off|inherit> | default <on|off>");
			}
			if (first === "default") {
				const enabled = second === "on";
				await configStore.update((config) => ({
					...config,
					statusNotifications: { ...config.statusNotifications, defaultEnabled: enabled },
				}));
				ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} Bark status notifications by default.`, "info");
				return;
			}
			if (!(["on", "off", "inherit"] as const).includes(first as "on" | "off" | "inherit")) {
				throw new Error("Usage: /bark-notifications <on|off|inherit> | default <on|off>");
			}
			const cwd = resolve(ctx.cwd);
			await configStore.update((config) => {
				const cwdOverrides = { ...config.statusNotifications.cwdOverrides };
				if (first === "inherit") delete cwdOverrides[cwd];
				else cwdOverrides[cwd] = first === "on";
				return {
					...config,
					statusNotifications: { ...config.statusNotifications, cwdOverrides },
				};
			});
			ctx.ui.notify(
				first === "inherit"
					? "This CWD now inherits the default Bark notification setting."
					: `${first === "on" ? "Enabled" : "Disabled"} Bark status notifications for this CWD.`,
				"info",
			);
		},
	});

	pi.registerCommand("copyb", {
		description: "Copy the last agent message and send a Bark push notification",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /copyb");
			const config = configStore.loadSync().value;
			if (!config.deviceKey) throw new Error("Bark is not configured. Run /set-bark <device-key> [server-url] first.");

			const text = lastAssistantText(ctx.sessionManager.buildContextEntries());
			if (!text) throw new Error("No agent messages to copy yet.");

			await copy(text);
			await sendPush(config, { body: text }, fetchImpl);
			ctx.ui.notify("Copied the last agent message and sent a Bark push notification.", "info");
		},
	});

	pi.registerCommand("set-bark", {
		description: "Set the Bark Device Key and optional server URL",
		handler: async (args, ctx) => {
			const [deviceKey, serverUrl = DEFAULT_SERVER_URL, extra] = args.trim().split(/\s+/);
			if (!deviceKey || extra) throw new Error("Usage: /set-bark <device-key> [server-url]");
			await configStore.update((config) => ({
				...config,
				serverUrl: parseServerUrl(serverUrl),
				deviceKey: parseDeviceKey(deviceKey),
			}));
			ctx.ui.notify("Saved the Bark Device Key and server URL.", "info");
		},
	});
}

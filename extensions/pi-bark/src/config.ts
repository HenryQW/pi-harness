import { isAbsolute, resolve } from "node:path";
import { createConfigStore } from "@henryqw/pi-config-store";

export const DEFAULT_SERVER_URL = "https://api.day.app";
export const ENCRYPTION_ALGORITHM = "AES256";
export const ENCRYPTION_MODE = "GCM";
export const ENCRYPTION_PADDING = "noPadding";
export const ENCRYPTION_KEY_BYTES = 32;

export type BarkEncryption = {
	algorithm: typeof ENCRYPTION_ALGORITHM;
	mode: typeof ENCRYPTION_MODE;
	padding: typeof ENCRYPTION_PADDING;
	key: string;
};

export type BarkConfig = {
	serverUrl: string;
	deviceKey: string | null;
	encryption: BarkEncryption | null;
	statusNotifications: {
		defaultEnabled: boolean;
		cwdOverrides: Record<string, boolean>;
	};
};

export function parseServerUrl(value: string): string {
	const input = value.trim();
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Bark server URL must be a valid HTTP or HTTPS URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Bark server URL must use HTTP or HTTPS.");
	}
	if (input.includes("?") || input.includes("#")) {
		throw new Error("Bark server URL must not include a query or fragment.");
	}
	return url.href.replace(/\/$/, "");
}

export function parseDeviceKey(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !value.trim()) {
		throw new Error('Invalid Bark config: "deviceKey" must be a non-empty string.');
	}
	return value.trim();
}

function parseEncryption(value: unknown): BarkEncryption | null {
	if (value === null) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error('Invalid Bark config: "encryption" must be an object or null.');
	}
	const encryption = value as Record<string, unknown>;
	if (
		Object.keys(encryption).length !== 4 ||
		encryption.algorithm !== ENCRYPTION_ALGORITHM ||
		encryption.mode !== ENCRYPTION_MODE ||
		encryption.padding !== ENCRYPTION_PADDING ||
		typeof encryption.key !== "string" ||
		Buffer.byteLength(encryption.key, "utf8") !== ENCRYPTION_KEY_BYTES
	) {
		throw new Error(
			`Invalid Bark encryption config: expected ${ENCRYPTION_ALGORITHM}, ${ENCRYPTION_MODE}, ${ENCRYPTION_PADDING}, and a ${ENCRYPTION_KEY_BYTES}-byte UTF-8 key.`,
		);
	}
	return {
		algorithm: ENCRYPTION_ALGORITHM,
		mode: ENCRYPTION_MODE,
		padding: ENCRYPTION_PADDING,
		key: encryption.key,
	};
}

function parseStatusNotifications(value: unknown): BarkConfig["statusNotifications"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error('Invalid Bark config: "statusNotifications" must be an object.');
	}
	const notifications = value as Record<string, unknown>;
	const overrides = notifications.cwdOverrides;
	if (
		Object.keys(notifications).length !== 2 ||
		typeof notifications.defaultEnabled !== "boolean" ||
		!overrides ||
		typeof overrides !== "object" ||
		Array.isArray(overrides)
	) {
		throw new Error('Invalid Bark config: expected "defaultEnabled" and "cwdOverrides" notification settings.');
	}
	const entries = Object.entries(overrides);
	if (entries.some(([cwd, enabled]) => !isAbsolute(cwd) || typeof enabled !== "boolean")) {
		throw new Error("Invalid Bark config: CWD notification overrides must map absolute paths to booleans.");
	}
	return {
		defaultEnabled: notifications.defaultEnabled,
		cwdOverrides: Object.fromEntries(entries) as Record<string, boolean>,
	};
}

function parseBarkConfig(value: unknown): BarkConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid Bark config: expected Bark settings object.");
	}
	const config = value as Record<string, unknown>;
	if (
		Object.keys(config).length !== 4 ||
		typeof config.serverUrl !== "string" ||
		!("deviceKey" in config) ||
		!("encryption" in config) ||
		!("statusNotifications" in config)
	) {
		throw new Error("Invalid Bark config: expected server, device, encryption, and notification settings.");
	}
	return {
		serverUrl: parseServerUrl(config.serverUrl),
		deviceKey: parseDeviceKey(config.deviceKey),
		encryption: parseEncryption(config.encryption),
		statusNotifications: parseStatusNotifications(config.statusNotifications),
	};
}

export function statusNotificationsEnabled(config: BarkConfig, cwd: string): boolean {
	return config.statusNotifications.cwdOverrides[resolve(cwd)] ?? config.statusNotifications.defaultEnabled;
}

export function createBarkConfigStore(agentDir?: string) {
	return createConfigStore<BarkConfig>({
		extensionId: "pi-bark",
		agentDir,
		defaults: () => ({
			serverUrl: DEFAULT_SERVER_URL,
			deviceKey: null,
			encryption: null,
			statusNotifications: { defaultEnabled: true, cwdOverrides: {} },
		}),
		parse: parseBarkConfig,
	});
}

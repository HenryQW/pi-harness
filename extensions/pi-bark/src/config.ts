import { resolve } from "node:path";
import { createConfigStore, field, type FieldParser, formatConfigIssues, parsers, required } from "@henryqw/pi-config-store";

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
	deviceKey: string;
	encryption: BarkEncryption | null;
	statusNotifications: {
		defaultEnabled: boolean;
		cwdOverrides: Record<string, boolean>;
	};
};

/** Config that repair commands write. The Device Key can still be unset. */
export type BarkConfigDraft = Omit<BarkConfig, "deviceKey"> & { deviceKey: string | null };

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

const serverUrl: FieldParser<string> = (raw) => {
	if (typeof raw !== "string") throw new Error("must be an HTTP or HTTPS URL");
	return parseServerUrl(raw);
};

const encryption: FieldParser<BarkEncryption> = (raw) => {
	const value = raw as Record<string, unknown>;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== 4 ||
		value.algorithm !== ENCRYPTION_ALGORITHM ||
		value.mode !== ENCRYPTION_MODE ||
		value.padding !== ENCRYPTION_PADDING ||
		typeof value.key !== "string" ||
		Buffer.byteLength(value.key, "utf8") !== ENCRYPTION_KEY_BYTES
	) {
		throw new Error(
			`expected ${ENCRYPTION_ALGORITHM}, ${ENCRYPTION_MODE}, ${ENCRYPTION_PADDING}, and a ${ENCRYPTION_KEY_BYTES}-byte UTF-8 key`,
		);
	}
	return value as BarkEncryption;
};

// A default server would receive the Device Key, and a null encryption default would send plaintext.
const sharedFields = {
	serverUrl: field(serverUrl, DEFAULT_SERVER_URL, { onInvalid: "disable" }),
	encryption: field(parsers.nullable(encryption), null, { onInvalid: "disable" }),
	statusNotifications: field(
		parsers.object({
			defaultEnabled: field(parsers.boolean(), true),
			cwdOverrides: field(parsers.record(parsers.boolean(), { key: parsers.absolutePath() }), {}),
		}),
		{ defaultEnabled: true, cwdOverrides: {} },
	),
};

export function statusNotificationsEnabled(config: BarkConfig, cwd: string): boolean {
	return config.statusNotifications.cwdOverrides[resolve(cwd)] ?? config.statusNotifications.defaultEnabled;
}

/** Bark cannot send without a Device Key, so a missing or invalid one disables pi-bark. */
export function createBarkConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-bark",
		agentDir,
		fields: { ...sharedFields, deviceKey: required(parsers.string({ trim: true })) },
	});
}

/** Same file; every field falls back to its default, so repair commands can read a disabled config. */
function createBarkDraftStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-bark",
		agentDir,
		fields: {
			serverUrl: field(serverUrl, DEFAULT_SERVER_URL),
			deviceKey: field(parsers.nullable(parsers.string({ trim: true })), null),
			encryption: field(parsers.nullable(encryption), null),
			statusNotifications: sharedFields.statusNotifications,
		},
	});
}

/**
 * Write config for a repair command. A clean file uses a locked update. A file with issues is replaced,
 * but only when the change sets each invalid server URL or encryption setting, so no safety setting is lost.
 */
export async function writeBarkConfig(
	agentDir: string | undefined,
	replaces: readonly (keyof BarkConfig)[],
	change: (config: BarkConfigDraft) => BarkConfigDraft,
): Promise<void> {
	const store = createBarkDraftStore(agentDir);
	const current = store.loadSync();
	// The draft store has no disabling field, so it always loads a value.
	if (current.status !== "ok") throw new Error(formatConfigIssues(current.issues));
	if (!current.issues.length) {
		await store.update(change);
		return;
	}
	const unsafe = current.issues.filter(({ key }) => {
		if (!key) return true;
		const root = key.split(/[.[]/, 1)[0];
		return (root === "serverUrl" || root === "encryption") && !(replaces as readonly string[]).includes(root);
	});
	if (unsafe.length) throw new Error(`Fix the Bark config at ${store.path} first: ${formatConfigIssues(unsafe)}`);
	await store.save(change(current.value));
}

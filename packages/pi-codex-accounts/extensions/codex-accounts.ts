import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";

const NATIVE_PROVIDER_ID = "openai-codex";
const ALIAS_PREFIX = `${NATIVE_PROVIDER_ID}-account-`;
const FIRST_ALIAS_SLOT = 2;
type CodexProvider = Provider<"openai-codex-responses">;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountIdOf(value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.accountId !== "string" || value.accountId.length === 0) {
		return undefined;
	}
	return value.accountId;
}

function isManagedProvider(providerId: string): boolean {
	return providerId === NATIVE_PROVIDER_ID || /^openai-codex-account-\d+$/.test(providerId);
}

function aliasSlot(providerId: string): number | undefined {
	if (!providerId.startsWith(ALIAS_PREFIX)) return undefined;
	const slot = Number(providerId.slice(ALIAS_PREFIX.length));
	return Number.isInteger(slot) && slot >= FIRST_ALIAS_SLOT ? slot : undefined;
}

function readStoredCodexAccounts(): Map<string, string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
		if (!isRecord(parsed)) return new Map();

		const accounts = new Map<string, string>();
		for (const [providerId, credential] of Object.entries(parsed)) {
			const accountId = accountIdOf(credential);
			if (accountId && isManagedProvider(providerId)) accounts.set(providerId, accountId);
		}
		return accounts;
	} catch {
		return new Map();
	}
}

function rebindModel(model: Model<"openai-codex-responses">, provider: string): Model<"openai-codex-responses"> {
	return model.provider === provider ? model : { ...model, provider };
}

function rebindContext(context: Context, fromProvider: string, toProvider: string): Context {
	if (fromProvider === toProvider) return context;
	return {
		...context,
		messages: context.messages.map((message) =>
			message.role === "assistant" && message.provider === fromProvider
				? { ...message, provider: toProvider }
				: message,
		),
	};
}

function rebindMessage(message: AssistantMessage, provider: string): AssistantMessage {
	return message.provider === provider ? message : { ...message, provider };
}

function rebindEvent(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: rebindMessage(event.message, provider) };
	if (event.type === "error") return { ...event, error: rebindMessage(event.error, provider) };
	return { ...event, partial: rebindMessage(event.partial, provider) };
}

function streamError(model: Model<"openai-codex-responses">, provider: string, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function aliasStream(
	stream: ReturnType<CodexProvider["stream"]>,
	provider: string,
	model: Model<"openai-codex-responses">,
): ReturnType<CodexProvider["stream"]> {
	if (provider === NATIVE_PROVIDER_ID) return stream;

	const aliased = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of stream) aliased.push(rebindEvent(event, provider));
			aliased.end();
		} catch (error) {
			aliased.push({ type: "error", reason: "error", error: streamError(model, provider, error) });
			aliased.end();
		}
	})();
	return aliased;
}

function duplicateError(providerId: string): Error {
	return new Error(
		`This Codex account is already signed in as ${providerId}. ` +
		"Log out that account or use a different subscription.",
	);
}

function wrapProvider(
	native: CodexProvider,
	providerId: string,
	onLogin: (providerId: string) => void,
	inFlightAccounts: Map<string, string>,
): CodexProvider {
	const nativeOAuth = native.auth.oauth;
	if (!nativeOAuth) throw new Error("Native openai-codex provider has no OAuth flow");

	const oauth = {
		...nativeOAuth,
		login: async (interaction: Parameters<typeof nativeOAuth.login>[0]): Promise<OAuthCredential> => {
			const credential = await nativeOAuth.login(interaction);
			const accountId = accountIdOf(credential);
			if (!accountId) throw new Error("OpenAI Codex login returned no account identity");

			for (const [existingProvider, existingAccountId] of [
				...readStoredCodexAccounts(),
				...inFlightAccounts,
			]) {
				if (existingProvider !== providerId && existingAccountId === accountId) {
					throw duplicateError(existingProvider);
				}
			}

			inFlightAccounts.set(providerId, accountId);
			try {
				onLogin(providerId);
				return credential;
			} finally {
				inFlightAccounts.delete(providerId);
			}
		},
	};

	const provider: CodexProvider = {
		id: providerId,
		name: providerId === NATIVE_PROVIDER_ID
			? native.name
			: `${native.name} (Account ${aliasSlot(providerId) ?? providerId})`,
		baseUrl: native.baseUrl,
		headers: native.headers,
		auth: { ...native.auth, oauth },
		getModels: () => native.getModels().map((model) => rebindModel(model, providerId)),
		filterModels: native.filterModels
			? (models, credential) => native.filterModels!(
				models.map((model) => rebindModel(model, NATIVE_PROVIDER_ID)),
				credential,
			).map((model) => rebindModel(model, providerId))
			: undefined,
		refreshModels: native.refreshModels
			? (context) => native.refreshModels!(context)
			: undefined,
		stream: (model, context, options) => aliasStream(
			native.stream(
				rebindModel(model, NATIVE_PROVIDER_ID),
				rebindContext(context, providerId, NATIVE_PROVIDER_ID),
				options,
			),
			providerId,
			model,
		),
		streamSimple: (model, context, options) => aliasStream(
			native.streamSimple(
				rebindModel(model, NATIVE_PROVIDER_ID),
				rebindContext(context, providerId, NATIVE_PROVIDER_ID),
				options,
			),
			providerId,
			model,
		),
	};

	if (native.fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) => aliasStream(
			native.fetchDeferred!(
				rebindModel(model, NATIVE_PROVIDER_ID),
				{ ...handle, provider: NATIVE_PROVIDER_ID },
				options,
			),
			providerId,
			model,
		);
	}
	if (native.cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => native.cancelDeferred!(
			rebindModel(model, NATIVE_PROVIDER_ID),
			{ ...handle, provider: NATIVE_PROVIDER_ID },
			options,
		);
	}

	return provider;
}

export function registerCodexAccounts(
	pi: ExtensionAPI,
	nativeProvider: CodexProvider = openaiCodexProvider(),
): void {
	const storedAccounts = readStoredCodexAccounts();
	const inFlightAccounts = new Map<string, string>();
	const registeredSlots = new Set<number>();

	const registerAlias = (slot: number) => {
		if (registeredSlots.has(slot)) return;
		registeredSlots.add(slot);
		const providerId = `${ALIAS_PREFIX}${slot}`;
		pi.registerProvider(wrapProvider(nativeProvider, providerId, onLogin, inFlightAccounts));
	};

	function registerNextEmptySlot(): void {
		let slot = FIRST_ALIAS_SLOT;
		while (registeredSlots.has(slot)) slot++;
		registerAlias(slot);
	}

	function onLogin(providerId: string): void {
		const slot = aliasSlot(providerId);
		if (slot !== undefined) registeredSlots.add(slot);
		registerNextEmptySlot();
	}

	pi.registerProvider(wrapProvider(nativeProvider, NATIVE_PROVIDER_ID, onLogin, inFlightAccounts));

	const storedAliasSlots = [...storedAccounts.keys()]
		.map(aliasSlot)
		.filter((slot): slot is number => slot !== undefined)
		.sort((a, b) => a - b);
	for (const slot of storedAliasSlots) registerAlias(slot);
	registerNextEmptySlot();
}

export default function codexAccountsExtension(pi: ExtensionAPI): void {
	registerCodexAccounts(pi);
}

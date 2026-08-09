import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type CodexModel = Model<"openai-codex-responses">;
type CodexProvider = Provider<"openai-codex-responses">;

type JsonRecord = Record<string, unknown>;

const NATIVE_PROVIDER_ID = "openai-codex";
const CODEX_ALIAS_PATTERN = /^openai-codex-([2-9]|[1-9]\d+)$/;
const NO_ACCOUNTS_MESSAGE = "No Codex OAuth accounts found. Run /login and select OpenAI Codex.";

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthCredential(value: unknown): value is JsonRecord & { type: "oauth" } {
	return isRecord(value) && value.type === "oauth";
}

function discoverCodexSlots(): Set<number> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
	} catch {
		return new Set();
	}
	if (!isRecord(parsed)) return new Set();

	const slots = new Set<number>();
	for (const [providerId, credential] of Object.entries(parsed)) {
		if (!isOAuthCredential(credential)) continue;
		if (providerId === NATIVE_PROVIDER_ID) {
			slots.add(1);
			continue;
		}
		const match = CODEX_ALIAS_PATTERN.exec(providerId);
		if (match) slots.add(Number(match[1]));
	}
	return slots;
}

function nativeModel(model: CodexModel): CodexModel {
	return model.provider === NATIVE_PROVIDER_ID ? model : { ...model, provider: NATIVE_PROVIDER_ID };
}

function aliasModel(model: CodexModel, provider: string): CodexModel {
	return model.provider === provider ? model : { ...model, provider };
}

function nativeContext(context: Context, alias: string): Context {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== "assistant" || message.provider !== alias) return message;
			const canonical = { ...message, provider: NATIVE_PROVIDER_ID };
			if (message.deferred) canonical.deferred = { ...message.deferred, provider: NATIVE_PROVIDER_ID };
			return canonical;
		}),
	};
}

function aliasMessage(message: AssistantMessage, provider: string): AssistantMessage {
	const aliased = { ...message, provider };
	if (message.deferred) aliased.deferred = { ...message.deferred, provider };
	return aliased;
}

function aliasEvent(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: aliasMessage(event.message, provider) };
	if (event.type === "error") return { ...event, error: aliasMessage(event.error, provider) };
	return { ...event, partial: aliasMessage(event.partial, provider) };
}

function emptyErrorMessage(model: CodexModel, provider: string, error: unknown): AssistantMessage {
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
	source: AssistantMessageEventStream,
	model: CodexModel,
	provider: string,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) output.push(aliasEvent(event, provider));
			output.end();
		} catch (error) {
			const message = emptyErrorMessage(model, provider, error);
			output.push({ type: "error", reason: "error", error: message });
			output.end();
		}
	})();
	return output;
}

export function createCodexAliasProvider(native: CodexProvider, slot: number): CodexProvider {
	const providerId = `${NATIVE_PROVIDER_ID}-${slot}`;
	const models = native.getModels().map((model) => aliasModel(model, providerId));
	const provider: CodexProvider = {
		id: providerId,
		name: `OpenAI Codex #${slot}`,
		baseUrl: native.baseUrl,
		headers: native.headers,
		auth: native.auth,
		getModels: () => models,
		stream: (model, context, options?: ApiStreamOptions<"openai-codex-responses">) =>
			aliasStream(native.stream(nativeModel(model), nativeContext(context, providerId), options), model, providerId),
		streamSimple: (model, context, options?: SimpleStreamOptions) =>
			aliasStream(native.streamSimple(nativeModel(model), nativeContext(context, providerId), options), model, providerId),
	};

	if (native.filterModels) {
		provider.filterModels = (available, credential) =>
			native
				.filterModels!(available.map(nativeModel), credential)
				.map((model) => aliasModel(model, providerId));
	}
	if (native.fetchDeferred) {
		provider.fetchDeferred = (model, handle, options?: DeferredFetchOptions) =>
			aliasStream(
				native.fetchDeferred!(nativeModel(model), { ...handle, provider: NATIVE_PROVIDER_ID }, options),
				model,
				providerId,
			);
	}
	if (native.cancelDeferred) {
		provider.cancelDeferred = (model, handle, options?: DeferredCancelOptions) =>
			native.cancelDeferred!(nativeModel(model), { ...handle, provider: NATIVE_PROVIDER_ID }, options);
	}
	return provider;
}

export default function multiCodex(pi: ExtensionAPI): void {
	const native = openaiCodexProvider();
	const registered = new Map<number, CodexProvider>();

	const registerSlot = (slot: number): void => {
		if (slot === 1 || registered.has(slot)) return;
		const provider = createCodexAliasProvider(native, slot);
		pi.registerProvider(provider);
		registered.set(slot, provider);
	};

	const syncSlots = (): Set<number> => {
		const slots = discoverCodexSlots();
		for (const slot of [...slots].sort((a, b) => a - b)) registerSlot(slot);
		return slots;
	};

	syncSlots();

	pi.on("session_start", (_event, ctx) => {
		const slots = syncSlots();
		if (slots.size === 0) ctx.ui.notify(NO_ACCOUNTS_MESSAGE, "warning");
	});

	pi.registerCommand("codex-add", {
		description: "enroll another OpenAI Codex OAuth slot",
		handler: async (_args, ctx) => {
			const slots = syncSlots();
			if (!slots.has(1)) {
				ctx.ui.notify("Run /login and select OpenAI Codex for slot 1 first.", "warning");
				return;
			}

			const used = new Set([...slots, ...registered.keys()]);
			let slot = 2;
			while (used.has(slot)) slot++;
			registerSlot(slot);
			ctx.ui.notify(`Codex slot ${slot} ready. Run /login and select OpenAI Codex #${slot}.`, "info");
		},
	});
}

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

import { fetchCodexUsage, type CodexAllowanceWindow } from "./codex-usage.ts";

const NATIVE_PROVIDER_ID = "openai-codex";
const ALIAS_PREFIX = `${NATIVE_PROVIDER_ID}-account-`;
const FIRST_ALIAS_SLOT = 2;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SNAPSHOT_FILE = "codex-accounts.json";
type CodexProvider = Provider<"openai-codex-responses">;

export interface CodexAccountSnapshot {
	accountId: string;
	allowance: number;
	windows: CodexAllowanceWindow[];
	fetchedAt: number;
}

export interface CodexAccountState {
	providerId: string;
	accountId: string;
	allowance: number | undefined;
	available: boolean;
}

export interface CodexAccountsOptions {
	fetch?: typeof fetch;
	now?: () => number;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
}

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

function validPercent(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validResetAt(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function snapshotOf(value: unknown): CodexAccountSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const accountId = accountIdOf(value);
	if (!accountId || !validPercent(value.allowance) || !validResetAt(value.fetchedAt)) {
		return undefined;
	}
	if (!Array.isArray(value.windows)) return undefined;

	const windows: CodexAllowanceWindow[] = [];
	for (const window of value.windows) {
		if (!isRecord(window) || !validPercent(window.remainingPercent) || !validResetAt(window.resetAt)) {
			return undefined;
		}
		windows.push({ remainingPercent: window.remainingPercent, resetAt: window.resetAt });
	}
	return { accountId, allowance: value.allowance, windows, fetchedAt: value.fetchedAt };
}

function readStoredCodexAccounts(): Map<string, string> | undefined {
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
		return undefined;
	}
}

function readUsageSnapshots(): Record<string, CodexAccountSnapshot> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), SNAPSHOT_FILE), "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.accounts)) return {};

		const snapshots: Record<string, CodexAccountSnapshot> = {};
		for (const [providerId, value] of Object.entries(parsed.accounts)) {
			const snapshot = isManagedProvider(providerId) ? snapshotOf(value) : undefined;
			if (snapshot) snapshots[providerId] = snapshot;
		}
		return snapshots;
	} catch {
		return {};
	}
}

async function writeUsageSnapshots(
	snapshots: Record<string, CodexAccountSnapshot>,
	signal: AbortSignal,
	canCommit: () => boolean,
): Promise<boolean> {
	const path = join(getAgentDir(), SNAPSHOT_FILE);
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, JSON.stringify({ accounts: snapshots }, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	if (signal.aborted || !canCommit()) {
		await rm(temporaryPath, { force: true });
		return false;
	}
	renameSync(temporaryPath, path);
	return true;
}

function compareProviderIds(left: string, right: string): number {
	const leftSlot = left === NATIVE_PROVIDER_ID ? 1 : aliasSlot(left) ?? Number.MAX_SAFE_INTEGER;
	const rightSlot = right === NATIVE_PROVIDER_ID ? 1 : aliasSlot(right) ?? Number.MAX_SAFE_INTEGER;
	return leftSlot - rightSlot || left.localeCompare(right);
}

export function rankCodexAccounts(
	accounts: ReadonlyMap<string, string>,
	snapshots: Readonly<Record<string, CodexAccountSnapshot>>,
	currentProviderId?: string,
	now = Date.now(),
): CodexAccountState[] {
	return [...accounts]
		.filter(([providerId]) => isManagedProvider(providerId))
		.map(([providerId, accountId]) => {
			const snapshot = snapshots[providerId];
			const windows = snapshot?.accountId === accountId
				? snapshot.windows.filter((window) => window.resetAt > now)
				: [];
			const allowance = windows.length > 0
				? Math.min(...windows.map((window) => window.remainingPercent))
				: undefined;
			return { providerId, accountId, allowance, available: allowance === undefined || allowance > 0 };
		})
		.sort((left, right) => {
			if (left.available !== right.available) return left.available ? -1 : 1;
			const leftMeasured = left.allowance !== undefined;
			const rightMeasured = right.allowance !== undefined;
			if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
			if (leftMeasured && rightMeasured && left.allowance !== right.allowance) {
				return right.allowance! - left.allowance!;
			}
			if (leftMeasured && rightMeasured && left.providerId === currentProviderId) return -1;
			if (leftMeasured && rightMeasured && right.providerId === currentProviderId) return 1;
			return compareProviderIds(left.providerId, right.providerId);
		});
}

function rebindModel(model: Model<"openai-codex-responses">, provider: string): Model<"openai-codex-responses"> {
	return model.provider === provider ? model : { ...model, provider };
}

function rebindContext(context: Context): Context {
	return {
		...context,
		messages: context.messages.map((message) =>
			message.role === "assistant" && isManagedProvider(message.provider)
				? { ...message, provider: NATIVE_PROVIDER_ID }
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

function reserveLoginUntilPersisted(
	credential: OAuthCredential,
	providerId: string,
	accountId: string,
	onLogin: (providerId: string) => void,
	inFlightAccounts: Map<string, string>,
	signal: AbortSignal,
): OAuthCredential {
	inFlightAccounts.set(providerId, accountId);
	let reconciled = false;
	const reconcile = () => {
		if (reconciled) return;
		reconciled = true;
		signal.removeEventListener("abort", scheduleReconcile);
		inFlightAccounts.delete(providerId);
		if (readStoredCodexAccounts()?.get(providerId) === accountId) onLogin(providerId);
	};
	const scheduleReconcile = () => setTimeout(reconcile, 0);
	signal.addEventListener("abort", scheduleReconcile, { once: true });

	const reservedCredential = { ...credential };
	Object.defineProperty(reservedCredential, "toJSON", {
		value: () => {
			// Models.login serializes this value immediately before its synchronous auth.json write.
			scheduleReconcile();
			return credential;
		},
	});
	return reservedCredential;
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
				...(readStoredCodexAccounts() ?? new Map()),
				...inFlightAccounts,
			]) {
				if (existingProvider !== providerId && existingAccountId === accountId) {
					throw duplicateError(existingProvider);
				}
			}

			return reserveLoginUntilPersisted(
				credential,
				providerId,
				accountId,
				onLogin,
				inFlightAccounts,
				interaction.signal,
			);
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
				rebindContext(context),
				options,
			),
			providerId,
			model,
		),
		streamSimple: (model, context, options) => aliasStream(
			native.streamSimple(
				rebindModel(model, NATIVE_PROVIDER_ID),
				rebindContext(context),
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
	options: CodexAccountsOptions = {},
): void {
	const storedAccounts = readStoredCodexAccounts() ?? new Map();
	const inFlightAccounts = new Map<string, string>();
	const registeredSlots = new Set<number>();
	const now = options.now ?? Date.now;
	const fetcher = options.fetch ?? fetch;
	const schedule = options.setInterval ?? setInterval;
	const cancelSchedule = options.clearInterval ?? clearInterval;
	let snapshots = readUsageSnapshots();
	let activeRefresh: AbortController | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let sessionActive = false;
	let lifecycleGeneration = 0;

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

	const refresh = async (ctx: ExtensionContext, generation: number): Promise<void> => {
		if (!sessionActive || generation !== lifecycleGeneration || activeRefresh) return;
		const controller = new AbortController();
		activeRefresh = controller;
		const isCurrent = () =>
			sessionActive &&
			generation === lifecycleGeneration &&
			activeRefresh === controller &&
			!controller.signal.aborted;
		try {
			const accounts = readStoredCodexAccounts();
			if (!accounts || !isCurrent()) return;
			const nextSnapshots = { ...snapshots };
			let changed = false;
			for (const [providerId, snapshot] of Object.entries(nextSnapshots)) {
				if (accounts.get(providerId) !== snapshot.accountId) {
					delete nextSnapshots[providerId];
					changed = true;
				}
			}

			const updates = await Promise.all([...accounts.keys()].map(async (providerId) => {
				try {
					const accountId = accounts.get(providerId);
					if (!accountId) return undefined;
					const auth = await ctx.modelRegistry.getProviderAuth(providerId);
					if (
						!isCurrent() ||
						readStoredCodexAccounts()?.get(providerId) !== accountId ||
						typeof auth?.auth.apiKey !== "string" ||
						auth.auth.apiKey.length === 0
					) {
						return undefined;
					}
					const usage = await fetchCodexUsage(auth.auth.apiKey, accountId, fetcher, now(), controller.signal);
					if (!usage) return undefined;
					return [providerId, { accountId, ...usage, fetchedAt: now() }] as const;
				} catch {
					return undefined;
				}
			}));
			if (!isCurrent()) return;

			for (const update of updates) {
				if (!update) continue;
				nextSnapshots[update[0]] = update[1];
				changed = true;
			}
			if (changed && await writeUsageSnapshots(nextSnapshots, controller.signal, isCurrent)) {
				snapshots = nextSnapshots;
			}
		} catch {
			// Background telemetry must never interrupt Pi.
		} finally {
			if (activeRefresh === controller) activeRefresh = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (!sessionActive) {
			sessionActive = true;
			lifecycleGeneration++;
		}
		const generation = lifecycleGeneration;
		queueMicrotask(() => void refresh(ctx, generation));
		if (refreshTimer === undefined) {
			refreshTimer = schedule(() => {
				const timerGeneration = lifecycleGeneration;
				queueMicrotask(() => void refresh(ctx, timerGeneration));
			}, REFRESH_INTERVAL_MS);
		}
	});
	pi.on("session_shutdown", () => {
		sessionActive = false;
		lifecycleGeneration++;
		if (refreshTimer !== undefined) {
			cancelSchedule(refreshTimer);
			refreshTimer = undefined;
		}
		activeRefresh?.abort();
		activeRefresh = undefined;
	});

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

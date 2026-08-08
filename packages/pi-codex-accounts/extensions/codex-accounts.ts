import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";

import { fetchCodexUsage, type CodexAllowanceWindow, type CodexUsage } from "./lib/codex-usage.ts";

const NATIVE_PROVIDER_ID = "openai-codex";
const ALIAS_PREFIX = `${NATIVE_PROVIDER_ID}-account-`;
const FIRST_ALIAS_SLOT = 2;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const USAGE_REQUEST_TIMEOUT_MS = 30 * 1000;
const SNAPSHOT_LOCK_STALE_MS = 60 * 1000;
const SNAPSHOT_FILE = "codex-accounts.json";
const ROUTING_MODE_ENTRY = "codex-accounts-mode";
const STATUS_KEY = "codex-accounts";
const RATE_LIMIT_MESSAGE = "Codex account reached usage limit. Run /codex-accounts next to switch accounts.";
const ALL_ACCOUNTS_EXHAUSTED_MESSAGE = "All Codex accounts are exhausted. Wait for a quota reset before trying again.";
type CodexProvider = Provider<"openai-codex-responses">;
type RoutingMode = "auto" | "manual";

function nativeCodexProvider(): CodexProvider {
	const provider = builtinProviders().find(({ id }) => id === NATIVE_PROVIDER_ID);
	if (!provider) throw new Error(`Native provider ${NATIVE_PROVIDER_ID} is unavailable`);
	return provider as CodexProvider;
}

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
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
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

function isInitialUnknownModel(model: Model<any> | undefined): boolean {
	return model?.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
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

async function acquireSnapshotLock(path: string): Promise<{ release: () => Promise<void> } | undefined> {
	const lockPath = `${path}.lock`;
	const token = randomUUID();
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(lockPath, "wx");
		await handle.writeFile(token, "utf8");
	} catch (error) {
		await handle?.close();
		if (handle) await rm(lockPath, { force: true });
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		try {
			if (Date.now() - statSync(lockPath).mtimeMs > SNAPSHOT_LOCK_STALE_MS) {
				await rm(lockPath, { force: true });
			}
		} catch {
			// The other writer may have released the lock between stat and cleanup.
		}
		// ponytail: skip contended writes; the next refresh retries instead of waiting cross-process.
		return undefined;
	}

	const lockHandle = handle;
	return {
		release: async () => {
			await lockHandle.close();
			try {
				if (readFileSync(lockPath, "utf8") === token) await rm(lockPath, { force: true });
			} catch {
				// The lock was already reclaimed or removed.
			}
		},
	};
}

async function writeUsageSnapshots(
	accounts: ReadonlyMap<string, string>,
	updates: readonly (readonly [string, CodexAccountSnapshot])[],
	signal: AbortSignal,
	canCommit: () => boolean,
): Promise<Record<string, CodexAccountSnapshot> | undefined> {
	const path = join(getAgentDir(), SNAPSHOT_FILE);
	if (signal.aborted || !canCommit()) return undefined;
	const lock = await acquireSnapshotLock(path);
	if (!lock) return undefined;

	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		if (signal.aborted || !canCommit()) return undefined;
		const snapshots = readUsageSnapshots();
		let changed = false;
		for (const [providerId, snapshot] of Object.entries(snapshots)) {
			if (accounts.get(providerId) !== snapshot.accountId) {
				delete snapshots[providerId];
				changed = true;
			}
		}
		for (const [providerId, snapshot] of updates) {
			const previous = snapshots[providerId];
			if (!previous || snapshot.fetchedAt >= previous.fetchedAt) {
				snapshots[providerId] = snapshot;
				changed = true;
			}
		}
		if (!changed) return snapshots;

		await writeFile(temporaryPath, JSON.stringify({ accounts: snapshots }, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		if (signal.aborted || !canCommit()) {
			await rm(temporaryPath, { force: true });
			return undefined;
		}
		renameSync(temporaryPath, path);
		return snapshots;
	} finally {
		await rm(temporaryPath, { force: true });
		await lock.release();
	}
}

async function fetchUsageWithTimeout(
	accessToken: string,
	accountId: string,
	fetcher: typeof fetch,
	now: () => number,
	parentSignal: AbortSignal,
	schedule: typeof setTimeout,
	cancelSchedule: typeof clearTimeout,
): Promise<CodexUsage | undefined> {
	if (parentSignal.aborted) return undefined;
	const requestController = new AbortController();
	let resolveResult!: (usage: CodexUsage | undefined) => void;
	let settled = false;
	const result = new Promise<CodexUsage | undefined>((resolve) => {
		resolveResult = resolve;
	});
	const finish = (usage: CodexUsage | undefined): void => {
		if (settled) return;
		settled = true;
		resolveResult(usage);
	};
	const abort = (): void => {
		requestController.abort();
		finish(undefined);
	};
	parentSignal.addEventListener("abort", abort, { once: true });
	const timeout = schedule(abort, USAGE_REQUEST_TIMEOUT_MS);
	void fetchCodexUsage(accessToken, accountId, fetcher, now(), requestController.signal).then(finish, () => finish(undefined));
	try {
		return await result;
	} finally {
		cancelSchedule(timeout);
		parentSignal.removeEventListener("abort", abort);
	}
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

function restoredRoutingMode(ctx: ExtensionContext): RoutingMode {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry.type === "custom" &&
			entry.customType === ROUTING_MODE_ENTRY &&
			isRecord(entry.data) &&
			(entry.data.mode === "auto" || entry.data.mode === "manual")
		) {
			return entry.data.mode;
		}
	}
	return "auto";
}

function accountLabel(providerId: string): string {
	return providerId === NATIVE_PROVIDER_ID ? "A1" : `A${aliasSlot(providerId) ?? "?"}`;
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
	nativeProvider: CodexProvider = nativeCodexProvider(),
	options: CodexAccountsOptions = {},
): void {
	const storedAccounts = readStoredCodexAccounts() ?? new Map();
	const inFlightAccounts = new Map<string, string>();
	const registeredSlots = new Set<number>();
	let emptyAliasSlot: number | undefined;
	const now = options.now ?? Date.now;
	const fetcher = options.fetch ?? fetch;
	const schedule = options.setInterval ?? setInterval;
	const cancelSchedule = options.clearInterval ?? clearInterval;
	const defer = options.setTimeout ?? setTimeout;
	const cancelDefer = options.clearTimeout ?? clearTimeout;
	let snapshots = readUsageSnapshots();
	let activeRefresh: AbortController | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let sessionActive = false;
	let lifecycleGeneration = 0;
	let mode: RoutingMode = "auto";
	let sessionStarted = false;
	let runActive = false;
	let rateLimitWarned = false;
	let extensionModelChanges = 0;

	const updateStatus = (ctx: ExtensionContext): void => {
		const model = ctx.model;
		if (!model || !isManagedProvider(model.provider)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const account = rankCodexAccounts(
			readStoredCodexAccounts() ?? new Map(),
			snapshots,
			model.provider,
			now(),
		).find((state) => state.providerId === model.provider);
		const allowance = account?.allowance === undefined ? "?" : `${account.allowance}%`;
		ctx.ui.setStatus(STATUS_KEY, `Codex ${accountLabel(model.provider)} · ${allowance} · ${mode}`);
	};

	const setMode = (nextMode: RoutingMode, ctx: ExtensionContext): void => {
		if (mode !== nextMode) {
			mode = nextMode;
			pi.appendEntry(ROUTING_MODE_ENTRY, { mode });
		}
		updateStatus(ctx);
	};

	const switchProvider = async (ctx: ExtensionContext, providerId: string): Promise<boolean> => {
		const model = ctx.model;
		if (!model || !isManagedProvider(model.provider) || model.provider === providerId) return false;
		const thinkingLevel = pi.getThinkingLevel();
		extensionModelChanges++;
		try {
			if (!await pi.setModel({ ...model, provider: providerId })) return false;
			pi.setThinkingLevel(thinkingLevel);
			return true;
		} finally {
			extensionModelChanges--;
		}
	};

	const registerAlias = (slot: number) => {
		if (registeredSlots.has(slot)) return;
		registeredSlots.add(slot);
		const providerId = `${ALIAS_PREFIX}${slot}`;
		pi.registerProvider(wrapProvider(nativeProvider, providerId, onLogin, inFlightAccounts));
	};

	function registerNextEmptySlot(): void {
		if (emptyAliasSlot !== undefined) return;
		let slot = FIRST_ALIAS_SLOT;
		while (registeredSlots.has(slot)) slot++;
		registerAlias(slot);
		emptyAliasSlot = slot;
	}

	function onLogin(providerId: string): void {
		if (aliasSlot(providerId) === emptyAliasSlot) {
			emptyAliasSlot = undefined;
			registerNextEmptySlot();
		}
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
					const usage = await fetchUsageWithTimeout(
						auth.auth.apiKey,
						accountId,
						fetcher,
						now,
						controller.signal,
						defer,
						cancelDefer,
					);
					if (!usage) return undefined;
					return [providerId, { accountId, ...usage, fetchedAt: now() }] as const;
				} catch {
					return undefined;
				}
			}));
			if (!isCurrent()) return;
			const nextSnapshots = await writeUsageSnapshots(
				accounts,
				updates.filter((update): update is readonly [string, CodexAccountSnapshot] => update !== undefined),
				controller.signal,
				isCurrent,
			);
			if (nextSnapshots && isCurrent()) {
				snapshots = nextSnapshots;
				updateStatus(ctx);
			}
		} catch {
			// Background telemetry must never interrupt Pi.
		} finally {
			if (activeRefresh === controller) activeRefresh = undefined;
		}
	};

	pi.on("session_start", (event, ctx) => {
		sessionStarted = true;
		const restoredMode = restoredRoutingMode(ctx);
		mode = event.reason === "new" || event.reason === "fork" ? "auto" : restoredMode;
		if (event.reason === "fork" && restoredMode !== mode) {
			pi.appendEntry(ROUTING_MODE_ENTRY, { mode });
		}
		updateStatus(ctx);
		if (!sessionActive) {
			sessionActive = true;
			lifecycleGeneration++;
		}
		const generation = lifecycleGeneration;
		defer(() => void refresh(ctx, generation), 0);
		if (refreshTimer === undefined) {
			refreshTimer = schedule(() => {
				const timerGeneration = lifecycleGeneration;
				defer(() => void refresh(ctx, timerGeneration), 0);
			}, REFRESH_INTERVAL_MS);
		}
	});
	pi.on("session_tree", (_event, ctx) => {
		mode = restoredRoutingMode(ctx);
		updateStatus(ctx);
	});
	pi.on("session_shutdown", () => {
		sessionActive = false;
		runActive = false;
		lifecycleGeneration++;
		if (refreshTimer !== undefined) {
			cancelSchedule(refreshTimer);
			refreshTimer = undefined;
		}
		activeRefresh?.abort();
		activeRefresh = undefined;
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		runActive = true;
		rateLimitWarned = false;
		if (mode === "auto" && isManagedProvider(ctx.model?.provider ?? "")) {
			const ranked = rankCodexAccounts(
				readStoredCodexAccounts() ?? new Map(),
				snapshots,
				ctx.model?.provider,
				now(),
			);
			const target = ranked.find((account) => account.available);
			if (target) {
				await switchProvider(ctx, target.providerId);
			} else if (ranked.length > 0 && ranked.every((account) => account.allowance !== undefined && !account.available)) {
				runActive = false;
				ctx.ui.notify(ALL_ACCOUNTS_EXHAUSTED_MESSAGE, "warning");
				ctx.abort();
				return;
			}
		}
		updateStatus(ctx);
	});
	pi.on("agent_settled", () => {
		runActive = false;
	});
	pi.on("model_select", (event, ctx) => {
		if (extensionModelChanges > 0) return;
		if (sessionStarted && event.source !== "restore" && !isInitialUnknownModel(event.previousModel)) setMode("manual", ctx);
		else updateStatus(ctx);
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (
			runActive &&
			event.status === 429 &&
			!rateLimitWarned &&
			isManagedProvider(ctx.model?.provider ?? "")
		) {
			rateLimitWarned = true;
			ctx.ui.notify(RATE_LIMIT_MESSAGE, "warning");
			ctx.abort();
		}
	});
	pi.registerCommand("codex-accounts", {
		description: "Switch to the next available Codex account or restore automatic routing.",
		handler: async (args, ctx) => {
			if (args.trim() === "auto") {
				setMode("auto", ctx);
				return;
			}
			if (args.trim() !== "next") {
				ctx.ui.notify("Usage: /codex-accounts <next|auto>", "error");
				return;
			}
			if (runActive) return;
			const currentProviderId = ctx.model?.provider;
			const target = isManagedProvider(currentProviderId ?? "")
				? rankCodexAccounts(readStoredCodexAccounts() ?? new Map(), snapshots, currentProviderId, now())
					.find((account) => account.available && account.providerId !== currentProviderId)
				: undefined;
			if (!target || !await switchProvider(ctx, target.providerId)) return;
			setMode("manual", ctx);
			ctx.ui.notify(`Switched to Codex account ${accountLabel(target.providerId)}.`, "info");
		},
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

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type CodexModel = Model<"openai-codex-responses">;
type CodexProvider = Provider<"openai-codex-responses">;
type JsonRecord = Record<string, unknown>;
type Timer = ReturnType<typeof setInterval>;

type CodexOAuthCredential = JsonRecord & {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
};

type SlotIdentity = {
	accountId: string;
	accountHash: string;
	credential: CodexOAuthCredential;
};

type UsageSnapshot = {
	slot: number;
	accountHash: string;
	tier?: string;
	checkedAt: number;
	fetchedAt?: number;
	remaining?: number;
	reset?: number;
};

type UsageLock = {
	slot: number;
	owner: string;
	accountHash: string;
	heartbeatAt: number;
};

type UsageState = {
	slots: Map<number, UsageSnapshot>;
	locks: Map<number, UsageLock>;
};

type ParsedUsage = { remaining: number; reset: number; tier?: string };

const NATIVE_PROVIDER_ID = "openai-codex";
const CODEX_ALIAS_PATTERN = /^openai-codex-([2-9]|[1-9]\d+)$/;
const NO_ACCOUNTS_MESSAGE = "No Codex OAuth accounts found. Run /login and select OpenAI Codex.";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 5 * 60_000;
const LOCK_STALE_MS = 45_000;
const HEARTBEAT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 10_000;
const CACHE_MUTEX_RETRY_MS = 20;
const CLEANUP_TIMEOUT_MS = 250;
const cachePath = () => join(getAgentDir(), "config", "pi-multi-codex", "usage.json");
const cacheMutexPath = () => `${cachePath()}.lock`;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthCredential(value: unknown): value is CodexOAuthCredential {
	return (
		isRecord(value) &&
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function slotForProvider(providerId: string): number | undefined {
	if (providerId === NATIVE_PROVIDER_ID) return 1;
	const match = CODEX_ALIAS_PATTERN.exec(providerId);
	return match ? Number(match[1]) : undefined;
}

function readCodexCredentials(): Map<number, CodexOAuthCredential> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
	} catch {
		return new Map();
	}
	if (!isRecord(parsed)) return new Map();

	const credentials = new Map<number, CodexOAuthCredential>();
	for (const [providerId, credential] of Object.entries(parsed)) {
		const slot = slotForProvider(providerId);
		if (slot && isOAuthCredential(credential)) credentials.set(slot, credential);
	}
	return credentials;
}

function discoverCodexSlots(): Set<number> {
	return new Set(readCodexCredentials().keys());
}

function accountIdFromAccessToken(access: string): string | undefined {
	try {
		const encoded = access.split(".")[1];
		if (!encoded) return undefined;
		const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!isRecord(payload)) return undefined;
		const auth = payload["https://api.openai.com/auth"];
		if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) return undefined;
		return auth.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function identityFor(credential: CodexOAuthCredential | undefined): SlotIdentity | undefined {
	if (!credential) return undefined;
	const accountId = typeof credential.accountId === "string" && credential.accountId
		? credential.accountId
		: accountIdFromAccessToken(credential.access);
	if (!accountId) return undefined;
	return {
		accountId,
		accountHash: createHash("sha256").update(accountId).digest("hex"),
		credential,
	};
}

function currentIdentity(slot: number): SlotIdentity | undefined {
	return identityFor(readCodexCredentials().get(slot));
}

function validHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validSlot(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validTier(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

function readSnapshot(value: unknown): UsageSnapshot | undefined {
	if (!isRecord(value) || !validSlot(value.slot) || !validHash(value.accountHash) || !validTime(value.checkedAt)) return undefined;
	const successful = value.fetchedAt !== undefined || value.remaining !== undefined || value.reset !== undefined;
	if (successful && (!validTime(value.fetchedAt) || typeof value.remaining !== "number" || !Number.isFinite(value.remaining) || !validTime(value.reset))) {
		return undefined;
	}
	return {
		slot: value.slot,
		accountHash: value.accountHash,
		...(validTier(value.tier) ? { tier: value.tier } : {}),
		checkedAt: value.checkedAt,
		...(successful
			? {
				fetchedAt: value.fetchedAt as number,
				remaining: Math.max(0, Math.min(100, value.remaining as number)),
				reset: value.reset as number,
			}
			: {}),
	};
}

function readLock(value: unknown): UsageLock | undefined {
	if (!isRecord(value) || !validSlot(value.slot) || typeof value.owner !== "string" || !value.owner || !validHash(value.accountHash) || !validTime(value.heartbeatAt)) {
		return undefined;
	}
	return { slot: value.slot, owner: value.owner, accountHash: value.accountHash, heartbeatAt: value.heartbeatAt };
}

function parseState(value: unknown): UsageState {
	const state: UsageState = { slots: new Map(), locks: new Map() };
	if (!isRecord(value)) return state;
	for (const snapshot of Array.isArray(value.slots) ? value.slots : []) {
		const parsed = readSnapshot(snapshot);
		if (parsed) state.slots.set(parsed.slot, parsed);
	}
	for (const lock of Array.isArray(value.locks) ? value.locks : []) {
		const parsed = readLock(lock);
		if (parsed) state.locks.set(parsed.slot, parsed);
	}
	return state;
}

async function loadState(): Promise<UsageState> {
	try {
		return parseState(JSON.parse(await readFile(cachePath(), "utf8")));
	} catch {
		return { slots: new Map(), locks: new Map() };
	}
}

async function saveState(state: UsageState): Promise<void> {
	const file = cachePath();
	const directory = join(getAgentDir(), "config", "pi-multi-codex");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const data = `${JSON.stringify({
		slots: [...state.slots.values()].sort((a, b) => a.slot - b.slot),
		locks: [...state.locks.values()].sort((a, b) => a.slot - b.slot),
	})}\n`;
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

type CacheMutex = { directory: string; owner: string };

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function sleepUnref(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		let abort: () => void;
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		timer.unref?.();
		abort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

function cleanupSignal(): AbortSignal {
	const controller = new AbortController();
	void sleepUnref(CLEANUP_TIMEOUT_MS).then(() => controller.abort());
	return controller.signal;
}

async function acquireCacheMutex(signal?: AbortSignal): Promise<CacheMutex> {
	signal?.throwIfAborted();
	await mkdir(join(getAgentDir(), "config", "pi-multi-codex"), { recursive: true, mode: 0o700 });
	const directory = cacheMutexPath();
	const owner = randomUUID();
	const ownerFile = join(directory, "owner");
	while (true) {
		signal?.throwIfAborted();
		try {
			await mkdir(directory, { mode: 0o700 });
			try {
				signal?.throwIfAborted();
				await writeFile(ownerFile, owner, { encoding: "utf8", mode: 0o600, flag: "wx" });
				return { directory, owner };
			} catch (error) {
				await rm(directory, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(directory)).mtimeMs >= LOCK_STALE_MS) {
					await rm(directory, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			await sleepUnref(CACHE_MUTEX_RETRY_MS, signal);
		}
	}
}

async function releaseCacheMutex(mutex: CacheMutex): Promise<void> {
	try {
		if (await readFile(join(mutex.directory, "owner"), "utf8") !== mutex.owner) return;
		await rm(mutex.directory, { recursive: true, force: true });
	} catch {
		// Reclaimed or already released.
	}
}

async function withCacheMutex<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const mutex = await acquireCacheMutex(signal);
	try {
		signal?.throwIfAborted();
		return await operation();
	} finally {
		await releaseCacheMutex(mutex);
	}
}

function isFresh(snapshot: UsageSnapshot | undefined, identity: SlotIdentity, now: number): boolean {
	return Boolean(
		snapshot &&
		snapshot.accountHash === identity.accountHash &&
		validTime(snapshot.fetchedAt) &&
		snapshot.fetchedAt <= now &&
		now - snapshot.fetchedAt < REFRESH_MS,
	);
}

function checkedRecently(snapshot: UsageSnapshot | undefined, identity: SlotIdentity, now: number): boolean {
	return Boolean(snapshot && snapshot.accountHash === identity.accountHash && snapshot.checkedAt <= now && now - snapshot.checkedAt < REFRESH_MS);
}

function owns(lock: UsageLock | undefined, slot: number, owner: string, accountHash: string): boolean {
	return lock?.slot === slot && lock.owner === owner && lock.accountHash === accountHash;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resetTime(window: JsonRecord, now: number): number | undefined {
	const resetAt = window.reset_at;
	if (typeof resetAt === "number" && Number.isFinite(resetAt)) return resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
	if (typeof resetAt === "string") {
		const parsed = Date.parse(resetAt);
		if (Number.isFinite(parsed)) return parsed;
	}
	const resetAfter = numberValue(window.reset_after_seconds);
	return resetAfter === undefined || resetAfter < 0 ? undefined : now + resetAfter * 1000;
}

/** Extract seven-day window, or only usable window when service reports one. */
export function parseCodexUsage(value: unknown, now = Date.now()): ParsedUsage | undefined {
	if (!isRecord(value)) return undefined;
	const rateLimit = isRecord(value.rate_limit) ? value.rate_limit : value;
	const windows = Object.entries(rateLimit)
		.flatMap(([name, entry]) => (isRecord(entry) && numberValue(entry.used_percent) !== undefined && resetTime(entry, now) !== undefined ? [{ name, value: entry }] : []));
	const sevenDay = windows.find((window) => numberValue(window.value.limit_window_seconds) === 7 * 24 * 60 * 60)
		?? (windows.length === 1 ? windows[0] : undefined);
	if (!sevenDay) return undefined;
	const used = numberValue(sevenDay.value.used_percent);
	const reset = resetTime(sevenDay.value, now);
	if (used === undefined || reset === undefined) return undefined;
	const tier = validTier(value.plan_type) ? value.plan_type : validTier(value.tier) ? value.tier : undefined;
	return { remaining: Math.max(0, Math.min(100, 100 - used)), reset, ...(tier ? { tier } : {}) };
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "now";
	const minutes = Math.ceil(ms / 60_000);
	const days = Math.floor(minutes / (24 * 60));
	const hours = Math.floor((minutes % (24 * 60)) / 60);
	const mins = minutes % 60;
	return [days ? `${days}d` : "", hours ? `${hours}h` : "", mins || (!days && !hours) ? `${mins}m` : ""].filter(Boolean).join(" ");
}

class CodexQuotaStatus {
	private generation = 0;
	private session: AbortController | undefined;
	private timer: Timer | undefined;
	private readonly heartbeats = new Map<number, { owner: string; timer: Timer }>();
	private readonly active = new Map<number, Promise<void>>();
	private writes: Promise<void> = Promise.resolve();
	private readonly native: CodexProvider;

	constructor(native: CodexProvider) {
		this.native = native;
	}

	private async state(): Promise<UsageState> {
		await this.writes;
		return loadState();
	}

	private change<T>(change: (state: UsageState) => { value: T; write: boolean }, signal?: AbortSignal): Promise<T> {
		const operation = this.writes.then(() => withCacheMutex(async () => {
			signal?.throwIfAborted();
			const state = await loadState();
			signal?.throwIfAborted();
			const result = change(state);
			if (result.write) {
				signal?.throwIfAborted();
				await saveState(state);
			}
			return result.value;
		}, signal));
		this.writes = operation.then(() => undefined, () => undefined);
		return operation;
	}

	start(): void {
		this.stop();
		const session = new AbortController();
		this.session = session;
		const generation = ++this.generation;
		void this.refreshDue(generation, session);
		this.timer = setInterval(() => void this.refreshDue(generation, session), REFRESH_MS);
		this.timer.unref?.();
	}

	stop(): void {
		this.generation++;
		this.session?.abort();
		this.session = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const heartbeat of this.heartbeats.values()) clearInterval(heartbeat.timer);
		this.heartbeats.clear();
	}

	private alive(generation: number, session: AbortController): boolean {
		return this.generation === generation && this.session === session && !session.signal.aborted;
	}

	private async refreshDue(generation: number, session: AbortController): Promise<void> {
		const credentials = readCodexCredentials();
		await Promise.all([...credentials.entries()].map(async ([slot, credential]) => {
			if (!this.alive(generation, session) || this.active.has(slot)) return;
			const identity = identityFor(credential);
			if (!identity) return;
			const snapshot = (await this.state()).slots.get(slot);
			if (isFresh(snapshot, identity, Date.now()) || checkedRecently(snapshot, identity, Date.now())) return;
			this.launch(slot, identity, generation, session);
		})).catch(() => undefined);
	}

	private launch(slot: number, identity: SlotIdentity, generation: number, session: AbortController): void {
		if (this.active.has(slot)) return;
		const task = this.refreshSlot(slot, identity, generation, session);
		this.active.set(slot, task);
		void task.finally(() => {
			if (this.active.get(slot) === task) this.active.delete(slot);
		});
	}

	private async claim(slot: number, identity: SlotIdentity, signal: AbortSignal): Promise<string | undefined> {
		const owner = randomUUID();
		const claimed = await this.change((state) => {
			const now = Date.now();
			const snapshot = state.slots.get(slot);
			if (isFresh(snapshot, identity, now) || checkedRecently(snapshot, identity, now)) {
				return { value: false, write: false };
			}
			const lock = state.locks.get(slot);
			if (lock && lock.accountHash === identity.accountHash && lock.heartbeatAt <= now && now - lock.heartbeatAt < LOCK_STALE_MS) {
				return { value: false, write: false };
			}
			if (snapshot?.accountHash !== identity.accountHash) state.slots.delete(slot);
			state.locks.set(slot, { slot, owner, accountHash: identity.accountHash, heartbeatAt: now });
			return { value: true, write: true };
		}, signal);
		if (!claimed) return undefined;

		const lock = (await this.state()).locks.get(slot);
		return owns(lock, slot, owner, identity.accountHash) ? owner : undefined;
	}

	private startHeartbeat(slot: number, owner: string, accountHash: string, signal: AbortSignal): void {
		const timer = setInterval(() => {
			void this.change((state) => {
				const lock = state.locks.get(slot);
				if (!lock || !owns(lock, slot, owner, accountHash)) return { value: false, write: false };
				state.locks.set(slot, { ...lock, heartbeatAt: Date.now() });
				return { value: true, write: true };
			}, signal).then((kept) => {
				if (!kept) this.stopHeartbeat(slot, owner);
			}).catch(() => this.stopHeartbeat(slot, owner));
		}, HEARTBEAT_MS);
		timer.unref?.();
		this.heartbeats.set(slot, { owner, timer });
	}

	private stopHeartbeat(slot: number, owner: string): void {
		const heartbeat = this.heartbeats.get(slot);
		if (!heartbeat || heartbeat.owner !== owner) return;
		clearInterval(heartbeat.timer);
		this.heartbeats.delete(slot);
	}

	private async stillOwn(slot: number, owner: string, accountHash: string): Promise<boolean> {
		return owns((await this.state()).locks.get(slot), slot, owner, accountHash);
	}

	private identityStillCurrent(slot: number, accountHash: string): boolean {
		return currentIdentity(slot)?.accountHash === accountHash;
	}

	private async resolveAuth(credential: CodexOAuthCredential, signal: AbortSignal): Promise<string | undefined> {
		const oauth = this.native.auth.oauth;
		if (!oauth) return undefined;
		const auth = await raceWithSignal(oauth.toAuth(credential), signal);
		return auth.apiKey;
	}

	private async finish(
		slot: number,
		owner: string,
		identity: SlotIdentity,
		outcome: ParsedUsage | undefined,
		generation: number,
		session: AbortController,
	): Promise<boolean> {
		if (!this.alive(generation, session)) return false;
		return this.change((state) => {
			if (!this.alive(generation, session) || !this.identityStillCurrent(slot, identity.accountHash)) {
				return { value: false, write: false };
			}
			const lock = state.locks.get(slot);
			if (!owns(lock, slot, owner, identity.accountHash)) return { value: false, write: false };
			const previous = state.slots.get(slot);
			const checkedAt = Date.now();
			if (outcome) {
				state.slots.set(slot, {
					slot,
					accountHash: identity.accountHash,
					...(outcome.tier ? { tier: outcome.tier } : {}),
					checkedAt,
					fetchedAt: checkedAt,
					remaining: outcome.remaining,
					reset: outcome.reset,
				});
			} else {
				state.slots.set(slot, previous?.accountHash === identity.accountHash
					? { ...previous, checkedAt }
					: { slot, accountHash: identity.accountHash, checkedAt });
			}
			state.locks.delete(slot);
			return { value: true, write: true };
		}, session.signal);
	}

	private async release(slot: number, owner: string, signal: AbortSignal): Promise<void> {
		await this.change((state) => {
			const lock = state.locks.get(slot);
			if (!lock || lock.owner !== owner) return { value: undefined, write: false };
			state.locks.delete(slot);
			return { value: undefined, write: true };
		}, signal);
	}

	private async refreshSlot(slot: number, identity: SlotIdentity, generation: number, session: AbortController): Promise<void> {
		let owner: string | undefined;
		let discard = false;
		try {
			owner = await this.claim(slot, identity, session.signal);
			if (!owner || !this.alive(generation, session)) return;
			this.startHeartbeat(slot, owner, identity.accountHash, session.signal);

			const authSignal = AbortSignal.any([session.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
			const apiKey = await this.resolveAuth(identity.credential, authSignal);
			if (!apiKey) throw new Error("Codex OAuth auth did not provide a bearer token.");
			if (!this.alive(generation, session) || !this.identityStillCurrent(slot, identity.accountHash) || !(await this.stillOwn(slot, owner, identity.accountHash))) {
				discard = true;
				return;
			}

			const fetchSignal = AbortSignal.any([session.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
			const response = await raceWithSignal(fetch(USAGE_URL, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"ChatGPT-Account-Id": identity.accountId,
				},
				signal: fetchSignal,
			}), fetchSignal);
			if (!response.ok) throw new Error(`Codex usage request failed (${response.status}).`);
			const usage = parseCodexUsage(await raceWithSignal(response.json(), fetchSignal));
			if (!usage) throw new Error("Codex usage response has no usable seven-day window.");
			if (!this.identityStillCurrent(slot, identity.accountHash) || !(await this.stillOwn(slot, owner, identity.accountHash))) {
				discard = true;
				return;
			}
			await this.finish(slot, owner, identity, usage, generation, session);
		} catch {
			if (!session.signal.aborted && !discard && owner) await this.finish(slot, owner, identity, undefined, generation, session);
		} finally {
			if (owner) {
				this.stopHeartbeat(slot, owner);
				await this.release(slot, owner, session.signal.aborted ? cleanupSignal() : session.signal).catch(() => undefined);
			}
		}
	}

	async statusLines(): Promise<string[]> {
		const credentials = readCodexCredentials();
		const state = await this.state();
		const now = Date.now();
		return [...credentials.entries()]
			.sort(([left], [right]) => left - right)
			.map(([slot, credential]) => {
				const identity = identityFor(credential);
				const snapshot = state.slots.get(slot);
				if (!identity || !snapshot || snapshot.accountHash !== identity.accountHash || !validTime(snapshot.fetchedAt) || typeof snapshot.remaining !== "number" || !validTime(snapshot.reset)) {
					return `Codex slot ${slot}: unavailable`;
				}
				const tier = snapshot.tier ? ` (${snapshot.tier})` : "";
				const status = isFresh(snapshot, identity, now) ? "measured" : "stale";
				return `Codex slot ${slot}${tier}: ${formatPercent(snapshot.remaining)}% remaining, resets in ${formatDuration(snapshot.reset - now)} (${status})`;
			});
	}
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
	const quota = new CodexQuotaStatus(native);
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
		quota.start();
		if (slots.size === 0) ctx.ui.notify(NO_ACCOUNTS_MESSAGE, "warning");
	});

	pi.on("session_shutdown", () => quota.stop());

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

	pi.registerCommand("codex-status", {
		description: "show shared Codex seven-day quota status",
		handler: async (_args, ctx: ExtensionContext) => {
			const lines = await quota.statusLines();
			ctx.ui.notify(lines.length ? lines.join("\n") : "No Codex OAuth accounts found.", "info");
		},
	});
}

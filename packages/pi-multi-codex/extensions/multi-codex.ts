import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";
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
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
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
};

type SlotAuthResolver = (slot: number) => Promise<string | undefined>;
type QuotaRefresh = { session: AbortController; resolveSlotAuth: SlotAuthResolver };

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
const AGENT_STARTED_ENTRY = "pi-multi-codex:agent-started";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 5 * 60_000;
const LOCK_STALE_MS = 45_000;
const HEARTBEAT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 10_000;
const CACHE_MUTEX_RETRY_MS = 20;
const CLEANUP_TIMEOUT_MS = 250;
const cachePath = () => join(getAgentDir(), "config", "pi-multi-codex", "usage.json");
const cacheMutexPath = () => `${cachePath()}.mutex`;

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
	const slot = match ? Number(match[1]) : undefined;
	return validSlot(slot) ? slot : undefined;
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

function emptyState(): UsageState {
	return { slots: new Map(), locks: new Map() };
}

function loadStateSync(): UsageState {
	try {
		return parseState(JSON.parse(readFileSync(cachePath(), "utf8")));
	} catch {
		return emptyState();
	}
}

async function loadState(signal?: AbortSignal): Promise<UsageState> {
	try {
		return parseState(JSON.parse(await readFile(cachePath(), { encoding: "utf8", signal })));
	} catch (error) {
		signal?.throwIfAborted();
		return emptyState();
	}
}

async function saveState(state: UsageState, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const file = cachePath();
	const directory = join(getAgentDir(), "config", "pi-multi-codex");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const data = `${JSON.stringify({
		slots: [...state.slots.values()].sort((a, b) => a.slot - b.slot),
		locks: [...state.locks.values()].sort((a, b) => a.slot - b.slot),
	})}\n`;
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
		signal?.throwIfAborted();
		await rename(temporary, file);
		signal?.throwIfAborted();
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function withCacheMutex<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	await mkdir(join(getAgentDir(), "config", "pi-multi-codex"), { recursive: true, mode: 0o700 });
	let release: (() => Promise<void>) | undefined;
	while (!release) {
		signal?.throwIfAborted();
		try {
			const compromised = new AbortController();
			release = await lock(cachePath(), {
				lockfilePath: cacheMutexPath(),
				realpath: false,
				stale: LOCK_STALE_MS,
				update: HEARTBEAT_MS,
				retries: 0,
				onCompromised: (error) => compromised.abort(error),
			});
			const operationSignal = signal ? AbortSignal.any([signal, compromised.signal]) : compromised.signal;
			try {
				operationSignal.throwIfAborted();
				return await raceWithSignal(operation(operationSignal), operationSignal);
			} finally {
				await release().catch(() => undefined);
			}
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && String(error.code) === "ELOCKED")) throw error;
			await delay(CACHE_MUTEX_RETRY_MS, undefined, { signal, ref: false });
		}
	}
	throw new Error("Cache mutex acquisition ended unexpectedly.");
}

function isFresh(snapshot: UsageSnapshot | undefined, identity: SlotIdentity, now: number): boolean {
	return Boolean(
		snapshot &&
		snapshot.accountHash === identity.accountHash &&
		validTime(snapshot.fetchedAt) &&
		validTime(snapshot.reset) &&
		snapshot.fetchedAt <= now &&
		snapshot.reset > now &&
		now - snapshot.fetchedAt < REFRESH_MS,
	);
}

function checkedRecently(snapshot: UsageSnapshot | undefined, identity: SlotIdentity, now: number): boolean {
	return Boolean(
		snapshot &&
		snapshot.accountHash === identity.accountHash &&
		snapshot.checkedAt <= now &&
		now - snapshot.checkedAt < REFRESH_MS &&
		(!validTime(snapshot.fetchedAt) || (validTime(snapshot.reset) && snapshot.reset > now)),
	);
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
		?? (windows.length === 1 && numberValue(windows[0].value.limit_window_seconds) === undefined ? windows[0] : undefined);
	if (!sevenDay) return undefined;
	const used = numberValue(sevenDay.value.used_percent);
	const reset = resetTime(sevenDay.value, now);
	if (used === undefined || reset === undefined || reset <= now) return undefined;
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
	private refreshContext: QuotaRefresh | undefined;
	private timer: Timer | undefined;
	private readonly heartbeats = new Map<number, { owner: string; timer: Timer }>();
	private readonly active = new Map<number, Promise<void>>();
	private writes: Promise<void> = Promise.resolve();
	private onChange: () => void = () => undefined;

	setOnChange(onChange: () => void): void {
		this.onChange = onChange;
	}

	snapshot(slot: number): UsageSnapshot | undefined {
		return loadStateSync().slots.get(slot);
	}

	private async state(): Promise<UsageState> {
		await this.writes;
		return loadState();
	}

	private change<T>(change: (state: UsageState) => { value: T; write: boolean }, signal?: AbortSignal): Promise<T> {
		const operation = this.writes.then(() => withCacheMutex(async (operationSignal) => {
			operationSignal.throwIfAborted();
			const state = await loadState(operationSignal);
			operationSignal.throwIfAborted();
			const result = change(state);
			if (result.write) {
				operationSignal.throwIfAborted();
				await saveState(state, operationSignal);
			}
			return result.value;
		}, signal));
		this.writes = operation.then(() => undefined, () => undefined);
		return operation;
	}

	start(resolveSlotAuth: SlotAuthResolver): void {
		this.stop();
		this.refreshContext = { session: new AbortController(), resolveSlotAuth };
		this.requestRefresh();
	}

	stop(): void {
		this.refreshContext?.session.abort();
		this.refreshContext = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const heartbeat of this.heartbeats.values()) clearInterval(heartbeat.timer);
		this.heartbeats.clear();
	}

	requestRefresh(): void {
		const refresh = this.refreshContext;
		if (!refresh) return;
		void this.refreshDue(refresh)
			.catch(() => undefined)
			.then(() => {
				if (this.refreshContext === refresh) this.scheduleRefresh();
			});
	}

	private scheduleRefresh(): void {
		const refresh = this.refreshContext;
		if (!refresh) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;

		const now = Date.now();
		const state = loadStateSync();
		let dueAt: number | undefined;
		for (const [slot, credential] of readCodexCredentials()) {
			if (this.active.has(slot)) continue;
			const identity = identityFor(credential);
			if (!identity) continue;
			const snapshot = state.slots.get(slot);
			const lock = state.locks.get(slot);
			const lockDue = lock && lock.accountHash === identity.accountHash && lock.heartbeatAt <= now && now - lock.heartbeatAt < LOCK_STALE_MS
				? lock.heartbeatAt + LOCK_STALE_MS + 1
				: undefined;
			const snapshotDue = isFresh(snapshot, identity, now)
				? Math.min(snapshot!.fetchedAt! + REFRESH_MS, snapshot!.reset!) + 1
				: checkedRecently(snapshot, identity, now)
					? snapshot!.checkedAt + REFRESH_MS + 1
					: now;
			const next = lockDue ?? snapshotDue;
			dueAt = dueAt === undefined ? next : Math.min(dueAt, next);
		}
		if (dueAt === undefined) return;
		const delay = Math.max(0, dueAt - now);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.refreshContext === refresh) this.requestRefresh();
		}, delay);
		this.timer.unref?.();
	}

	private async refreshDue(refresh: QuotaRefresh): Promise<void> {
		const credentials = readCodexCredentials();
		const state = await this.state();
		await Promise.all([...credentials.entries()].map(async ([slot, credential]) => {
			if (this.refreshContext !== refresh || this.active.has(slot)) return;
			const identity = identityFor(credential);
			if (!identity) return;
			const snapshot = state.slots.get(slot);
			if (isFresh(snapshot, identity, Date.now()) || checkedRecently(snapshot, identity, Date.now())) return;
			this.launch(slot, identity, refresh);
		})).catch(() => undefined);
	}

	private launch(slot: number, identity: SlotIdentity, refresh: QuotaRefresh): void {
		if (this.active.has(slot)) return;
		const task = this.refreshSlot(slot, identity, refresh);
		this.active.set(slot, task);
		const cleanup = () => {
			if (this.active.get(slot) !== task) return;
			this.active.delete(slot);
			if (this.refreshContext === refresh) this.scheduleRefresh();
			else this.requestRefresh();
		};
		void task.then(cleanup, cleanup);
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

	private async finish(
		slot: number,
		owner: string,
		identity: SlotIdentity,
		outcome: ParsedUsage | undefined,
		refresh: QuotaRefresh,
	): Promise<boolean> {
		if (this.refreshContext !== refresh) return false;
		const finished = await this.change((state) => {
			if (this.refreshContext !== refresh || !this.identityStillCurrent(slot, identity.accountHash)) {
				return { value: false, write: false };
			}
			const lock = state.locks.get(slot);
			if (!owns(lock, slot, owner, identity.accountHash)) return { value: false, write: false };
			const previous = state.slots.get(slot);
			const checkedAt = Date.now();
			if (outcome && outcome.reset > checkedAt) {
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
				state.slots.set(slot, previous?.accountHash === identity.accountHash && (!validTime(previous.reset) || previous.reset > checkedAt)
					? { ...previous, checkedAt }
					: { slot, accountHash: identity.accountHash, checkedAt });
			}
			state.locks.delete(slot);
			return { value: true, write: true };
		}, refresh.session.signal);
		if (finished) this.onChange();
		return finished;
	}

	private async release(slot: number, owner: string, signal: AbortSignal): Promise<void> {
		await this.change((state) => {
			const lock = state.locks.get(slot);
			if (!lock || lock.owner !== owner) return { value: undefined, write: false };
			state.locks.delete(slot);
			return { value: undefined, write: true };
		}, signal);
	}

	private async refreshSlot(slot: number, identity: SlotIdentity, refresh: QuotaRefresh): Promise<void> {
		let owner: string | undefined;
		let discard = false;
		try {
			owner = await this.claim(slot, identity, refresh.session.signal);
			if (!owner || this.refreshContext !== refresh) return;
			this.startHeartbeat(slot, owner, identity.accountHash, refresh.session.signal);

			const authSignal = AbortSignal.any([refresh.session.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
			const apiKey = await raceWithSignal(refresh.resolveSlotAuth(slot), authSignal);
			if (!apiKey) throw new Error("Codex OAuth auth did not provide a bearer token.");
			if (this.refreshContext !== refresh || !this.identityStillCurrent(slot, identity.accountHash) || !(await this.stillOwn(slot, owner, identity.accountHash))) {
				discard = true;
				return;
			}

			const fetchSignal = AbortSignal.any([refresh.session.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
			const response = await fetch(USAGE_URL, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"ChatGPT-Account-Id": identity.accountId,
				},
				signal: fetchSignal,
			});
			if (!response.ok) throw new Error(`Codex usage request failed (${response.status}).`);
			const usage = parseCodexUsage(await raceWithSignal(response.json(), fetchSignal));
			if (!usage) throw new Error("Codex usage response has no usable seven-day window.");
			if (!this.identityStillCurrent(slot, identity.accountHash) || !(await this.stillOwn(slot, owner, identity.accountHash))) {
				discard = true;
				return;
			}
			await this.finish(slot, owner, identity, usage, refresh);
		} catch {
			if (!refresh.session.signal.aborted && !discard && owner) await this.finish(slot, owner, identity, undefined, refresh);
		} finally {
			if (owner) {
				this.stopHeartbeat(slot, owner);
				await this.release(slot, owner, refresh.session.signal.aborted ? AbortSignal.timeout(CLEANUP_TIMEOUT_MS) : refresh.session.signal).catch(() => undefined);
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
			if (message.role !== "assistant") return message;
			const provider = message.provider === alias ? NATIVE_PROVIDER_ID : message.provider === NATIVE_PROVIDER_ID ? alias : message.provider;
			if (provider === message.provider) return message;
			const rewritten = { ...message, provider };
			if (message.deferred) rewritten.deferred = { ...message.deferred, provider };
			return rewritten;
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

function providerForSlot(slot: number): string {
	return slot === 1 ? NATIVE_PROVIDER_ID : `${NATIVE_PROVIDER_ID}-${slot}`;
}

function isManagedProvider(provider: string | undefined): boolean {
	return provider !== undefined && slotForProvider(provider) !== undefined;
}

function sessionHasAgentWork(ctx: ExtensionContext): boolean {
	return ctx.sessionManager?.getBranch?.().some((entry) =>
		entry.type === "message" || (entry.type === "custom" && entry.customType === AGENT_STARTED_ENTRY),
	) ?? false;
}

export default function multiCodex(pi: ExtensionAPI): void {
	const native = builtinProviders().find((provider) => provider.id === NATIVE_PROVIDER_ID) as CodexProvider | undefined;
	if (!native) return;
	const quota = new CodexQuotaStatus();
	const registered = new Map<number, CodexProvider>();
	let sessionContext: ExtensionContext | undefined;
	let automaticOpen = false;
	let automaticCandidate: Model<any> | undefined;

	const registerSlot = (slot: number): void => {
		if (slot === 1 || registered.has(slot)) return;
		const provider = createCodexAliasProvider(native, slot);
		pi.registerProvider(provider);
		registered.set(slot, provider);
	};

	const syncSlots = (): Set<number> => {
		const slots = new Set(readCodexCredentials().keys());
		for (const slot of [...slots].sort((a, b) => a - b)) registerSlot(slot);
		return slots;
	};

	const allowsModel = (ctx: ExtensionContext, model: Model<any>, slot: number): boolean => {
		const scopedModels = ctx.scopedModels ?? [];
		return scopedModels.length === 0 || scopedModels.some(({ model: scoped }) => scoped.provider === providerForSlot(slot) && scoped.id === model.id);
	};

	const freshSlots = (ctx: ExtensionContext, model: Model<any>): { slot: number; remaining: number }[] => {
		const state = loadStateSync();
		const now = Date.now();
		return [...readCodexCredentials().entries()]
			.flatMap(([slot, credential]) => {
				if ((slot !== 1 && !registered.has(slot)) || !allowsModel(ctx, model, slot)) return [];
				const identity = identityFor(credential);
				const snapshot = state.slots.get(slot);
				if (!identity || !isFresh(snapshot, identity, now) || typeof snapshot?.remaining !== "number") return [];
				return [{ slot, remaining: snapshot.remaining }];
			});
	};

	const selectFreshSlot = (ctx: ExtensionContext, model: Model<any>): number | undefined => {
		const candidates = freshSlots(ctx, model);
		if (candidates.length === 0) return undefined;
		const currentSlot = slotForProvider(model.provider);
		const remaining = Math.max(...candidates.map((candidate) => candidate.remaining));
		const tied = candidates.filter((candidate) => candidate.remaining === remaining);
		return tied.find((candidate) => candidate.slot === currentSlot)?.slot
			?? Math.min(...tied.map((candidate) => candidate.slot));
	};

	const footerText = (ctx: ExtensionContext): string | undefined => {
		const model = ctx.model;
		const slot = slotForProvider(model?.provider ?? "");
		if (!model || !slot) return undefined;
		const identity = currentIdentity(slot);
		const snapshot = quota.snapshot(slot);
		const prefix = `Codex #${slot}`;
		if (!identity || !snapshot || snapshot.accountHash !== identity.accountHash || !validTime(snapshot.fetchedAt) || typeof snapshot.remaining !== "number" || !validTime(snapshot.reset)) {
			return `${prefix} · unavailable`;
		}
		if (!isFresh(snapshot, identity, Date.now())) return `${prefix} · stale`;
		const text = `${prefix} · ${formatPercent(snapshot.remaining)}% · 7d ${formatDuration(snapshot.reset - Date.now())}`;
		const color = snapshot.remaining >= 50 ? "success" : snapshot.remaining >= 25 ? "warning" : "error";
		return ctx.ui.theme?.fg ? ctx.ui.theme.fg(color, text) : text;
	};

	const updateFooter = (ctx: ExtensionContext | undefined = sessionContext): void => {
		if (ctx) ctx.ui.setStatus?.("pi-multi-codex", footerText(ctx));
	};

	const updatePendingCandidate = (ctx: ExtensionContext): void => {
		if (!automaticOpen || !ctx.model || !isManagedProvider(ctx.model.provider)) return;
		const slot = selectFreshSlot(ctx, ctx.model);
		automaticCandidate = slot ? { ...ctx.model, provider: providerForSlot(slot) } : ctx.model;
	};

	quota.setOnChange(() => {
		if (!sessionContext) return;
		syncSlots();
		updatePendingCandidate(sessionContext);
		updateFooter();
	});

	syncSlots();

	pi.on("session_start", (_event, ctx) => {
		const slots = syncSlots();
		sessionContext = ctx;
		automaticOpen = isManagedProvider(ctx.model?.provider) && !sessionHasAgentWork(ctx);
		automaticCandidate = ctx.model;
		// Cache-only ranking happens before background refresh starts.
		updatePendingCandidate(ctx);
		updateFooter(ctx);
		quota.start(async (slot) => (await ctx.modelRegistry.getProviderAuth(providerForSlot(slot)))?.auth.apiKey);
		if (slots.size === 0) ctx.ui.notify(NO_ACCOUNTS_MESSAGE, "warning");
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!automaticOpen) return;
		const model = ctx.model;
		updatePendingCandidate(ctx);
		// Close before await: no timer, refresh, queued turn, or provider event can route later.
		automaticOpen = false;
		const candidate = automaticCandidate;
		if (!model || !candidate || !isManagedProvider(model.provider) || candidate.id !== model.id || candidate.provider === model.provider) return;
		await pi.setModel(candidate);
		updateFooter(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		automaticOpen = false;
		if (!sessionHasAgentWork(ctx)) pi.appendEntry(AGENT_STARTED_ENTRY);
	});
	pi.on("session_shutdown", () => {
		automaticOpen = false;
		sessionContext = undefined;
		quota.stop();
	});
	pi.on("model_select", (_event, ctx) => {
		// Explicit selector choice wins over startup routing.
		automaticOpen = false;
		syncSlots();
		quota.requestRefresh();
		updateFooter(ctx);
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

	pi.registerCommand("codex-status", {
		description: "show shared Codex seven-day quota status",
		handler: async (_args, ctx: ExtensionContext) => {
			const lines = await quota.statusLines();
			ctx.ui.notify(lines.length ? lines.join("\n") : NO_ACCOUNTS_MESSAGE, "info");
		},
	});

	pi.registerCommand("codex-switch", {
		description: "switch current Codex model to another authenticated slot",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model || !isManagedProvider(model.provider)) {
				ctx.ui.notify("Select an OpenAI Codex model before switching slots.", "warning");
				return;
			}

			const authenticated = [...syncSlots()]
				.filter((slot) => slot === 1 || registered.has(slot))
				.sort((left, right) => left - right);
			const scopedModels = ctx.scopedModels ?? [];
			const slots = authenticated.filter((slot) => allowsModel(ctx, model, slot));
			const currentSlot = slotForProvider(model.provider);
			if (slots.length === 0 || (scopedModels.length > 0 && authenticated.some((slot) => !allowsModel(ctx, model, slot)) && slots.every((slot) => slot === currentSlot))) {
				ctx.ui.notify(
					scopedModels.length > 0
						? "No authenticated Codex slot matches this session's model scope. Restart Pi or update scoped models."
						: "No authenticated Codex slots found. Run /login and select OpenAI Codex.",
					"warning",
				);
				return;
			}

			const choices = slots.map((slot) => `Codex #${slot}`);
			const selected = await ctx.ui.select("Switch Codex slot", choices);
			const index = selected ? choices.indexOf(selected) : -1;
			if (index < 0) return;
			automaticOpen = false;
			const provider = providerForSlot(slots[index]);
			if (provider !== model.provider) await pi.setModel({ ...model, provider });
			updateFooter(ctx);
		},
	});
}

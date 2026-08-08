import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";

import { rankCodexAccounts, registerCodexAccounts } from "../extensions/codex-accounts.ts";

const NATIVE_PROVIDER_ID = "openai-codex";
const ALIAS_PROVIDER_ID = "openai-codex-account-2";
const MODEL: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-luna",
	name: "GPT-5.6 Luna",
	api: "openai-codex-responses",
	provider: NATIVE_PROVIDER_ID,
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

function credential(accountId: string): OAuthCredential {
	return {
		type: "oauth",
		accountId,
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 60_000,
	};
}

function fakeNativeProvider(
	login: (accountId: string) => OAuthCredential | Promise<OAuthCredential>,
): Provider<"openai-codex-responses"> {
	const oauth = {
		name: "OpenAI Codex",
		async login() {
			return login("account-2");
		},
		async refresh(value: OAuthCredential) {
			return value;
		},
		async toAuth(value: OAuthCredential) {
			return { apiKey: value.access };
		},
	};

	return {
		id: NATIVE_PROVIDER_ID,
		name: "OpenAI Codex",
		baseUrl: MODEL.baseUrl,
		auth: { oauth },
		getModels: () => [MODEL],
		stream(model, context) {
			const stream = createAssistantMessageEventStream();
			const previous = context.messages.find((message) => message.role === "assistant");
			const itemId = previous ? "call-2|item-2" : "call-1|item-1";
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: itemId, name: "echo", arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end();
			return stream;
		},
		streamSimple(model, context) {
			return this.stream(model, context);
		},
	};
}

type RecordedHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

function fakePi(
	providers: Provider<"openai-codex-responses">[],
	onRegister?: (provider: Provider<"openai-codex-responses">) => void,
	handlers?: Map<string, RecordedHandler>,
): ExtensionAPI {
	return {
		on(event: string, handler: RecordedHandler) {
			handlers?.set(event, handler);
		},
		registerProvider(provider: Provider<"openai-codex-responses">) {
			providers.push(provider);
			onRegister?.(provider);
		},
	} as unknown as ExtensionAPI;
}

async function registerRuntime(
	authPath: string,
	providers: Provider<"openai-codex-responses">[],
	native: Provider<"openai-codex-responses">,
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
	registerCodexAccounts(
		fakePi(providers, (provider) => runtime.registerNativeProvider(provider)),
		native,
	);
	return runtime;
}

function loginInteraction() {
	return {
		signal: new AbortController().signal,
		prompt: async () => "",
		notify: () => {},
	};
}

async function settleAuthJson(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await predicate()) return;
		await settleAuthJson();
	}
	throw new Error("Timed out waiting for background work");
}

async function withAuthDir<T>(callback: (authPath: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return await callback(join(dir, "auth.json"));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
}

test("registers A1, authenticated aliases, and one next empty slot", async () => {
	await withAuthDir(async (authPath) => {
		await writeFile(authPath, JSON.stringify({
			openaiCodex: { accountId: "ignored" },
			"openai-codex": credential("account-1"),
			"openai-codex-account-2": credential("account-2"),
		}));

		const providers: Provider<"openai-codex-responses">[] = [];
		registerCodexAccounts(fakePi(providers), fakeNativeProvider(() => credential("account-3")));
		assert.deepEqual(providers.map((provider) => provider.id), [
			NATIVE_PROVIDER_ID,
			"openai-codex-account-2",
			"openai-codex-account-3",
		]);
	});
});

test("rejects duplicate account IDs before Pi can persist a login", async () => {
	await withAuthDir(async (authPath) => {
		const existing = credential("account-1");
		await writeFile(authPath, JSON.stringify({ "openai-codex": existing }));
		const providers: Provider<"openai-codex-responses">[] = [];
		registerCodexAccounts(fakePi(providers), fakeNativeProvider(() => credential("account-1")));

		const alias = providers.find((provider) => provider.id === ALIAS_PROVIDER_ID);
		assert.ok(alias?.auth.oauth);
		await assert.rejects(
			alias.auth.oauth.login({
				signal: new AbortController().signal,
				prompt: async () => "",
				notify: () => {},
			}),
			/account is already signed in as openai-codex/,
		);
		const persisted = JSON.parse(await readFile(authPath, "utf8"));
		assert.deepEqual(persisted, { "openai-codex": existing });
	});
});

test("allows a logged-out account to enroll under another alias", async () => {
	await withAuthDir(async (authPath) => {
		await writeFile(authPath, JSON.stringify({ [ALIAS_PROVIDER_ID]: credential("account-2") }));
		const providers: Provider<"openai-codex-responses">[] = [];
		const runtime = await registerRuntime(authPath, providers, fakeNativeProvider(() => credential("account-2")));

		await writeFile(authPath, JSON.stringify({}));
		const nextAlias = providers.find((provider) => provider.id === "openai-codex-account-3");
		assert.ok(nextAlias);
		await runtime.login(nextAlias.id, "oauth", loginInteraction());
		await settleAuthJson();

		assert.ok(providers.some((provider) => provider.id === "openai-codex-account-4"));
	});
});

test("successful numbered login exposes the following empty slot after Pi saves auth.json", async () => {
	await withAuthDir(async (authPath) => {
		const providers: Provider<"openai-codex-responses">[] = [];
		const signedIn = credential("account-2");
		const runtime = await registerRuntime(authPath, providers, fakeNativeProvider(() => signedIn));
		const alias = providers.find((provider) => provider.id === ALIAS_PROVIDER_ID);
		assert.ok(alias);

		await runtime.login(alias.id, "oauth", loginInteraction());
		assert.equal(JSON.parse(await readFile(authPath, "utf8"))[ALIAS_PROVIDER_ID].accountId, "account-2");
		await settleAuthJson();
		assert.deepEqual(providers.map((provider) => provider.id), [
			NATIVE_PROVIDER_ID,
			ALIAS_PROVIDER_ID,
			"openai-codex-account-3",
		]);
	});
});

test("keeps duplicate accounts reserved until Pi saves auth.json", async () => {
	await withAuthDir(async (authPath) => {
		await writeFile(authPath, JSON.stringify({ [ALIAS_PROVIDER_ID]: credential("account-old") }));
		const providers: Provider<"openai-codex-responses">[] = [];
		const runtime = await registerRuntime(authPath, providers, fakeNativeProvider(() => credential("account-new")));

		const first = runtime.login("openai-codex-account-3", "oauth", loginInteraction());
		const duplicate = runtime.login(ALIAS_PROVIDER_ID, "oauth", loginInteraction());
		await assert.rejects(duplicate, /account is already signed in as openai-codex-account-3/);
		await first;
		await settleAuthJson();

		const persisted = JSON.parse(await readFile(authPath, "utf8"));
		assert.equal(persisted["openai-codex-account-3"].accountId, "account-new");
		assert.equal(persisted[ALIAS_PROVIDER_ID].accountId, "account-old");
	});
});

test("failed Pi auth.json save releases the reservation without publishing a slot", async () => {
	await withAuthDir(async (authPath) => {
		await writeFile(authPath, JSON.stringify({ [ALIAS_PROVIDER_ID]: credential("account-old") }));
		const providers: Provider<"openai-codex-responses">[] = [];
		const runtime = await registerRuntime(authPath, providers, fakeNativeProvider(() => credential("account-new")));

		await chmod(authPath, 0o400);
		try {
			await assert.rejects(
				runtime.login("openai-codex-account-3", "oauth", loginInteraction()),
				/Credential store modify failed/,
			);
			await settleAuthJson();
			assert.ok(!providers.some((provider) => provider.id === "openai-codex-account-4"));
		} finally {
			await chmod(authPath, 0o600);
		}

		await runtime.login(ALIAS_PROVIDER_ID, "oauth", loginInteraction());
		await settleAuthJson();
		assert.ok(providers.some((provider) => provider.id === "openai-codex-account-4"));
	});
});

test("rebinding preserves Codex tool-call item IDs across A2 to A3 and A1 turns", async () => {
	await withAuthDir(async (authPath) => {
		await writeFile(authPath, JSON.stringify({ [ALIAS_PROVIDER_ID]: credential("account-2") }));
		const providers: Provider<"openai-codex-responses">[] = [];
		const native = fakeNativeProvider(() => credential("account-2"));
		const nativeContexts: Context[] = [];
		const originalStream = native.stream;
		native.stream = (model, context, options) => {
			nativeContexts.push(context);
			return originalStream(model, context, options);
		};
		registerCodexAccounts(fakePi(providers), native);
		const alias = providers.find((provider) => provider.id === ALIAS_PROVIDER_ID);
		assert.ok(alias);

		const first = await alias.stream({ ...MODEL, provider: ALIAS_PROVIDER_ID }, { messages: [] }).result();
		const secondContext: Context = {
			messages: [
				first,
				{ role: "toolResult", toolCallId: "call-1|item-1", toolName: "echo", content: [], isError: false, timestamp: Date.now() },
			],
		};

		assert.equal(first.provider, ALIAS_PROVIDER_ID);
		for (const providerId of ["openai-codex-account-3", NATIVE_PROVIDER_ID]) {
			const provider = providers.find((entry) => entry.id === providerId);
			assert.ok(provider);
			const second = await provider.stream({ ...MODEL, provider: providerId }, secondContext).result();

			assert.equal(second.provider, providerId);
			const nativeContext = nativeContexts.at(-1);
			assert.equal(nativeContext?.messages[0]?.role, "assistant");
			assert.equal(nativeContext?.messages[0]?.provider, NATIVE_PROVIDER_ID);
			assert.equal(
				nativeContext?.messages[0]?.role === "assistant"
					? nativeContext.messages[0].content[0]?.type === "toolCall"
						? nativeContext.messages[0].content[0].id
						: undefined
					: undefined,
				"call-1|item-1",
			);
		}
	});
});

test("refreshes credential-free allowance snapshots concurrently and retains stale data", async () => {
	await withAuthDir(async (authPath) => {
		const now = 1_800_000_000_000;
		const future = (now + 60_000) / 1000;
		const expired = (now - 60_000) / 1000;
		const storedAuth = {
			"openai-codex": credential("account-1"),
			"openai-codex-account-2": credential("account-2"),
			"openai-codex-account-3": credential("account-3"),
		};
		await writeFile(authPath, JSON.stringify(storedAuth));

		const providers: Provider<"openai-codex-responses">[] = [];
		const handlers = new Map<string, RecordedHandler>();
		const requests: {
			input: string;
			headers: Headers;
			accountId: string;
			signal: AbortSignal | null | undefined;
			resolve: (response: Response) => void;
		}[] = [];
		const usageFetch: typeof fetch = async (input, init) => {
			const headers = new Headers(init?.headers);
			const accountId = headers.get("chatgpt-account-id");
			if (!accountId) throw new Error("missing account header");
			return new Promise<Response>((resolve) => {
				requests.push({ input: input.toString(), headers, accountId, signal: init?.signal, resolve });
			});
		};
		let refresh: (() => void) | undefined;
		let cleared: unknown;
		const schedule = ((callback: () => void, delay: number) => {
			assert.equal(delay, 5 * 60 * 1000);
			refresh = callback;
			return 1;
		}) as typeof setInterval;
		const cancelSchedule = ((timer: unknown) => {
			cleared = timer;
		}) as typeof clearInterval;
		const context = {
			modelRegistry: {
				async getProviderAuth(providerId: string) {
					return { auth: { apiKey: `current-${providerId}` } };
				},
			},
		} as unknown as ExtensionContext;

		registerCodexAccounts(fakePi(providers, undefined, handlers), fakeNativeProvider(() => credential("account-4")), {
			fetch: usageFetch,
			now: () => now,
			setInterval: schedule,
			clearInterval: cancelSchedule,
		});
		const start = handlers.get("session_start");
		assert.ok(start);
		assert.equal(start({ type: "session_start", reason: "startup" }, context), undefined);
		await waitFor(() => requests.length === 3);

		assert.equal(refresh !== undefined, true);
		for (const request of requests) {
			assert.equal(request.input, "https://chatgpt.com/backend-api/wham/usage");
			assert.equal(request.headers.get("authorization"), `Bearer current-openai-codex${request.accountId === "account-1" ? "" : `-account-${request.accountId.slice(-1)}`}`);
			assert.equal(request.headers.get("chatgpt-account-id"), request.accountId);
		}

		requests.find((request) => request.accountId === "account-1")?.resolve(new Response(JSON.stringify({
			rate_limit: {
				primary_window: { used_percent: 20, reset_at: future },
				expired_window: { remaining_percent: 0, reset_at: expired },
			},
		}), { status: 200 }));
		requests.find((request) => request.accountId === "account-2")?.resolve(new Response(JSON.stringify({
			rate_limit: { any_window: { remaining_percent: 45, reset_at: future } },
		}), { status: 200 }));
		requests.find((request) => request.accountId === "account-3")?.resolve(new Response(JSON.stringify({
			rate_limit: { malformed_window: { used_percent: "bad", reset_at: future } },
		}), { status: 200 }));

		const cachePath = join(dirname(authPath), "codex-accounts.json");
		await waitFor(async () => {
			try {
				const cache = JSON.parse(await readFile(cachePath, "utf8"));
				return cache.accounts?.[NATIVE_PROVIDER_ID]?.allowance === 80 &&
					cache.accounts?.[ALIAS_PROVIDER_ID]?.allowance === 45;
			} catch {
				return false;
			}
		});
		const firstCache = await readFile(cachePath, "utf8");
		assert.ok(!firstCache.includes("current-openai-codex"));
		assert.ok(!firstCache.includes("access-account-1"));
		assert.ok(!firstCache.includes("refresh-account-1"));
		assert.equal(JSON.parse(firstCache).accounts["openai-codex-account-3"], undefined);

		refresh?.();
		await waitFor(() => requests.length === 6);
		for (const request of requests.slice(3)) {
			if (request.accountId === "account-1") request.resolve(new Response("", { status: 500 }));
			else if (request.accountId === "account-2") request.resolve(new Response(JSON.stringify({
				rate_limit: { any_window: { used_percent: 10, reset_at: future } },
			}), { status: 200 }));
			else request.resolve(new Response(JSON.stringify({
				rate_limit: { malformed_window: { remaining_percent: 101, reset_at: future } },
			}), { status: 200 }));
		}
		await waitFor(async () => {
			try {
				const cache = JSON.parse(await readFile(cachePath, "utf8"));
				return cache.accounts?.[ALIAS_PROVIDER_ID]?.allowance === 90;
			} catch {
				return false;
			}
		});
		const secondCache = JSON.parse(await readFile(cachePath, "utf8"));
		assert.equal(secondCache.accounts[NATIVE_PROVIDER_ID].allowance, 80);
		assert.equal(secondCache.accounts[ALIAS_PROVIDER_ID].allowance, 90);

		await writeFile(authPath, "{");
		refresh?.();
		await settleAuthJson();
		assert.equal(requests.length, 6);
		assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), secondCache);
		await writeFile(authPath, JSON.stringify(storedAuth));

		refresh?.();
		await waitFor(() => requests.length === 9);
		const shutdown = handlers.get("session_shutdown");
		assert.ok(shutdown);
		shutdown({ type: "session_shutdown", reason: "quit" }, context);
		assert.equal(cleared, 1);
		assert.ok(requests.slice(6).every((request) => request.signal?.aborted));
		for (const request of requests.slice(6)) {
			request.resolve(new Response(JSON.stringify({
				rate_limit: { any_window: { remaining_percent: 1, reset_at: future } },
			}), { status: 200 }));
		}
		await settleAuthJson();
		await settleAuthJson();
		assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), secondCache);
	});
});

test("skips a refresh when an account changes while Pi resolves auth", async () => {
	await withAuthDir(async (authPath) => {
		await writeFile(authPath, JSON.stringify({ [NATIVE_PROVIDER_ID]: credential("account-1") }));

		const providers: Provider<"openai-codex-responses">[] = [];
		const handlers = new Map<string, RecordedHandler>();
		let releaseAuth!: () => void;
		const authGate = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		let authRequested = false;
		let requests = 0;
		const schedule = ((_: () => void, delay: number) => {
			assert.equal(delay, 5 * 60 * 1000);
			return 1;
		}) as typeof setInterval;
		const context = {
			modelRegistry: {
				async getProviderAuth() {
					authRequested = true;
					await authGate;
					return { auth: { apiKey: "access-account-1" } };
				},
			},
		} as unknown as ExtensionContext;

		registerCodexAccounts(fakePi(providers, undefined, handlers), fakeNativeProvider(() => credential("account-3")), {
			fetch: (async () => {
				requests++;
				return new Response("{}", { status: 200 });
			}) as typeof fetch,
			setInterval: schedule,
			clearInterval: (() => undefined) as typeof clearInterval,
		});
		const start = handlers.get("session_start");
		assert.ok(start);
		start({ type: "session_start", reason: "startup" }, context);
		assert.equal(authRequested, false);
		await waitFor(() => authRequested);

		await writeFile(authPath, JSON.stringify({ [NATIVE_PROVIDER_ID]: credential("account-2") }));
		releaseAuth();
		await settleAuthJson();
		await settleAuthJson();
		assert.equal(requests, 0);
	});
});

test("ranks measured allowances ahead of unknown accounts and excludes zero allowance", () => {
	const accounts = new Map([
		[NATIVE_PROVIDER_ID, "account-1"],
		["openai-codex-account-2", "account-2"],
		["openai-codex-account-3", "account-3"],
		["openai-codex-account-4", "account-4"],
		["openai-codex-account-5", "account-5"],
	]);
	const snapshots = {
		[NATIVE_PROVIDER_ID]: { accountId: "account-1", allowance: 0, windows: [{ remainingPercent: 0, resetAt: 2 }], fetchedAt: 1 },
		"openai-codex-account-2": { accountId: "account-2", allowance: 60, windows: [{ remainingPercent: 60, resetAt: 2 }], fetchedAt: 1 },
		"openai-codex-account-3": { accountId: "account-3", allowance: 60, windows: [{ remainingPercent: 60, resetAt: 2 }], fetchedAt: 1 },
		"openai-codex-account-4": { accountId: "account-4", allowance: 0, windows: [{ remainingPercent: 0, resetAt: 1 }], fetchedAt: 1 },
		"openai-codex-account-5": { accountId: "account-5", allowance: 30, windows: [{ remainingPercent: 30, resetAt: 2 }], fetchedAt: 1 },
	};

	assert.deepEqual(
		rankCodexAccounts(accounts, snapshots, "openai-codex-account-3", 1)
			.map(({ providerId, allowance, available }) => [providerId, allowance, available]),
		[
			["openai-codex-account-3", 60, true],
			["openai-codex-account-2", 60, true],
			["openai-codex-account-5", 30, true],
			["openai-codex-account-4", undefined, true],
			[NATIVE_PROVIDER_ID, 0, false],
		],
	);
	assert.deepEqual(
		rankCodexAccounts(accounts, snapshots, undefined, 1).map(({ providerId }) => providerId),
		[
			"openai-codex-account-2",
			"openai-codex-account-3",
			"openai-codex-account-5",
			"openai-codex-account-4",
			NATIVE_PROVIDER_ID,
		],
	);
});

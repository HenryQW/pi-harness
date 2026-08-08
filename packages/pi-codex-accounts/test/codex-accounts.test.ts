import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";

import { registerCodexAccounts } from "../extensions/codex-accounts.ts";

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

function fakePi(
	providers: Provider<"openai-codex-responses">[],
	onRegister?: (provider: Provider<"openai-codex-responses">) => void,
): ExtensionAPI {
	return {
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

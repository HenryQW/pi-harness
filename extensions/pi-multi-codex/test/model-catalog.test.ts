import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import { ModelRegistry, ModelRuntime, resolveCliModel, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import multiCodex from "../extensions/multi-codex.ts";

const nativeId = "openai-codex";
const aliasId = "openai-codex-2";
const cachedModel = {
	id: "issue-578-cached",
	name: "Cached Codex model",
	api: "openai-codex-responses",
	provider: nativeId,
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
	contextWindow: 500_000,
	maxTokens: 128_000,
};
const catalogEntry = (models: typeof cachedModel[]) => ({ models, lastModified: Date.now() + 86_400_000 });

async function withCatalog(check: (app: {
	root: string;
	runtime: ModelRuntime;
	start: () => Promise<void>;
}) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-multi-codex-catalog-"));
	const priorDir = process.env.PI_CODING_AGENT_DIR;
	const priorFetch = globalThis.fetch;
	const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
	process.env.PI_CODING_AGENT_DIR = root;
	globalThis.fetch = async () => { throw new Error("catalog tests must not use the network"); };
	try {
		const auth = Object.fromEntries([nativeId, aliasId].map((provider) => [provider, {
			type: "oauth", access: `access-${provider}`, refresh: `refresh-${provider}`,
			expires: Date.now() + 3_600_000, accountId: provider,
		}]));
		await writeFile(join(root, "auth.json"), JSON.stringify(auth));
		await writeFile(join(root, "models-store.json"), JSON.stringify({ [nativeId]: catalogEntry([cachedModel]) }));
		await writeFile(join(root, "models.json"), JSON.stringify({ providers: {
			[nativeId]: { modelOverrides: { [cachedModel.id]: { contextWindow: 600_000 } } },
			[aliasId]: {
				modelOverrides: { [cachedModel.id]: { maxTokens: 64_000 } },
				models: [{ ...cachedModel, id: "issue-578-user", name: "User model" }],
			},
		} }));
		const cacheDir = extensionConfigDir("pi-multi-codex", root);
		await mkdir(cacheDir, { recursive: true });
		await writeFile(join(cacheDir, "usage.json"), JSON.stringify({
			slots: [nativeId, aliasId].map((provider, index) => ({
				slot: index + 1, accountHash: createHash("sha256").update(provider).digest("hex"),
				checkedAt: Date.now(), fetchedAt: Date.now(), remaining: 70,
				reset: Date.now() + 3_600_000, limitedUntil: null,
			})), locks: [],
		}));
		const runtime = await ModelRuntime.create({ allowModelNetwork: false });
		const emit = async (event: string, ctx?: unknown) => {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
		};
		try {
			await multiCodex({
				on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
				registerProvider(provider: Provider) { runtime.registerNativeProvider(provider); },
				registerCommand() {},
			} as unknown as ExtensionAPI);
			await runtime.refresh({ allowNetwork: false });
			await check({ root, runtime, start: () => emit("session_start", {
				modelRegistry: new ModelRegistry(runtime),
				sessionManager: { getBranch: () => [] },
				ui: { setStatus() {}, notify() {} },
			}) });
		} finally {
			await emit("session_shutdown");
		}
	} finally {
		globalThis.fetch = priorFetch;
		if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorDir;
		await rm(root, { recursive: true, force: true });
	}
}

test("cached native models reach aliases before session start and in --list-models", async () => {
	await withCatalog(async ({ root, runtime }) => {
		const originalAuth = await readFile(join(root, "auth.json"), "utf8");
		const originalConfig = await readFile(join(root, "models.json"), "utf8");
		assert.deepEqual(runtime.getModel(aliasId, cachedModel.id), {
			...runtime.getModel(nativeId, cachedModel.id), provider: aliasId, maxTokens: 64_000,
		});
		assert.equal(runtime.getModel(aliasId, cachedModel.id)?.contextWindow, 600_000);
		assert.equal(resolveCliModel({ cliModel: `${aliasId}/${cachedModel.id}`, modelRuntime: runtime }).model?.provider, aliasId);
		assert.equal(runtime.getModel(aliasId, "issue-578-user")?.name, "User model");
		assert.equal((await runtime.getAuth(aliasId))?.auth.apiKey, `access-${aliasId}`);
		const available = await runtime.getAvailable(aliasId);
		assert.ok(available.some((model) => model.id === cachedModel.id));

		const cli = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
		const extension = fileURLToPath(new URL("../extensions/multi-codex.ts", import.meta.url));
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli,
			"--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
			"--no-context-files", "--no-approve", "--extension", extension, "--list-models", cachedModel.id,
		], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, timeout: 20_000, maxBuffer: 64 * 1024 });
		assert.match(stdout, /openai-codex\s+issue-578-cached/);
		assert.match(stdout, /openai-codex-2\s+issue-578-cached/);
		assert.doesNotMatch(stderr, /Extension.*error|Failed to load/);
		assert.equal(await readFile(join(root, "auth.json"), "utf8"), originalAuth);
		assert.equal(await readFile(join(root, "models.json"), "utf8"), originalConfig);
	});
});

test("aliases track native refresh and keep user settings without copying virtual models", async () => {
	await withCatalog(async ({ root, runtime, start }) => {
		await start();
		const refreshed = { ...cachedModel, id: "issue-578-refreshed", contextWindow: 750_000 };
		await writeFile(join(root, "models-store.json"), JSON.stringify({ [nativeId]: catalogEntry([refreshed]) }));
		await runtime.refresh({ providers: [nativeId], allowNetwork: false });
		assert.equal(runtime.getModel(aliasId, refreshed.id)?.contextWindow, 750_000);
		assert.deepEqual(runtime.getModel(aliasId, refreshed.id), { ...runtime.getModel(nativeId, refreshed.id), provider: aliasId });
		assert.equal(runtime.getModel(aliasId, cachedModel.id), undefined);
		assert.equal(runtime.getModel(aliasId, "issue-578-user")?.name, "User model");
		runtime.registerVirtualModel({ provider: nativeId, id: "issue-578-virtual", name: "Virtual", route() { throw new Error("not requested"); } });
		assert.ok(runtime.getModel(nativeId, "issue-578-virtual"));
		assert.equal(runtime.getModel(aliasId, "issue-578-virtual"), undefined);
		assert.equal((await runtime.getAuth(aliasId))?.auth.apiKey, `access-${aliasId}`);
	});
});

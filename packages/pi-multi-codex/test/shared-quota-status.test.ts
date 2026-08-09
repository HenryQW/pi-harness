import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import multiCodex, { parseCodexUsage } from "../extensions/multi-codex.ts";

type Command = (args: string, ctx: ExtensionContext) => Promise<void>;
type Handler = (event: never, ctx: ExtensionContext) => unknown;

const oauth = (accountId: string) => ({
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 60_000,
	accountId,
});

function context(notices: string[]): ExtensionContext {
	return { ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for background quota refresh.");
}

test("parses seven-day quota before sole usable fallback and clamps remaining", () => {
	assert.deepEqual(
		parseCodexUsage({
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 1, limit_window_seconds: 18_000, reset_after_seconds: 60 },
				secondary_window: { used_percent: 120, limit_window_seconds: 604_800, reset_after_seconds: 120 },
			},
		}, 1_000),
		{ remaining: 0, reset: 121_000, tier: "pro" },
	);
	assert.deepEqual(
		parseCodexUsage({ rate_limit: { primary_window: { used_percent: -4, reset_after_seconds: 60 } } }, 1_000),
		{ remaining: 100, reset: 61_000 },
	);
});

test("shares credential-free measured cache and status never fetches", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-quota-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let requests = 0;
	let requestHeaders: Headers | undefined;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("raw-account-id") }));
		globalThis.fetch = async (_input, init) => {
			requests++;
			requestHeaders = new Headers(init?.headers);
			return new Response(JSON.stringify({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 90, limit_window_seconds: 18_000, reset_after_seconds: 60 },
					secondary_window: { used_percent: 25, limit_window_seconds: 604_800, reset_after_seconds: 3600 },
				},
			}));
		};

		const commands = new Map<string, Command>();
		const handlers = new Map<string, Handler>();
		multiCodex({
			on(event: string, handler: Handler) { handlers.set(event, handler); },
			registerCommand(name: string, options: { handler: Command }) { commands.set(name, options.handler); },
			registerProvider() {},
		} as unknown as ExtensionAPI);

		handlers.get("session_start")?.({} as never, context([]));
		await waitFor(async () => {
			if (requests !== 1) return false;
			try {
				return (await readFile(join(agentDir, "config", "pi-multi-codex", "usage.json"), "utf8")).includes("\"remaining\":75");
			} catch {
				return false;
			}
		});
		assert.equal(requestHeaders?.get("authorization"), "Bearer access-token");
		assert.equal(requestHeaders?.get("chatgpt-account-id"), "raw-account-id");

		const notices: string[] = [];
		await commands.get("codex-status")?.("", context(notices));
		assert.deepEqual(notices, ["Codex slot 1 (plus): 75% remaining, resets in 1h (measured)"]);
		assert.equal(requests, 1);
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("replacement-account") }));
		const replacedNotices: string[] = [];
		await commands.get("codex-status")?.("", context(replacedNotices));
		assert.deepEqual(replacedNotices, ["Codex slot 1: unavailable"]);

		const file = join(agentDir, "config", "pi-multi-codex", "usage.json");
		const saved = await readFile(file, "utf8");
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		assert.match(saved, /"slot":1/);
		for (const secret of ["raw-account-id", "replacement-account", "access-token", "refresh-token", "Bearer"]) assert.ok(!saved.includes(secret));
		handlers.get("session_shutdown")?.({} as never, context([]));
	} finally {
		globalThis.fetch = oldFetch;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

async function runQuotaProcess(agentDir: string, fetchMock: string, countFile: string, lifetime = 750): Promise<void> {
	const extension = new URL("../extensions/multi-codex.ts", import.meta.url).href;
	const program = `
		import multiCodex from ${JSON.stringify(extension)};
		const handlers = new Map();
		multiCodex({
			on(event, handler) { handlers.set(event, handler); },
			registerCommand() {},
			registerProvider() {},
		});
		const ctx = { ui: { notify() {} } };
		handlers.get("session_start")?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, ${lifetime}));
		handlers.get("session_shutdown")?.({}, ctx);
	`;
	const child = spawn(process.execPath, ["--import", pathToFileURL(fetchMock).href, "--input-type=module", "--eval", program], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, QUOTA_REQUESTS: countFile },
		stdio: "pipe",
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { stderr += chunk; });
	const [code, signal] = await once(child, "exit") as [number | null, string | null];
	if (code !== 0) throw new Error(`Quota child failed (${code ?? signal}): ${stderr}`);
}

test("two Pi processes claim one shared quota refresh", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-lock-"));
	const countFile = join(agentDir, "requests");
	const fetchMock = join(agentDir, "fetch-mock.mjs");
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("process-account") }));
		await writeFile(fetchMock, `
			import { appendFileSync } from "node:fs";
			globalThis.fetch = async () => {
				appendFileSync(process.env.QUOTA_REQUESTS, "1\\n");
				return new Response(JSON.stringify({ rate_limit: {
					secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_after_seconds: 3600 }
				} }));
			};
		`);
		await Promise.all([runQuotaProcess(agentDir, fetchMock, countFile), runQuotaProcess(agentDir, fetchMock, countFile)]);
		assert.equal((await readFile(countFile, "utf8")).trim(), "1");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("shutdown cancels fresh stranded cache-mutex wait", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-stranded-lock-"));
	const countFile = join(agentDir, "requests");
	const fetchMock = join(agentDir, "fetch-mock.mjs");
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("stranded-account") }));
		const mutex = join(agentDir, "config", "pi-multi-codex", "usage.json.lock");
		await mkdir(mutex, { recursive: true });
		await writeFile(join(mutex, "owner"), "stranded-owner");
		await writeFile(fetchMock, `globalThis.fetch = async () => { throw new Error("must not fetch"); };`);
		const started = Date.now();
		await runQuotaProcess(agentDir, fetchMock, countFile, 20);
		assert.ok(Date.now() - started < 2_000);
		await assert.rejects(readFile(join(agentDir, "config", "pi-multi-codex", "usage.json"), "utf8"));
		await assert.rejects(readFile(countFile, "utf8"));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("shutdown releases owned slot lock before next Pi refresh", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-release-lock-"));
	const pendingFile = join(agentDir, "pending");
	const countFile = join(agentDir, "requests");
	const pendingFetch = join(agentDir, "pending-fetch.mjs");
	const successFetch = join(agentDir, "success-fetch.mjs");
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("release-account") }));
		await writeFile(pendingFetch, `
			import { writeFileSync } from "node:fs";
			globalThis.fetch = async () => {
				writeFileSync(process.env.QUOTA_REQUESTS, "started");
				return new Promise(() => {});
			};
		`);
		await runQuotaProcess(agentDir, pendingFetch, pendingFile);
		assert.equal(await readFile(pendingFile, "utf8"), "started");
		const state = JSON.parse(await readFile(join(agentDir, "config", "pi-multi-codex", "usage.json"), "utf8"));
		assert.deepEqual(state.locks, []);

		await writeFile(successFetch, `
			import { appendFileSync } from "node:fs";
			globalThis.fetch = async () => {
				appendFileSync(process.env.QUOTA_REQUESTS, "1\\n");
				return new Response(JSON.stringify({ rate_limit: {
					secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_after_seconds: 3600 }
				} }));
			};
		`);
		const started = Date.now();
		await runQuotaProcess(agentDir, successFetch, countFile);
		assert.ok(Date.now() - started < 2_000);
		assert.equal((await readFile(countFile, "utf8")).trim(), "1");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

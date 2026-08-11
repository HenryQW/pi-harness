import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

const hash = (accountId: string) => createHash("sha256").update(accountId).digest("hex");

function context(notices: string[], apiKey = "access-token"): ExtensionContext {
	return {
		ui: { notify: (message: string) => notices.push(message) },
		modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey } }) },
	} as unknown as ExtensionContext;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
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
	assert.equal(
		parseCodexUsage({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_after_seconds: 60 } } }, 1_000),
		undefined,
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
		import { readFileSync } from "node:fs";
		const ctx = {
			ui: { notify() {} },
			modelRegistry: {
				async getProviderAuth(provider) {
					const credential = JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + "/auth.json", "utf8"))[provider];
					return credential ? { auth: { apiKey: credential.access } } : undefined;
				},
			},
		};
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

test("quota request gets refreshed bearer from Pi auth store", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-auth-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { ...oauth("expired-account"), access: "expired-token", expires: 0 } }));
		let authorization: string | null = null;
		globalThis.fetch = async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify({ rate_limit: {
				secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_after_seconds: 3600 },
			} }));
		};
		const handlers = new Map<string, Handler>();
		multiCodex({
			on(event: string, handler: Handler) { handlers.set(event, handler); },
			registerCommand() {},
			registerProvider() {},
		} as unknown as ExtensionAPI);
		handlers.get("session_start")?.({} as never, context([], "refreshed-token"));
		await waitFor(() => authorization !== null);
		assert.equal(authorization, "Bearer refreshed-token");
		handlers.get("session_shutdown")?.({} as never, context([]));
	} finally {
		globalThis.fetch = oldFetch;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("new session refreshes after aborted predecessor cleans up", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-restarted-session-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("restart-account") }));
		let requests = 0;
		globalThis.fetch = (_input, init) => {
			requests++;
			if (requests === 1) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			return Promise.resolve(new Response(JSON.stringify({ rate_limit: {
				secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_after_seconds: 3600 },
			} })));
		};
		const handlers = new Map<string, Handler>();
		multiCodex({
			on(event: string, handler: Handler) { handlers.set(event, handler); },
			registerCommand() {},
			registerProvider() {},
		} as unknown as ExtensionAPI);
		const ctx = context([]);
		handlers.get("session_start")?.({} as never, ctx);
		await waitFor(() => requests === 1);
		handlers.get("session_start")?.({} as never, ctx);
		await waitFor(() => requests === 2);
		handlers.get("session_shutdown")?.({} as never, ctx);
	} finally {
		globalThis.fetch = oldFetch;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("refreshes fresh cache at its expiry", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-refresh-deadline-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("deadline-account") }));
		await mkdir(join(agentDir, "config", "pi-multi-codex"), { recursive: true });
		const now = Date.now();
		await writeFile(join(agentDir, "config", "pi-multi-codex", "usage.json"), JSON.stringify({
			slots: [{ slot: 1, accountHash: hash("deadline-account"), checkedAt: now - 299_970, fetchedAt: now - 299_970, remaining: 50, reset: now + 3_600_000 }],
			locks: [],
		}));
		let requests = 0;
		globalThis.fetch = async () => {
			requests++;
			return new Response(JSON.stringify({ rate_limit: {
				secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_after_seconds: 3600 },
			} }));
		};
		const handlers = new Map<string, Handler>();
		multiCodex({
			on(event: string, handler: Handler) { handlers.set(event, handler); },
			registerCommand() {},
			registerProvider() {},
		} as unknown as ExtensionAPI);
		const started = Date.now();
		handlers.get("session_start")?.({} as never, context([]));
		await waitFor(() => requests === 1);
		assert.ok(Date.now() - started < 1_000);
		handlers.get("session_shutdown")?.({} as never, context([]));
	} finally {
		globalThis.fetch = oldFetch;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("elapsed quota window bypasses recent-check backoff", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-elapsed-window-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("elapsed-account") }));
		await mkdir(join(agentDir, "config", "pi-multi-codex"), { recursive: true });
		const now = Date.now();
		await writeFile(join(agentDir, "config", "pi-multi-codex", "usage.json"), JSON.stringify({
			slots: [{ slot: 1, accountHash: hash("elapsed-account"), checkedAt: now, fetchedAt: now, remaining: 90, reset: now - 1 }],
			locks: [],
		}));
		let requests = 0;
		globalThis.fetch = async () => {
			requests++;
			return new Response(JSON.stringify({ rate_limit: {
				secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_after_seconds: 3600 },
			} }));
		};
		const handlers = new Map<string, Handler>();
		multiCodex({
			on(event: string, handler: Handler) { handlers.set(event, handler); },
			registerCommand() {},
			registerProvider() {},
		} as unknown as ExtensionAPI);
		handlers.get("session_start")?.({} as never, context([]));
		await waitFor(() => requests === 1);
		handlers.get("session_shutdown")?.({} as never, context([]));
	} finally {
		globalThis.fetch = oldFetch;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("retries when a foreign slot lock expires", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-foreign-lock-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("locked-account") }));
		await mkdir(join(agentDir, "config", "pi-multi-codex"), { recursive: true });
		const now = Date.now();
		await writeFile(join(agentDir, "config", "pi-multi-codex", "usage.json"), JSON.stringify({
			slots: [],
			locks: [{ slot: 1, owner: "foreign", accountHash: hash("locked-account"), heartbeatAt: now - 44_750 }],
		}));
		let requests = 0;
		globalThis.fetch = async () => {
			requests++;
			return new Response(JSON.stringify({ rate_limit: {
				secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_after_seconds: 3600 },
			} }));
		};
		const handlers = new Map<string, Handler>();
		multiCodex({
			on(event: string, handler: Handler) { handlers.set(event, handler); },
			registerCommand() {},
			registerProvider() {},
		} as unknown as ExtensionAPI);
		handlers.get("session_start")?.({} as never, context([]));
		await waitFor(() => requests === 1);
		assert.ok(Date.now() - now < 2_000);
		handlers.get("session_shutdown")?.({} as never, context([]));
	} finally {
		globalThis.fetch = oldFetch;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("two Pi processes reclaim one stale cache mutex", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-stale-mutex-"));
	const countFile = join(agentDir, "requests");
	const fetchMock = join(agentDir, "fetch-mock.mjs");
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("stale-mutex-account") }));
		const mutex = join(agentDir, "config", "pi-multi-codex", "usage.json.lock");
		await mkdir(mutex, { recursive: true });
		await writeFile(join(mutex, "owner"), "dead-owner");
		const staleAt = new Date(Date.now() - 45_000);
		await utimes(mutex, staleAt, staleAt);
		await writeFile(fetchMock, `
			import { appendFileSync } from "node:fs";
			globalThis.fetch = async () => {
				appendFileSync(process.env.QUOTA_REQUESTS, "1\\n");
				await new Promise((resolve) => setTimeout(resolve, 100));
				return new Response(JSON.stringify({ rate_limit: {
					secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_after_seconds: 3600 }
				} }));
			};
		`);
		await Promise.all([runQuotaProcess(agentDir, fetchMock, countFile), runQuotaProcess(agentDir, fetchMock, countFile)]);
		assert.equal((await readFile(countFile, "utf8")).trim(), "1");
		const tombstone = `${mutex}.${createHash("sha256").update("dead-owner").digest("hex")}.stale`;
		assert.equal(await readFile(join(tombstone, "owner"), "utf8"), "dead-owner");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

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

test("failed refresh shares five-minute backoff across Pi processes", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-failure-backoff-"));
	const countFile = join(agentDir, "requests");
	const failedFetch = join(agentDir, "failed-fetch.mjs");
	const blockedFetch = join(agentDir, "blocked-fetch.mjs");
	const retryFetch = join(agentDir, "retry-fetch.mjs");
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("failed-account") }));
		await writeFile(failedFetch, `
			import { appendFileSync } from "node:fs";
			globalThis.fetch = async () => {
				appendFileSync(process.env.QUOTA_REQUESTS, "failed\\n");
				throw new Error("offline");
			};
		`);
		await runQuotaProcess(agentDir, failedFetch, countFile, 400);
		const file = join(agentDir, "config", "pi-multi-codex", "usage.json");
		const failed = JSON.parse(await readFile(file, "utf8"));
		assert.equal(failed.slots[0].fetchedAt, undefined);
		assert.equal(typeof failed.slots[0].checkedAt, "number");

		await writeFile(blockedFetch, `
			import { appendFileSync } from "node:fs";
			globalThis.fetch = async () => { appendFileSync(process.env.QUOTA_REQUESTS, "early-retry\\n"); throw new Error("must not fetch"); };
		`);
		await runQuotaProcess(agentDir, blockedFetch, countFile, 400);
		assert.equal(await readFile(countFile, "utf8"), "failed\n");

		failed.slots[0].checkedAt = Date.now() - 5 * 60_000;
		await writeFile(file, JSON.stringify(failed));
		await writeFile(retryFetch, `
			import { appendFileSync } from "node:fs";
			globalThis.fetch = async () => {
				appendFileSync(process.env.QUOTA_REQUESTS, "retry\\n");
				return new Response(JSON.stringify({ rate_limit: {
					secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_after_seconds: 3600 }
				} }));
			};
		`);
		await runQuotaProcess(agentDir, retryFetch, countFile, 400);
		assert.equal(await readFile(countFile, "utf8"), "failed\nretry\n");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("credential replacement discards stale cross-process refresh", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-replaced-refresh-"));
	const countFile = join(agentDir, "requests");
	const oldFetch = join(agentDir, "old-fetch.mjs");
	const replacementFetch = join(agentDir, "replacement-fetch.mjs");
	const releaseFile = join(agentDir, "release");
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("old-account") }));
		await writeFile(oldFetch, `
			import { existsSync, writeFileSync } from "node:fs";
			import { join } from "node:path";
			globalThis.fetch = async () => {
				writeFileSync(process.env.QUOTA_REQUESTS, "old\\n");
				while (!existsSync(join(process.env.PI_CODING_AGENT_DIR, "release"))) await new Promise((resolve) => setTimeout(resolve, 5));
				return new Response(JSON.stringify({ rate_limit: {
					secondary_window: { used_percent: 1, limit_window_seconds: 604800, reset_after_seconds: 3600 }
				} }));
			};
		`);
		await writeFile(replacementFetch, `
			import { appendFileSync } from "node:fs";
			globalThis.fetch = async () => {
				appendFileSync(process.env.QUOTA_REQUESTS, "replacement\\n");
				return new Response(JSON.stringify({ rate_limit: {
					secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_after_seconds: 3600 }
				} }));
			};
		`);

		const oldRefresh = runQuotaProcess(agentDir, oldFetch, countFile, 500);
		await waitFor(async () => (await readFile(countFile, "utf8").catch(() => "")) === "old\n");
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("replacement-account") }));
		const replacementRefresh = runQuotaProcess(agentDir, replacementFetch, countFile, 500);
		await waitFor(async () => (await readFile(countFile, "utf8").catch(() => "")).includes("replacement\n"));
		await writeFile(releaseFile, "");
		await Promise.all([oldRefresh, replacementRefresh]);

		const state = JSON.parse(await readFile(join(agentDir, "config", "pi-multi-codex", "usage.json"), "utf8"));
		assert.deepEqual(state.locks, []);
		assert.equal(state.slots[0].accountHash, hash("replacement-account"));
		assert.equal(state.slots[0].remaining, 20);
		assert.notEqual(state.slots[0].accountHash, hash("old-account"));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

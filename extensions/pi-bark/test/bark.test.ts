import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import barkExtension from "../extensions/bark.ts";
import { parseServerUrl } from "../src/config.ts";

type Context = {
	cwd: string;
	sessionManager: { buildContextEntries(): SessionEntry[] };
	ui: { notify(message: string, type: string): void };
};
type Command = (args: string, ctx: Context) => Promise<void>;

function assistantEntry(
	content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>,
	stopReason = "stop",
): SessionEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "assistant", content, stopReason },
	} as SessionEntry;
}

function harness(
	agentDir: string,
	fetchImpl: typeof fetch,
	copy: (text: string) => Promise<void>,
	sessionName: string | (() => string | undefined) = "Test session",
) {
	const commands = new Map<string, Command>();
	const lifecycleHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerCommand(name: string, command: { handler: Command }) {
			commands.set(name, command.handler);
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			lifecycleHandlers.set(name, handler);
		},
		getSessionName: () => (typeof sessionName === "function" ? sessionName() : sessionName),
	} as unknown as ExtensionAPI;
	barkExtension(pi, { agentDir, fetch: fetchImpl, copy });
	return { commands, lifecycleHandlers };
}

function runKeyGenerator(agentDir: string, ...args: string[]) {
	const script = join(import.meta.dirname, "..", "dist", "scripts", "generate-encryption-key.js");
	return spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
}

function waitForImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("server URLs preserve HTTP(S) paths and reject raw query or fragment delimiters", () => {
	assert.equal(parseServerUrl("http://push.example.com/bark/"), "http://push.example.com/bark");
	for (const url of [
		"https://push.example.com/bark?",
		"https://push.example.com/bark#",
		"https://push.example.com/bark?token=value",
		"https://push.example.com/bark#section",
	]) {
		assert.throws(() => parseServerUrl(url), /must not include a query or fragment/);
	}
});

test("built key generator stores, protects, replaces, and disables Bark push encryption", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-key-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const configPath = join(agentDir, "config", "pi-bark", "config.json");

	const generated = runKeyGenerator(agentDir);
	assert.equal(generated.status, 0, generated.stderr);
	const firstKey = generated.stdout.match(/^Key: (.+)$/m)?.[1];
	assert.equal(firstKey?.length, 32);
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		serverUrl: "https://api.day.app",
		deviceKey: null,
		encryption: {
			algorithm: "AES256",
			mode: "GCM",
			padding: "noPadding",
			key: firstKey,
		},
		statusNotifications: { defaultEnabled: true, cwdOverrides: {} },
	});

	const protectedRun = runKeyGenerator(agentDir);
	assert.equal(protectedRun.status, 1);
	assert.match(protectedRun.stderr, /already exists/);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).encryption.key, firstKey);

	const replaced = runKeyGenerator(agentDir, "--force");
	assert.equal(replaced.status, 0, replaced.stderr);
	const replacementKey = replaced.stdout.match(/^Key: (.+)$/m)?.[1];
	assert.equal(replacementKey?.length, 32);
	assert.notEqual(replacementKey, firstKey);

	const disabled = runKeyGenerator(agentDir, "--disable");
	assert.equal(disabled.status, 0, disabled.stderr);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).encryption, null);
});

test("/set-bark saves config and /copyb copies then posts the exact text", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));

	const events: string[] = [];
	let request: { url: string; init?: RequestInit } | undefined;
	let responseStatus = 200;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		events.push("fetch");
		request = { url: String(input), init };
		return new Response(responseStatus === 200 ? '{"code":200,"message":"success"}' : null, { status: responseStatus });
	}) as typeof fetch;
	const { commands } = harness(agentDir, fetchImpl, async (text) => {
		events.push(`copy:${text}`);
	});
	const notices: string[] = [];
	const text = "# Done\n\n- kept exactly\n- including `format`";
	const older = assistantEntry([{ type: "text", text: "older" }]);
	const thinking = assistantEntry([{ type: "thinking", thinking: "not visible" }]);
	let entries = [
		older,
		assistantEntry([{ type: "text", text: "  # Done\n\n" }, { type: "text", text: "- kept exactly\n- including `format`  " }]),
		assistantEntry([], "aborted"),
	];
	const ctx: Context = {
		cwd: join(agentDir, "project"),
		sessionManager: { buildContextEntries: () => entries },
		ui: { notify: (message) => notices.push(message) },
	};

	await commands.get("set-bark")!("device-key", ctx);
	const configPath = join(agentDir, "config", "pi-bark", "config.json");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		serverUrl: "https://api.day.app",
		deviceKey: "device-key",
		encryption: null,
		statusNotifications: { defaultEnabled: true, cwdOverrides: {} },
	});

	await commands.get("copyb")!("", ctx);
	assert.deepEqual(events, [`copy:${text}`, "fetch"]);
	assert.equal(request?.url, "https://api.day.app/push");
	assert.equal(request?.init?.method, "POST");
	assert.equal(request?.init?.body, JSON.stringify({ device_key: "device-key", body: text }));
	assert.deepEqual(request?.init?.headers, { "Content-Type": "application/json; charset=utf-8" });
	assert.deepEqual(notices, [
		"Saved the Bark Device Key and server URL.",
		"Copied the last agent message and sent a Bark push notification.",
	]);

	responseStatus = 503;
	await assert.rejects(() => commands.get("copyb")!("", ctx), /HTTP 503/);
	assert.deepEqual(events.slice(-2), [`copy:${text}`, "fetch"]);
	assert.equal(notices.length, 2);

	responseStatus = 200;
	entries = [older, thinking];
	await commands.get("copyb")!("", ctx);
	assert.deepEqual(events.slice(-2), ["copy:older", "fetch"]);
	assert.equal(request?.init?.body, JSON.stringify({ device_key: "device-key", body: "older" }));

	entries = [thinking, assistantEntry([], "aborted")];
	const eventCount = events.length;
	await assert.rejects(() => commands.get("copyb")!("", ctx), /No agent messages to copy yet/);
	assert.equal(events.length, eventCount);
});

test("Bark sends status-only notifications when Pi is blocked or finished", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));

	const pushes: Array<Record<string, string>> = [];
	const { commands, lifecycleHandlers } = harness(
		agentDir,
		(async (_input: string | URL | Request, init?: RequestInit) => {
			pushes.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		async () => {},
		"Deploy API",
	);
	let idle = true;
	const ctx = {
		cwd: join(agentDir, "project"),
		sessionManager: { buildContextEntries: () => [] },
		isIdle: () => idle,
		ui: { notify: () => {} },
	};
	await commands.get("set-bark")!("device-key", ctx);

	const promptStart = lifecycleHandlers.get("ui_prompt_start");
	assert.ok(promptStart);
	await promptStart({}, ctx);
	assert.deepEqual(pushes, [{ device_key: "device-key", title: "Pi needs input", body: "Pi session: Deploy API" }]);

	const settled = lifecycleHandlers.get("agent_settled");
	assert.ok(settled);
	assert.equal(settled({ type: "agent_settled", aborted: true }, ctx), undefined);
	await waitForImmediate();
	assert.equal(pushes.length, 1, "a cancelled settlement sends no Pi finished push");

	assert.equal(settled({ type: "agent_settled", aborted: false }, ctx), undefined, "agent_settled stays non-blocking for later handlers");
	idle = false;
	await waitForImmediate();
	assert.equal(pushes.length, 1, "a continuation queued by a later settled handler suppresses Pi finished");

	idle = true;
	assert.equal(settled({ type: "agent_settled", aborted: false }, ctx), undefined);
	await waitForImmediate();
	assert.deepEqual(pushes[1], {
		device_key: "device-key",
		title: "Pi finished",
		body: "Pi session: Deploy API",
	});

	await commands.get("bark")!("off", ctx);
	await promptStart({}, ctx);
	assert.equal(pushes.length, 2);

	await commands.get("bark")!("on", ctx);
	await promptStart({}, ctx);
	assert.equal(pushes.length, 3);

	await commands.get("bark")!("default off", ctx);
	await promptStart({}, ctx);
	assert.equal(pushes.length, 4, "the explicit CWD override wins over the default");

	await commands.get("bark")!("inherit", ctx);
	await promptStart({}, ctx);
	assert.equal(pushes.length, 4, "the CWD inherits the disabled default");

	await commands.get("bark")!("default on", ctx);
	await promptStart({}, ctx);
	assert.equal(pushes.length, 5);
	const config = JSON.parse(readFileSync(join(agentDir, "config", "pi-bark", "config.json"), "utf8"));
	assert.deepEqual(config.statusNotifications, { defaultEnabled: true, cwdOverrides: {} });
});

test("a continuation cancels a finished push after its deferred idle check", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));

	let requestSignal: AbortSignal | null | undefined;
	const notices: string[] = [];
	const { commands, lifecycleHandlers } = harness(
		agentDir,
		((_input: string | URL | Request, init?: RequestInit) => {
			requestSignal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
			});
		}) as typeof fetch,
		async () => {},
	);
	const ctx = {
		cwd: join(agentDir, "project"),
		sessionManager: { buildContextEntries: () => [] },
		isIdle: () => true,
		ui: { notify: (message: string) => notices.push(message) },
	};
	await commands.get("set-bark")!("device-key", ctx);
	notices.length = 0;

	assert.equal(lifecycleHandlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx), undefined);
	await waitForImmediate();
	assert.equal(requestSignal?.aborted, false);

	lifecycleHandlers.get("agent_start")!({}, ctx);
	await Promise.resolve();
	assert.equal(requestSignal?.aborted, true);
	assert.deepEqual(notices, []);
});

test("settled notifications report the run outcome without error details", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));

	const pushes: Array<Record<string, string>> = [];
	const notices: string[] = [];
	const { commands, lifecycleHandlers } = harness(
		agentDir,
		(async (_input: string | URL | Request, init?: RequestInit) => {
			init?.signal?.throwIfAborted();
			pushes.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		async () => {},
		"Deploy API",
	);
	const ctx = {
		cwd: join(agentDir, "project"),
		sessionManager: { buildContextEntries: () => [assistantEntry([{ type: "text", text: "older branch" }], "error")] },
		isIdle: () => true,
		ui: { notify: (message: string) => notices.push(message) },
	};
	await commands.get("set-bark")!("device-key", ctx);
	notices.length = 0;

	const emit = (name: string, event: unknown) => lifecycleHandlers.get(name)!(event, ctx);
	const assistant = (stopReason: string) => [
		"message_end",
		{ type: "message_end", message: { role: "assistant", content: [], stopReason, errorMessage: "provider detail" } },
	] as const;
	const compactFailed = (reason: string, aborted: boolean) => [
		"session_compact_failed",
		{
			type: "session_compact_failed",
			reason,
			aborted,
			willRetry: false,
			errorMessage: aborted ? undefined : "Compaction failed: detail",
			fromExtension: false,
		},
	] as const;
	const run = async (events: ReadonlyArray<readonly [string, unknown]>, aborted = false) => {
		const count = pushes.length;
		emit("agent_start", { type: "agent_start" });
		for (const [name, event] of events) emit(name, event);
		emit("agent_settled", { type: "agent_settled", aborted });
		await waitForImmediate();
		return pushes.slice(count).map((push) => push.title);
	};

	assert.deepEqual(await run([assistant("error")]), ["Pi failed"]);
	assert.deepEqual(pushes[0], { device_key: "device-key", title: "Pi failed", body: "Pi session: Deploy API" });
	assert.deepEqual(await run([assistant("error"), assistant("stop")]), ["Pi finished"], "a successful retry clears the failure");
	assert.deepEqual(await run([assistant("length"), compactFailed("overflow", false)]), ["Pi failed"]);
	assert.deepEqual(await run([assistant("error"), compactFailed("overflow", true)]), [], "an aborted compaction is silent");
	assert.deepEqual(await run([assistant("error")], true), [], "a cancelled settlement is silent");
	assert.deepEqual(
		await run([["message_end", { type: "message_end", message: { role: "user", content: [] } }]]),
		["Pi finished"],
		"a fresh run ignores earlier and branch failures",
	);

	emit(...compactFailed("manual", false));
	emit("agent_settled", { type: "agent_settled", aborted: false });
	await waitForImmediate();
	assert.equal(pushes.at(-1)?.title, "Pi finished", "idle manual compaction does not change the outcome");

	const count = pushes.length;
	emit("agent_start", { type: "agent_start" });
	emit(...assistant("error"));
	emit("agent_settled", { type: "agent_settled", aborted: false });
	emit("agent_start", { type: "agent_start" });
	await waitForImmediate();
	assert.equal(pushes.length, count, "a new run suppresses the pending Pi failed push");
	assert.deepEqual(notices, []);
});

test("automatic status pushes preserve event order and event-time state", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));

	const pushes: Array<Record<string, string>> = [];
	let finishFirst: ((response: Response) => void) | undefined;
	const firstResponse = new Promise<Response>((resolve) => {
		finishFirst = resolve;
	});
	let sessionName = "First session";
	const { commands, lifecycleHandlers } = harness(
		agentDir,
		(async (_input: string | URL | Request, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body)) as Record<string, string>;
			pushes.push(payload);
			return payload.title === "Pi needs input" ? firstResponse : new Response(null, { status: 200 });
		}) as typeof fetch,
		async () => {},
		() => sessionName,
	);
	const ctx = {
		cwd: join(agentDir, "project"),
		sessionManager: { buildContextEntries: () => [] },
		isIdle: () => true,
		ui: { notify: () => {} },
	};
	await commands.get("set-bark")!("device-key", ctx);

	const promptStart = lifecycleHandlers.get("ui_prompt_start");
	const settled = lifecycleHandlers.get("agent_settled");
	assert.ok(promptStart);
	assert.ok(settled);
	assert.equal(promptStart({}, ctx), undefined, "ui_prompt_start stays non-blocking");
	await Promise.resolve();
	assert.equal(pushes[0]?.title, "Pi needs input");

	sessionName = "Settled at event";
	assert.equal(settled({ type: "agent_settled", aborted: false }, ctx), undefined);
	await commands.get("bark")!("off", ctx);
	sessionName = "Disabled at event";
	assert.equal(promptStart({}, ctx), undefined);
	await commands.get("bark")!("on", ctx);
	sessionName = "Changed after events";
	assert.equal(pushes.length, 1, "settled notification waits for the prompt push");

	finishFirst?.(new Response(null, { status: 200 }));
	await waitForImmediate();
	assert.equal(pushes.length, 2, "settled notification starts after the prompt push completes");
	assert.deepEqual(pushes, [
		{ device_key: "device-key", title: "Pi needs input", body: "Pi session: First session" },
		{ device_key: "device-key", title: "Pi finished", body: "Pi session: Settled at event" },
	]);
});

test("/copyb sends Bark-compatible AES256-GCM ciphertext when push encryption is enabled", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));

	let requestBody = "";
	const { commands, lifecycleHandlers } = harness(
		agentDir,
		(async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = String(init?.body);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		async () => {},
	);
	const text = "# Private result\n\n```ts\nconst secret = true;\n```";
	const ctx: Context = {
		cwd: join(agentDir, "project"),
		sessionManager: { buildContextEntries: () => [assistantEntry([{ type: "text", text }])] },
		ui: { notify: () => {} },
	};
	await commands.get("set-bark")!("device-key", ctx);
	const key = "0123456789abcdefghijklmnopqrstuv";
	writeFileSync(
		join(agentDir, "config", "pi-bark", "config.json"),
		`${JSON.stringify({
			serverUrl: "https://api.day.app",
			deviceKey: "device-key",
			encryption: { algorithm: "AES256", mode: "GCM", padding: "noPadding", key },
			statusNotifications: { defaultEnabled: true, cwdOverrides: {} },
		})}\n`,
	);

	await commands.get("copyb")!("", ctx);
	const payload = JSON.parse(requestBody) as Record<string, string>;
	assert.deepEqual(Object.keys(payload).sort(), ["ciphertext", "device_key", "iv"]);
	assert.equal(payload.device_key, "device-key");
	assert.equal(payload.iv.length, 12);

	const combined = Buffer.from(payload.ciphertext, "base64");
	const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(payload.iv));
	decipher.setAuthTag(combined.subarray(-16));
	const plaintext = Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString("utf8");
	assert.equal(plaintext, JSON.stringify({ body: text }));

	lifecycleHandlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, {
		cwd: join(agentDir, "project"),
		isIdle: () => true,
		ui: { notify: () => {} },
	});
	await waitForImmediate();
	const statusPayload = JSON.parse(requestBody) as Record<string, string>;
	assert.deepEqual(Object.keys(statusPayload).sort(), ["ciphertext", "device_key", "iv"]);
	const statusCombined = Buffer.from(statusPayload.ciphertext, "base64");
	const statusDecipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(statusPayload.iv));
	statusDecipher.setAuthTag(statusCombined.subarray(-16));
	const statusPlaintext = Buffer.concat([
		statusDecipher.update(statusCombined.subarray(0, -16)),
		statusDecipher.final(),
	]).toString("utf8");
	assert.equal(statusPlaintext, JSON.stringify({ title: "Pi finished", body: "Pi session: Test session" }));
});

test("/copyb requires valid config and preserves malformed files", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	let copied = false;
	let pushed = false;
	const notices: Array<{ message: string; type: string }> = [];
	const { commands, lifecycleHandlers } = harness(
		agentDir,
		(async () => {
			pushed = true;
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		async () => { copied = true; },
	);
	const ctx: Context = {
		cwd: join(agentDir, "project"),
		sessionManager: { buildContextEntries: () => [assistantEntry([{ type: "text", text: "done" }])] },
		ui: { notify: (message, type) => notices.push({ message, type }) },
	};
	const configPath = join(agentDir, "config", "pi-bark", "config.json");

	await lifecycleHandlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, {
		cwd: join(agentDir, "project"),
		isIdle: () => true,
		ui: { notify: () => {} },
	});
	assert.equal(pushed, false);
	assert.equal(existsSync(join(agentDir, "config", "pi-bark")), false);
	await assert.rejects(() => commands.get("copyb")!("", ctx), /Bark is not configured/);
	assert.equal(existsSync(join(agentDir, "config", "pi-bark")), false);
	await assert.rejects(() => commands.get("set-bark")!("device-key file:///tmp/bark", ctx), /HTTP or HTTPS/);
	assert.equal(existsSync(configPath), false);

	await commands.get("set-bark")!("device-key https://push.example.com/bark", ctx);
	const malformed = '{"serverUrl":"https://api.day.app","deviceKey":42,"encryption":null,"statusNotifications":{"defaultEnabled":true,"cwdOverrides":{}}}\n';
	writeFileSync(configPath, malformed);
	assert.equal(lifecycleHandlers.get("ui_prompt_start")!({}, ctx), undefined);
	await Promise.resolve();
	assert.equal(notices.at(-1)?.type, "warning");
	assert.match(notices.at(-1)?.message ?? "", /deviceKey/);
	await assert.rejects(() => commands.get("copyb")!("", ctx), /deviceKey/);
	assert.equal(readFileSync(configPath, "utf8"), malformed);
	assert.equal(copied, false);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { Compile } from "typebox/compile";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkoutAdmission } from "@henryqw/pi-herdr";
import { CommandManager, commandParameters, registerCommands, validateRequest } from "../internal/commands.ts";
import { atomicState, cancelJob, outputTail, readJob, readPrivate, terminal, writePrivate, type JobSpec } from "../internal/command-state.ts";

const runner = fileURLToPath(new URL("../dist/command-runner.js", import.meta.url));
const policy = { runtimeMs: 5000, outputBytes: 4096, concurrency: 4, retainedJobs: 100 };
async function fixture(t: TestContext, command: string, limits = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "herdr command 雪 ")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const id = randomUUID();
	const dir = join(root, id);
	await mkdir(dir, { mode: 0o700 });
	const spec: JobSpec = { version: 1, id, token: randomUUID(), callId: "call", callEntryId: "launch", sessionId: "session", sessionFile: null,
		createdAt: Date.now(), cwd: root, checkout: root, workspaceId: "workspace", socketPath: "/tmp/test-herdr.sock",
		command, access: "write", runtimeMs: 5000, outputBytes: 4096, ...limits };
	await writePrivate(join(dir, "spec.json"), spec);
	return { root, dir, spec };
}
function start(dir: string, spec: JobSpec, runnerPath = runner) {
	const child = spawn(process.execPath, [runnerPath, dir], { env: { ...process.env, HERDR_WORKSPACE_ID: spec.workspaceId,
		HERDR_TAB_ID: "tab", HERDR_PANE_ID: "pane", HERDR_SOCKET_PATH: spec.socketPath }, stdio: "ignore" });
	const done = new Promise<number | null>((resolve) => child.once("exit", resolve));
	return { child, done };
}
async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 8000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await delay(25); }
	throw new Error("Test observation timed out");
}

test("installed standalone runner drains substantial output and trailing bytes before normal and nonzero completion", async (t) => {
	const output = "x".repeat(2 * 1024 * 1024) + "a b\n雪\n";
	const command = `exec '${process.execPath}' -e 'process.stdout.write("x".repeat(2 * 1024 * 1024)); process.stdout.end("a b\\n雪\\n")'`;
	for (const [script, expected, code] of [[command, "succeeded", 0], ["printf 'failed' >&2; exit 7", "failed", 7]] as const) {
		const f = await fixture(t, script, { outputBytes: Buffer.byteLength(output) + 1024 });
		const installed = join(f.root, "node_modules", "@henryqw", "pi-herdr-tools");
		await mkdir(installed, { recursive: true });
		await cp(new URL("../package.json", import.meta.url), join(installed, "package.json"));
		await cp(new URL("../dist", import.meta.url), join(installed, "dist"), { recursive: true });
		assert.equal(await start(f.dir, f.spec, join(installed, "dist", "command-runner.js")).done, 0);
		const job = await readJob(f.dir);
		assert.equal(job.state, expected); assert.equal(job.result?.exitCode, code);
		assert.equal(await readFile(job.outputPath, "utf8"), code ? "failed" : output);
		assert.equal(job.claim?.paneId, "pane");
	}
});

test("runtime and output limits are terminal errors with bounded readable logs", async (t) => {
	for (const [command, limits, expected] of [
		["sleep 20", { runtimeMs: 150 }, "timeout"],
		["while :; do printf '1234567890'; done", { outputBytes: 1024 }, "output_limit"],
	] as const) {
		const f = await fixture(t, command, limits);
		await start(f.dir, f.spec).done;
		const job = await readJob(f.dir);
		assert.equal(job.state, expected, JSON.stringify(job.result));
		assert.ok(Buffer.byteLength(await outputTail(job)) <= f.spec.outputBytes);
	}
});

test("private cancellation stops the owned ordinary descendant group; completion wins a later cancel", async (t) => {
	const f = await fixture(t, "sleep 60 & echo $!; wait");
	const execution = start(f.dir, f.spec);
	const pid = await waitFor(async () => { const text = await outputTail(await readJob(f.dir)); return /^\d+\n$/.test(text) ? Number(text) : undefined; });
	await cancelJob(await readJob(f.dir));
	await execution.done;
	const job = await readJob(f.dir);
	assert.equal(job.state, "cancelled");
	assert.equal(job.result?.signal, "SIGTERM");
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	const completed = await fixture(t, "exit 0");
	await start(completed.dir, completed.spec).done;
	await cancelJob(await readJob(completed.dir));
	assert.equal(await readPrivate(join(completed.dir, "cancel.json")), undefined);
	assert.equal((await readJob(completed.dir)).state, "succeeded");
});

test("unclosed output from an escaped descendant records unknown instead of releasing ownership", async (t) => {
	const script = 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setTimeout(()=>{}, 20000)"],{detached:true,stdio:"inherit"}); console.log(child.pid); child.unref()';
	const f = await fixture(t, `exec '${process.execPath}' -e '${script}'`);
	const execution = start(f.dir, f.spec);
	const pid = await waitFor(async () => { const text = await outputTail(await readJob(f.dir)); return /^\d+\n$/.test(text) ? Number(text) : undefined; });
	t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
	await execution.done;
	const job = await readJob(f.dir);
	assert.equal(job.state, "unknown");
	assert.equal(job.result?.failure, "output_close_timeout");
});

test("one-time runner claim prevents duplicate execution, including after an interrupted claim", async (t) => {
	const f = await fixture(t, "printf once; sleep 0.1", { createdAt: Date.now() - 30_000 });
	const first = start(f.dir, f.spec);
	await waitFor(async () => (await readJob(f.dir)).claim);
	assert.equal(await start(f.dir, f.spec).done, 1);
	await first.done;
	assert.equal(await outputTail(await readJob(f.dir)), "once");
	const claim = (await readJob(f.dir)).claim!;
	await atomicState(f.dir, { ...claim, state: "running", updatedAt: Date.now() - 20_000, exitCode: null, signal: null });
	// A foreign/stale completion cannot grant cancellation or launch authority.
	assert.equal((await readJob(f.dir)).state, "unknown");
	assert.equal(await start(f.dir, f.spec).done, 1);
});

function host(cwd: string, bus = new EventEmitter()) {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		events: { emit: (name: string, value: unknown) => { bus.emit(name, value); }, on: (name: string, fn: (value: unknown) => void) => { bus.on(name, fn); return () => { bus.off(name, fn); }; } },
		on: (name: string, fn: (...args: any[]) => any) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		exec: async () => ({ code: 0, stdout: cwd + "\n" }),
	};
	const admission = checkoutAdmission(pi);
	admission.install(pi);
	return { pi, admission, bus,
		async event(name: string, value: unknown, ctx: unknown = { cwd }) { for (const handler of handlers.get(name) ?? []) { const result = await handler(value, ctx); if (result) return result; } },
	};
}
async function environment(t: TestContext) {
	const old = { HERDR_ENV: process.env.HERDR_ENV, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_SOCKET_PATH: "/tmp/test-herdr.sock" });
	t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-manager-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
function input(root: string) { return { command: "printf once", access: "write" as const, callId: "call", callEntryId: "launch", sessionId: "session", sessionFile: null, cwd: root, checkout: root }; }

test("uncertain dispatch survives restart and rewind, retains admission, and never relaunches duplicate delivery", async (t) => {
	const root = await environment(t);
	let dispatched = 0;
	const h = host(root);
	const manager = new CommandManager(join(root, "commands"), h.admission, async () => { dispatched++; throw new Error("lost response"); });
	const job = await manager.launch(input(root), policy);
	assert.equal(job.state, "unknown");
	assert.equal((await manager.launch(input(root), policy)).spec.id, job.spec.id);
	assert.equal(dispatched, 1);
	const fresh = host(root);
	const restored = new CommandManager(manager.root, fresh.admission, async () => { throw new Error("must not dispatch"); });
	await fresh.event("session_start", {});
	assert.equal((await fresh.event("tool_call", { toolCallId: "edit", toolName: "edit", input: {} })).block, true);
	assert.equal(await fresh.event("tool_call", { toolCallId: "status", toolName: "background_command", input: { action: "status" } }), undefined);
	assert.equal(await fresh.event("tool_call", { toolCallId: "read", toolName: "read", input: {} }), undefined);
	assert.equal((await restored.launch(input(root), policy)).spec.id, job.spec.id);
	await assert.rejects(restored.guardRemoval(root), /including forced completion/);
	await cancelJob(await restored.get(job.spec.id));
	assert.equal((await restored.get(job.spec.id)).state, "unknown");
});

test("runner completion recovers a lost launch response and releases durable ownership", async (t) => {
	const root = await environment(t);
	const h = host(root);
	let execution: ReturnType<typeof start> | undefined;
	const manager = new CommandManager(join(root, "commands"), h.admission, async (_method, params) => {
		const argv = (params.root as { command: string[] }).command;
		assert.equal(argv[0], process.execPath); assert.equal(argv[1], runner);
		const job = await readJob(argv[2]!);
		execution = start(job.dir, job.spec);
		throw new Error("response lost after launch");
	});
	const job = await manager.launch(input(root), policy);
	await execution!.done;
	assert.equal((await manager.get(job.spec.id)).state, "succeeded");
	assert.equal(await h.event("tool_call", { toolCallId: "edit", toolName: "edit", input: {} }), undefined);
});

test("shared admission blocks command launch behind Main and direct writes across event-bus facades", async (t) => {
	const root = await environment(t);
	const main = host(root);
	const other = host(root, main.bus);
	assert.equal(other.admission, main.admission);
	const manager = new CommandManager(join(root, "commands"), other.admission, async () => { throw new Error("must not dispatch"); });
	await main.event("tool_call", { toolCallId: "main", toolName: "write", input: {} });
	await assert.rejects(manager.launch(input(root), policy), /active writer \(main\)/);
	await main.event("tool_execution_end", { toolCallId: "main" });
	await main.event("tool_call", { toolCallId: "direct", toolName: "delegate_task", input: {} });
	const release = main.admission.hold("direct");
	await main.event("session_shutdown", {});
	await assert.rejects(manager.launch(input(root), policy), /active writer \(direct\)/);
	release();
	const removal = await manager.guardRemoval(root);
	await assert.rejects(manager.launch({ ...input(root), access: "read" }, policy), /active writer/);
	removal();
});

test("malformed or foreign state is preserved and blocks writes instead of granting authority", async (t) => {
	const root = await environment(t);
	const h = host(root);
	const manager = new CommandManager(join(root, "commands"), h.admission, async () => { throw new Error("lost"); });
	const job = await manager.launch(input(root), policy);
	await writeFile(join(job.dir, "claim.json"), JSON.stringify({ id: job.spec.id, token: "foreign", runnerId: randomUUID(), workspaceId: "workspace", tabId: "tab", paneId: "pane" }), { mode: 0o600 });
	await assert.rejects(manager.get(job.spec.id), /Foreign command runner/);
	const before = await readFile(join(job.dir, "claim.json"), "utf8");
	assert.equal((await h.event("tool_call", { toolCallId: "edit", toolName: "edit", input: {} })).block, true);
	await assert.rejects(manager.guardRemoval(root), /Foreign command runner/);
	assert.equal(await readFile(join(job.dir, "claim.json"), "utf8"), before);
});

test("tool variants have a flat object root and reject mixed actions before work", () => {
	assert.equal(commandParameters.type, "object");
	assert.equal(Compile(commandParameters).Check({ action: "launch", command: "true", access: "write" }), true);
	for (const request of [{ action: "launch", command: "true" }, { action: "list", id: randomUUID() }, { action: "cancel", id: "../foreign" }, { action: "status", id: randomUUID(), command: "true" }]) assert.throws(() => validateRequest(request));
});

test("runner death cannot authorize a replacement runner or release its checkout", async (t) => {
	const f = await fixture(t, "echo $$; sleep 20", { createdAt: Date.now() - 30_000 });
	const execution = start(f.dir, f.spec);
	const pid = await waitFor(async () => { const text = await outputTail(await readJob(f.dir)); return /^\d+\n$/.test(text) ? Number(text) : undefined; });
	t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
	execution.child.kill("SIGKILL");
	await execution.done;
	assert.equal(await start(f.dir, f.spec).done, 1);
	const job = await readJob(f.dir);
	assert.equal(terminal(job.state), false);
	await atomicState(f.dir, { ...job.claim!, state: "running", updatedAt: Date.now() - 20_000, exitCode: null, signal: null });
	assert.equal((await readJob(f.dir)).state, "unknown");
	assert.doesNotThrow(() => process.kill(pid, 0));
});

test("first completion waits for its launch branch, survives reload, and is not repeated after rewind", async (t) => {
	const root = await environment(t);
	const previousHome = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => { if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousHome; });
	const sessionManager = SessionManager.inMemory(root);
	const firstEntry = sessionManager.appendMessage({ role: "user", content: "run a command", timestamp: Date.now() });
	const launchInput = { action: "launch", command: "printf once", access: "write" };
	const launchEntry = sessionManager.appendMessage({ role: "assistant",
		content: [{ type: "toolCall", id: "call", name: "background_command", arguments: launchInput },
			{ type: "toolCall", id: "sibling", name: "read", arguments: { path: "README.md" } }],
		api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	sessionManager.appendMessage({ role: "toolResult", toolCallId: "sibling", toolName: "read",
		content: [{ type: "text", text: "sibling result" }], isError: false, timestamp: Date.now() });
	let sent = 0;
	let idle = false;
	const ctx = { cwd: root, sessionManager, hasUI: false, isIdle: () => idle } as unknown as ExtensionContext;
	const load = () => {
		const h = host(root);
		let tool: any;
		const api = { ...h.pi, registerTool(value: any) { tool = value; }, registerCommand() {}, sendMessage(message: any, options: any) {
			assert.equal(options.triggerTurn, false);
			sent++; sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		} } as unknown as ExtensionAPI;
		const manager = registerCommands(api);
		return { h, manager, tool };
	};
	const first = load();
	t.mock.method(first.manager, "request", async () => { throw new Error("response lost"); });
	const result = await first.tool.execute("call", launchInput, undefined, undefined, ctx);
	const job = await first.manager.get(result.structuredContent.jobs[0].id);
	assert.equal(job.spec.callEntryId, launchEntry);
	await start(job.dir, job.spec).done;
	await first.h.event("session_start", {}, ctx);
	await first.h.event("session_shutdown", {}, ctx);
	assert.equal(sent, 0);
	idle = true;
	sessionManager.branch(firstEntry);
	const branchReads = t.mock.method(sessionManager, "getBranch");
	t.mock.timers.enable({ apis: ["setInterval"] });
	const reloaded = load();
	t.after(() => reloaded.h.event("session_shutdown", {}, ctx));
	await reloaded.h.event("session_start", {}, ctx);
	t.mock.timers.tick(1000);
	await waitFor(async () => branchReads.mock.callCount() > 0 ? true : undefined);
	assert.equal(sent, 0);
	assert.equal(await readPrivate(join(job.dir, "delivered.json")), undefined);
	assert.equal((await reloaded.manager.get(job.spec.id)).state, "succeeded");
	sessionManager.branch(launchEntry);
	t.mock.timers.tick(1000);
	await waitFor(async () => sent === 1 ? true : undefined);
	await waitFor(async () => await readPrivate(join(job.dir, "delivered.json")));
	await reloaded.h.event("session_shutdown", {}, ctx);
	// Simulate loss of the delivery checkpoint after the transcript append.
	await rm(join(job.dir, "delivered.json"));
	sessionManager.branch(firstEntry);
	const rewound = load();
	t.after(() => rewound.h.event("session_shutdown", {}, ctx));
	await rewound.h.event("session_start", {}, ctx);
	t.mock.timers.tick(1000);
	await waitFor(async () => await readPrivate(join(job.dir, "delivered.json")));
	assert.equal(sent, 1);
});

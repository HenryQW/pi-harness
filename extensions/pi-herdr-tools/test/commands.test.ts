import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import timers, { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { Compile } from "typebox/compile";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkoutAdmission, HerdrRequestError, withWorktreeLock } from "@henryqw/pi-herdr";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { CommandManager, commandParameters, registerCommands, validateRequest } from "../internal/commands.ts";
import { atomicState, cancelJob, claimRunner, inventoryJobs, listJobs, outputTail, pruneJob, readJob, readPrivate, recordNonDispatch, recoveryDiagnostic, releaseJob, startUnreleased, terminal, writePrivate, type Job, type JobSpec } from "../internal/command-state.ts";

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
async function assertLockHeld(dir: string) {
	await assert.rejects(withWorktreeLock(dir, async () => assert.fail("Entered a held lock")), { code: "ELOCKED" });
}
async function assertLockReleased(dir: string) {
	assert.equal(await withWorktreeLock(dir, async () => true), true);
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
		await symlink(await realpath(new URL("../node_modules/@henryqw/pi-herdr", import.meta.url)), join(f.root, "node_modules", "@henryqw", "pi-herdr"), "dir");
		assert.equal(await start(f.dir, f.spec, join(installed, "dist", "command-runner.js")).done, 0);
		const job = await readJob(f.dir);
		assert.equal(job.state, expected); assert.equal(job.result?.exitCode, code);
		assert.equal(await readFile(job.outputPath, "utf8"), code ? "failed" : output);
		assert.equal(job.claim?.paneId, "pane");
	}
});

test("private readers wait for incomplete publication and early cancellation; claims remain write-once", async (t) => {
	const f = await fixture(t, "true");
	const file = join(f.dir, "claim.json");
	const claim = { id: f.spec.id, token: f.spec.token, runnerId: randomUUID(), workspaceId: "workspace", tabId: "tab", paneId: "pane" };
	let resume!: () => void, paused!: () => void;
	const gate = new Promise<void>((resolve) => { resume = resolve; });
	const opened = new Promise<void>((resolve) => { paused = resolve; });
	const open = fs.open;
	const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		if (args[0] === file && args[1] === "wx") {
			const write = handle.writeFile.bind(handle);
			t.mock.method(handle, "writeFile", async (...args: Parameters<typeof handle.writeFile>) => {
				paused(); await gate; return await write(...args);
			});
		}
		return handle;
	});
	syncBuiltinESMExports();
	const publication = writePrivate(file, claim).then(() => atomicState(f.dir, {
		...claim, state: "cancelled", updatedAt: Date.now(), exitCode: null, signal: null,
	}));
	await opened;
	// Release the real, empty file only after the reader encounters the publisher's lock.
	const waitMock = t.mock.method(timers, "setTimeout", async () => { resume(); await publication; });
	syncBuiltinESMExports();
	try {
		const [job] = await listJobs(f.root);
		assert.deepEqual(job?.claim, claim);
		assert.equal(job?.state, "cancelled");
	} finally {
		resume(); await publication;
		openMock.mock.restore(); waitMock.mock.restore(); syncBuiltinESMExports();
	}
	await assert.rejects(writePrivate(file, { ...claim, runnerId: randomUUID() }), { code: "EEXIST" });
	assert.deepEqual(await readPrivate(file), claim);
});

for (const aged of [false, true])
test(`shared-job scanning holds and releases the foreign-session lock with ${aged ? "old" : "unchanged"} timestamps`, async (t) => {
	const f = await fixture(t, "true");
	const other = { ...f.spec, id: randomUUID(), token: randomUUID(), sessionId: "another-session" };
	const otherDir = join(f.root, other.id);
	await mkdir(otherDir, { mode: 0o700 });
	await writePrivate(join(otherDir, "spec.json"), other);
	const before = await fs.lstat(otherDir + ".lock");
	const open = fs.open;
	let checked = false;
	const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		// Mutable state must be read under the job lock, even with an old lock timestamp.
		if (args[0] === join(otherDir, "claim.json")) {
			if (aged) await fs.utimes(otherDir + ".lock", 0, 0);
			await assertLockHeld(otherDir);
			checked = true;
		}
		return await open(...args);
	});
	syncBuiltinESMExports();
	try {
		const jobs = await listJobs(f.root);
		assert.deepEqual(jobs.map(job => job.spec.sessionId).sort(), ["another-session", "session"]);
		assert.ok(jobs.every(job => job.state === "starting"));
		assert.ok(checked, "The scan must inspect foreign-session mutable state under its lock");
	} finally { openMock.mock.restore(); syncBuiltinESMExports(); }
	for (const dir of [f.dir, otherDir]) {
		assert.ok((await fs.lstat(dir + ".lock")).isFile(), "Persistent sidecars must not become job records");
		await assertLockReleased(dir);
	}
	const after = await fs.lstat(otherDir + ".lock");
	assert.equal(after.ino, before.ino);
	assert.equal(after.mtimeMs, aged ? 0 : before.mtimeMs);
});

test("shared recovery refuses a pipe in completed history without holding its lock or granting writes", async (t) => {
	const f = await fixture(t, "true", { sessionId: "historical-session" });
	const claim = { id: f.spec.id, token: f.spec.token, runnerId: randomUUID(), workspaceId: f.spec.workspaceId, tabId: "tab", paneId: "pane" };
	await writePrivate(join(f.dir, "claim.json"), claim);
	await atomicState(f.dir, { ...claim, state: "succeeded", updatedAt: Date.now(), exitCode: 0, signal: null });
	const root = join(f.root, "config", "pi-herdr-tools", "commands");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const dir = join(root, f.spec.id);
	await cp(f.dir, dir, { recursive: true });
	const file = join(dir, "dispatch.json");
	assert.equal(spawnSync("mkfifo", ["-m", "600", file]).status, 0);
	const script = `import assert from "node:assert/strict";
		import { lstat, readFile } from "node:fs/promises";
		import { EventEmitter } from "node:events";
		import { withWorktreeLock } from ${JSON.stringify(import.meta.resolve("@henryqw/pi-herdr"))};
		import { registerCommands } from ${JSON.stringify(new URL("../internal/commands.ts", import.meta.url).href)};
		process.env.PI_CODING_AGENT_DIR = process.argv[1];
		const handlers = new Map(), bus = new EventEmitter();
		const pi = { events: bus, on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
			exec: async () => ({ code: 0, stdout: process.argv[1] + "\\n" }), registerTool() {}, registerCommand() {} };
		const manager = registerCommands(pi);
		const file = process.argv[2] + "/dispatch.json";
		const before = await readFile(process.argv[2] + "/state.json");
		const expected = { message: "Unsafe command state file: " + file };
		const ctx = { cwd: process.argv[1] };
		await assert.rejects(async () => { for (const fn of handlers.get("session_start")) await fn({}, ctx); }, expected);
		await assert.rejects(manager.refresh(), expected);
		const gate = await handlers.get("tool_call")[0]({ toolCallId: "edit", toolName: "edit", input: {} }, ctx);
		assert.equal(gate.block, true);
		await assert.rejects(manager.guardRemoval(process.argv[1], async () => {}), expected);
		assert.ok((await lstat(file)).isFIFO());
		assert.deepEqual(await readFile(process.argv[2] + "/state.json"), before);
		for (const dir of [manager.root, process.argv[2]]) assert.equal(await withWorktreeLock(dir, async () => true), true);`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.root, dir], { encoding: "utf8", timeout: 5000 });
	assert.equal(result.error, undefined, result.stderr);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("command output refuses a pipe without waiting for a writer", async (t) => {
	const f = await fixture(t, "true");
	const file = join(f.dir, "output.log");
	assert.equal(spawnSync("mkfifo", ["-m", "600", file]).status, 0);
	const script = `import assert from "node:assert/strict";
		import { lstat } from "node:fs/promises";
		import { outputTail, readJob } from ${JSON.stringify(new URL("../internal/command-state.ts", import.meta.url).href)};
		await assert.rejects(outputTail(await readJob(process.argv[1])), { message: "Unsafe command output file." });
		assert.ok((await lstat(process.argv[1] + "/output.log")).isFIFO());`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.dir], { encoding: "utf8", timeout: 5000 });
	assert.equal(result.error, undefined, result.stderr);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("malformed private files are refused and never replaced", async (t) => {
	const f = await fixture(t, "true");
	const file = join(f.dir, "claim.json");
	await writeFile(file, "{", { mode: 0o600 });
	await assert.rejects(readPrivate(file), SyntaxError);
	await assert.rejects(readJob(f.dir), SyntaxError);
	await assert.rejects(writePrivate(file, {}), { code: "EEXIST" });
	assert.equal(await readFile(file, "utf8"), "{");
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
	const old = { HERDR_ENV: process.env.HERDR_ENV, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
		PI_SUBAGENT_PROCESS_LEASE: process.env.PI_SUBAGENT_PROCESS_LEASE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	const argv = process.argv;
	process.argv = argv.slice(0, 2);
	delete process.env.PI_SUBAGENT_PROCESS_LEASE;
	t.after(() => { process.argv = argv; });
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_SOCKET_PATH: "/tmp/test-herdr.sock" });
	t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-manager-")));
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
function input(root: string) { return { command: "printf once", access: "write" as const, callId: "call", callEntryId: "launch", sessionId: "session", sessionFile: null, cwd: root, checkout: root }; }

test("delegated launches fail before dispatch, state, or admission; list, status, and cancel remain available", async (t) => {
	for (const marker of ["role flag", "role flag equals", "process lease", "empty process lease"]) await t.test(marker, async (t) => {
		const root = await environment(t);
		if (marker === "role flag") process.argv.push("--pi-subagent-role-tools", "[]");
		else if (marker === "role flag equals") process.argv.push("--pi-subagent-role-tools=[]");
		else process.env.PI_SUBAGENT_PROCESS_LEASE = marker === "process lease" ? join(root, "worker.lease") : "";
		const h = host(root);
		let tool: any;
		const manager = registerCommands({ ...h.pi, registerTool(value: any) { tool = value; }, registerCommand() {} } as unknown as ExtensionAPI);
		const dispatch = t.mock.method(manager, "request", async () => { throw new Error("must not dispatch"); });
		const reserve = t.mock.method(h.admission, "reserve");
		await assert.rejects(manager.launch(input(root), policy), /Main-only/);
		// No session context: refusal must precede config and branch work at the tool boundary.
		await assert.rejects(tool.execute("call", { action: "launch", command: "true", access: "read" }, undefined, undefined, {}), /Main-only/);
		assert.equal(dispatch.mock.callCount(), 0);
		assert.equal(reserve.mock.callCount(), 0);
		assert.deepEqual(await readdir(root), []);

		const f = await fixture(t, "true", { createdAt: Date.now() - 30_000 });
		await mkdir(manager.root, { recursive: true, mode: 0o700 });
		const dir = join(manager.root, f.spec.id);
		await cp(f.dir, dir, { recursive: true });
		const execute = (action: string) => tool.execute("inspect", { action, ...(action === "list" ? {} : { id: f.spec.id }) }, undefined, undefined, {});
		assert.equal((await execute("list")).structuredContent.totalJobs, 1);
		assert.equal((await execute("status")).structuredContent.jobs[0].state, "unknown");
		await execute("cancel");
		assert.deepEqual(await readPrivate(join(dir, "cancel.json")), { id: f.spec.id, token: f.spec.token });
	});
});

test("Show output uses an awaited terminal view but keeps RPC notifications and non-UI lists", async (t) => {
	const root = await environment(t);
	const h = host(root);
	let command: any;
	const manager = registerCommands({ ...h.pi, registerTool() {}, registerCommand(_name: string, value: any) { command = value; } } as unknown as ExtensionAPI);
	const f = await fixture(t, "true");
	await mkdir(manager.root, { recursive: true, mode: 0o700 });
	const dir = join(manager.root, f.spec.id);
	await cp(f.dir, dir, { recursive: true });
	const output = "x".repeat(8190) + "\r\n";
	await writeFile(join(dir, "output.log"), "omitted prefix" + output, { mode: 0o600 });
	let component!: Component, notified = "", customCalls = 0, selectCalls = 0;
	const ctx = { mode: "tui", hasUI: true, sessionManager: SessionManager.inMemory(root), ui: {
		async select(_title: string, choices: string[]) { selectCalls++; return choices[0]; },
		notify(message: string) { notified = message; },
		custom(factory: Function) {
			customCalls++;
			return new Promise<void>((done) => {
				component = factory({ terminal: { rows: 300, columns: 100 }, requestRender() {} },
					{ fg: (_color: string, text: string) => `\x1b[39m${text}\x1b[39m` },
					new KeybindingsManager(TUI_KEYBINDINGS), done);
				if (customCalls === 1) { component.render(100); component.handleInput!("\r"); }
			});
		},
	} };
	let returned = false;
	const pending = command.handler("", ctx).then(() => { returned = true; });
	await waitFor(async () => customCalls === 2 ? component : undefined);
	const lines = component.render(100).map(stripTerminalSequences);
	assert.ok(lines.some((line) => line.includes(f.spec.id)));
	assert.ok(!lines.join("").includes("omitted prefix"));
	const start = lines.findIndex((line) => line.startsWith("Last 8192 output bytes"));
	assert.equal(lines.slice(start + 1, -2).map((line) => line.trimEnd()).join(""), "x".repeat(8190) + "\\u000d");
	assert.equal(returned, false);
	assert.equal(notified, "");
	component.handleInput!("\x1b"); await pending;
	assert.equal(await readPrivate(join(dir, "cancel.json")), undefined);
	const selected = selectCalls;
	const stdout: string[] = [];
	const write = t.mock.method(process.stdout, "write", (chunk: any) => { stdout.push(String(chunk)); return true; });
	try {
		ctx.mode = "rpc";
		await command.handler("", ctx);
		assert.equal(stdout.length, 0);
		assert.ok(notified.endsWith("\n" + output));
		ctx.mode = "print"; ctx.hasUI = false;
		await command.handler("", ctx);
	} finally { write.mock.restore(); }
	for (const line of stdout.join("").trim().split("\n")) assert.equal(JSON.parse(line)[0].id, f.spec.id);
	assert.equal(selectCalls, selected + 2);
	assert.equal(customCalls, 2);
	assert.equal(await outputTail(await manager.get(f.spec.id)), output);
});

test("retained history reads 100 completed records with a 64-descriptor limit", async (t) => {
	const f = await fixture(t, "true");
	for (let index = 0; index < 100; index++) {
		const spec = index === 0 ? f.spec : { ...f.spec, id: randomUUID(), token: randomUUID() };
		const dir = join(f.root, spec.id);
		if (index > 0) {
			await mkdir(dir, { mode: 0o700 });
			await writePrivate(join(dir, "spec.json"), spec);
		}
		const claim = { id: spec.id, token: spec.token, runnerId: randomUUID(), workspaceId: spec.workspaceId, tabId: "tab", paneId: "pane" };
		await writePrivate(join(dir, "claim.json"), claim);
		await atomicState(dir, { ...claim, state: "succeeded", updatedAt: Date.now(), exitCode: 0, signal: null });
	}
	const script = `import assert from "node:assert/strict";
		import { listJobs } from ${JSON.stringify(new URL("../internal/command-state.ts", import.meta.url).href)};
		for (const checkouts of [undefined, [process.argv[1]]]) {
			const jobs = await listJobs(process.argv[1], checkouts);
			assert.equal(jobs.length, 100);
			assert.ok(jobs.every(job => job.state === "succeeded"));
		}`;
	const result = spawnSync("/bin/sh", ["-c", 'ulimit -n 64 && exec "$@"', "history-test", process.execPath, "--input-type=module", "-e", script, f.root], { encoding: "utf8", timeout: 10_000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
});

test("a held historical job lock in checkout A does not block admission in checkout B", async (t) => {
	const f = await fixture(t, "true");
	const checkoutB = await environment(t);
	const claim = { id: f.spec.id, token: f.spec.token, runnerId: randomUUID(), workspaceId: f.spec.workspaceId, tabId: "tab", paneId: "pane" };
	await writePrivate(join(f.dir, "claim.json"), claim);
	await atomicState(f.dir, { ...claim, state: "succeeded", updatedAt: Date.now(), exitCode: 0, signal: null });
	const h = host(checkoutB);
	new CommandManager(f.root, h.admission);
	const wait = t.mock.method(timers, "setTimeout", async () => {});
	syncBuiltinESMExports();
	try {
		await withWorktreeLock(f.dir, async () => {
			assert.equal(await h.event("tool_call", { toolCallId: "edit-b", toolName: "edit", input: {} }), undefined);
		});
	} finally { wait.mock.restore(); syncBuiltinESMExports(); }
});

for (const publication of ["missing", "partial"] as const)
for (const listing of [false, true])
test(`concurrent command publication with a ${publication} specification protects ${listing ? "unfiltered listing" : "checkout B admission"}`,  { timeout: 5000 }, async (t) => {
	const root = await environment(t);
	const checkoutA = join(root, "checkout-a"), checkoutB = join(root, "checkout-b");
	await mkdir(checkoutA); await mkdir(checkoutB);
	const a = host(checkoutA), b = host(checkoutB, a.bus);
	const manager = new CommandManager(join(root, "commands"), a.admission, async () => ({
		type: "layout_apply", layout: { workspace_id: "workspace", tab_id: "tab", root: { type: "pane", pane_id: "pane" } },
	}));
	let file = "", resume!: () => void, paused!: () => void;
	const gate = new Promise<void>((resolve) => { resume = resolve; });
	const opened = new Promise<void>((resolve) => { paused = resolve; });
	const makeDirectory = fs.mkdir;
	const mkdirMock = t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
		const result = await makeDirectory(...args);
		if (publication === "missing" && String(args[0]).startsWith(manager.root + "/")) {
			file = join(String(args[0]), "spec.json");
			paused(); await gate;
		}
		return result;
	});
	const open = fs.open;
	const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const publishing = args[1] === "wx" && String(args[0]).startsWith(manager.root + "/") && String(args[0]).endsWith("/spec.json");
		if (publishing) file = String(args[0]);
		const handle = await open(...args);
		if (publishing && publication === "partial") {
			const write = handle.writeFile.bind(handle);
			t.mock.method(handle, "writeFile", async (...args: Parameters<typeof handle.writeFile>) => {
				const contents = String(args[0]);
				await write(contents.slice(0, 1));
				paused(); await gate;
				return await write(contents.slice(1));
			});
		}
		return handle;
	});
	syncBuiltinESMExports();
	const launch = manager.launch(input(checkoutA), policy);
	let admission;
	try {
		await Promise.race([opened, launch.then(() => assert.fail("Launch did not reach the publication gate."))]);
		await assertLockHeld(manager.root);
		if (publication === "missing") await assert.rejects(fs.lstat(file), { code: "ENOENT" });
		else assert.equal(await readFile(file, "utf8"), "{");
		// Keep publication paused until recovery waits for the root lock.
		const wait = t.mock.method(timers, "setTimeout", async () => { resume(); await launch; });
		syncBuiltinESMExports();
		try {
			if (listing) assert.equal((await listJobs(manager.root)).length, 1);
			admission = await b.event("tool_call", { toolCallId: "edit-b", toolName: "edit", input: {} });
		}
		finally { wait.mock.restore(); syncBuiltinESMExports(); }
	} finally {
		resume(); mkdirMock.mock.restore(); openMock.mock.restore(); syncBuiltinESMExports();
		await launch;
	}
	assert.equal(admission, undefined, "checkout B must be admitted during checkout A's command publication");
	assert.match((await a.event("tool_call", { toolCallId: "edit-a", toolName: "edit", input: {} })).reason, /admitted direct writer \(command:/);
});

test("matching held completion fails closed for checkout sets, reservations, and removal without leaking locks", async (t) => {
	const f = await fixture(t, "true");
	const checkoutB = await environment(t);
	const claim = { id: f.spec.id, token: f.spec.token, runnerId: randomUUID(), workspaceId: f.spec.workspaceId, tabId: "tab", paneId: "pane" };
	await writePrivate(join(f.dir, "claim.json"), claim);
	await atomicState(f.dir, { ...claim, state: "succeeded", updatedAt: Date.now(), exitCode: 0, signal: null });
	const h = host(checkoutB);
	const manager = new CommandManager(f.root, h.admission);
	h.admission.restore(`command:${f.spec.id}`, f.spec.checkout);
	h.admission.classifyDirect(() => true, async () => [f.spec.checkout, checkoutB]);
	const wait = t.mock.method(timers, "setTimeout", async () => {});
	syncBuiltinESMExports();
	try {
		await withWorktreeLock(f.dir, async () => {
			assert.equal((await h.event("tool_call", { toolCallId: "set", toolName: "delegate_task", input: {} })).block, true);
			assert.equal(await h.event("tool_call", { toolCallId: "edit-b", toolName: "edit", input: {} }), undefined, "failed set reserves no member");
			await h.event("tool_execution_end", { toolCallId: "edit-b" });
			(await h.admission.reserve("reserve-b", checkoutB))();
			await assert.rejects(h.admission.reserve("reserve-a", f.spec.checkout), { code: "ELOCKED" });
			await manager.guardRemoval(checkoutB, async () => {});
			await assert.rejects(manager.guardRemoval(f.spec.checkout, async () => {}), { code: "ELOCKED" });
			await assertLockReleased(f.root);
			await assertLockHeld(f.dir);
		});
	} finally { wait.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(await h.event("tool_call", { toolCallId: "recovered-set", toolName: "delegate_task", input: {} }), undefined);
	h.admission.hold("recovered-set")();
	await assertLockReleased(f.dir);
});

test("publication lock contention is bounded and never removes a held lock or damaged record", { timeout: 5000 }, async (t) => {
	const f = await fixture(t, "true");
	const checkoutB = await environment(t);
	const h = host(checkoutB);
	new CommandManager(f.root, h.admission);
	const file = join(f.dir, "spec.json");
	const wait = t.mock.method(timers, "setTimeout", async () => {});
	syncBuiltinESMExports();
	try {
		await withWorktreeLock(f.root, async () => {
			assert.equal(await h.event("tool_call", { toolCallId: "valid", toolName: "edit", input: {} }), undefined);
			assert.equal(wait.mock.callCount(), 0, "valid foreign specifications need no publication lock");
			await writeFile(file, "{");
			assert.deepEqual(await h.event("tool_call", { toolCallId: "damaged", toolName: "edit", input: {} }), {
				block: true, reason: "Command ownership recovery failed; writes are blocked. Inspect /commands.",
			});
			assert.equal(wait.mock.callCount(), 400);
			await assertLockHeld(f.root);
			assert.equal(await readFile(file, "utf8"), "{");
		});
	} finally { wait.mock.restore(); syncBuiltinESMExports(); }
});

for (const operation of ["launch", "removal"] as const)
test(`${operation} reservation fails closed without waiting for its own publication lock`, async (t) => {
	const f = await fixture(t, "true");
	const checkoutB = await environment(t);
	const h = host(checkoutB);
	const request = t.mock.fn(async () => { throw new Error("must not dispatch"); });
	const manager = new CommandManager(f.root, h.admission, request);
	const file = join(f.dir, "spec.json"), open = fs.open;
	let reads = 0;
	const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		// Damage the record after the initial scan, at the reservation's recovery read.
		if (args[0] === file && ++reads === 2) await writeFile(file, "{");
		return await open(...args);
	});
	const wait = t.mock.method(timers, "setTimeout", async () => {});
	syncBuiltinESMExports();
	try {
		await assert.rejects(operation === "launch"
			? manager.launch({ ...input(checkoutB), callId: "new" }, policy)
			: manager.guardRemoval(checkoutB, async () => {}), SyntaxError);
		assert.equal(wait.mock.callCount(), 0);
		assert.equal(reads, 2);
		assert.equal(request.mock.callCount(), 0);
		assert.equal(await readFile(file, "utf8"), "{");
		await assertLockReleased(f.root);
	} finally { openMock.mock.restore(); wait.mock.restore(); syncBuiltinESMExports(); }
});

for (const publication of ["missing", "partial"] as const)
test(`interrupted ${publication} command publication stays blocked without retrying the write or dispatch`, async (t) => {
	const root = await environment(t);
	const h = host(root);
	const request = t.mock.fn(async () => { throw new Error("must not dispatch"); });
	const manager = new CommandManager(join(root, "commands"), h.admission, request);
	const failure = Object.assign(new Error("publication interrupted"), { code: "ELOCKED" });
	const open = fs.open;
	let attempts = 0, file = "";
	const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const publishing = args[1] === "wx" && String(args[0]).endsWith("/spec.json");
		if (publishing) {
			attempts++; file = String(args[0]);
			if (publication === "missing") throw failure;
		}
		const handle = await open(...args);
		if (publishing) {
			const write = handle.writeFile.bind(handle);
			t.mock.method(handle, "writeFile", async () => { await write("{"); throw failure; });
		}
		return handle;
	});
	syncBuiltinESMExports();
	try { await assert.rejects(manager.launch(input(root), policy), failure); }
	finally { openMock.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(attempts, 1);
	const before = (await readdir(manager.root)).filter(name => !name.endsWith(".lock"));
	// A failed publisher releases its locks; persistent sidecars do not prove safe command ownership.
	const dirs = [manager.root, join(manager.root, before[0]!)];
	const inodes = await Promise.all(dirs.map(async dir => {
		await assertLockReleased(dir);
		await fs.utimes(dir + ".lock", 0, 0);
		return (await fs.lstat(dir + ".lock")).ino;
	}));
	const restarted = host(root);
	const recovered = new CommandManager(manager.root, restarted.admission, request);
	assert.equal((await restarted.event("tool_call", { toolCallId: "edit", toolName: "edit", input: {} })).block, true);
	await assert.rejects(recovered.launch(input(root), policy));
	assert.equal(request.mock.callCount(), 0);
	assert.deepEqual((await readdir(manager.root)).filter(name => !name.endsWith(".lock")), before);
	if (publication === "missing") await assert.rejects(fs.lstat(file), { code: "ENOENT" });
	else assert.equal(await readFile(file, "utf8"), "{");
	for (const [index, dir] of dirs.entries()) {
		await assertLockReleased(dir);
		assert.equal((await fs.lstat(dir + ".lock")).ino, inodes[index], "Recovery must not replace a persistent lock file");
	}
});

test("untrustworthy foreign job scope blocks admission and removal without changing the record", async (t) => {
	for (const fault of ["missing", "partial", "identity", "public", "symlink", "pipe"]) await t.test(fault, async (t) => {
		const f = await fixture(t, "true");
		const checkoutB = await environment(t);
		const file = join(f.dir, "spec.json");
		if (fault === "missing" || fault === "symlink" || fault === "pipe") await rm(file);
		if (fault === "partial") await writeFile(file, "{");
		if (fault === "identity") await writeFile(file, JSON.stringify({ ...f.spec, id: randomUUID() }));
		if (fault === "public") await fs.chmod(file, 0o644);
		if (fault === "symlink") {
			const target = join(checkoutB, "spec.json");
			await writeFile(target, JSON.stringify(f.spec), { mode: 0o600 });
			await symlink(target, file);
		}
		if (fault === "pipe") assert.equal(spawnSync("mkfifo", ["-m", "600", file]).status, 0);
		const before = fault === "missing" ? undefined : await fs.lstat(file);
		const h = host(checkoutB);
		const manager = new CommandManager(f.root, h.admission);
		await withWorktreeLock(f.dir, async () => {
			assert.equal((await h.event("tool_call", { toolCallId: "edit-b", toolName: "edit", input: {} })).block, true);
			const wait = t.mock.method(timers, "setTimeout", async () => {});
			syncBuiltinESMExports();
			try {
				await assert.rejects(manager.guardRemoval(checkoutB, async () => {}));
				assert.equal(wait.mock.callCount(), 0, "removal must not wait for its own publication lock");
			} finally { wait.mock.restore(); syncBuiltinESMExports(); }
		});
		if (before) {
			const after = await fs.lstat(file);
			assert.deepEqual([after.ino, after.mode, after.size, after.mtimeMs], [before.ino, before.mode, before.size, before.mtimeMs]);
		} else await assert.rejects(fs.lstat(file), { code: "ENOENT" });
		await assertLockReleased(f.root);
	});
});

test("startup and polling recover local writers while a foreign job stays locked", async (t) => {
	const checkoutB = await environment(t);
	const h = host(checkoutB);
	const sessionManager = SessionManager.inMemory(checkoutB);
	const callEntryId = sessionManager.appendMessage({ role: "user", content: "run", timestamp: Date.now() });
	const sent: unknown[] = [];
	const ctx = { cwd: checkoutB, sessionManager, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
	const manager = registerCommands({ ...h.pi, registerTool() {}, registerCommand() {}, sendMessage(message: unknown) { sent.push(message); } } as unknown as ExtensionAPI);
	t.after(() => h.event("session_shutdown", {}, ctx));
	const f = await fixture(t, "true");
	await mkdir(manager.root, { recursive: true, mode: 0o700 });
	const foreignDir = join(manager.root, f.spec.id);
	await cp(f.dir, foreignDir, { recursive: true });
	// Invalid mutable foreign state must not be read to decide scope or completion.
	await writeFile(join(foreignDir, "state.json"), "{", { mode: 0o600 });
	const local = { ...f.spec, id: randomUUID(), token: randomUUID(), createdAt: Date.now() - 30_000, checkout: checkoutB,
		cwd: checkoutB, sessionId: sessionManager.getSessionId(), callEntryId };
	const localDir = join(manager.root, local.id);
	await mkdir(localDir, { mode: 0o700 });
	await writePrivate(join(localDir, "spec.json"), local);
	const claim = { id: local.id, token: local.token, runnerId: randomUUID(), workspaceId: local.workspaceId, tabId: "tab", paneId: "pane" };
	await writePrivate(join(localDir, "claim.json"), claim);
	await atomicState(localDir, { ...claim, state: "running", updatedAt: Date.now(), exitCode: null, signal: null });
	t.mock.timers.enable({ apis: ["setInterval"] });
	await withWorktreeLock(foreignDir, async () => {
		await h.event("session_start", {}, ctx);
		await h.event("session_shutdown", {}, ctx);
		const wait = t.mock.method(timers, "setTimeout", async () => {});
		syncBuiltinESMExports();
		try {
			await withWorktreeLock(localDir, async () => {
				await assert.rejects(h.event("session_start", {}, ctx), { code: "ELOCKED" });
			});
		} finally { wait.mock.restore(); syncBuiltinESMExports(); }
		assert.equal((await h.event("tool_call", { toolCallId: "live", toolName: "edit", input: {} })).block, true);
		await atomicState(localDir, { ...claim, state: "running", updatedAt: Date.now() - 20_000, exitCode: null, signal: null });
		assert.equal((await h.event("tool_call", { toolCallId: "unknown", toolName: "edit", input: {} })).block, true);
		await atomicState(localDir, { ...claim, state: "succeeded", updatedAt: Date.now(), exitCode: 0, signal: null });
		t.mock.timers.tick(1000);
		await waitFor(async () => sent.length === 1 ? true : undefined);
		assert.equal(await h.event("tool_call", { toolCallId: "recovered", toolName: "edit", input: {} }), undefined);
		await assertLockHeld(foreignDir);
		assert.equal(await readFile(join(foreignDir, "state.json"), "utf8"), "{");
	});
});

test("removal still protects matching live and unknown read jobs but excludes foreign jobs", async (t) => {
	const f = await fixture(t, "true", { access: "read", createdAt: Date.now() - 30_000 });
	const checkoutB = await environment(t);
	const h = host(checkoutB);
	const manager = new CommandManager(f.root, h.admission);
	const claim = { id: f.spec.id, token: f.spec.token, runnerId: randomUUID(), workspaceId: f.spec.workspaceId, tabId: "tab", paneId: "pane" };
	await writePrivate(join(f.dir, "claim.json"), claim);
	for (const updatedAt of [Date.now(), Date.now() - 20_000]) {
		await atomicState(f.dir, { ...claim, state: "running", updatedAt, exitCode: null, signal: null });
		await assert.rejects(manager.guardRemoval(f.spec.checkout, async () => {}), /including forced completion/);
		await manager.guardRemoval(checkoutB, async () => {});
	}
	await atomicState(f.dir, { ...claim, state: "succeeded", updatedAt: Date.now(), exitCode: 0, signal: null });
	await manager.guardRemoval(f.spec.checkout, async () => {});
});

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
	await assert.rejects(restored.guardRemoval(root, async () => {}), /including forced completion/);
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
	await manager.guardRemoval(root, async () => {
		await assert.rejects(manager.launch({ ...input(root), access: "read" }, policy), { code: "ELOCKED" });
	});
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
	await assert.rejects(manager.guardRemoval(root, async () => {}), /Foreign command runner/);
	assert.equal(await readFile(join(job.dir, "claim.json"), "utf8"), before);
});

test("complete serialized specifications are bounded before state creation or reservation", async (t) => {
	const root = await environment(t), h = host(root);
	const request = t.mock.fn(async () => { throw new Error("must not dispatch"); });
	const reserve = t.mock.method(h.admission, "reserve");
	const manager = new CommandManager(join(root, "commands"), h.admission, request);
	for (const extra of [{ command: "\u0001".repeat(16_384) },
		{ command: "雪".repeat(16_384), sessionId: "雪".repeat(4096), callId: "雪".repeat(4096) }]) {
		await assert.rejects(manager.launch({ ...input(root), ...extra }, policy), /65536 serialized bytes/);
	}
	await assert.rejects(manager.launch({ ...input(root), sessionFile: "relative" }, policy), /Invalid command specification/);
	assert.equal(reserve.mock.callCount(), 0);
	assert.equal(request.mock.callCount(), 0);
	assert.deepEqual(await readdir(root), []);
});

for (const aborted of [false, true])
test(`typed non-dispatch proves ${aborted ? "cancellation" : "failure"} without a runner and survives duplicate calls and reload`, async (t) => {
	const root = await environment(t), h = host(root);
	const request = t.mock.fn(async () => { throw new HerdrRequestError(aborted ? "aborted" : "ECONNREFUSED", "secret-token command", false); });
	const manager = new CommandManager(join(root, "commands"), h.admission, request);
	const job = await manager.launch(input(root), policy);
	assert.equal(job.state, aborted ? "cancelled" : "failed");
	assert.equal(job.claim, undefined);
	assert.equal(job.result, undefined);
	assert.equal(job.nonDispatch?.reason, "not_dispatched");
	assert.ok(!(await readFile(join(job.dir, "claim.json"), "utf8")).includes("secret-token"));
	await cancelJob(job);
	assert.equal(await readPrivate(join(job.dir, "cancel.json")), undefined);
	assert.equal(await start(job.dir, job.spec).done, 1);
	assert.deepEqual(await readPrivate(join(job.dir, "claim.json")), job.nonDispatch);
	const restored = new CommandManager(manager.root, host(root).admission, request);
	assert.equal((await restored.launch(input(root), policy)).spec.id, job.spec.id);
	assert.equal(request.mock.callCount(), 1);
	await restored.guardRemoval(root, async () => {});
	const proof = await readFile(join(job.dir, "claim.json"), "utf8");
	await writeFile(join(job.dir, "claim.json"), proof.replace(job.spec.token, randomUUID()));
	await assert.rejects(restored.get(job.spec.id), /Invalid non-dispatch proof/);
	await assert.rejects(restored.guardRemoval(root, async () => {}), /Invalid non-dispatch proof/);
});

test("abort after reservation seals dispatch without calling Herdr", async (t) => {
	const root = await environment(t), h = host(root), controller = new AbortController();
	const reserve = h.admission.reserve.bind(h.admission);
	t.mock.method(h.admission, "reserve", async (...args: Parameters<typeof reserve>) => { const release = await reserve(...args); controller.abort(); return release; });
	const request = t.mock.fn(async () => { throw new Error("must not dispatch"); });
	const manager = new CommandManager(join(root, "commands"), h.admission, request);
	assert.equal((await manager.launch(input(root), policy, controller.signal)).state, "cancelled");
	assert.equal(request.mock.callCount(), 0);
	assert.equal(await h.event("tool_call", { toolCallId: "edit", toolName: "edit", input: {} }), undefined);
});

test("untyped and dispatched errors never count as non-dispatch proof", async (t) => {
	const root = await environment(t);
	for (const [index, error] of [Object.assign(new Error("not sent"), { dispatched: false }), new HerdrRequestError("aborted", "sent", true)].entries()) {
		const manager = new CommandManager(join(root, `commands-${index}`), host(root).admission, async () => { throw error; });
		const job = await manager.launch(input(root), policy);
		assert.equal(job.state, "unknown");
		assert.equal(job.nonDispatch, undefined);
		await assert.rejects(manager.guardRemoval(root, async () => {}), /including forced completion/);
	}
});

test("runner claim and non-dispatch proof exclude each other; contradictory records fail closed", async (t) => {
	for (const winner of ["claim", "proof", "concurrent"] as const) {
		const f = await fixture(t, "printf once"), job = await readJob(f.dir);
		const identity = { id: f.spec.id, token: f.spec.token, runnerId: randomUUID(), workspaceId: f.spec.workspaceId, tabId: "tab", paneId: "pane" };
		const error = new HerdrRequestError("closed", "private", false);
		if (winner === "claim") {
			await claimRunner(f.dir, identity);
			assert.equal(await recordNonDispatch(job, error), false);
			assert.equal((await readJob(f.dir)).nonDispatch, undefined);
		} else if (winner === "proof") {
			assert.equal(await recordNonDispatch(job, error), true);
			await assert.rejects(claimRunner(f.dir, identity), { code: "EEXIST" });
			await writePrivate(join(f.dir, "dispatch.json"), identity);
			await assert.rejects(readJob(f.dir), /Conflicting command dispatch proof/);
		} else {
			const [proof, claim] = await Promise.allSettled([recordNonDispatch(job, error), claimRunner(f.dir, identity)]);
			const saved = await readJob(f.dir);
			assert.equal(Boolean(saved.claim), !saved.nonDispatch);
			assert.deepEqual(proof, { status: "fulfilled", value: Boolean(saved.nonDispatch) });
			assert.equal(claim.status, saved.nonDispatch ? "rejected" : "fulfilled");
		}
	}
});

test("launch fails fast on a foreign job lock and never bypasses global capacity", async (t) => {
	const f = await fixture(t, "true"), checkoutB = await environment(t), h = host(checkoutB);
	const request = t.mock.fn(async () => { throw new Error("must not dispatch"); });
	const manager = new CommandManager(f.root, h.admission, request);
	const wait = t.mock.method(timers, "setTimeout", async () => {});
	syncBuiltinESMExports();
	try {
		await withWorktreeLock(f.dir, async () => {
			await assert.rejects(manager.launch({ ...input(checkoutB), callId: "new" }, { ...policy, concurrency: 1 }), { code: "ELOCKED" });
			assert.equal(wait.mock.callCount(), 0);
			await assertLockReleased(f.root);
			assert.equal(await h.event("tool_call", { toolCallId: "edit-b", toolName: "edit", input: {} }), undefined);
		});
	} finally { wait.mock.restore(); syncBuiltinESMExports(); }
	await assert.rejects(manager.launch({ ...input(checkoutB), callId: "new" }, { ...policy, concurrency: 1 }), /concurrency limit/);
	assert.equal(request.mock.callCount(), 0);
	assert.deepEqual((await listJobs(f.root)).map(job => job.spec.id), [f.spec.id]);
});

for (const cause of ["timeout", "cancelled", "output_limit"] as const)
test(`${cause} stops the live child while its record lock stays held`, { timeout: 12_000 }, async (t) => {
	const script = `console.log(process.pid); ${cause === "output_limit" ? 'setTimeout(()=>setInterval(()=>process.stdout.write("x".repeat(1024)),10),500)' : 'setInterval(()=>{},1000)'}`;
	const f = await fixture(t, `exec '${process.execPath}' -e '${script}'`, { runtimeMs: cause === "timeout" ? 1800 : 8000, outputBytes: 1024 });
	const job = await readJob(f.dir), execution = start(f.dir, f.spec);
	const pid = await waitFor(async () => { const text = await outputTail(job); return /^\d+\n/.test(text) ? Number(text.split("\n")[0]) : undefined; });
	t.after(() => { execution.child.kill("SIGKILL"); try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
	await waitFor(async () => {
		try {
			return await withWorktreeLock(f.dir, async () => {
				if (cause === "cancelled") await cancelJob(job);
				await waitFor(async () => { try { process.kill(pid, 0); return undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } }, 3500);
				await assertLockHeld(f.dir);
				return true;
			});
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined; throw error; }
	});
	await execution.done;
	assert.equal((await readJob(f.dir)).state, cause);
});

test("the cancel tool publishes control before waiting for locked status", { timeout: 12_000 }, async (t) => {
	const root = await environment(t), h = host(root);
	let tool: any;
	const manager = registerCommands({ ...h.pi, registerTool(value: any) { tool = value; }, registerCommand() {} } as unknown as ExtensionAPI);
	const f = await fixture(t, `exec '${process.execPath}' -e 'console.log(process.pid);setInterval(()=>{},1000)'`);
	await mkdir(manager.root, { recursive: true, mode: 0o700 });
	const dir = join(manager.root, f.spec.id);
	await cp(f.dir, dir, { recursive: true });
	const job = await manager.get(f.spec.id), execution = start(dir, f.spec);
	const pid = await waitFor(async () => { const text = await outputTail(job); return /^\d+\n$/.test(text) ? Number(text) : undefined; });
	t.after(() => { execution.child.kill("SIGKILL"); try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
	let cancellation: Promise<unknown> | undefined, failure: unknown;
	await waitFor(async () => {
		try {
			return await withWorktreeLock(dir, async () => {
				cancellation = tool.execute("cancel", { action: "cancel", id: f.spec.id }, undefined, undefined, {}).catch((error: unknown) => { failure = error; });
				await waitFor(async () => { try { process.kill(pid, 0); return undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } }, 3500);
				return true;
			});
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined; throw error; }
	});
	await cancellation; await execution.done;
	assert.equal(failure, undefined);
	assert.equal((await manager.get(f.spec.id)).state, "cancelled");
});

for (const release of [false, true])
test(`a delayed refresh cannot restore a ${release ? "user-released" : "terminal"} owner but missing unknown owners stay held`, async (t) => {
	const f = await fixture(t, "true"), otherCheckout = await environment(t), h = host(f.root);
	const manager = new CommandManager(f.root, h.admission);
	const identity = { id: f.spec.id, token: f.spec.token, runnerId: randomUUID(), workspaceId: f.spec.workspaceId, tabId: "tab", paneId: "pane" };
	await claimRunner(f.dir, identity);
	await atomicState(f.dir, { ...identity, state: "running", updatedAt: Date.now(), exitCode: null, signal: null });
	const other = { ...f.spec, id: "ffffffff-ffff-ffff-ffff-ffffffffffff", token: randomUUID(), checkout: otherCheckout };
	const otherDir = join(f.root, other.id);
	await mkdir(otherDir, { mode: 0o700 }); await writePrivate(join(otherDir, "spec.json"), other);
	await manager.refresh();
	let resume!: () => void, paused!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; }), opened = new Promise<void>(resolve => { paused = resolve; });
	const open = fs.open;
	let held = false;
	const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (!held && args[0] === join(otherDir, "spec.json")) { held = true; paused(); await gate; }
		return await open(...args);
	});
	syncBuiltinESMExports();
	const stale = manager.refresh();
	try {
		await opened;
		if (release) await manager.release(f.spec, true, () => {});
		else await atomicState(f.dir, { ...identity, state: "succeeded", updatedAt: Date.now(), exitCode: 0, signal: null });
		const reloaded = new CommandManager(f.root, host(f.root, h.bus).admission);
		await reloaded.refresh([f.root]);
		resume(); await stale;
		await rm(f.dir, { recursive: true }); await rm(otherDir, { recursive: true });
		(await h.admission.reserve("new", f.root))();
		await assert.rejects(h.admission.reserve("other", otherCheckout), /active writer/);
	} finally { resume(); await stale; mock.mock.restore(); syncBuiltinESMExports(); }
});

test("corrupt delivery checkpoints stay local; non-dispatch completion delivers once with bounded safe warnings", async (t) => {
	const root = await environment(t), h = host(root), sessionManager = SessionManager.inMemory(root);
	const callEntryId = sessionManager.appendMessage({ role: "user", content: "run", timestamp: Date.now() });
	const sent: any[] = [], notifications: string[] = [];
	const ctx = { cwd: root, sessionManager, hasUI: true, isIdle: () => true, hasPendingMessages: () => false, ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext;
	const manager = registerCommands({ ...h.pi, registerTool() {}, registerCommand() {}, sendMessage(message: any) {
		sent.push(message); sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
	} } as unknown as ExtensionAPI);
	t.after(() => h.event("session_shutdown", {}, ctx));
	await mkdir(manager.root, { recursive: true, mode: 0o700 });
	const f = await fixture(t, "secret-command token-value");
	const jobs: Job[] = [];
	for (let index = 1; index <= 5; index++) {
		const spec = { ...f.spec, id: `00000000-0000-0000-0000-00000000000${index}`, token: randomUUID(), checkout: root, callEntryId, sessionId: sessionManager.getSessionId() };
		const dir = join(manager.root, spec.id);
		await mkdir(dir, { mode: 0o700 }); await writePrivate(join(dir, "spec.json"), spec);
		await recordNonDispatch(await readJob(dir), new HerdrRequestError("closed", "untrusted-exception", false));
		jobs.push(await readJob(dir));
		if (index < 5) await writeFile(join(dir, "delivered.json"), '{"secret-command token-value untrusted-exception":', { mode: 0o600 });
	}
	t.mock.timers.enable({ apis: ["setInterval"] });
	await h.event("session_start", {}, ctx);
	await waitFor(async () => { t.mock.timers.tick(1000); return sent.length === 1 ? true : undefined; });
	await waitFor(async () => { t.mock.timers.tick(1000); return await readPrivate(join(jobs[4]!.dir, "delivered.json")); });
	assert.equal(sent[0].details.id, jobs[4]!.spec.id);
	assert.equal(sent[0].details.runnerId, null);
	assert.equal(sent[0].details.failure, "not_dispatched");
	assert.equal(notifications.length, 4);
	assert.match(notifications[0]!, /Command [0-9a-f-]+: delivered.json \(invalid_json\)/);
	assert.match(notifications[3]!, /^Background command recovery or delivery failed/);
	assert.ok(notifications.every(message => message.length < 300 && !/secret-command|token-value|untrusted-exception/.test(message)));
	assert.equal(recoveryDiagnostic(new Error("untrusted-exception")), undefined);
	await h.event("session_shutdown", {}, ctx);
	await rm(join(jobs[4]!.dir, "delivered.json"));
	await h.event("session_start", {}, ctx);
	await waitFor(async () => { t.mock.timers.tick(1000); return await readPrivate(join(jobs[4]!.dir, "delivered.json")); });
	assert.equal(sent.length, 1);
	assert.equal(notifications.length, 4);
	assert.equal(await readFile(join(jobs[0]!.dir, "delivered.json"), "utf8"), '{"secret-command token-value untrusted-exception":');
	await h.event("session_shutdown", {}, ctx);
});

test("tool variants have a flat object root and reject mixed actions before work", () => {
	assert.equal(commandParameters.type, "object");
	assert.equal(Compile(commandParameters).Check({ action: "launch", command: "true", access: "write" }), true);
	for (const request of [{ action: "release", id: randomUUID() }, { action: "prune", id: randomUUID() }, { action: "launch", command: "true" }, { action: "list", id: randomUUID() }, { action: "cancel", id: "../foreign" }, { action: "status", id: randomUUID(), command: "true" }]) assert.throws(() => validateRequest(request));
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

for (const [command, state, exitCode] of [["printf once", "succeeded", 0], ["printf failed >&2; exit 7", "failed", 7]] as const)
test(`shared nested config loads without warnings; ${state} completion requests one turn on its idle launch branch across reload and rewind`, async (t) => {
	const root = await environment(t);
	const configDir = join(root, "config", "pi-herdr-tools");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({ ...policy, btw: { autoSubmit: true, tools: "none", split: "down" } }));
	const notifications: string[] = [];
	const sessionManager = SessionManager.inMemory(root);
	const firstEntry = sessionManager.appendMessage({ role: "user", content: "run a command", timestamp: Date.now() });
	const launchInput = { action: "launch", command, access: "write" };
	const launchEntry = sessionManager.appendMessage({ role: "assistant",
		content: [{ type: "toolCall", id: "call", name: "background_command", arguments: launchInput },
			{ type: "toolCall", id: "sibling", name: "read", arguments: { path: "README.md" } }],
		api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	sessionManager.appendMessage({ role: "toolResult", toolCallId: "sibling", toolName: "read",
		content: [{ type: "text", text: "sibling result" }], isError: false, timestamp: Date.now() });
	const sent: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
	const turnRequests: boolean[] = [];
	let idle = false;
	const ctx = { cwd: root, sessionManager, hasUI: true, ui: { notify: (message: string) => notifications.push(message) }, isIdle: () => idle, hasPendingMessages: () => false } as unknown as ExtensionContext;
	const load = () => {
		const h = host(root);
		let tool: any;
		const api = { ...h.pi, registerTool(value: any) { tool = value; }, registerCommand() {}, sendMessage(message: any, options: any) {
			turnRequests.push(options?.triggerTurn === true && options?.deliverAs === "followUp");
			sent.push(message);
		} } as unknown as ExtensionAPI;
		const manager = registerCommands(api);
		return { h, manager, tool };
	};
	const first = load();
	t.mock.method(first.manager, "request", async () => { throw new Error("response lost"); });
	const result = await first.tool.execute("call", launchInput, undefined, undefined, ctx);
	const job = await first.manager.get(result.structuredContent.jobs[0].id);
	assert.equal(job.spec.callEntryId, launchEntry);
	assert.equal(job.spec.runtimeMs, policy.runtimeMs);
	assert.equal(job.spec.outputBytes, policy.outputBytes);
	assert.deepEqual(notifications, []);
	await start(job.dir, job.spec).done;
	t.mock.timers.enable({ apis: ["setInterval"] });
	const idleChecks = t.mock.method(ctx, "isIdle");
	await first.h.event("session_start", {}, ctx);
	t.mock.timers.tick(1000);
	await waitFor(async () => idleChecks.mock.callCount() > 0 ? true : undefined);
	await first.h.event("session_shutdown", {}, ctx);
	assert.equal(sent.length, 0);
	idle = true;
	sessionManager.branch(firstEntry);
	const branchReads = t.mock.method(sessionManager, "getBranch");
	const reloaded = load();
	t.after(() => reloaded.h.event("session_shutdown", {}, ctx));
	await reloaded.h.event("session_start", {}, ctx);
	const sessionId = sessionManager.getSessionId();
	const sessionCheck = t.mock.method(sessionManager, "getSessionId", () => "another-session");
	t.mock.timers.tick(1000);
	await waitFor(async () => sessionCheck.mock.callCount() > 0 ? true : undefined);
	assert.equal(sent.length, 0);
	assert.equal(await readPrivate(join(job.dir, "delivered.json")), undefined);
	sessionCheck.mock.mockImplementation(() => sessionId);
	await waitFor(async () => { t.mock.timers.tick(1000); return branchReads.mock.callCount() > 0 ? true : undefined; });
	assert.equal(sent.length, 0);
	assert.equal(await readPrivate(join(job.dir, "delivered.json")), undefined);
	assert.equal((await reloaded.manager.get(job.spec.id)).state, state);
	sessionManager.branch(launchEntry);
	t.mock.timers.tick(1000);
	await waitFor(async () => sent.length === 1 ? true : undefined);
	assert.equal(await readPrivate(join(job.dir, "delivered.json")), undefined);
	const entryReads = t.mock.method(sessionManager, "getEntries");
	t.mock.timers.tick(1000);
	await waitFor(async () => entryReads.mock.callCount() > 0 ? true : undefined);
	assert.equal(sent.length, 1);
	assert.equal(await readPrivate(join(job.dir, "delivered.json")), undefined);
	assert.equal(sent[0]!.content, `Background command ${job.spec.id}: ${state}. Output: ${job.outputPath}. Inspect the result and continue the existing request when appropriate.`);
	assert.equal((sent[0]!.details as { exitCode: number }).exitCode, exitCode);
	// An unrecorded dispatch can be retried only after reload.
	await reloaded.h.event("session_shutdown", {}, ctx);
	const recovered = load();
	t.after(() => recovered.h.event("session_shutdown", {}, ctx));
	await recovered.h.event("session_start", {}, ctx);
	await waitFor(async () => { t.mock.timers.tick(1000); return sent.length === 2 ? true : undefined; });
	assert.equal(await readPrivate(join(job.dir, "delivered.json")), undefined);
	const message = sent[1]!;
	sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
	await waitFor(async () => { t.mock.timers.tick(1000); return await readPrivate(join(job.dir, "delivered.json")); });
	assert.deepEqual(turnRequests, [true, true]);
	await recovered.h.event("session_shutdown", {}, ctx);
	// Simulate loss of the delivery checkpoint after the transcript append.
	await rm(join(job.dir, "delivered.json"));
	sessionManager.branch(firstEntry);
	const rewound = load();
	t.after(() => rewound.h.event("session_shutdown", {}, ctx));
	await rewound.h.event("session_start", {}, ctx);
	t.mock.timers.tick(1000);
	await waitFor(async () => await readPrivate(join(job.dir, "delivered.json")));
	assert.equal(sent.length, 2);
	assert.deepEqual(turnRequests, [true, true]);
	await rewound.h.event("session_shutdown", {}, ctx);
});

test("diagnostic inventory isolates locked and malformed records without admitting writes or changing locks", async (t) => {
	const f = await fixture(t, "secret-command"), h = host(f.root), manager = new CommandManager(f.root, h.admission);
	const bad = join(f.root, randomUUID());
	await mkdir(bad, { mode: 0o700 }); await writeFile(join(bad, "spec.json"), '{"secret-token":', { mode: 0o600 });
	const lock = await fs.lstat(f.dir + ".lock");
	await withWorktreeLock(f.dir, async () => {
		const inventory = await inventoryJobs(f.root);
		assert.equal(inventory.length, 2);
		const item = inventory.find(item => item.id === f.spec.id)!;
		assert.equal(item.category, "locked"); assert.equal(item.spec?.checkout, f.root);
		assert.match(item.diagnostic!, /lock_busy/);
		const damaged = inventory.find(item => item.id !== f.spec.id)!;
		assert.equal(damaged.category, "unverified"); assert.equal(damaged.spec, undefined);
		assert.ok(!JSON.stringify(inventory.map(({ diagnostic }) => diagnostic)).includes("secret-token"));
		assert.equal((await h.event("tool_call", { toolName: "write", toolCallId: "blocked", input: {} })).block, true);
		await assertLockHeld(f.dir);
	});
	assert.equal((await fs.lstat(f.dir + ".lock")).ino, lock.ino);
	assert.equal(await readFile(join(bad, "spec.json"), "utf8"), '{"secret-token":');
});

test("confirmed release works with a held job lock and corrupt state, preserves evidence, and survives reload", async (t) => {
	await environment(t);
	const f = await fixture(t, "printf must-not-start"), h = host(f.root), manager = new CommandManager(f.root, h.admission);
	await manager.refresh();
	await writeFile(join(f.dir, "state.json"), "{", { mode: 0o600 });
	await writeFile(join(f.dir, "cancel.json"), "{", { mode: 0o600 });
	await writeFile(join(f.dir, "output.log"), "keep evidence", { mode: 0o600 });
	await assert.rejects(manager.release(f.spec, false, () => {}), /Explicit user confirmation/);
	await assert.rejects(fs.lstat(join(f.dir, "released.json")), { code: "ENOENT" });
	await withWorktreeLock(f.dir, async () => {
		await manager.release(f.spec, true, () => {});
		const job = await manager.get(f.spec.id);
		assert.equal(job.released, true); assert.equal(job.state, "unknown"); assert.equal(terminal(job.state), false);
		assert.equal(await outputTail(job), "keep evidence");
		assert.equal(await h.event("tool_call", { toolName: "write", toolCallId: "allowed", input: {} }), undefined);
		await h.event("tool_execution_end", { toolCallId: "allowed" });
		await manager.guardRemoval(f.root, async () => {});
		const request = t.mock.fn(async () => { throw new Error("must not dispatch"); });
		const reloaded = new CommandManager(f.root, host(f.root).admission, request);
		assert.equal((await reloaded.launch(input(f.root), policy)).released, true);
		assert.equal(request.mock.callCount(), 0);
		await reloaded.guardRemoval(f.root, async () => {});
		await assertLockHeld(f.dir);
	});
	assert.equal(await start(f.dir, f.spec).done, 1);
	await assert.rejects(fs.lstat(join(f.dir, "claim.json")), { code: "ENOENT" });
	for (const file of ["state.json", "cancel.json"]) assert.equal(await readFile(join(f.dir, file), "utf8"), "{");
	await assert.rejects(pruneJob(f.dir, f.spec, () => {}, async () => {}), SyntaxError);
});

test("release rejects changed identity and a held start gate without removing evidence or kernel locks", async (t) => {
	const f = await fixture(t, "true");
	await assert.rejects(releaseJob(f.dir, { ...f.spec, checkout: "/different" }, true, () => {}), /identity or scope changed/);
	await withWorktreeLock(join(f.dir, "spec.json"), async () => {
		await assert.rejects(releaseJob(f.dir, f.spec, true, () => {}), { code: "ELOCKED" });
		await assertLockHeld(join(f.dir, "spec.json"));
	});
	await assert.rejects(fs.lstat(join(f.dir, "released.json")), { code: "ENOENT" });
	assert.deepEqual(await readPrivate(join(f.dir, "spec.json")), f.spec);
});

test("release during an in-flight dispatch seals an unclaimed runner and duplicate delivery", async (t) => {
	const root = await environment(t), h = host(root);
	let manager: CommandManager, dispatched = 0;
	manager = new CommandManager(join(root, "commands"), h.admission, async (_method, params) => {
		dispatched++;
		const dir = (params.root as { command: string[] }).command[2]!;
		const job = await readJob(dir);
		await manager.release(job.spec, true, () => {});
		assert.equal(await start(dir, job.spec).done, 1);
		return { type: "layout_apply", layout: { workspace_id: "workspace", tab_id: "tab", root: { type: "pane", pane_id: "pane" } } };
	});
	const job = await manager.launch(input(root), policy);
	assert.equal(job.released, true); assert.equal(job.state, "unknown");
	assert.equal((await manager.launch(input(root), policy)).spec.id, job.spec.id);
	assert.equal(dispatched, 1);
	await assert.rejects(fs.lstat(join(job.dir, "claim.json")), { code: "ENOENT" });
	assert.ok(await readPrivate(join(job.dir, "dispatch.json")));
});

test("release seals a delayed claim and the claimed-before-spawn boundary", async (t) => {
	for (const claimed of [false, true]) {
		const f = await fixture(t, "printf must-not-start");
		const identity = { id: f.spec.id, token: f.spec.token, runnerId: randomUUID(), workspaceId: f.spec.workspaceId, tabId: "tab", paneId: "pane" };
		if (claimed) await claimRunner(f.dir, identity);
		await releaseJob(f.dir, f.spec, true, () => {});
		if (!claimed) await assert.rejects(claimRunner(f.dir, identity), /released by user/);
		const launch = t.mock.fn(() => spawn("/bin/sh", ["-c", f.spec.command], { stdio: "ignore" }));
		await assert.rejects(startUnreleased(f.dir, f.spec, launch), /sealed by user control/);
		assert.equal(launch.mock.callCount(), 0);
		assert.equal(await start(f.dir, f.spec).done, 1);
		await assert.rejects(fs.lstat(join(f.dir, "output.log")), { code: "ENOENT" });
	}
});

test("a contended start gate fails closed in the installed runner before a shell can write", async (t) => {
	const f = await fixture(t, "printf must-not-start");
	await withWorktreeLock(join(f.dir, "spec.json"), async () => {
		assert.equal(await start(f.dir, f.spec).done, 1);
		assert.equal((await readJob(f.dir)).state, "unknown");
		await assert.rejects(fs.lstat(join(f.dir, "output.log")), { code: "ENOENT" });
		await assertLockHeld(join(f.dir, "spec.json"));
	});
});

test("pruning retains completion and duplicate receipts across reload and frees output capacity", async (t) => {
	await environment(t);
	const f = await fixture(t, "printf once");
	await assert.rejects(pruneJob(f.dir, f.spec, () => {}, async () => {}), /Only verified finished/);
	assert.equal(await start(f.dir, f.spec).done, 0);
	const job = await readJob(f.dir);
	await assert.rejects(pruneJob(f.dir, f.spec, () => {}, async () => {}), /delivery is pending/);
	await writePrivate(join(f.dir, "delivered.json"), { id: f.spec.id, runnerId: job.claim!.runnerId });
	await withWorktreeLock(join(f.dir, "spec.json"), async () => {
		await assert.rejects(pruneJob(f.dir, f.spec, () => {}, async () => {}), { code: "ELOCKED" });
	});
	assert.equal(await outputTail(job), "once");
	await pruneJob(f.dir, f.spec, () => {}, async () => {});
	assert.equal((await readJob(f.dir)).pruned, true);
	assert.equal((await readJob(f.dir)).state, "succeeded");
	assert.match(await outputTail(job), /Output has been pruned/);
	const request = t.mock.fn(async () => { throw new HerdrRequestError("closed", "not sent", false); });
	const reloaded = new CommandManager(f.root, host(f.root).admission, request);
	assert.equal((await reloaded.launch(input(f.root), { ...policy, retainedJobs: 1 })).spec.id, f.spec.id);
	assert.equal(request.mock.callCount(), 0);
	assert.equal(await start(f.dir, f.spec).done, 1);
	await reloaded.launch({ ...input(f.root), callId: "new" }, { ...policy, retainedJobs: 1 });
	assert.equal(request.mock.callCount(), 1);
});

async function commandUI(t: TestContext, finished = false, commandText = "true") {
	const root = await environment(t), h = host(root), sessionManager = SessionManager.inMemory(root);
	const callEntryId = sessionManager.appendMessage({ role: "user", content: "run", timestamp: Date.now() });
	let command: any;
	const sent: any[] = [];
	const manager = registerCommands({ ...h.pi, registerTool() {}, registerCommand(_name: string, value: any) { command = value; }, sendMessage(message: any) { sent.push(message); } } as unknown as ExtensionAPI);
	await mkdir(manager.root, { recursive: true, mode: 0o700 });
	const f = await fixture(t, commandText, { sessionId: sessionManager.getSessionId(), checkout: root, callEntryId });
	const dir = join(manager.root, f.spec.id);
	await cp(f.dir, dir, { recursive: true });
	if (finished) await recordNonDispatch(await readJob(dir), new HerdrRequestError("closed", "private", false));
	const notifications: string[] = [], choices: string[][] = [], titles: string[] = [];
	const answers: Array<string | undefined> = [];
	let scanDone: Promise<void> | undefined, finishScan: (() => void) | undefined, scanReady = false;
	let pruneDone: Promise<void> | undefined, finishPrune: (() => void) | undefined;
	const ctx = { cwd: root, mode: "rpc", hasUI: true, sessionManager, isIdle: () => true, hasPendingMessages: () => false, ui: {
		async select(title: string, options: string[]) {
			titles.push(title); choices.push(options);
			const answer = answers.shift();
			if (answer === "$review") return options.find(option => option.startsWith("Review selection"));
			if (answer?.startsWith("$toggle:")) return options.find(option => option.includes(answer.slice(8)));
			return answer === "$job" || answer === "$default" ? options[0] : answer;
		},
		async input() { return answers.shift(); }, notify(message: string) { notifications.push(message); },
		setStatus(_key: string, value: string | undefined) {
			if (value === "Scanning command outputs...") {
				scanReady = false;
				scanDone = new Promise<void>(resolve => { finishScan = resolve; });
			} else if (value?.startsWith("Command prune ready")) {
				scanReady = true; finishScan?.(); finishScan = undefined;
			} else if (value === "Pruning command outputs...") pruneDone = new Promise<void>(resolve => { finishPrune = resolve; });
			else if (!value) { finishScan?.(); finishScan = undefined; finishPrune?.(); finishPrune = undefined; }
		},
		custom(factory: Function) {
			return new Promise<string | undefined>((done, reject) => {
				const component: Component = factory({ terminal: { rows: 20, columns: 200 }, requestRender() {} },
					{ fg: (_color: string, text: string) => text }, new KeybindingsManager(TUI_KEYBINDINGS), done);
				const lines = component.render(200).map(stripTerminalSequences);
				const option = lines.find(line => line.startsWith("→ "))!.slice(2).trimEnd();
				void ctx.ui.select(lines[0]!.trimEnd(), [option]).then(answer => component.handleInput!(answer ? "\r" : "\x1b"), reject);
			});
		},
	} };
	const startHandler = command.handler.bind(command);
	command.handler = async (...args: unknown[]) => {
		const previousScan = scanDone;
		await startHandler(...args);
		if (args[0] === "prune" && scanDone !== previousScan) {
			await scanDone;
			if (scanReady) await startHandler(...args);
		}
		await pruneDone;
	};
	t.after(() => h.event("session_shutdown", {}, ctx));
	return { h, manager, command, startHandler, ctx, spec: f.spec, dir, answers, choices, titles, notifications, sent };
}

async function batchUI(t: TestContext) {
	const ui = await commandUI(t, true);
	ui.ctx.mode = "rpc";
	const save = async (dir: string, spec: JobSpec) => {
		await writeFile(join(dir, "output.log"), "saved output", { mode: 0o600 });
		await writePrivate(join(dir, "delivered.json"), { id: spec.id, runnerId: null });
	};
	await save(ui.dir, ui.spec);
	const add = async (overrides: Partial<JobSpec> = {}) => {
		const f = await fixture(t, "true", { sessionId: ui.spec.sessionId, checkout: ui.spec.checkout, callEntryId: ui.spec.callEntryId, ...overrides });
		const dir = join(ui.manager.root, f.spec.id);
		await cp(f.dir, dir, { recursive: true });
		await recordNonDispatch(await readJob(dir), new HerdrRequestError("closed", "not sent", false));
		await save(dir, f.spec);
		return { dir, spec: f.spec };
	};
	return { ...ui, add };
}

for (const pruned of [false, true])
test(`${pruned ? "pruned receipts" : "commands list"} pages to a later command and opens its actions`, async (t) => {
	const ui = await batchUI(t);
	const jobs = [ui];
	for (let i = 0; i < 24; i++) jobs.push({ ...ui, ...await ui.add() });
	if (pruned) for (const job of jobs) await pruneJob(job.dir, job.spec, () => {}, async () => {});
	ui.ctx.mode = "tui";
	const keys = new KeybindingsManager(TUI_KEYBINDINGS);
	let selectedId = "", visibleId = "";
	const heading = pruned ? "Pruned command receipts" : "Background commands";
	t.mock.method(ui.ctx.ui, "select", async (title: string) => {
		assert.notEqual(title, heading, "The command list must use a bounded selector");
		selectedId = title.split(":")[0]!;
		return undefined;
	});
	Object.assign(ui.ctx.ui, { custom(factory: Function) {
		return new Promise<string | undefined>(done => {
			const component: Component = factory({ terminal: { rows: 10, columns: 100 }, requestRender() {} },
				{ fg: (_color: string, text: string) => text }, keys, done);
			const render = () => {
				const lines = component.render(100).map(stripTerminalSequences);
				assert.ok(lines.length <= 10);
				return lines.join("\n");
			};
			assert.ok(render().includes(heading));
			for (let i = 0; i < 30; i++) component.handleInput!("\x1b[6~");
			const last = render().split("\n").find(line => line.includes("→"))!;
			assert.match(last, /25\./);
			visibleId = last.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)![0];
			component.handleInput!("\r");
		});
	} });
	await ui.command.handler(pruned ? "pruned" : "", ui.ctx);
	assert.equal(selectedId, visibleId);
});

for (const pruned of [false, true])
test(`${pruned ? "pruned receipts" : "commands list"} searches command text and opens the matching original identity`, async (t) => {
	const ui = await batchUI(t);
	for (let i = 0; i < 24; i++) await ui.add();
	const target = await ui.add({ command: "printf 'Needle 雪'" });
	if (pruned) for (const item of await inventoryJobs(ui.manager.root)) await pruneJob(item.job!.dir, item.spec!, () => {}, async () => {});
	ui.ctx.mode = "tui";
	let selectedId = "";
	t.mock.method(ui.ctx.ui, "select", async (title: string) => { selectedId = title.split(":")[0]!; return undefined; });
	Object.assign(ui.ctx.ui, { custom(factory: Function) {
		return new Promise<string | undefined>(done => {
			const component: Component = factory({ terminal: { rows: 10, columns: 100 }, requestRender() {} },
				{ fg: (_color: string, text: string) => text }, new KeybindingsManager(TUI_KEYBINDINGS), done);
			component.render(100);
			for (const character of "NEEDLE") component.handleInput!(character);
			const lines = component.render(100).map(stripTerminalSequences);
			assert.ok(lines.length <= 10);
			assert.ok(lines.every(line => visibleWidth(line) <= 100));
			assert.equal(lines.filter(line => line.startsWith("→ ") || line.startsWith("  ")).length, 1);
			const selected = lines.find(line => line.startsWith("→ "))!;
			assert.ok(selected.includes(target.spec.id));
			assert.doesNotMatch(selected, /printf|Needle/, "Command text must not appear in the list.");
			component.handleInput!("\r");
		});
	} });
	await ui.command.handler(pruned ? "pruned" : "", ui.ctx);
	assert.equal(selectedId, target.spec.id);
	assert.equal((await inventoryJobs(ui.manager.root)).length, 26, "Search must preserve every record.");
	await assert.rejects(fs.lstat(join(target.dir, "cancel.json")), { code: "ENOENT" });
});

test("commands completion filters pruning paths without executing them", async (t) => {
	const ui = await commandUI(t);
	assert.deepEqual(ui.command.getArgumentCompletions("pru").map((item: any) => item.value), ["prune", "pruned"]);
	assert.match(ui.command.getArgumentCompletions("pruned")[0].description, /receipts/);
	assert.deepEqual(ui.command.getArgumentCompletions("prune "), []);
	assert.deepEqual(ui.command.getArgumentCompletions("unknown"), []);
	assert.equal(ui.choices.length, 0);
});

test("batch prune can remove delivered output from a finished command whose foreign checkout is gone", async (t) => {
	const ui = await batchUI(t);
	const old = await ui.add({ sessionId: "former-session", checkout: join(ui.ctx.cwd, "deleted-worktree") });
	ui.answers.push(`$toggle:${old.spec.id}`, "$review", "Delete output despite this risk");
	await ui.command.handler("prune", ui.ctx);
	assert.equal((await ui.manager.get(old.spec.id)).pruned, true);
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
});

test("prune scan returns while inventory input is pending", async (t) => {
	const ui = await batchUI(t);
	let resume!: () => void, opened!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const waiting = new Promise<void>(resolve => { opened = resolve; });
	const lstat = fs.lstat;
	const mock = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		if (String(args[0]) === ui.manager.root) { opened(); await gate; }
		return await lstat(...args);
	});
	syncBuiltinESMExports();
	try {
		const running = ui.startHandler("prune", ui.ctx);
		await waiting;
		await Promise.race([running, delay(1000).then(() => { throw new Error("Inventory scan blocked the command"); })]);
		await ui.startHandler("prune", ui.ctx);
		assert.match(ui.notifications.at(-1)!, /still running/);
		assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
		resume();
		await waitFor(async () => ui.notifications.some(message => message.includes("scan ready")) ? true : undefined);
		assert.equal(ui.choices.length, 0);
		assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
		await assert.rejects(fs.lstat(join(ui.dir, "pruned.json")), { code: "ENOENT" });
	} finally { resume(); mock.mock.restore(); syncBuiltinESMExports(); }
});

test("shutdown waits for an invalidated prune scan to release its reads", async (t) => {
	const ui = await batchUI(t);
	let resume!: () => void, opened!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const waiting = new Promise<void>(resolve => { opened = resolve; });
	const lstat = fs.lstat;
	const mock = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		if (String(args[0]) === ui.manager.root) { opened(); await gate; }
		return await lstat(...args);
	});
	syncBuiltinESMExports();
	try {
		await ui.startHandler("prune", ui.ctx);
		await waiting;
		await ui.h.event("session_tree", {}, ui.ctx);
		let stopped = false;
		const shutdown = ui.h.event("session_shutdown", {}, ui.ctx).then(() => { stopped = true; });
		await delay(50);
		assert.equal(stopped, false);
		resume();
		await shutdown;
		assert.equal(stopped, true);
	} finally { resume(); mock.mock.restore(); syncBuiltinESMExports(); }
});

test("a branch change invalidates the background prune scan", async (t) => {
	const ui = await batchUI(t);
	let resume!: () => void, opened!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const waiting = new Promise<void>(resolve => { opened = resolve; });
	const lstat = fs.lstat;
	const mock = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		if (String(args[0]) === ui.manager.root) { opened(); await gate; }
		return await lstat(...args);
	});
	syncBuiltinESMExports();
	try {
		await ui.startHandler("prune", ui.ctx);
		await waiting;
		ui.ctx.sessionManager.appendMessage({ role: "user", content: "new request", timestamp: Date.now() });
		resume();
		await waitFor(async () => ui.notifications.some(message => message.includes("scan stopped")) ? true : undefined);
		assert.equal(ui.choices.length, 0);
		assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
	} finally { resume(); mock.mock.restore(); syncBuiltinESMExports(); }
});

test("confirmed batch pruning returns while file operations are pending", async (t) => {
	const ui = await batchUI(t);
	ui.answers.push("Select all", "$review", "Delete output despite this risk");
	let resume!: () => void, opened!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const waiting = new Promise<void>(resolve => { opened = resolve; });
	const open = fs.open;
	const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]).includes("/pruned-") && args[1] === "wx") { opened(); await gate; }
		return await open(...args);
	});
	syncBuiltinESMExports();
	try {
		await ui.startHandler("prune", ui.ctx);
		await waitFor(async () => ui.notifications.some(message => message.includes("scan ready")) ? true : undefined);
		await Promise.race([ui.startHandler("prune", ui.ctx), delay(2000).then(() => { throw new Error("Pruning blocked the command"); })]);
		await waiting;
		assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
		await ui.startHandler("prune", ui.ctx);
		assert.match(ui.notifications.at(-1)!, /still running/);
		resume();
		await waitFor(async () => (await ui.manager.get(ui.spec.id)).pruned ? true : undefined);
		await waitFor(async () => ui.notifications.some(message => message.includes("Pruned 1;")) ? true : undefined);
	} finally { resume(); mock.mock.restore(); syncBuiltinESMExports(); }
});

test("background pruning preserves output when the session becomes busy", async (t) => {
	const ui = await batchUI(t);
	ui.answers.push("Select all", "$review", "Delete output despite this risk");
	let resume!: () => void, opened!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const waiting = new Promise<void>(resolve => { opened = resolve; });
	const open = fs.open;
	const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]).includes("/pruned-") && args[1] === "wx") { opened(); await gate; }
		return await open(...args);
	});
	syncBuiltinESMExports();
	try {
		await ui.startHandler("prune", ui.ctx);
		await waitFor(async () => ui.notifications.some(message => message.includes("scan ready")) ? true : undefined);
		await ui.startHandler("prune", ui.ctx);
		await waiting;
		ui.ctx.isIdle = () => false;
		resume();
		await waitFor(async () => ui.notifications.some(message => message.includes("failed 1")) ? true : undefined);
		assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
	} finally { resume(); mock.mock.restore(); syncBuiltinESMExports(); }
});

test("foreign output needs a missing checkout and matching delivery receipt", async (t) => {
	const ui = await batchUI(t);
	const existing = await ui.add({ sessionId: "other-session", checkout: ui.ctx.cwd });
	const undelivered = await ui.add({ sessionId: "other-session", checkout: join(ui.ctx.cwd, "gone") });
	await rm(join(undelivered.dir, "delivered.json"));
	ui.answers.push("Select all", "$review", "Delete output despite this risk");
	await ui.command.handler("prune", ui.ctx);
	assert.equal((await ui.manager.get(ui.spec.id)).pruned, true);
	for (const job of [existing, undelivered]) assert.equal(await readFile(join(job.dir, "output.log"), "utf8"), "saved output");
	assert.match(ui.notifications.join("\n"), /existing checkout/);
	assert.match(ui.notifications.join("\n"), /delivery is pending or unverified/);
});

test("individual pruning accepts a delivered command from a missing foreign checkout", async (t) => {
	const ui = await batchUI(t);
	const old = await ui.add({ sessionId: "former-session", checkout: join(ui.ctx.cwd, "deleted-worktree") });
	ui.answers.push(`$toggle:${old.spec.id}`, "Prune finished output", "Delete output despite this risk");
	await ui.command.handler("", ui.ctx);
	assert.equal((await ui.manager.get(old.spec.id)).pruned, true);
});

test("pruning preserves foreign output if its checkout returns before deletion", async (t) => {
	const ui = await batchUI(t);
	const checkout = join(ui.ctx.cwd, "returning-worktree");
	const old = await ui.add({ sessionId: "former-session", checkout });
	ui.answers.push(`$toggle:${old.spec.id}`, "$review", "Delete output despite this risk");
	const open = fs.open;
	const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]).includes("/pruned-") && args[1] === "wx") await mkdir(checkout);
		return await open(...args);
	});
	syncBuiltinESMExports();
	try { await ui.command.handler("prune", ui.ctx); }
	finally { mock.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(await readFile(join(old.dir, "output.log"), "utf8"), "saved output");
	assert.match(ui.notifications.at(-1)!, /failed 1/);
});

test("batch prune reviews an exact multi-selection and confirms once without holding locks", async (t) => {
	const ui = await batchUI(t), second = await ui.add(), third = await ui.add();
	ui.answers.push(`$toggle:${ui.spec.id}`, "Clear selection", "Select all", `$toggle:${third.spec.id}`, "$review", "Delete output despite this risk");
	const select = ui.ctx.ui.select.bind(ui.ctx.ui);
	t.mock.method(ui.ctx.ui, "select", async (...args: Parameters<typeof select>) => {
		for (const item of [ui, second, third]) {
			await assertLockReleased(item.dir);
			await assertLockReleased(join(item.dir, "spec.json"));
			assert.equal(await readFile(join(item.dir, "output.log"), "utf8"), "saved output");
		}
		return select(...args);
	});
	await ui.command.handler("prune", ui.ctx);
	const confirmations = ui.titles.filter(title => title.startsWith("Delete these"));
	assert.equal(confirmations.length, 1);
	const warning = confirmations[0]!;
	const selectedRows = ui.choices.at(-1)!.join("\n");
	for (const item of [ui, second]) assert.ok(selectedRows.includes(join(item.dir, "output.log")));
	assert.ok(!selectedRows.includes(third.spec.id));
	assert.match(warning, /Another Pi session may still need it/);
	assert.match(warning, /cannot be undone/);
	assert.equal(ui.choices.at(-1)![0], "Keep output");
	assert.equal((await ui.manager.get(ui.spec.id)).pruned, true);
	assert.equal((await ui.manager.get(second.spec.id)).pruned, true);
	assert.equal(await readFile(join(third.dir, "output.log"), "utf8"), "saved output");
	assert.match(ui.notifications.at(-1)!, /Pruned 2; skipped 0; failed 0/);
});

test("terminal batch pruning bounds both menus and opens exact identities before confirmation", async (t) => {
	const ui = await batchUI(t);
	const jobs = [ui];
	for (let i = 0; i < 24; i++) jobs.push({ ...ui, ...await ui.add() });
	ui.ctx.mode = "tui";
	let stage = 0;
	const keys = new KeybindingsManager(TUI_KEYBINDINGS);
	t.mock.method(ui.ctx.ui, "select", async () => { throw new Error("The unbounded terminal selector must not be used."); });
	Object.assign(ui.ctx.ui, { custom(factory: Function) {
		return new Promise<string | undefined>(done => {
			const component: Component = factory({ terminal: { rows: 18, columns: 100 }, requestRender() {} },
				{ fg: (_color: string, text: string) => text }, keys, done);
			const render = () => {
				const lines = component.render(100).map(stripTerminalSequences);
				assert.ok(lines.length <= 18);
				assert.ok(lines.every(line => visibleWidth(line) <= 100));
				return lines.join("\n");
			};
			const first = render();
			if (stage === 0 || stage === 1) {
				assert.match(first, /→ Cancel/);
				component.handleInput!(stage === 0 ? "\x1b[B" : "\x1b[A");
				assert.match(render(), stage === 0 ? /→ Select all/ : /→ Review selection \(25\)/);
			} else if (stage === 2 || stage === 4) {
				assert.match(first, /→ Keep output/);
				component.handleInput!(stage === 2 ? "\x1b[B" : "\x1b[A");
				const selected = render();
				assert.match(selected.replace(/\s+/g, " "), /Deletion cannot be undone/);
				assert.match(selected, /Another Pi session may still need it/);
				if (stage === 4) assert.match(selected, /→ Delete output despite this risk/);
			} else {
				assert.equal(stage, 3);
				assert.match(first, /Selected output/);
				assert.ok(jobs.some(job => first.includes(job.spec.id)));
				assert.ok(jobs.some(job => first.replace(/\s+/g, "").includes(JSON.stringify(join(job.dir, "output.log")).replace(/\s+/g, ""))));
				assert.doesNotMatch(first, /Last 8192 output bytes/);
			}
			stage++;
			component.handleInput!("\r");
		});
	} });
	await ui.command.handler("prune", ui.ctx);
	assert.equal(stage, 5);
	assert.match(ui.notifications.at(-1)!, /Pruned 25; skipped 0; failed 0/);
	for (const job of jobs) assert.equal((await ui.manager.get(job.spec.id)).pruned, true);
});

test("batch prune cancellation, empty selection, and non-interactive use never delete", async (t) => {
	const ui = await batchUI(t);
	for (const answers of [[undefined], ["Select all", "Cancel"], ["Select all", "$review", "$default"],
		["Select all", "$review", undefined], ["Select all", "$review", `$toggle:${ui.spec.id}`, "$default"],
		["Select all", "Clear selection", "$review"]]) {
		ui.answers.push(...answers);
		await ui.command.handler("prune", ui.ctx);
		assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
		await assert.rejects(fs.lstat(join(ui.dir, "pruned.json")), { code: "ENOENT" });
	}
	ui.ctx.hasUI = false;
	await assert.rejects(ui.command.handler("prune", ui.ctx), /requires a user interface/);
	await assert.rejects(ui.command.handler("prune all", ui.ctx), /Usage/);
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
});

test("batch prune excludes foreign sessions, absent launches, and unverified delivery", async (t) => {
	const ui = await batchUI(t);
	const excluded = [await ui.add({ sessionId: randomUUID() }), await ui.add({ callEntryId: "off-branch" }), await ui.add()];
	await rm(join(excluded[2]!.dir, "delivered.json"));
	ui.answers.push("Select all", "$review", "Delete output despite this risk");
	await ui.command.handler("prune", ui.ctx);
	assert.ok(ui.notifications.some(message => /Skipped 3/.test(message)));
	for (const item of excluded) {
		assert.ok(!ui.choices.at(-1)!.join("\n").includes(item.spec.id));
		assert.equal(await readFile(join(item.dir, "output.log"), "utf8"), "saved output");
	}
	assert.equal((await ui.manager.get(ui.spec.id)).pruned, true);
});

for (const change of ["working", "queued", "session", "branch", "shutdown"])
test(`batch prune rechecks ${change} after confirmation`, async (t) => {
	const ui = await batchUI(t);
	ui.answers.push("Select all", "$review", "Delete output despite this risk");
	const select = ui.ctx.ui.select.bind(ui.ctx.ui);
	t.mock.method(ui.ctx.ui, "select", async (...args: Parameters<typeof select>) => {
		const answer = await select(...args);
		if (answer === "Delete output despite this risk") {
			if (change === "working") ui.ctx.isIdle = () => false;
			else if (change === "queued") ui.ctx.hasPendingMessages = () => true;
			else if (change === "session") t.mock.method(ui.ctx.sessionManager, "getSessionId", () => "another-session");
			else if (change === "branch") ui.ctx.sessionManager.resetLeaf();
			else await ui.h.event("session_shutdown", {}, ui.ctx);
		}
		return answer;
	});
	if (["working", "queued"].includes(change)) {
		await ui.command.handler("prune", ui.ctx);
		assert.match(ui.notifications.at(-1)!, /Pruned 0; skipped 1; failed 0/);
	} else await assert.rejects(ui.command.handler("prune", ui.ctx), /lifecycle changed/);
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
	await assert.rejects(fs.lstat(join(ui.dir, "pruned.json")), { code: "ENOENT" });
});

test("batch prune reports a locked item and continues with other confirmed outputs", async (t) => {
	const ui = await batchUI(t), second = await ui.add();
	ui.ctx.mode = "rpc";
	ui.answers.push("Select all", "$review", "Delete output despite this risk");
	await withWorktreeLock(join(ui.dir, "spec.json"), async () => {
		await ui.command.handler("prune", ui.ctx);
		await assertLockHeld(join(ui.dir, "spec.json"));
	});
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
	assert.equal((await ui.manager.get(second.spec.id)).pruned, true);
	assert.match(ui.notifications.at(-1)!, /Pruned 1; skipped 0; failed 1/);
	assert.ok(ui.notifications.at(-1)!.includes(`Failed ${ui.spec.id}`));
});

test("batch prune rechecks local safety before each deletion and reports partial completion", async (t) => {
	const ui = await batchUI(t), second = await ui.add();
	ui.answers.push("Select all", "$review", "Delete output despite this risk");
	const unlink = fs.unlink;
	let removed: string | undefined;
	const mock = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
		const result = await unlink(...args);
		if (String(args[0]).endsWith("/output.log")) { removed = String(args[0]); ui.ctx.hasPendingMessages = () => true; }
		return result;
	});
	syncBuiltinESMExports();
	try { await ui.command.handler("prune", ui.ctx); }
	finally { mock.mock.restore(); syncBuiltinESMExports(); }
	assert.match(ui.notifications.at(-1)!, /Pruned 1; skipped 1; failed 0/);
	for (const item of [ui, second]) {
		if (join(item.dir, "output.log") === removed) assert.equal((await ui.manager.get(item.spec.id)).pruned, true);
		else assert.equal(await readFile(join(item.dir, "output.log"), "utf8"), "saved output");
	}
});

test("recovery requires explicit Yes with safe No and cancel defaults, and preserves locked evidence", async (t) => {
	const ui = await commandUI(t);
	ui.ctx.mode = "rpc";
	t.mock.method(ui.ctx.ui, "input", async () => { throw new Error("Recovery must not require a typed command ID."); });
	await writeFile(join(ui.dir, "output.log"), "saved evidence", { mode: 0o600 });
	await withWorktreeLock(ui.dir, async () => {
		ui.answers.push("$job", "Cancel and recheck", "No");
		await ui.command.handler("", ui.ctx);
		assert.deepEqual(ui.choices[2], ["No", "Yes"]);
		assert.deepEqual(JSON.parse(await readFile(join(ui.dir, "cancel.json"), "utf8")), { id: ui.spec.id, token: ui.spec.token });
		await assert.rejects(fs.lstat(join(ui.dir, "released.json")), { code: "ENOENT" });
		for (const answer of [undefined, "$default", "No", "unexpected", "Yes"]) {
			ui.answers.push("$job", "Recheck proof", answer);
			await ui.command.handler("", ui.ctx);
			assert.deepEqual(ui.choices.at(-1), ["No", "Yes"]);
			assert.match(ui.titles.at(-1)!, /live command could still write/);
			assert.ok(ui.titles.at(-1)!.includes(ui.spec.id));
			assert.ok(ui.titles.at(-1)!.includes(JSON.stringify(ui.spec.checkout)));
			assert.match(ui.titles.at(-1)!, /Pi writes and checkout removal/);
			assert.match(ui.titles.at(-1)!, /records and output stay saved/);
			assert.equal((await inventoryJobs(ui.manager.root))[0]!.job?.released, answer === "Yes" ? true : undefined);
		}
		assert.ok(ui.notifications.some(message => message.includes("released by user, termination unproved")));
		assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved evidence");
		assert.deepEqual(JSON.parse(await readFile(join(ui.dir, "spec.json"), "utf8")), ui.spec);
		await assertLockHeld(ui.dir);
	});
});

for (const answer of ["No", "cancel", "Yes"])
test(`terminal recovery keeps the full warning and requires a visible choice: ${answer}`, async (t) => {
	const ui = await commandUI(t);
	ui.ctx.mode = "tui";
	const terminal = { rows: 18, columns: 80 };
	let stage = 0;
	t.mock.method(ui.ctx.ui, "select", async () => "Recheck proof");
	t.mock.method(ui.ctx.ui, "input", async () => { throw new Error("Release must not require typing."); });
	Object.assign(ui.ctx.ui, { custom(factory: Function) {
		return new Promise<string | undefined>(done => {
			const component: Component = factory({ terminal, requestRender() {} },
				{ fg: (_color: string, text: string) => text }, new KeybindingsManager(TUI_KEYBINDINGS), done);
			const render = () => {
				const lines = component.render(terminal.columns).map(stripTerminalSequences);
				assert.ok(lines.length <= terminal.rows);
				assert.ok(lines.every(line => visibleWidth(line) <= terminal.columns));
				return lines.join("\n");
			};
			const first = render();
			if (stage === 1) {
				assert.ok(first.includes(ui.spec.id));
				assert.match(first.replace(/\s+/g, " "), /A live command could still write/);
				assert.match(first.replace(/\s+/g, " "), /Pi writes and checkout removal/);
				assert.ok(first.replace(/\s+/g, "").includes(JSON.stringify(ui.spec.checkout).replace(/\s+/g, "")));
				assert.doesNotMatch(first, /Search:/, "A risk confirmation cannot filter away its safe default.");
			}
			if (stage === 1) {
				assert.match(first, /→ No/);
				if (answer === "Yes") {
					terminal.rows = 2;
					component.handleInput!("\r"); // A hidden confirmation must not complete the dialog.
					assert.match(render(), /Enlarge terminal/);
					terminal.rows = 18;
					render();
					component.handleInput!("\x1b[B");
					assert.match(render(), /→ Yes/);
				}
			}
			const cancel = stage === 1 && answer === "cancel";
			stage++;
			component.handleInput!(cancel ? "\x1b" : "\r");
		});
	} });
	await ui.command.handler("", ui.ctx);
	assert.equal(stage, 2);
	assert.equal((await ui.manager.get(ui.spec.id)).released, answer === "Yes" ? true : undefined);
});

for (const step of [1, 2, 3])
test(`recovery aborts a changed session branch after dialog ${step}`, async (t) => {
	const ui = await commandUI(t);
	ui.answers.push("$job", "Recheck proof", "Yes");
	let dialogs = 0;
	for (const method of ["select", "input"] as const) {
		const original = ui.ctx.ui[method].bind(ui.ctx.ui) as (...args: any[]) => Promise<string | undefined>;
		t.mock.method(ui.ctx.ui, method, async (...args: any[]) => {
			const answer = await original(...args);
			if (++dialogs === step) ui.ctx.sessionManager.appendMessage({ role: "user", content: "changed", timestamp: Date.now() });
			return answer;
		});
	}
	await assert.rejects(ui.command.handler("", ui.ctx), /Session, branch, or command lifecycle changed/);
	await assert.rejects(fs.lstat(join(ui.dir, "released.json")), { code: "ENOENT" });
});

test("release rechecks lifecycle at publication, and malformed identity remains report-only", async (t) => {
	const ui = await commandUI(t);
	ui.answers.push("$job", "Recheck proof", "Yes");
	const open = fs.open;
	const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]).includes("/released-") && args[1] === "wx") await ui.h.event("session_shutdown", {}, ui.ctx);
		return await open(...args);
	});
	syncBuiltinESMExports();
	try { await assert.rejects(ui.command.handler("", ui.ctx), /lifecycle changed/); }
	finally { mock.mock.restore(); syncBuiltinESMExports(); }
	await assert.rejects(fs.lstat(join(ui.dir, "released.json")), { code: "ENOENT" });
	await writeFile(join(ui.dir, "spec.json"), "{");
	ui.answers.push("$job");
	await ui.command.handler("", ui.ctx);
	assert.match(ui.notifications.at(-1)!, /identity and checkout scope cannot be verified/);
	assert.equal(await readFile(join(ui.dir, "spec.json"), "utf8"), "{");
});

test("an existing pruning receipt reports missing output, not output that still exists", async (t) => {
	const f = await fixture(t, "printf retained");
	assert.equal(await start(f.dir, f.spec).done, 0);
	await writePrivate(join(f.dir, "pruned.json"), { version: 1, id: f.spec.id, token: f.spec.token, checkout: f.spec.checkout,
		sessionId: f.spec.sessionId, callId: f.spec.callId, kind: "pruned", updatedAt: Date.now() });
	assert.equal((await readJob(f.dir)).pruned, undefined);
	assert.equal(await outputTail(await readJob(f.dir)), "retained");
	await rm(join(f.dir, "output.log"));
	const pruned = await readJob(f.dir);
	assert.equal(pruned.pruned, true);
	assert.match(await outputTail(pruned), /Output has been pruned/);
	await writeFile(join(f.dir, "output.log"), "restored", { mode: 0o600 });
	assert.equal(await outputTail(pruned), "restored");
	assert.equal((await readJob(f.dir)).pruned, undefined);
});

test("explicit release asks only the live runner to stop, keeps its log, and never invents completion", async (t) => {
	const f = await fixture(t, "printf running; sleep 60");
	const execution = start(f.dir, f.spec);
	t.after(() => execution.child.kill("SIGTERM"));
	await waitFor(async () => await outputTail(await readJob(f.dir)) === "running" ? true : undefined);
	await releaseJob(f.dir, f.spec, true, () => {});
	assert.equal(await execution.done, 0);
	const released = await readJob(f.dir);
	assert.equal(released.state, "cancelled"); assert.equal(released.released, true);
	assert.equal(await outputTail(released), "running");
	assert.equal((await readPrivate(join(f.dir, "state.json")) as { state: string }).state, "cancelled");
	assert.equal(await start(f.dir, f.spec).done, 1);
	assert.equal(await outputTail(await readJob(f.dir)), "running");
});

test("proof-based recheck stops before override when completion becomes available between dialogs", async (t) => {
	const ui = await commandUI(t);
	ui.answers.push("$job", "Recheck proof");
	const select = ui.ctx.ui.select.bind(ui.ctx.ui);
	t.mock.method(ui.ctx.ui, "select", async (...args: Parameters<typeof select>) => {
		await assertLockReleased(ui.dir);
		await assertLockReleased(join(ui.dir, "spec.json"));
		const answer = await select(...args);
		if (answer === "Recheck proof") await recordNonDispatch(await readJob(ui.dir), new HerdrRequestError("closed", "not sent", false));
		return answer;
	});
	await ui.command.handler("", ui.ctx);
	assert.equal(ui.choices.length, 2);
	assert.match(ui.notifications.at(-1)!, /Verified completion: failed/);
	assert.equal((await ui.manager.get(ui.spec.id)).released, undefined);
	await ui.manager.guardRemoval(ui.spec.checkout, async () => {});
});

test("warned deletion can remove output another native Pi session still needs, only after human confirmation", async (t) => {
	const ui = await commandUI(t, true);
	const file = join(ui.ctx.cwd, "consumer-session.jsonl"), output = join(ui.dir, "output.log");
	await writeFile(output, "pending output", { mode: 0o600 });
	await writePrivate(join(ui.dir, "delivered.json"), { id: ui.spec.id, runnerId: null });
	await writeFile(file, [ui.ctx.sessionManager.getHeader(), ...ui.ctx.sessionManager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const script = `import { SessionManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
		import { readFile } from "node:fs/promises";
		const session = SessionManager.open(process.argv[1]);
		console.log(session.getSessionId());
		process.stdin.once("data", async () => { try { console.log(await readFile(process.argv[2], "utf8")); } catch (error) { console.log(error.code); } });`;
	const consumer = spawn(process.execPath, ["--input-type=module", "-e", script, file, output], { stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => consumer.kill("SIGTERM"));
	const done = new Promise<number | null>(resolve => consumer.once("exit", resolve));
	let received = "", errors = "";
	consumer.stdout.on("data", chunk => { received += chunk; });
	consumer.stderr.on("data", chunk => { errors += chunk; });
	await waitFor(async () => received.includes(ui.spec.sessionId) ? true : undefined);
	// The native manager permits both processes to open the same saved session.
	ui.ctx.sessionManager = SessionManager.open(file);
	for (const mode of ["tui", "rpc"]) {
		ui.ctx.mode = mode;
		ui.answers.push("$job", "Prune finished output", "$default");
		await ui.command.handler("", ui.ctx);
		assert.equal(ui.choices.at(-1)![0], "Keep output");
		assert.match(ui.titles.at(-1)!, /Another Pi session may still need it/);
		assert.match(ui.titles.at(-1)!, /cannot prove/);
		assert.match(ui.titles.at(-1)!, /cannot be undone/);
	}
	await assert.rejects(fs.lstat(join(ui.dir, "pruned.json")), { code: "ENOENT" });
	assert.equal(await readFile(output, "utf8"), "pending output");
	ui.answers.push("$job", "Prune finished output", "Delete output despite this risk");
	await ui.command.handler("", ui.ctx);
	consumer.stdin.end("consume");
	assert.equal(await done, 0, errors);
	assert.ok(received.endsWith("ENOENT\n"));
	assert.match(await outputTail(await ui.manager.get(ui.spec.id)), /Output has been pruned/);
});

test("released jobs stay inspectable under a held lock and later deliver real verified runner completion", async (t) => {
	const ui = await commandUI(t, false, "printf running; sleep 60");
	const execution = start(ui.dir, ui.spec);
	t.after(() => execution.child.kill("SIGTERM"));
	await waitFor(async () => await outputTail(await readJob(ui.dir)) === "running" ? true : undefined);
	await waitFor(async () => {
		try {
			return await withWorktreeLock(ui.dir, async () => {
				await ui.manager.release(ui.spec, true, () => {});
				assert.equal((await ui.manager.get(ui.spec.id)).state, "unknown");
				assert.equal((await inventoryJobs(ui.manager.root))[0]!.job?.released, true);
				return true;
			});
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined; throw error; }
	});
	const audit = await readFile(join(ui.dir, "released.json"), "utf8");
	assert.equal(await execution.done, 0);
	const job = await ui.manager.get(ui.spec.id);
	assert.equal(job.state, "cancelled"); assert.equal(job.released, true);
	assert.equal(await readFile(join(ui.dir, "released.json"), "utf8"), audit);
	t.mock.timers.enable({ apis: ["setInterval"] });
	await ui.h.event("session_start", {}, ui.ctx);
	await waitFor(async () => { t.mock.timers.tick(1000); return ui.sent.length === 1 ? true : undefined; });
	assert.equal(ui.sent[0].details.state, "cancelled");
	assert.equal(ui.sent[0].details.recovery, "released by user; completion later verified");
	ui.ctx.sessionManager.appendCustomMessageEntry(ui.sent[0].customType, ui.sent[0].content, true, ui.sent[0].details);
	await waitFor(async () => { t.mock.timers.tick(1000); return await readPrivate(join(ui.dir, "delivered.json")); });
	assert.equal(ui.sent.length, 1);
	assert.equal(await outputTail(job), "running");
	await ui.h.event("session_shutdown", {}, ui.ctx);
	ui.answers.push("$job", "Prune finished output", "Delete output despite this risk");
	await ui.command.handler("", ui.ctx);
	assert.equal((await ui.manager.get(ui.spec.id)).pruned, true);
	assert.equal(await readFile(join(ui.dir, "released.json"), "utf8"), audit);
});

test("remote dialogs use native No/Yes selection without writing protocol stdout", async (t) => {
	const ui = await commandUI(t);
	ui.ctx.mode = "rpc";
	ui.answers.push("$job", "Recheck proof", "Yes");
	const stdout: string[] = [];
	const write = t.mock.method(process.stdout, "write", (chunk: any) => { stdout.push(String(chunk)); return true; });
	try { await ui.command.handler("", ui.ctx); }
	finally { write.mock.restore(); }
	assert.equal(ui.answers.length, 0);
	assert.deepEqual(stdout, []);
	assert.equal((await ui.manager.get(ui.spec.id)).released, true);
	assert.match(ui.notifications.at(-1)!, /released by user, termination unproved/);
});

test("confirmed pruning clears the default list, keeps receipts, and has no non-UI mutation path", async (t) => {
	const ui = await commandUI(t, true);
	ui.ctx.mode = "rpc";
	await writeFile(join(ui.dir, "output.log"), "saved output", { mode: 0o600 });
	await writePrivate(join(ui.dir, "delivered.json"), { id: ui.spec.id, runnerId: null });
	const evidence = await Promise.all(["spec.json", "claim.json", "delivered.json"].map(file => readFile(join(ui.dir, file), "utf8")));
	for (const answer of [undefined, "$default"]) {
		ui.answers.push("$job", "Prune finished output", answer);
		await ui.command.handler("", ui.ctx);
		assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
		await assert.rejects(fs.lstat(join(ui.dir, "pruned.json")), { code: "ENOENT" });
	}
	ui.ctx.hasUI = false;
	const reports: string[] = [];
	const write = t.mock.method(process.stdout, "write", (chunk: any) => { reports.push(String(chunk)); return true; });
	try { await ui.command.handler("", ui.ctx); } finally { write.mock.restore(); }
	assert.equal(JSON.parse(reports[0]!)[0].outputPruned, false);
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "saved output");
	ui.ctx.hasUI = true;
	ui.answers.push("$job", "Prune finished output", "Delete output despite this risk");
	await ui.command.handler("", ui.ctx);
	assert.equal((await ui.manager.get(ui.spec.id)).pruned, true);
	assert.deepEqual(await Promise.all(["spec.json", "claim.json", "delivered.json"].map(file => readFile(join(ui.dir, file), "utf8"))), evidence);
	const selections = ui.choices.length;
	await ui.command.handler("", ui.ctx);
	assert.equal(ui.choices.length, selections);
	assert.match(ui.notifications.at(-1)!, /No unpruned commands/);
	ui.answers.push("$job", "Show output");
	await ui.command.handler("pruned", ui.ctx);
	assert.match(ui.choices[selections]![0]!, /output pruned/);
	assert.deepEqual(ui.choices.at(-1), ["Show output"]);
	assert.match(ui.notifications.at(-1)!, /Output has been pruned/);
	t.mock.timers.enable({ apis: ["setInterval"] });
	await ui.h.event("session_start", {}, ui.ctx);
	t.mock.timers.tick(1000);
	await ui.h.event("session_shutdown", {}, ui.ctx);
	assert.equal(ui.sent.length, 0);
});

test("unknown and released-unproved commands never offer or permit pruning", async (t) => {
	const ui = await commandUI(t);
	await writeFile(join(ui.dir, "output.log"), "keep evidence", { mode: 0o600 });
	for (const release of [false, true]) {
		if (release) await ui.manager.release(ui.spec, true, () => {});
		ui.answers.push("$job", undefined);
		await ui.command.handler("", ui.ctx);
		assert.ok(!ui.choices.at(-1)!.some(choice => choice.includes("Prune")));
		await assert.rejects(pruneJob(ui.dir, ui.spec, () => {}, async () => {}), /Only verified finished/);
		await ui.command.handler("prune", ui.ctx);
		assert.match(ui.notifications.at(-1)!, /No eligible finished outputs/);
	}
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "keep evidence");
	await assert.rejects(fs.lstat(join(ui.dir, "pruned.json")), { code: "ENOENT" });
});

test("pending completion requires local history even when a shared delivery receipt already exists", async (t) => {
	const ui = await commandUI(t, true);
	await writeFile(join(ui.dir, "output.log"), "keep pending output", { mode: 0o600 });
	ui.answers.push("$job", "Prune finished output", "Delete output despite this risk");
	await assert.rejects(ui.command.handler("", ui.ctx), /delivery is pending/);
	t.mock.timers.enable({ apis: ["setInterval"] });
	await ui.h.event("session_start", {}, ui.ctx);
	await waitFor(async () => { t.mock.timers.tick(1000); return ui.sent.length === 1 ? true : undefined; });
	await waitFor(async () => {
		try { return await withWorktreeLock(join(ui.dir, "spec.json"), async () => true); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined; throw error; }
	});
	await writePrivate(join(ui.dir, "delivered.json"), { id: ui.spec.id, runnerId: null });
	let reads = 0;
	const entries = ui.ctx.sessionManager.getEntries.bind(ui.ctx.sessionManager);
	t.mock.method(ui.ctx.sessionManager, "getEntries", () => { reads++; return entries(); });
	const scanOnce = async () => {
		const before = reads;
		await waitFor(async () => { t.mock.timers.tick(1000); return reads > before ? true : undefined; });
	};
	await scanOnce();
	ui.answers.push("$job", "Prune finished output");
	await assert.rejects(ui.command.handler("", ui.ctx), /local pending delivery/);
	await ui.command.handler("prune", ui.ctx);
	assert.match(ui.notifications.at(-2)!, /local pending delivery/);
	assert.match(ui.notifications.at(-1)!, /No eligible finished outputs/);
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "keep pending output");
	await assert.rejects(fs.lstat(join(ui.dir, "pruned.json")), { code: "ENOENT" });
	const message = ui.sent[0];
	ui.ctx.sessionManager.appendCustomMessageEntry(message.customType, message.content, true, message.details);
	await scanOnce();
	await ui.h.event("session_shutdown", {}, ui.ctx);
	ui.answers.push("$job", "Prune finished output", "Delete output despite this risk");
	await ui.command.handler("", ui.ctx);
	assert.equal((await ui.manager.get(ui.spec.id)).pruned, true);
	assert.equal(ui.sent.length, 1);
});

for (const change of ["working", "queued", "session", "branch", "shutdown"])
test(`pruning rechecks ${change} after human confirmation`, async (t) => {
	const ui = await commandUI(t, true);
	await writeFile(join(ui.dir, "output.log"), "keep", { mode: 0o600 });
	await writePrivate(join(ui.dir, "delivered.json"), { id: ui.spec.id, runnerId: null });
	ui.answers.push("$job", "Prune finished output", "Delete output despite this risk");
	const select = ui.ctx.ui.select.bind(ui.ctx.ui);
	t.mock.method(ui.ctx.ui, "select", async (...args: Parameters<typeof select>) => {
		const answer = await select(...args);
		if (answer === "Delete output despite this risk") {
			if (change === "working") ui.ctx.isIdle = () => false;
			else if (change === "queued") ui.ctx.hasPendingMessages = () => true;
			else if (change === "session") t.mock.method(ui.ctx.sessionManager, "getSessionId", () => "another-session");
			else if (change === "branch") ui.ctx.sessionManager.resetLeaf();
			else await ui.h.event("session_shutdown", {}, ui.ctx);
		}
		return answer;
	});
	await assert.rejects(ui.command.handler("", ui.ctx), /lifecycle changed|local pending delivery/);
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "keep");
	await assert.rejects(fs.lstat(join(ui.dir, "pruned.json")), { code: "ENOENT" });
});

for (const batch of [false, true])
for (const change of ["spec", "state", "delivery", "release", "output", "lifecycle"])
test(`${batch ? "batch" : "individual"} pruning rechecks ${change} after receipt preparation and before deletion`, async (t) => {
	const ui = await commandUI(t, false, "printf keep");
	if (batch) ui.ctx.mode = "rpc";
	assert.equal(await start(ui.dir, ui.spec).done, 0);
	const job = await readJob(ui.dir);
	await writePrivate(join(ui.dir, "delivered.json"), { id: ui.spec.id, runnerId: job.claim!.runnerId });
	const target = join(ui.ctx.cwd, "unrelated-output");
	await writeFile(target, "unrelated", { mode: 0o600 });
	ui.answers.push(...batch ? ["Select all", "$review", "Delete output despite this risk"] : ["$job", "Prune finished output", "Delete output despite this risk"]);
	const open = fs.open;
	const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]).includes("/pruned-") && args[1] === "wx") {
			if (change === "spec") await writeFile(join(ui.dir, "spec.json"), JSON.stringify({ ...ui.spec, checkout: ui.ctx.cwd + "/other" }));
			else if (change === "state") await writeFile(join(ui.dir, "state.json"), JSON.stringify({ ...job.result, state: "unknown" }));
			else if (change === "delivery") await writeFile(join(ui.dir, "delivered.json"), JSON.stringify({ id: ui.spec.id, runnerId: "foreign" }));
			else if (change === "release") await writeFile(join(ui.dir, "released.json"), "{", { mode: 0o600 });
			else if (change === "output") { await rm(job.outputPath); await symlink(target, job.outputPath); }
			else ui.ctx.hasPendingMessages = () => true;
		}
		return await open(...args);
	});
	syncBuiltinESMExports();
	try {
		if (batch) {
			await ui.command.handler("prune", ui.ctx);
			assert.match(ui.notifications.at(-1)!, /Pruned 0; skipped 0; failed 1/);
			assert.match(ui.notifications.at(-1)!, /identity|verified completion|Foreign completion|Invalid command state|ELOOP|local pending/);
		} else await assert.rejects(ui.command.handler("", ui.ctx), /identity|verified completion|Foreign completion|Invalid command state|ELOOP|local pending/);
	} finally { mock.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(await readFile(target, "utf8"), "unrelated");
	assert.equal(await readFile(job.outputPath, "utf8"), change === "output" ? "unrelated" : "keep");
});

test("a failed output deletion leaves its receipt honest and requires a new confirmation", async (t) => {
	const ui = await commandUI(t, true);
	await writeFile(join(ui.dir, "output.log"), "keep", { mode: 0o600 });
	await writePrivate(join(ui.dir, "delivered.json"), { id: ui.spec.id, runnerId: null });
	ui.answers.push("$job", "Prune finished output", "Delete output despite this risk");
	const unlink = fs.unlink;
	const mock = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
		if (args[0] === join(ui.dir, "output.log")) throw Object.assign(new Error("injected deletion failure"), { code: "EACCES" });
		return await unlink(...args);
	});
	syncBuiltinESMExports();
	try { await assert.rejects(ui.command.handler("", ui.ctx), { code: "EACCES" }); }
	finally { mock.mock.restore(); syncBuiltinESMExports(); }
	assert.equal((await ui.manager.get(ui.spec.id)).pruned, undefined);
	assert.equal(await outputTail(await ui.manager.get(ui.spec.id)), "keep");
	ui.answers.push("$job", "Prune finished output", "$default");
	await ui.command.handler("", ui.ctx);
	assert.equal(await readFile(join(ui.dir, "output.log"), "utf8"), "keep");
	ui.answers.push("$job", "Prune finished output", "Delete output despite this risk");
	await ui.command.handler("", ui.ctx);
	assert.equal((await ui.manager.get(ui.spec.id)).pruned, true);
});


test("older shared coordinators fail before registration or command controls are written", async (t) => {
	const root = await environment(t);
	for (const missing of ["complete", "guard", "restore", "reserve", "release", "install"] as const) {
		const h = host(root);
		const old = { ...h.admission } as Record<string, unknown>;
		delete old[missing];
		h.bus.on("pi-herdr:checkout-admission", ({ receive }) => receive(old));
		assert.throws(() => registerCommands(h.pi as unknown as ExtensionAPI), /active checkout coordinator/);
	}
	await assert.rejects(fs.lstat(join(extensionConfigDir("pi-herdr-tools"), "commands")), { code: "ENOENT" });
});

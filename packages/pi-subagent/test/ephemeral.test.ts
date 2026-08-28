import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createEphemeralSubagentExecutor,
	EphemeralSubagentError,
	type EphemeralSubagentExecutor,
	type PiLaunch,
} from "../src/index.ts";
import type { EphemeralSubagentActivityEvent } from "../src/ephemeral.ts";

const timeout = { idleMs: 1_000, maxMs: 2_000 };
const launch: PiLaunch = { env: {}, args: [] };
const successfulRunner = `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));\n`;

function simulateActivePi(t: import("node:test").TestContext): void {
	const previousMarker = process.env.PI_CODING_AGENT;
	const previousTitle = process.title;
	process.env.PI_CODING_AGENT = "true";
	process.title = "pi";
	t.after(() => {
		if (previousMarker === undefined) delete process.env.PI_CODING_AGENT;
		else process.env.PI_CODING_AGENT = previousMarker;
		process.title = previousTitle;
	});
}

async function useRunner(t: import("node:test").TestContext, source: string): Promise<string> {
	simulateActivePi(t);
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-ephemeral-"));
	const runner = join(cwd, "fake-pi.mjs");
	const previous = process.argv[1];
	await writeFile(runner, source);
	process.argv[1] = runner;
	t.after(async () => {
		process.argv[1] = previous;
		await rm(cwd, { recursive: true, force: true });
	});
	return cwd;
}

function executor(maxConcurrency = 1): EphemeralSubagentExecutor {
	return createEphemeralSubagentExecutor({ maxConcurrency, timeout });
}

function prepared(cwd: string, task = "work", childLaunch = launch) {
	return { launch: childLaunch, task, cwd };
}

function usage(multiplier: number) {
	return {
		input: 1 * multiplier,
		output: 2 * multiplier,
		cacheRead: 3 * multiplier,
		cacheWrite: 4 * multiplier,
		cacheWrite1h: 1 * multiplier,
		reasoning: 2 * multiplier,
		totalTokens: 10 * multiplier,
		cost: {
			input: 0.1 * multiplier,
			output: 0.2 * multiplier,
			cacheRead: 0.3 * multiplier,
			cacheWrite: 0.4 * multiplier,
			total: 1 * multiplier,
		},
	};
}

test("executor acquires FIFO permits before prepare", async (t) => {
	const cwd = await useRunner(t, successfulRunner);
	const calls: number[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const run = (id: number) => executorInstance.run({
		prepare: async () => {
			calls.push(id);
			if (id === 1) await firstGate;
			return prepared(cwd, `task-${id}`);
		},
	});
	const executorInstance = executor();
	const runs = [run(1), run(2), run(3)];
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, [1]);
	releaseFirst();
	await Promise.all(runs);
	assert.deepEqual(calls, [1, 2, 3]);
});

test("queued abort never calls prepare and preserves the abort cause", async (t) => {
	const cwd = await useRunner(t, successfulRunner);
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const executorInstance = executor();
	const first = executorInstance.run({ prepare: async () => {
		await firstGate;
		return prepared(cwd, "first");
	} });
	let preparedQueued = false;
	const controller = new AbortController();
	const queued = executorInstance.run({
		signal: controller.signal,
		prepare: async () => {
			preparedQueued = true;
			return prepared(cwd, "queued");
		},
	});
	const cause = new Error("cancelled by caller");
	controller.abort(cause);
	await assert.rejects(queued, (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "aborted");
		assert.equal(error.cause, cause);
		return true;
	});
	assert.equal(preparedQueued, false);
	releaseFirst();
	await first;
});

test("malformed run signal rejects before prepare without leaking a permit", async (t) => {
	const cwd = await useRunner(t, successfulRunner);
	const executorInstance = executor();
	let prepareCalled = false;
	await assert.rejects(executorInstance.run({
		signal: {} as AbortSignal,
		prepare: async () => {
			prepareCalled = true;
			return prepared(cwd, "malformed");
		},
	}), TypeError);
	assert.equal(prepareCalled, false);
	assert.equal((await executorInstance.run({ prepare: async () => prepared(cwd, "valid") })).output, "done");
});

test("executor merges env and launches active Pi with cwd and argv without a shell", async (t) => {
	const cwd = await useRunner(t, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), inherited: process.env.EPHEMERAL_INHERITED, override: process.env.EPHEMERAL_OVERRIDE }) }], stopReason: "stop" } }));\n`);
	const previousInherited = process.env.EPHEMERAL_INHERITED;
	const previousOverride = process.env.EPHEMERAL_OVERRIDE;
	process.env.EPHEMERAL_INHERITED = "parent";
	process.env.EPHEMERAL_OVERRIDE = "parent";
	t.after(() => {
		if (previousInherited === undefined) delete process.env.EPHEMERAL_INHERITED;
		else process.env.EPHEMERAL_INHERITED = previousInherited;
		if (previousOverride === undefined) delete process.env.EPHEMERAL_OVERRIDE;
		else process.env.EPHEMERAL_OVERRIDE = previousOverride;
	});

	const result = await executor().run({ prepare: async () => prepared(cwd, "quoted task; echo unsafe", {
		env: { EPHEMERAL_OVERRIDE: "child" },
		args: ["--model", "test/model"],
	}) });
	assert.equal(result.outcome, "success");
	assert.deepEqual(JSON.parse(result.output), {
		argv: ["--mode", "json", "-p", "--model", "test/model", "Task: quoted task; echo unsafe"],
		cwd: await realpath(cwd),
		inherited: "parent",
		override: "child",
	});
});

test("executor captures its active Pi invocation before later argv mutation", async (t) => {
	const cwd = await useRunner(t, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "captured" }], stopReason: "stop" } }));\n`);
	const executorInstance = executor();
	const redirected = join(cwd, "redirected.mjs");
	await writeFile(redirected, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "redirected" }], stopReason: "stop" } }));\n`);
	process.argv[1] = redirected;
	assert.equal((await executorInstance.run({ prepare: async () => prepared(cwd) })).output, "captured");
});

test("Bun virtual entrypoints reuse the active executable instead of PATH", async (t) => {
	simulateActivePi(t);
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-bun-invocation-"));
	const previous = process.argv[1];
	process.argv[1] = "/$bunfs/root/pi";
	t.after(async () => {
		process.argv[1] = previous;
		await rm(cwd, { recursive: true, force: true });
	});
	const result = await executor().run({
		prepare: async () => prepared(cwd, "work", { env: { PATH: "" }, args: [] }),
	});
	assert.equal(result.outcome, "failure");
	assert.match(result.stderr, /(?:bad|unknown|illegal) option/i);
});

test("post-exit stdio drain releases one queued permit held by an escaped descendant", async (t) => {
	const cwd = await useRunner(t, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const task = process.argv.at(-1);
if (task === "Task: first") {
	const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { detached: true, stdio: "inherit" });
	escaped.unref();
	writeFileSync(process.env.EPHEMERAL_ESCAPED_PID_FILE, String(escaped.pid));
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" } }));
} else {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop" } }));
}
`);
	const pidFile = join(cwd, "escaped.pid");
	t.after(async () => {
		try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch {}
	});
	const executorInstance = executor();
	const preparedTasks: string[] = [];
	const first = executorInstance.run({
		prepare: async () => {
			preparedTasks.push("first");
			return prepared(cwd, "first", { env: { EPHEMERAL_ESCAPED_PID_FILE: pidFile }, args: [] });
		},
	});
	const second = executorInstance.run({
		prepare: async () => {
			preparedTasks.push("second");
			return prepared(cwd, "second");
		},
	});
	let rejectDeadline!: (error: Error) => void;
	const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
	const deadlineTimer = setTimeout(
		() => rejectDeadline(new Error("post-exit stdio drain did not release the queued permit")),
		1_500,
	);
	try {
		const [firstResult, secondResult] = await Promise.race([Promise.all([first, second]), deadline]);
		assert.equal(firstResult.output, "first");
		assert.equal(secondResult.output, "second");
		assert.deepEqual(preparedTasks, ["first", "second"]);
	} finally {
		clearTimeout(deadlineTimer);
	}
});

test("post-exit hard stdio deadline releases a queued permit despite inherited output", async (t) => {
	const cwd = await useRunner(t, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const task = process.argv.at(-1);
if (task === "Task: first") {
	const escaped = spawn(process.execPath, ["-e", "setInterval(() => process.stdout.write('.'), 50)"], { detached: true, stdio: "inherit" });
	escaped.unref();
	writeFileSync(process.env.EPHEMERAL_ESCAPED_PID_FILE, String(escaped.pid));
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" } }));
} else {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop" } }));
}
`);
	const pidFile = join(cwd, "escaped.pid");
	t.after(async () => {
		try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch {}
	});
	const executorInstance = executor();
	const launches: string[] = [];
	let firstOutputAt = 0;
	let secondStarted!: () => void;
	const secondStart = new Promise<void>((resolve) => { secondStarted = resolve; });
	const first = executorInstance.run({
		onUpdate: (output) => { if (output === "first") firstOutputAt = Date.now(); },
		prepare: async () => {
			launches.push("first");
			return prepared(cwd, "first", { env: { EPHEMERAL_ESCAPED_PID_FILE: pidFile }, args: [] });
		},
	});
	const second = executorInstance.run({
		prepare: async () => {
			launches.push("second");
			secondStarted();
			return prepared(cwd, "second");
		},
	});
	await Promise.race([
		secondStart,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("post-exit hard stdio deadline did not release the queued permit")), 1_250)),
	]);
	assert.ok(firstOutputAt > 0);
	assert.ok(Date.now() - firstOutputAt < 1_250);
	assert.deepEqual(launches, ["first", "second"]);
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.output, "first");
	assert.equal(secondResult.output, "second");
});

test("executor projects validated child activity", async (t) => {
	const cwd = await useRunner(t, `const event = (value) => console.log(JSON.stringify(value));
event({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/ephemeral.ts" } });
event({ type: "tool_execution_start", toolCallId: "bash-2", toolName: "bash", args: {} });
event({ type: "tool_execution_start", toolCallId: "write-3", toolName: "write", args: { path: "one\\ntwo" } });
event({ type: "tool_execution_end", toolCallId: "bash-2", toolName: "bash" });
event({ type: "tool_execution_end", toolCallId: "write-3", toolName: "write" });
event({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" });
event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
`);
	const activity: EphemeralSubagentActivityEvent[] = [];
	const result = await executor().run({
		onActivity: (event) => activity.push(event),
		prepare: async () => prepared(cwd),
	});
	assert.equal(result.output, "done");
	assert.deepEqual(activity, [
		{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", path: "src/ephemeral.ts" },
		{ type: "tool_execution_start", toolCallId: "bash-2", toolName: "bash" },
		{ type: "tool_execution_start", toolCallId: "write-3", toolName: "write" },
		{ type: "tool_execution_end", toolCallId: "bash-2", toolName: "bash" },
		{ type: "tool_execution_end", toolCallId: "write-3", toolName: "write" },
		{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" },
		{ type: "message_end" },
	]);
});

test("executor excludes malformed activity telemetry without failing the child", async (t) => {
	const cwd = await useRunner(t, `const event = (value) => console.log(JSON.stringify(value));
event({ type: "tool_execution_start", toolCallId: "", toolName: "read", args: {} });
event({ type: "tool_execution_start", toolCallId: "tool-2", toolName: " ", args: {} });
event({ type: "tool_execution_end", toolCallId: 3, toolName: "read" });
event({ type: "tool_execution_end", toolCallId: "tool-4", toolName: null });
event({ type: "message_end", message: { role: "user", content: [] } });
event({ type: "message_end", message: null });
event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
`);
	const activity: EphemeralSubagentActivityEvent[] = [];
	const result = await executor().run({
		onActivity: (event) => activity.push(event),
		prepare: async () => prepared(cwd),
	});
	assert.equal(result.output, "done");
	assert.deepEqual(activity, [{ type: "message_end" }]);
});

test("activity callback failures are typed executor failures", async (t) => {
	const cwd = await useRunner(t, `console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} })); setInterval(() => {}, 1_000);\n`);
	const cause = new Error("activity observer failed");
	await assert.rejects(executor().run({
		onActivity: async () => { throw cause; },
		prepare: async () => prepared(cwd),
	}), (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "callback");
		assert.equal(error.cause, cause);
		return true;
	});
});

test("callback failure terminates the child and releases the next queued run", async (t) => {
	const observedUsage = usage(1);
	const cwd = await useRunner(t, `const task = process.argv.at(-1);
if (task === "Task: first") {
	console.log(JSON.stringify({ type: "message_update", usage: ${JSON.stringify(observedUsage)}, assistantMessageEvent: { type: "text_delta", delta: "partial" } }));
	setInterval(() => {}, 1_000);
} else {
	${successfulRunner}
}
`);
	const executorInstance = executor();
	const cause = new Error("observer failed");
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	try {
		const first = executorInstance.run({
			onUpdate: () => { throw cause; },
			onTokens: () => new Promise<void>(() => {}),
			prepare: async () => prepared(cwd, "first"),
		});
		const next = executorInstance.run({ prepare: async () => prepared(cwd, "second") });
		await assert.rejects(first, (error) => {
			assert.ok(error instanceof EphemeralSubagentError);
			assert.equal(error.code, "callback");
			assert.equal(error.cause, cause);
			assert.deepEqual(error.usage, observedUsage);
			return true;
		});
		assert.equal((await next).output, "done");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a never-settling callback rejects as a typed callback failure and releases the permit", async (t) => {
	const cwd = await useRunner(t, successfulRunner);
	const executorInstance = executor();
	await assert.rejects(executorInstance.run({
		onUpdate: () => new Promise<void>(() => {}),
		prepare: async () => prepared(cwd, "first"),
	}), (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "callback");
		return true;
	});
	assert.equal((await executorInstance.run({ prepare: async () => prepared(cwd, "second") })).output, "done");
});

test("async token callback rejection is a typed executor failure", async (t) => {
	const cwd = await useRunner(t, `console.log(JSON.stringify({ type: "message_update", usage: { totalTokens: 1 } })); setInterval(() => {}, 1_000);\n`);
	const cause = new Error("token observer failed");
	await assert.rejects(executor().run({
		onTokens: async () => { throw cause; },
		prepare: async () => prepared(cwd),
	}), (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "callback");
		assert.equal(error.cause, cause);
		return true;
	});
});

test("executor returns complete aggregated Usage", async (t) => {
	const first = usage(1);
	const second = usage(2);
	const cwd = await useRunner(t, `const event = (value) => console.log(JSON.stringify(value));
event({ type: "message_update", usage: ${JSON.stringify(first)} });
event({ type: "message_end", message: { role: "assistant", content: [], usage: ${JSON.stringify(first)}, stopReason: "toolUse" } });
event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: ${JSON.stringify(second)}, stopReason: "stop" } });
`);
	const tokens: number[] = [];
	const result = await executor().run({
		onTokens: (value) => tokens.push(value),
		prepare: async () => prepared(cwd),
	});
	assert.deepEqual(result.usage, usage(3));
	assert.deepEqual(tokens, [10, 10, 30]);
});

test("launched abort rejects with accumulated Usage", async (t) => {
	const observedUsage = usage(1);
	const cwd = await useRunner(t, `console.log(JSON.stringify({ type: "message_update", usage: ${JSON.stringify(observedUsage)} })); setInterval(() => {}, 1_000);\n`);
	const controller = new AbortController();
	let observed!: () => void;
	const update = new Promise<void>((resolve) => { observed = resolve; });
	const running = executor().run({
		signal: controller.signal,
		onTokens: () => observed(),
		prepare: async () => prepared(cwd),
	});
	await update;
	const cause = new Error("stop launched child");
	controller.abort(cause);
	await assert.rejects(running, (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "aborted");
		assert.equal(error.cause, cause);
		assert.deepEqual(error.usage, observedUsage);
		return true;
	});
});

test("abort keeps its permit through a child error until close and stdio drain", async (t) => {
	if (process.platform === "win32") {
		t.skip("The executor uses taskkill instead of ChildProcess.kill on Windows.");
		return;
	}
	const firstUsage = usage(1);
	const finalUsage = usage(2);
	const cwd = await useRunner(t, `import { existsSync } from "node:fs";
const update = (usage) => JSON.stringify({ type: "message_update", usage });
const end = (usage) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage, stopReason: "toolUse" } });
if (process.argv.at(-1) === "Task: first") {
	process.on("SIGTERM", () => process.stdout.write(update(${JSON.stringify(finalUsage)}) + "\\n"));
	process.stdout.write(end(${JSON.stringify(firstUsage)}) + "\\n");
	const timer = setInterval(() => {
		if (existsSync(process.env.EPHEMERAL_RELEASE_FILE)) {
			clearInterval(timer);
			process.exit(0);
		}
	}, 10);
} else {
	${successfulRunner}
}
`);
	const releaseFile = join(cwd, "release");
	const controller = new AbortController();
	const cause = new Error("stop launched child");
	const originalProcessKill = process.kill;
	const originalChildKill = ChildProcess.prototype.kill;
	let injectError = true;
	process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid < 0 && injectError) throw new Error("induced tree-kill failure");
		return originalProcessKill(pid, signal);
	}) as typeof process.kill;
	ChildProcess.prototype.kill = function(signal) {
		if (injectError) {
			injectError = false;
			this.emit("error", new Error("induced abort error"));
		}
		return originalChildKill.call(this, signal);
	};
	t.after(() => {
		process.kill = originalProcessKill;
		ChildProcess.prototype.kill = originalChildKill;
	});

	const starts: string[] = [];
	let observedFirst!: () => void;
	const firstObserved = new Promise<void>((resolve) => { observedFirst = resolve; });
	let drained!: () => void;
	const usageDrained = new Promise<void>((resolve) => { drained = resolve; });
	const executorInstance = executor();
	const first = executorInstance.run({
		signal: controller.signal,
		onTokens: (tokens) => {
			if (tokens === firstUsage.totalTokens) {
				observedFirst();
				controller.abort(cause);
			}
			if (tokens === firstUsage.totalTokens + finalUsage.totalTokens) drained();
		},
		prepare: async () => {
			starts.push("first");
			return prepared(cwd, "first", { env: { EPHEMERAL_RELEASE_FILE: releaseFile }, args: [] });
		},
	});
	const firstError = first.then<unknown>(undefined, (error) => error);
	const second = executorInstance.run({
		prepare: async () => {
			starts.push("second");
			return prepared(cwd, "second");
		},
	});
	await firstObserved;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["first"]);
	await Promise.race([
		usageDrained,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("aborted child did not drain usage")), 1_000)),
	]);
	await writeFile(releaseFile, "");
	const error = await firstError;
	assert.ok(error instanceof EphemeralSubagentError);
	assert.equal(error.code, "aborted");
	assert.equal(error.cause, cause);
	assert.deepEqual(error.usage, usage(3));
	assert.equal((await second).output, "done");
});

test("executor rejects timeout with accumulated Usage without double counting", async (t) => {
	const first = usage(1);
	const current = usage(2);
	const cwd = await useRunner(t, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: ${JSON.stringify(first)}, stopReason: "toolUse" } })); console.log(JSON.stringify({ type: "message_update", usage: ${JSON.stringify(current)} })); setInterval(() => {}, 1_000);\n`);
	const timeoutExecutor = createEphemeralSubagentExecutor({ maxConcurrency: 1, timeout });
	let observed!: () => void;
	const usageObserved = new Promise<void>((resolve) => { observed = resolve; });
	const running = timeoutExecutor.run({
		onTokens: (tokens) => {
			if (tokens === first.totalTokens + current.totalTokens) observed();
		},
		prepare: async () => prepared(cwd),
	});
	await Promise.race([usageObserved, running]);
	await assert.rejects(running, (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "timeout");
		assert.ok(error.cause instanceof Error);
		assert.deepEqual(error.usage, usage(3));
		return true;
	});
});

test("executor rejects relevant protocol overflow with accumulated Usage", async (t) => {
	const observedUsage = usage(1);
	const cwd = await useRunner(t, `console.log(JSON.stringify({ type: "message_update", usage: ${JSON.stringify(observedUsage)} })); process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] } })); setInterval(() => {}, 1_000);\n`);
	await assert.rejects(executor().run({ prepare: async () => prepared(cwd) }), (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "protocol");
		assert.ok(error.cause instanceof Error);
		assert.deepEqual(error.usage, observedUsage);
		return true;
	});
});

test("executor returns process failures as typed outcomes", async (t) => {
	const cwd = await useRunner(t, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model failed" } })); process.stderr.write("details"); process.exitCode = 2;\n`);
	const result = await executor().run({ prepare: async () => prepared(cwd) });
	assert.equal(result.outcome, "failure");
	assert.equal(result.exitCode, 2);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "model failed");
	assert.equal(result.stderr, "details");
});

test("executor requires the active Pi marker, exact process title, and reusable invocation", (t) => {
	const previousMarker = process.env.PI_CODING_AGENT;
	const previousTitle = process.title;
	const previousScript = process.argv[1];
	t.after(() => {
		if (previousMarker === undefined) delete process.env.PI_CODING_AGENT;
		else process.env.PI_CODING_AGENT = previousMarker;
		process.title = previousTitle;
		process.argv[1] = previousScript;
	});
	const rejectsInactive = () => assert.throws(() => executor(), (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "prepare");
		assert.match(error.message, /active Pi.*PI_CODING_AGENT=true.*pi or pi-rpc/);
		return true;
	});

	process.title = "pi";
	delete process.env.PI_CODING_AGENT;
	rejectsInactive();
	process.env.PI_CODING_AGENT = "true";
	process.title = "node /usr/local/bin/pi";
	rejectsInactive();
	process.title = "pi";
	process.argv[1] = "/missing/pi-entry.js";
	assert.throws(() => executor(), (error) => error instanceof EphemeralSubagentError
		&& error.code === "prepare" && /cannot reuse/.test(error.message));
	process.title = "pi-rpc";
	process.argv[1] = previousScript;
	assert.doesNotThrow(() => executor());
});

test("executor validates run input and prepared launch at the boundary", async (t) => {
	const cwd = await useRunner(t, successfulRunner);
	for (const input of [
		null,
		[],
		{},
		{ prepare: 1 },
		{ prepare: async () => prepared(cwd), onUpdate: 1 },
		{ prepare: async () => prepared(cwd), onTokens: 1 },
		{ prepare: async () => prepared(cwd), onActivity: 1 },
	]) {
		await assert.rejects(executor().run(input as never), TypeError);
	}

	const malformed = [
		null,
		{},
		{ launch: null, task: "work", cwd },
		{ launch: { env: {}, args: null }, task: "work", cwd },
		{ launch: { env: {}, args: [1] }, task: "work", cwd },
		{ launch: { env: {}, args: ["bad\0arg"] }, task: "work", cwd },
		{ launch: { env: null, args: [] }, task: "work", cwd },
		{ launch: { env: { "BAD-NAME": "value" }, args: [] }, task: "work", cwd },
		{ launch: { env: { GOOD: 1 }, args: [] }, task: "work", cwd },
		{ launch: { env: { GOOD: "bad\0value" }, args: [] }, task: "work", cwd },
		{ launch, task: " ", cwd },
		{ launch, task: "bad\0task", cwd },
		{ launch, task: "work", cwd: "" },
		{ launch, task: "work", cwd: "bad\0cwd" },
	];
	for (const value of malformed) {
		await assert.rejects(executor().run({ prepare: async () => value as never }), (error) => {
			assert.ok(error instanceof EphemeralSubagentError);
			assert.equal(error.code, "prepare");
			assert.ok(error.cause instanceof TypeError);
			return true;
		});
	}
});

test("executor uses stable prepare and spawn error codes with causes", async (t) => {
	const cwd = await useRunner(t, successfulRunner);
	const prepareCause = new Error("route unavailable");
	await assert.rejects(executor().run({ prepare: async () => { throw prepareCause; } }), (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "prepare");
		assert.equal(error.cause, prepareCause);
		return true;
	});

	await assert.rejects(executor().run({ prepare: async () => prepared(join(cwd, "missing")) }), (error) => {
		assert.ok(error instanceof EphemeralSubagentError);
		assert.equal(error.code, "spawn");
		assert.ok(error.cause instanceof Error);
		return true;
	});
});

test("executor validates concurrency and timeout at construction", () => {
	for (const maxConcurrency of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => createEphemeralSubagentExecutor({ maxConcurrency, timeout }));
	}
	assert.throws(() => createEphemeralSubagentExecutor({ maxConcurrency: 1, timeout: { idleMs: 0, maxMs: 2 } }));
	assert.throws(() => createEphemeralSubagentExecutor({ maxConcurrency: 1, timeout: { idleMs: 2, maxMs: 2 } }));
	assert.throws(() => createEphemeralSubagentExecutor({ maxConcurrency: 1, timeout: { idleMs: 1, maxMs: 2_147_483_648 } }));
});

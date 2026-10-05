import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrClient, startPiAgent, type HerdrExecResult } from "../src/index.ts";

test("createHerdrClient copies caller args and forwards to executor", async () => {
	const args = Object.freeze(["agent", "list"]);
	const calls: Array<{ command: string; args: string[]; options: { cwd: string } }> = [];
	const client = createHerdrClient<{ cwd: string }>(async (command, args, options) => {
		calls.push({ command, args: [...args], options });
		args.push("mutated-by-executor");
		return { code: 0, stdout: "{}", stderr: "" } satisfies HerdrExecResult;
	});

	await client.exec(args, { cwd: "/tmp" });

	assert.deepEqual(calls, [{ command: "herdr", args: ["agent", "list"], options: { cwd: "/tmp" } }]);
	assert.deepEqual(args, ["agent", "list"], "caller array must not be mutated");
});

test("run throws on failure and json parses stdout", async () => {
	const client = createHerdrClient(async () => ({ code: 1, stdout: "", stderr: "boom" }));
	await assert.rejects(client.run(["x"], {}), /herdr x failed: boom/);

	const ok = createHerdrClient(async () => ({ code: 0, stdout: '{"ok":true}', stderr: "" }));
	assert.deepEqual(await ok.json(["y"], {}), { ok: true });
});

const ok: HerdrExecResult = { code: 0, stdout: "", stderr: "" };
const PROBE = /^pi-herdr-ready-[0-9a-f]{16}$/;

/** Executor that answers the shell-prompt probe successfully and routes `agent start` to `start`. */
function probingExecutor(start: (args: string[]) => HerdrExecResult | Promise<HerdrExecResult>, calls: string[][] = []) {
	return createHerdrClient(async (_command, args) => {
		calls.push(args);
		if (args[0] === "agent") return await start(args);
		assert.equal(args[0], "pane");
		if (args[1] === "run") assert.match(args[3]!.replace(/^echo /, ""), PROBE);
		else assert.equal(args[1], "wait-output");
		return ok;
	});
}

test("startPiAgent proves the shell prompt before each agent start and retries structured pane contention", async () => {
	const calls: string[][] = [];
	let attempts = 0;
	const client = probingExecutor(() => ++attempts === 1
		? { code: 1, stdout: "", stderr: '{"error":{"code":"agent_pane_busy"}}' }
		: { code: 0, stdout: '{"result":{"type":"agent_started"}}', stderr: "" }, calls);

	const result = await startPiAgent(client, {
		name: "worker",
		pane: "pane-1",
		args: ["--session", "/tmp/session.jsonl"],
		options: {},
		delay: async () => {},
	});

	assert.equal(result.code, 0);
	const token = calls[0]![3]!.replace(/^echo /, "");
	const start = ["agent", "start", "worker", "--kind", "pi", "--pane", "pane-1", "--", "--session", "/tmp/session.jsonl"];
	const wait = ["pane", "wait-output", "pane-1", "--source", "recent-unwrapped", "--regex", `^${token}$`, "--timeout", "20000"];
	assert.deepEqual(calls.slice(0, 3), [["pane", "run", "pane-1", `echo ${token}`], wait, start]);
	assert.equal(calls.length, 6);
	assert.notEqual(calls[3]![3], calls[0]![3], "each attempt uses a fresh probe token");
	assert.deepEqual(calls[5], start);
});

test("startPiAgent returns a failed shell prompt probe without starting the agent", async () => {
	const calls: string[][] = [];
	const stalled: HerdrExecResult = { code: 1, stdout: "", stderr: '{"error":{"code":"timeout"}}' };
	const client = createHerdrClient(async (_command, args) => {
		calls.push(args);
		return args[1] === "wait-output" ? stalled : ok;
	});

	const result = await startPiAgent(client, { name: "worker", pane: "pane-1", args: [], options: {} });

	assert.equal(result, stalled);
	assert.deepEqual(calls.map((args) => args[1]), ["run", "wait-output"]);
});

test("startPiAgent lets consumer policy stop killed pane contention", async () => {
	let starts = 0;
	let policyResult: HerdrExecResult | undefined;
	const killed: HerdrExecResult = {
		code: 124,
		stdout: "",
		stderr: '{"error":{"code":"agent_pane_busy"}}',
		killed: true,
	};
	const client = probingExecutor(() => {
		starts += 1;
		return killed;
	});

	const result = await startPiAgent(client, {
		name: "worker",
		pane: "pane-1",
		args: [],
		options: {},
		delay: async () => { throw new Error("retry delay should not run"); },
		shouldRetry: (candidate) => {
			policyResult = candidate;
			return !candidate.killed;
		},
	});

	assert.equal(starts, 1);
	assert.equal(policyResult, killed);
	assert.equal(result, killed);
});

test("startPiAgent lets consumer policy retry killed pane contention", async () => {
	const events: Array<HerdrExecResult | "delay"> = [];
	let starts = 0;
	const killed: HerdrExecResult = {
		code: 124,
		stdout: "",
		stderr: '{"error":{"code":"agent_pane_busy"}}',
		killed: true,
	};
	const success: HerdrExecResult = { code: 0, stdout: "ok", stderr: "" };
	const client = probingExecutor(() => ++starts === 1 ? killed : success);

	const result = await startPiAgent(client, {
		name: "worker",
		pane: "pane-1",
		args: [],
		options: {},
		delay: async () => { events.push("delay"); },
		shouldRetry: (candidate) => {
			events.push(candidate);
			return true;
		},
	});

	assert.equal(starts, 2);
	assert.deepEqual(events, [killed, "delay", killed]);
	assert.equal(result, success);
});

test("startPiAgent rejects malformed launch input before execution", async () => {
	let starts = 0;
	const busy: HerdrExecResult = {
		code: 1,
		stdout: "",
		stderr: '{"error":{"code":"agent_pane_busy"}}',
	};
	const client = probingExecutor(() => {
		starts += 1;
		return busy;
	});
	const valid = { name: "worker", pane: "pane-1", args: [] as string[], options: {} };
	const malformed = [
		{ input: { ...valid, name: " " }, error: /name must be a non-empty string/ },
		{ input: { ...valid, pane: "" }, error: /pane must be a non-empty string/ },
		{ input: { ...valid, args: null }, error: /arguments must be an array of strings/ },
		{ input: { ...valid, args: ["--model", 1] }, error: /arguments must be an array of strings/ },
	];
	for (const { input, error } of malformed) {
		await assert.rejects(startPiAgent(client, input as never), error);
	}
	assert.equal(starts, 0);

	await assert.rejects(startPiAgent(client, {
		...valid,
		onPaneBusy: async () => " ",
	}), /pane returned by onPaneBusy must be a non-empty string/);
	assert.equal(starts, 1);
});

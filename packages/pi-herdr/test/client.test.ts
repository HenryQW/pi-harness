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

test("startPiAgent retries structured pane contention and returns the raw result", async () => {
	const calls: string[][] = [];
	let attempts = 0;
	const client = createHerdrClient(async (_command, args) => {
		calls.push(args);
		attempts += 1;
		return attempts === 1
			? { code: 1, stdout: "", stderr: '{"error":{"code":"agent_pane_busy"}}' }
			: { code: 0, stdout: '{"result":{"type":"agent_started"}}', stderr: "" };
	});

	const result = await startPiAgent(client, {
		name: "worker",
		pane: "pane-1",
		args: ["--session", "/tmp/session.jsonl"],
		options: {},
		delay: async () => {},
	});

	assert.equal(result.code, 0);
	assert.deepEqual(calls, [
		["agent", "start", "worker", "--kind", "pi", "--pane", "pane-1", "--", "--session", "/tmp/session.jsonl"],
		["agent", "start", "worker", "--kind", "pi", "--pane", "pane-1", "--", "--session", "/tmp/session.jsonl"],
	]);
});

test("startPiAgent lets consumer policy stop killed pane contention", async () => {
	let calls = 0;
	let policyResult: HerdrExecResult | undefined;
	const killed: HerdrExecResult = {
		code: 124,
		stdout: "",
		stderr: '{"error":{"code":"agent_pane_busy"}}',
		killed: true,
	};
	const client = createHerdrClient(async () => {
		calls += 1;
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

	assert.equal(calls, 1);
	assert.equal(policyResult, killed);
	assert.equal(result, killed);
});

test("startPiAgent lets consumer policy retry killed pane contention", async () => {
	const events: Array<HerdrExecResult | "delay"> = [];
	let calls = 0;
	const killed: HerdrExecResult = {
		code: 124,
		stdout: "",
		stderr: '{"error":{"code":"agent_pane_busy"}}',
		killed: true,
	};
	const success: HerdrExecResult = { code: 0, stdout: "ok", stderr: "" };
	const client = createHerdrClient(async () => ++calls === 1 ? killed : success);

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

	assert.equal(calls, 2);
	assert.deepEqual(events, [killed, "delay", killed]);
	assert.equal(result, success);
});

test("startPiAgent rejects malformed launch input before execution", async () => {
	let calls = 0;
	const busy: HerdrExecResult = {
		code: 1,
		stdout: "",
		stderr: '{"error":{"code":"agent_pane_busy"}}',
	};
	const client = createHerdrClient(async () => {
		calls += 1;
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
	assert.equal(calls, 0);

	await assert.rejects(startPiAgent(client, {
		...valid,
		onPaneBusy: async () => " ",
	}), /pane returned by onPaneBusy must be a non-empty string/);
	assert.equal(calls, 1);
});

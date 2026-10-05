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

/** The pane shell is pid 501; a foreground group of 501 means the shell (or its startup children) owns the tty. */
function processInfo(foregroundGroup: number): HerdrExecResult {
	return { code: 0, stderr: "", stdout: JSON.stringify({ result: { type: "pane_process_info", process_info: {
		pane_id: "pane-1", shell_pid: 501, foreground_process_group_id: foregroundGroup,
		foreground_processes: [{ pid: foregroundGroup, name: foregroundGroup === 501 ? "zsh" : "node" }],
	} } }) };
}

/** Executor answering the shell-readiness probe for an idle shell; `agent start` goes to `start`. */
function probingExecutor(
	start: (args: string[]) => HerdrExecResult | Promise<HerdrExecResult>,
	calls: string[][] = [],
	screens: (token: string) => string[] = (token) => [`\u276f echo ${token}\n${token}\n\u276f `],
) {
	let token = "";
	let reads: string[] = [];
	return createHerdrClient(async (_command, args) => {
		calls.push(args);
		if (args[0] === "agent") return await start(args);
		assert.equal(args[0], "pane");
		if (args[1] === "process-info") return processInfo(501);
		if (args[1] === "run") {
			token = args[3]!.replace(/^echo /, "");
			assert.match(token, PROBE);
			reads = screens(token);
			return ok;
		}
		assert.equal(args[1], "read");
		return { ...ok, stdout: reads.length > 1 ? reads.shift()! : reads[0]! };
	});
}

test("startPiAgent proves the shell is reading input before each agent start and retries structured pane contention", async () => {
	const calls: string[][] = [];
	let attempts = 0;
	const client = probingExecutor(() => ++attempts === 1
		? { code: 1, stdout: "", stderr: '{"error":{"code":"agent_pane_busy"}}' }
		: { code: 0, stdout: '{"result":{"type":"agent_started"}}', stderr: "" }, calls,
	// The token alone is not readiness: the prompt must follow it (slow prompt hooks run in between).
	(token) => [`\u276f echo ${token}\n${token}\n`, `\u276f echo ${token}\n${token}\n\n\u276f `]);

	const result = await startPiAgent(client, {
		name: "worker",
		pane: "pane-1",
		args: ["--session", "/tmp/session.jsonl"],
		options: {},
		delay: async () => {},
	});

	assert.equal(result.code, 0);
	const start = ["agent", "start", "worker", "--kind", "pi", "--pane", "pane-1", "--", "--session", "/tmp/session.jsonl"];
	const read = ["pane", "read", "pane-1", "--source", "recent-unwrapped", "--lines", "40", "--format", "text"];
	const token = calls[1]![3]!.replace(/^echo /, "");
	assert.deepEqual(calls.slice(0, 5), [["pane", "process-info", "--pane", "pane-1"], ["pane", "run", "pane-1", `echo ${token}`], read, read, start]);
	assert.deepEqual(calls.slice(5).map((args) => args.slice(0, 2)), [["pane", "process-info"], ["pane", "run"], ["pane", "read"], ["pane", "read"], ["agent", "start"]]);
	assert.notEqual(calls[6]![3], calls[1]![3], "each attempt uses a fresh probe token");
});

test("startPiAgent leaves an occupied pane alone so agent start reports contention itself", async () => {
	const calls: string[][] = [];
	const busy: HerdrExecResult = { code: 1, stdout: "", stderr: '{"error":{"code":"agent_pane_busy"}}' };
	const client = createHerdrClient(async (_command, args) => {
		calls.push(args);
		return args[0] === "agent" ? busy : processInfo(777);
	});

	const result = await startPiAgent(client, { name: "worker", pane: "pane-1", args: [], options: {}, shouldRetry: () => false });

	assert.equal(result, busy);
	assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["pane", "process-info"], ["agent", "start"]]);
});

test("startPiAgent returns a failed readiness probe without starting the agent and rejects malformed process info", async () => {
	const calls: string[][] = [];
	const failed: HerdrExecResult = { code: 1, stdout: "", stderr: '{"error":{"code":"pane_not_found"}}' };
	const client = createHerdrClient(async (_command, args) => {
		calls.push(args);
		return args[1] === "read" ? failed : args[1] === "process-info" ? processInfo(501) : ok;
	});

	const result = await startPiAgent(client, { name: "worker", pane: "pane-1", args: [], options: {} });

	assert.equal(result, failed);
	assert.deepEqual(calls.map((args) => args[1]), ["process-info", "run", "read"]);

	const malformed = createHerdrClient(async () => ({ ...ok, stdout: '{"result":{}}' }));
	await assert.rejects(startPiAgent(malformed, { name: "worker", pane: "pane-1", args: [], options: {} }), /malformed output/);
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

import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrClient, hasHerdrErrorCode } from "@henryqw/pi-herdr";

type Call = { command: string; args: readonly string[]; cwd: string };

function recordingExecutor(calls: Call[], result: { code: number; stdout: string; stderr: string }) {
	return async (command: string, args: readonly string[], options: { cwd: string }) => {
		calls.push({ command, args, cwd: options.cwd });
		return result;
	};
}

test("exec wires the herdr command and forwards options", async () => {
	const calls: Call[] = [];
	const herdr = createHerdrClient(recordingExecutor(calls, { code: 0, stdout: JSON.stringify({ result: { type: "agent_list" } }), stderr: "" }));

	assert.deepEqual(await herdr.json(["agent", "list"], { cwd: "/repo" }), { result: { type: "agent_list" } });
	assert.deepEqual(calls, [{ command: "herdr", args: ["agent", "list"], cwd: "/repo" }]);
});

test("run rejects exit failures and killed processes", async () => {
	const failed = { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found" } }) };
	const failureClient = createHerdrClient(async () => failed);
	await assert.rejects(failureClient.run(["agent", "get", "missing"], { cwd: "/repo" }), /herdr agent get failed/);
	assert.equal(hasHerdrErrorCode(failed, "agent_not_found"), true);
	assert.equal(hasHerdrErrorCode({ stdout: JSON.stringify({ result: { error: { code: "nested" } } }), stderr: "" }, "nested"), true);

	const killed = createHerdrClient(async () => ({ code: 0, stdout: "", stderr: "", killed: true }));
	await assert.rejects(killed.run(["agent", "wait"], { cwd: "/repo" }), /herdr agent wait failed: killed/);
});

test("json rejects invalid JSON output", async () => {
	const invalid = createHerdrClient(async () => ({ code: 0, stdout: "not json", stderr: "" }));
	await assert.rejects(invalid.json(["tab", "list"], { cwd: "/repo" }), /herdr tab list returned invalid JSON/);
});

test("exec validates string argv before executing", async () => {
	let executed = false;
	const validated = createHerdrClient(async () => {
		executed = true;
		return { code: 0, stdout: "", stderr: "" };
	});
	await assert.rejects(validated.exec([1] as unknown as string[], {}), /arguments must be an array of strings/);
	assert.equal(executed, false);
});

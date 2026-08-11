import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrClient, hasHerdrErrorCode } from "@henryqw/pi-herdr";

test("Herdr client keeps execution generic and normalizes CLI responses", async () => {
	const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
	const herdr = createHerdrClient(async (command, args, options: { cwd: string }) => {
		calls.push({ command, args, cwd: options.cwd });
		return { code: 0, stdout: JSON.stringify({ result: { type: "agent_list" } }), stderr: "" };
	});

	assert.deepEqual(await herdr.json(["agent", "list"], { cwd: "/repo" }), { result: { type: "agent_list" } });
	assert.deepEqual(calls, [{ command: "herdr", args: ["agent", "list"], cwd: "/repo" }]);

	const failed = { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found" } }) };
	const failureClient = createHerdrClient(async () => failed);
	await assert.rejects(failureClient.run(["agent", "get", "missing"], { cwd: "/repo" }), /herdr agent get failed/);
	assert.equal(hasHerdrErrorCode(failed, "agent_not_found"), true);
	assert.equal(hasHerdrErrorCode({ stdout: JSON.stringify({ result: { error: { code: "nested" } } }), stderr: "" }, "nested"), true);

	const killed = createHerdrClient(async () => ({ code: 0, stdout: "", stderr: "", killed: true }));
	await assert.rejects(killed.run(["agent", "wait"], { cwd: "/repo" }), /herdr agent wait failed: killed/);

	const invalid = createHerdrClient(async () => ({ code: 0, stdout: "not json", stderr: "" }));
	await assert.rejects(invalid.json(["tab", "list"], { cwd: "/repo" }), /herdr tab list returned invalid JSON/);

	let executed = false;
	const validated = createHerdrClient(async () => {
		executed = true;
		return { code: 0, stdout: "", stderr: "" };
	});
	await assert.rejects(validated.exec([1] as unknown as string[], {}), /arguments must be an array of strings/);
	assert.equal(executed, false);
});

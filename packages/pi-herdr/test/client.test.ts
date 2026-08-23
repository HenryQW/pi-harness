import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrClient, type HerdrExecResult } from "../src/index.ts";

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

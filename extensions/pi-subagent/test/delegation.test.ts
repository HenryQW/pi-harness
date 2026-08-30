import assert from "node:assert/strict";
import test from "node:test";
import type { EphemeralSubagentExecutor, EphemeralSubagentResult, PiLaunch } from "@henryqw/pi-subagent";
import { runDelegation } from "../extensions/delegation.ts";

test("runs a caller-prepared launch in its supplied cwd without lifecycle work", async () => {
	const launch: PiLaunch = { args: ["--no-session"], env: {} };
	const result: EphemeralSubagentResult = { outcome: "success", exitCode: 0, output: "done", stderr: "" };
	const controller = new AbortController();
	const updates: string[] = [];
	const tokens: number[] = [];
	let prepared: { launch: PiLaunch; task: string; cwd: string } | undefined;
	const executor: EphemeralSubagentExecutor = {
		async run(input) {
			assert.equal(input.signal, controller.signal);
			input.onUpdate?.("working");
			input.onTokens?.(3);
			prepared = await input.prepare();
			return result;
		},
	};

	assert.equal(await runDelegation(executor, {
		signal: controller.signal,
		onUpdate: (text) => updates.push(text),
		onTokens: (count) => tokens.push(count),
		prepare: async () => ({ launch, task: "review this", cwd: "/caller/unit-worktree" }),
	}), result);
	assert.deepEqual(prepared, { launch, task: "review this", cwd: "/caller/unit-worktree" });
	assert.deepEqual(updates, ["working"]);
	assert.deepEqual(tokens, [3]);
});

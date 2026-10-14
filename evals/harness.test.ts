import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calledTimes, check, notCalled } from "./graders.ts";
import { parseEvents, requiredPasses } from "./harness.ts";

test("safety cases need every trial; quality cases need two thirds", () => {
	assert.equal(requiredPasses("safety", 3), 3);
	assert.equal(requiredPasses("quality", 3), 2);
	assert.equal(requiredPasses("quality", 1), 1);
	assert.equal(requiredPasses("quality", 5), 4);
});

test("parses tool calls, results, final text, and model from a recorded Pi event stream", () => {
	const run = parseEvents(readFileSync(new URL("fixtures/probe-events.jsonl", import.meta.url), "utf8"));
	assert.deepEqual(run.trace, {
		calls: [{ name: "pi_pr_sweep", args: { action: "scan" }, result: "STUB-SCAN-OK 42", isError: false }],
		finalText: "STUB-SCAN-OK 42",
	});
	assert.equal(run.model, "anthropic/claude-haiku-5-5");
	assert.equal(run.error, undefined);
	assert.deepEqual(check(calledTimes(run.trace, "pi_pr_sweep", 1, { action: /^sc/ }), notCalled(run.trace, "pi_pr_sweep", { action: "resolve" })), {
		pass: true,
		reasons: [],
	});
});

test("reports a run that never settles", () => {
	assert.equal(parseEvents('{"type":"agent_start"}\n').error, "Pi did not settle");
});

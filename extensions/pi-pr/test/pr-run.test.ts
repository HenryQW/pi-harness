import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { extensionConfigPath } from "@henryqw/pi-config-store";
import { DEFAULT_PR_POLICY, loadPrPolicy, PrRun } from "../extensions/pr-run.ts";

test("PR policy defaults and valid limits load without overwriting invalid configuration", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-policy-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	assert.deepEqual(loadPrPolicy(agentDir), DEFAULT_PR_POLICY);
	const path = extensionConfigPath("pi-pr", agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, '{"maxPublicationCycles":1}');
	assert.deepEqual(loadPrPolicy(agentDir), { maxPublicationCycles: 1, maxRepairAttempts: 3 });
	for (const contents of ['{', '{"maxRepairAttempts":0}', '{"maxPublicationCycles":1.5}', '{"maxRepairAttempts":"3"}', '{"constructor":1}']) {
		writeFileSync(path, contents);
		assert.throws(() => loadPrPolicy(agentDir), (error: Error) => error.message.includes(path));
		assert.equal(readFileSync(path, "utf8"), contents);
	}
});

test("publication budget counts changed remote heads once and permits unchanged-head cleanup", () => {
	const run = new PrRun({ maxPublicationCycles: 2, maxRepairAttempts: 3 });
	run.beforePush("a", "b");
	run.observeRemote("b");
	run.observeRemote("b");
	run.beforePush("b", "c");
	run.observeRemote("c");
	run.beforePush("c", "c");
	assert.throws(() => run.beforePush("c", "d"), /Publication budget stop/);
	run.complete("sweep", "b");
	assert.equal(run.hasCompleted("sweep", "b"), true);
	assert.equal(run.hasCompleted("sweep", "c"), false);
});

test("checks cannot repeat, drop failures, or exceed the invocation repair budget", () => {
	const run = new PrRun({ maxPublicationCycles: 3, maxRepairAttempts: 2 });
	const checks = [{ command: "pnpm", args: ["test"] }];
	run.beginChecks("sweep", "a", checks);
	run.checksFailed();
	assert.throws(() => run.beginChecks("sweep", "a", checks), /already executed/);
	assert.throws(() => run.beginChecks("sweep", "b", []), /frozen/);
	run.beginChecks("sweep", "b", checks);
	run.checksFailed();
	assert.throws(() => run.beginChecks("sweep", "c", checks), /Repair budget stop/);
});

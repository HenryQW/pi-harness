import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPrPolicyStore, DEFAULT_PR_POLICY, PrRun } from "../extensions/pr-run.ts";

test("PR policy loads valid limits and replaces each invalid or unknown key with its default", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-policy-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const store = createPrPolicyStore(agentDir);
	const load = (contents: string) => {
		writeFileSync(store.path, contents);
		const loaded = store.loadSync();
		assert.equal(loaded.status, "ok");
		assert.equal(readFileSync(store.path, "utf8"), contents);
		return loaded.status === "ok" ? { value: loaded.value, issues: loaded.issues.map(({ kind, key }) => `${kind}:${key}`) } : undefined;
	};
	assert.deepEqual(store.loadSync(), { status: "ok", source: "missing", value: DEFAULT_PR_POLICY, issues: [] });
	mkdirSync(dirname(store.path), { recursive: true });
	for (const policy of [{ maxPublicationCycles: 1 }, { mergeMethod: "rebase" }, { ciPollSeconds: 2147483 }, { checkTimeoutMinutes: 35791 }, { codexReview: true }, { ciWaitMinutes: 0, ciPollSeconds: 5 }]) {
		assert.deepEqual(load(JSON.stringify(policy)), { value: { ...DEFAULT_PR_POLICY, ...policy }, issues: [] });
	}
	for (const [key, value] of [["maxRepairAttempts", 0], ["ciPollSeconds", 0], ["ciPollSeconds", 2147484], ["ciWaitMinutes", -1], ["checkTimeoutMinutes", 0], ["checkTimeoutMinutes", 35792], ["mergeMethod", "SQUASH"], ["mergeMethod", 1], ["maxPublicationCycles", 1.5], ["maxRepairAttempts", "3"], ["codexReview", "true"], ["codexReview", null]] as const) {
		assert.deepEqual(load(JSON.stringify({ [key]: value })), { value: DEFAULT_PR_POLICY, issues: [`invalid-value:${key}`] });
	}
	assert.deepEqual(load('{"maxRepairAttempts":0,"mergeMethod":"rebase"}'), { value: { ...DEFAULT_PR_POLICY, mergeMethod: "rebase" }, issues: ["invalid-value:maxRepairAttempts"] });
	assert.deepEqual(load('{"constructor":1,"mergeMethd":"rebase","codexReview":true}'), { value: { ...DEFAULT_PR_POLICY, codexReview: true }, issues: ["unknown-key:constructor", "invalid-value:mergeMethod"] });
	assert.deepEqual(load("{"), { value: DEFAULT_PR_POLICY, issues: ["invalid-json:"] });
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
	run.beginChecks("publish-work", "a", checks);
	run.checksFailed();
	assert.throws(() => run.beginChecks("sweep", "a", structuredClone(checks)), /already executed/);
	run.beginChecks("sweep", "a", [{ command: "pnpm", args: ["typecheck"] }]);
	assert.throws(() => run.beginChecks("publish-work", "a", checks), /already executed/);
	assert.throws(() => run.beginChecks("publish-work", "b", []), /frozen/);
	run.beginChecks("publish-work", "b", checks);
	run.checksFailed();
	assert.throws(() => run.beginChecks("sweep", "c", checks), /Repair budget stop/);
});

test("CI waiting consumes poll intervals until the invocation budget is spent", () => {
	const run = new PrRun({ ciPollSeconds: 30, ciWaitMinutes: 1 });
	assert.equal(run.consumeCiWait(), 30_000);
	assert.equal(run.consumeCiWait(), 30_000);
	assert.equal(run.consumeCiWait(), null);
	assert.equal(new PrRun({ ciWaitMinutes: 0 }).consumeCiWait(), null);
	assert.equal(new PrRun({ ciPollSeconds: 45, ciWaitMinutes: 1 }).consumeCiWait(), 45_000);
});

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Check } from "typebox/value";
import {
	MAX_WORKFLOW_ENTRIES,
	identifyWorkflowEntries,
	parseWorkflow as parseDirectWorkflow,
	runForegroundWorkflow as runEntries,
	type DelegationRunner,
	type ParsedWorkflow,
	WorkflowSchema,
} from "../extensions/workflow.ts";

const delegation = (task = "work") => ({ role: "worker", name: "Test work", task, kind: "text" as const });
const parseWorkflow = (value: unknown) => parseDirectWorkflow(
	value && typeof value === "object" && !Array.isArray(value) ? { mode: "direct", ...value } : value,
);
const runForegroundWorkflow = (id: string, workflow: ParsedWorkflow, run: DelegationRunner, signal?: AbortSignal) =>
	runEntries(workflow.mode, identifyWorkflowEntries(id, workflow), run, signal);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("parses and normalizes each explicit workflow mode", () => {
	assert.deepEqual(parseWorkflow({
		role: " worker ",
		name: " Inspect auth flow ",
		task: " inspect ",
		model: " provider/model ",
		modelClass: "fast",
	}), {
		mode: "single",
		delegations: [{
			role: "worker",
			kind: "text",
			name: "Inspect auth flow",
			task: "inspect",
			model: "provider/model",
			modelClass: "fast",
		}],
	});
	assert.deepEqual(parseWorkflow({ tasks: [delegation("one"), delegation("two")] }), {
		mode: "parallel",
		delegations: [delegation("one"), delegation("two")],
	});
	assert.deepEqual(parseWorkflow({ chain: [delegation("one"), delegation("two")] }), {
		mode: "chain",
		delegations: [delegation("one"), delegation("two")],
	});

	for (const modelClass of ["fast", "balanced", "frontier", "fav"]) {
		assert.equal(parseWorkflow({ ...delegation(), modelClass }).delegations[0]!.modelClass, modelClass);
	}
	assert.equal(parseWorkflow({ tasks: Array.from({ length: MAX_WORKFLOW_ENTRIES }, () => delegation()) }).delegations.length, 8);
	assert.equal(parseWorkflow({ chain: Array.from({ length: MAX_WORKFLOW_ENTRIES }, () => delegation()) }).delegations.length, 8);
});

test("rejects caller thinking in every workflow mode", () => {
	for (const value of [
		{ ...delegation(), thinking: "high" },
		{ tasks: [{ ...delegation(), thinking: "high" }] },
		{ chain: [{ ...delegation(), thinking: "high" }] },
	]) {
		assert.throws(() => parseWorkflow(value), /declared tool schema/);
	}
});

test("rejects every workflow shape boundary at runtime", () => {
	assert.throws(() => parseDirectWorkflow(delegation()), /required properties mode/);
	const nine = Array.from({ length: MAX_WORKFLOW_ENTRIES + 1 }, () => delegation());
	const schemaInvalid = [
		null,
		[],
		"workflow",
		{ ...delegation(), extra: true },
		{ ...delegation(), background: "yes" },
		{ tasks: delegation() },
		{ chain: delegation() },
		{ tasks: [] },
		{ chain: [] },
		{ tasks: nine },
		{ chain: nine },
		{ tasks: [null] },
		{ chain: [null] },
		{ tasks: [{ ...delegation(), extra: true }] },
		{ chain: [{ ...delegation(), extra: true }] },
		{ tasks: [{ ...delegation(), background: true }] },
		{ chain: [{ ...delegation(), tasks: [delegation()] }] },
		{ tasks: [{ ...delegation(), chain: [delegation()] }] },
		{ tasks: [{ role: "worker" }] },
		{ tasks: [{ role: "worker", task: "work" }] },
	];
	for (const value of schemaInvalid) assert.throws(() => parseWorkflow(value), /declared tool schema/);

	for (const value of [
		{},
		{ background: true },
		{ ...delegation(), tasks: [delegation()] },
		{ ...delegation(), chain: [delegation()] },
		{ tasks: [delegation()], chain: [delegation()] },
		{ ...delegation(), tasks: [delegation()], chain: [delegation()] },
	]) {
		assert.throws(() => parseWorkflow(value), /exactly one/);
	}
	for (const value of [{ role: "worker" }, { name: "Test work" }, { task: "work" }, { model: "provider/model" }, { role: "worker", task: "work" }]) {
		assert.throws(() => parseWorkflow(value), /requires role, name, and task/);
	}
});

test("rejects empty, NUL, and unknown delegation values in single and array modes", () => {
	const invalidDelegations: Array<[string, Record<string, unknown>]> = [
		["empty role", { ...delegation(), role: "" }],
		["blank role", { ...delegation(), role: " \n " }],
		["NUL role", { ...delegation(), role: "work\0er" }],
		["newline role", { ...delegation(), role: "work\ner" }],
		["terminal escape role", { ...delegation(), role: "work\u001ber" }],
		["C1 role", { ...delegation(), role: "work\u009ber" }],
		["empty name", { ...delegation(), name: "" }],
		["blank name", { ...delegation(), name: "\t" }],
		["NUL name", { ...delegation(), name: "wo\0rk" }],
		["newline name", { ...delegation(), name: "line\nbreak" }],
		["terminal escape name", { ...delegation(), name: "line\u001b[31m" }],
		["30-character name", { ...delegation(), name: "x".repeat(30) }],
		["empty task", { ...delegation(), task: "" }],
		["blank task", { ...delegation(), task: "\t" }],
		["NUL task", { ...delegation(), task: "wo\0rk" }],
		["empty model", { ...delegation(), model: "" }],
		["NUL model", { ...delegation(), model: "p\0m" }],
		["newline model", { ...delegation(), model: "provider\n/model" }],
		["terminal escape model", { ...delegation(), model: "provider/\u001bmodel" }],
		["C1 model", { ...delegation(), model: "provider/\u009bmodel" }],
		["unknown model class", { ...delegation(), modelClass: "slow" }],
		["blank model class", { ...delegation(), modelClass: " " }],
	];
	for (const [name, value] of invalidDelegations) {
		assert.throws(() => parseWorkflow(value), `${name} in single mode`);
		assert.throws(() => parseWorkflow({ tasks: [value] }), `${name} in parallel mode`);
		assert.throws(() => parseWorkflow({ chain: [value] }), `${name} in chain mode`);
	}

	assert.equal(parseWorkflow({ ...delegation("first line\nsecond line") }).delegations[0]!.task, "first line\nsecond line");
});

test("runs a single delegation exactly once", async () => {
	const calls: string[] = [];
	await runForegroundWorkflow("call", parseWorkflow(delegation()), (entry) => {
		calls.push(entry.id);
		return entry.delegation.task;
	});
	assert.deepEqual(calls, ["call:single:0"]);
});

test("runs parallel entries concurrently and waits for every callback after a failure", async () => {
	const gates = Array.from({ length: 3 }, () => deferred<string>());
	const started: string[] = [];
	const running = runForegroundWorkflow("call", parseWorkflow({
		tasks: [delegation("zero"), delegation("one"), delegation("two")],
	}), async (entry) => {
		started.push(entry.id);
		return await gates[entry.index]!.promise;
	});
	await setImmediate();
	assert.deepEqual(started, ["call:parallel:0", "call:parallel:1", "call:parallel:2"]);
	let settled = false;
	void running.then(() => { settled = true; });
	gates[1]!.reject(new Error("worker failed"));
	gates[2]!.resolve("two");
	await setImmediate();
	assert.equal(settled, false);
	gates[0]!.resolve("zero");
	assert.equal(await running, undefined);
});

test("parallel parent abort starts nothing when pre-aborted and otherwise waits for cleanup", async () => {
	const preAborted = new AbortController();
	const preAbortReason = new Error("already aborted");
	preAborted.abort(preAbortReason);
	let calls = 0;
	await assert.rejects(runForegroundWorkflow("call", parseWorkflow({
		tasks: [delegation("never")],
	}), () => {
		calls++;
		return "unexpected";
	}, preAborted.signal), (error) => error === preAbortReason);
	assert.equal(calls, 0);

	const controller = new AbortController();
	const reason = new Error("parent aborted");
	const gates = Array.from({ length: 3 }, () => deferred<string>());
	const started: number[] = [];
	const cleaned: number[] = [];
	const running = runForegroundWorkflow("call", parseWorkflow({
		tasks: [delegation("zero"), delegation("one"), delegation("two")],
	}), async (entry) => {
		started.push(entry.index);
		try {
			const execution = await gates[entry.index]!.promise;
			controller.signal.throwIfAborted();
			return execution;
		} finally {
			cleaned.push(entry.index);
		}
	}, controller.signal);
	await setImmediate();
	assert.deepEqual(started, [0, 1, 2]);

	let settled = false;
	void running.then(() => { settled = true; }, () => { settled = true; });
	controller.abort(reason);
	gates[0]!.resolve("zero");
	gates[1]!.resolve("one");
	await setImmediate();
	assert.equal(settled, false);
	gates[2]!.resolve("two");
	await assert.rejects(running, (error) => error === reason);
	assert.deepEqual(cleaned, [0, 1, 2]);
});

test("chains immediate successful assistant output by explicit placeholder only", async () => {
	const seenTasks: string[] = [];
	const outputs = ["one $& {previous}", "two", "three", "four"];
	const ids: string[] = [];
	await runForegroundWorkflow("call", parseWorkflow({ chain: [
		delegation("first:{previous}"),
		delegation("twice [{previous}] [{previous}]"),
		delegation("fixed task"),
		delegation("last {previous}"),
	] }), (entry) => {
		ids.push(entry.id);
		seenTasks.push(entry.delegation.task);
		return outputs[entry.index]!;
	});
	assert.deepEqual(seenTasks, [
		"first:",
		"twice [one $& {previous}] [one $& {previous}]",
		"fixed task",
		"last three",
	]);
	assert.deepEqual(ids, ["call:chain:0", "call:chain:1", "call:chain:2", "call:chain:3"]);
});

test("chain fails fast on child failure and thrown callback rejection", async () => {
	const childCalls: number[] = [];
	await runForegroundWorkflow("call", parseWorkflow({
		chain: [delegation("first"), delegation("second"), delegation("never")],
	}), (entry) => {
		childCalls.push(entry.index);
		if (entry.index === 1) throw new Error("child failed");
		return "first output";
	});
	assert.deepEqual(childCalls, [0, 1]);

	const thrownCalls: number[] = [];
	await runForegroundWorkflow("call", parseWorkflow({
		chain: [delegation("first"), delegation("never")],
	}), (entry) => {
		thrownCalls.push(entry.index);
		throw new Error("launch failed");
	});
	assert.deepEqual(thrownCalls, [0]);
});

test("chain parent abort rethrows its reason without launching a later step", async () => {
	const controller = new AbortController();
	const reason = new Error("parent aborted");
	const first = deferred<string>();
	const calls: number[] = [];
	const running = runForegroundWorkflow("call", parseWorkflow({
		chain: [delegation("first"), delegation("never")],
	}), (entry) => {
		calls.push(entry.index);
		return first.promise;
	}, controller.signal);
	await setImmediate();
	assert.deepEqual(calls, [0]);

	controller.abort(reason);
	first.reject(new Error("child cleanup rejected"));
	await assert.rejects(running, (error) => error === reason);
	assert.deepEqual(calls, [0]);
});


test("direct schema excludes changesets and their writer-only fields in every shape", () => {
	for (const value of [
		{ ...delegation(), kind: "changeset" },
		{ tasks: [{ ...delegation(), kind: "changeset" }] },
		{ chain: [{ ...delegation(), kind: "changeset" }] },
		{ ...delegation(), checks: [{ command: "true", args: [] }] },
		{ tasks: [{ ...delegation(), checks: [{ command: "true", args: [] }] }] },
		{ chain: [{ ...delegation(), checks: [{ command: "true", args: [] }] }] },
	]) {
		assert.equal(Check(WorkflowSchema, { mode: "direct", ...value }), false);
		assert.throws(() => parseWorkflow(value), /declared tool schema/);
	}
	assert.throws(() => parseWorkflow({ ...delegation(), kind: "changeset" }), /use mode isolated for changesets/);
	assert.throws(() => parseWorkflow({ ...delegation(), background: false }), /declared tool schema/);
});

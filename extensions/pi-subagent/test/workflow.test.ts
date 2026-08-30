import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
	DelegationSchema,
	identifyWorkflowEntries,
	MAX_WORKFLOW_ENTRIES,
	parseWorkflow,
	runForegroundWorkflow,
	WorkflowSchema,
	type DelegationExecution,
} from "../extensions/workflow.ts";
import { TASK_NAME_CONTRACT } from "../extensions/task-name.ts";

const delegation = (task = "work") => ({ role: "worker", name: "Test work", task });
const succeeded = <T>(assistantOutput: string, result: T): DelegationExecution<T> => ({ ok: true, assistantOutput, result });
const failed = <T>(result: T): DelegationExecution<T> => ({ ok: false, result });

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("schemas expose strict delegation fields and top-level workflow modes", () => {
	const delegationSchema = DelegationSchema as any;
	const workflowSchema = WorkflowSchema as any;
	assert.equal(delegationSchema.additionalProperties, false);
	assert.deepEqual(Object.keys(delegationSchema.properties), ["role", "name", "task", "model", "modelClass"]);
	assert.equal(delegationSchema.properties.name.maxLength, TASK_NAME_CONTRACT.maxLength);
	assert.equal(delegationSchema.properties.name.description, TASK_NAME_CONTRACT.description);
	assert.equal(workflowSchema.additionalProperties, false);
	assert.ok("background" in workflowSchema.properties);
	assert.equal("background" in delegationSchema.properties, false);
	assert.equal("thinking" in delegationSchema.properties, false);
	assert.equal("thinking" in workflowSchema.properties, false);
	assert.equal(workflowSchema.properties.tasks.minItems, 1);
	assert.equal(workflowSchema.properties.tasks.maxItems, MAX_WORKFLOW_ENTRIES);
	assert.equal(workflowSchema.properties.chain.minItems, 1);
	assert.equal(workflowSchema.properties.chain.maxItems, MAX_WORKFLOW_ENTRIES);
});

test("parses and normalizes each explicit workflow mode", () => {
	assert.deepEqual(parseWorkflow({
		role: " worker ",
		name: " Inspect auth flow ",
		task: " inspect ",
		model: " provider/model ",
		modelClass: "fast",
		background: true,
	}), {
		mode: "single",
		background: true,
		delegations: [{
			role: "worker",
			name: "Inspect auth flow",
			task: "inspect",
			model: "provider/model",
			modelClass: "fast",
		}],
	});
	assert.deepEqual(parseWorkflow({ tasks: [delegation("one"), delegation("two")] }), {
		mode: "parallel",
		background: false,
		delegations: [delegation("one"), delegation("two")],
	});
	assert.deepEqual(parseWorkflow({ chain: [delegation("one"), delegation("two")] }), {
		mode: "chain",
		background: false,
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
		assert.throws(() => parseWorkflow(value), /exactly one mode/);
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
		["unknown model class", { ...delegation(), modelClass: "slow" }],
		["blank model class", { ...delegation(), modelClass: " " }],
	];
	for (const [name, value] of invalidDelegations) {
		assert.throws(() => parseWorkflow(value), `${name} in single mode`);
		assert.throws(() => parseWorkflow({ tasks: [value] }), `${name} in parallel mode`);
		assert.throws(() => parseWorkflow({ chain: [value] }), `${name} in chain mode`);
	}
});

test("assigns deterministic mode-scoped entry identities", () => {
	for (const [input, expected] of [
		[delegation(), ["tool-7:single:0"]],
		[{ tasks: [delegation("a"), delegation("b")] }, ["tool-7:parallel:0", "tool-7:parallel:1"]],
		[{ chain: [delegation("a"), delegation("b")] }, ["tool-7:chain:0", "tool-7:chain:1"]],
	] as const) {
		const entries = identifyWorkflowEntries("tool-7", parseWorkflow(input));
		assert.deepEqual(entries.map(({ id }) => id), expected);
		assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
	}
});

test("runs single exactly once and refuses background workflows", async () => {
	let calls = 0;
	const outcomes = await runForegroundWorkflow("call", parseWorkflow(delegation()), (entry) => {
		calls++;
		return succeeded(entry.delegation.task, "single-result");
	});
	assert.equal(calls, 1);
	assert.deepEqual(outcomes, [{
		status: "succeeded",
		entry: { id: "call:single:0", mode: "single", index: 0, delegation: delegation() },
		assistantOutput: "work",
		result: "single-result",
	}]);

	await assert.rejects(
		runForegroundWorkflow("call", parseWorkflow({ ...delegation(), background: true }), () => {
			calls++;
			return succeeded("unexpected", "unexpected");
		}),
		/Background workflows cannot use foreground orchestration/,
	);
	assert.equal(calls, 1);
});

test("runs parallel entries concurrently, all-settled, and in stable input order", async () => {
	const gates = Array.from({ length: 3 }, () => deferred<DelegationExecution<string>>());
	const started: number[] = [];
	const running = runForegroundWorkflow("call", parseWorkflow({
		tasks: [delegation("zero"), delegation("one"), delegation("two")],
	}), async (entry) => {
		started.push(entry.index);
		return await gates[entry.index]!.promise;
	});
	await setImmediate();
	assert.deepEqual(started, [0, 1, 2]);

	gates[2]!.resolve(succeeded("output-2", "result-2"));
	gates[0]!.resolve(succeeded("output-0", "result-0"));
	gates[1]!.resolve(failed("child failed"));
	const outcomes = await running;
	assert.deepEqual(outcomes.map(({ entry }) => entry.id), ["call:parallel:0", "call:parallel:1", "call:parallel:2"]);
	assert.deepEqual(outcomes.map(({ status }) => status), ["succeeded", "failed", "succeeded"]);
	assert.deepEqual(outcomes.map((outcome) => outcome.status === "rejected" ? undefined : outcome.result), [
		"result-0",
		"child failed",
		"result-2",
	]);
});

test("keeps thrown callback rejection distinct from child failure without short-circuiting parallel work", async () => {
	const infrastructure = new Error("parent aborted");
	infrastructure.name = "AbortError";
	const called: number[] = [];
	const outcomes = await runForegroundWorkflow<string>("call", parseWorkflow({
		tasks: [delegation("child"), delegation("abort"), delegation("success")],
	}), (entry) => {
		called.push(entry.index);
		if (entry.index === 0) return failed("child process failed");
		if (entry.index === 1) throw infrastructure;
		return succeeded("done", "ok");
	});
	assert.deepEqual(called, [0, 1, 2]);
	assert.deepEqual(outcomes.map(({ status }) => status), ["failed", "rejected", "succeeded"]);
	assert.equal(outcomes[0]!.status === "failed" && outcomes[0].result, "child process failed");
	assert.equal(outcomes[1]!.status, "rejected");
	if (outcomes[1]!.status === "rejected") assert.equal(outcomes[1].reason, infrastructure);
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
		return succeeded("unexpected", "unexpected");
	}, preAborted.signal), (error) => error === preAbortReason);
	assert.equal(calls, 0);

	const controller = new AbortController();
	const reason = new Error("parent aborted");
	const gates = Array.from({ length: 3 }, () => deferred<DelegationExecution<string>>());
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
	gates[0]!.resolve(succeeded("zero", "zero"));
	gates[1]!.resolve(succeeded("one", "one"));
	await setImmediate();
	assert.equal(settled, false);
	gates[2]!.resolve(succeeded("two", "two"));
	await assert.rejects(running, (error) => error === reason);
	assert.deepEqual(cleaned, [0, 1, 2]);
});

test("chains immediate successful assistant output by explicit placeholder only", async () => {
	const seenTasks: string[] = [];
	const outputs = ["one $& {previous}", "two", "three", "four"];
	const outcomes = await runForegroundWorkflow("call", parseWorkflow({ chain: [
		delegation("first:{previous}"),
		delegation("twice [{previous}] [{previous}]"),
		delegation("fixed task"),
		delegation("last {previous}"),
	] }), (entry) => {
		seenTasks.push(entry.delegation.task);
		return succeeded(outputs[entry.index]!, entry.index);
	});
	assert.deepEqual(seenTasks, [
		"first:",
		"twice [one $& {previous}] [one $& {previous}]",
		"fixed task",
		"last three",
	]);
	assert.deepEqual(outcomes.map(({ status }) => status), ["succeeded", "succeeded", "succeeded", "succeeded"]);
	assert.deepEqual(outcomes.map(({ entry }) => entry.id), ["call:chain:0", "call:chain:1", "call:chain:2", "call:chain:3"]);
});

test("chain fails fast on child failure and thrown callback rejection", async () => {
	const childCalls: number[] = [];
	const childOutcomes = await runForegroundWorkflow("call", parseWorkflow({
		chain: [delegation("first"), delegation("second"), delegation("never")],
	}), (entry) => {
		childCalls.push(entry.index);
		return entry.index === 0 ? succeeded("first output", "ok") : failed("child failed");
	});
	assert.deepEqual(childCalls, [0, 1]);
	assert.deepEqual(childOutcomes.map(({ status }) => status), ["succeeded", "failed"]);

	const infrastructure = new Error("launch failed");
	const thrownCalls: number[] = [];
	const thrownOutcomes = await runForegroundWorkflow("call", parseWorkflow({
		chain: [delegation("first"), delegation("never")],
	}), (entry) => {
		thrownCalls.push(entry.index);
		throw infrastructure;
	});
	assert.deepEqual(thrownCalls, [0]);
	assert.equal(thrownOutcomes[0]!.status, "rejected");
	if (thrownOutcomes[0]!.status === "rejected") assert.equal(thrownOutcomes[0].reason, infrastructure);
});

test("chain parent abort rethrows its reason without launching a later step", async () => {
	const controller = new AbortController();
	const reason = new Error("parent aborted");
	const first = deferred<DelegationExecution<string>>();
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

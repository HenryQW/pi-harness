import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ROLE_TOOL_POLICY_FLAG } from "@henryqw/pi-subagent";
import {
	registerOrchestratorExtension,
	type OrchestratorExtensionDependencies,
} from "../extensions/orchestrator.ts";
import type { ComposeOrchestratorRuntimeOptions } from "../src/composition.ts";
import type { CheckedGitRuntimeOptions, DirectProcessRunner } from "../src/git-runtime.ts";
import type { HerdrHostRuntimeOptions } from "../src/herdr-runtime.ts";
import type { OperationContext, RunResponse } from "../src/runner.ts";
import {
	ExecuteRequestSchema,
	IdOnlySchema,
	ResumeRequestSchema,
	parseExecuteRequest,
	parseIdOnly,
	parseResumeRequest,
	type ExecuteRequest,
	type RunState,
} from "../src/schema.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_ROOT = "/canonical/repository";

const EXECUTE_REQUEST: ExecuteRequest = {
	id: "request-one",
	goal: "Deliver checked work.",
	budgetMs: 10_000,
	tasks: [{
		id: "unit-one",
		modelClass: "fast",
		requirements: "Implement the bounded unit.",
		deliverable: "A checked commit.",
		dependsOn: [],
		checks: [{ command: "pnpm", args: ["test"] }],
	}],
	finalChecks: [{ command: "pnpm", args: ["typecheck"] }],
};

const PRIVATE_STATE = {
	version: 1,
	request: EXECUTE_REQUEST,
	root: CANONICAL_ROOT,
	status: "needs_attention",
	accepted: false,
	tasks: [{
		taskId: "unit-one",
		status: "needs_attention",
		attempts: [{ prompts: [{ task: "PRIVATE IMPLEMENTER PROMPT" }] }],
	}],
	final: { status: "pending" },
	launchRecords: {
		"implementer/fast": {
			env: { SECRET_TOKEN: "PRIVATE PROCESS ENVIRONMENT" },
			rawArgs: ["--private-command-line"],
		},
	},
	createdAt: 100,
	updatedAt: 200,
} as unknown as RunState;

function context(cwd: string, model: unknown = undefined): ExtensionContext {
	return { cwd, model } as unknown as ExtensionContext;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type RegisteredTool = {
	name: string;
	parameters: unknown;
	prepareArguments(value: unknown): unknown;
	execute(
		toolCallId: string,
		params: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

type RunnerCall = { method: string; args: unknown[] };

interface Harness {
	pi: ExtensionAPI;
	tools: RegisteredTool[];
	handlers: Map<string, EventHandler>;
	factoryCalls: string[];
	runnerCalls: RunnerCall[];
	rootCalls: Array<{ cwd: string; context: OperationContext }>;
	execCalls: Array<{ command: string; args: string[]; options: unknown }>;
	getGitOptions(): CheckedGitRuntimeOptions;
	getHostOptions(): HerdrHostRuntimeOptions;
	getRuntimeOptions(): ComposeOrchestratorRuntimeOptions;
	getReviewerExecutor(): NonNullable<CheckedGitRuntimeOptions["executeReview"]>;
	getRoleContext(): ExtensionContext;
	getProcessRunner(): DirectProcessRunner;
}

function response(method: string, continuation = false): RunResponse {
	return {
		text: `bounded ${method} result`,
		state: PRIVATE_STATE,
		...(continuation ? { continuation: { id: "request-one", action: "finalize" as const } } : {}),
	};
}

function createHarness(overrides: Partial<OrchestratorExtensionDependencies> = {}): Harness {
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, EventHandler>();
	const factoryCalls: string[] = [];
	const runnerCalls: RunnerCall[] = [];
	const rootCalls: Array<{ cwd: string; context: OperationContext }> = [];
	const execCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
	let gitOptions: CheckedGitRuntimeOptions | undefined;
	let hostOptions: HerdrHostRuntimeOptions | undefined;
	let runtimeOptions: ComposeOrchestratorRuntimeOptions | undefined;
	let processRunner: DirectProcessRunner | undefined;

	const pi = {
		on(name: string, handler: EventHandler) {
			handlers.set(name, handler);
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		async exec(command: string, args: string[], options: unknown) {
			execCalls.push({ command, args: [...args], options });
			return { code: 0, killed: false, stdout: "ok\n", stderr: "" };
		},
	} as unknown as ExtensionAPI;

	const reviewerExecutor = async () => ({ verdict: "PASS" });
	const git = {
		marker: "checked-git",
		async inspectTaskCandidate(this: unknown, input: unknown, operation: OperationContext) {
			runnerCalls.push({ method: "inspectTaskCandidate", args: [this, input, operation] });
			return { branch: "refs/heads/task", head: "1".repeat(40), index: "2".repeat(40), tree: "2".repeat(40) };
		},
	};
	const host = { marker: "herdr-host" };
	const runtime = { marker: "composed-runtime" };
	const store = { marker: "file-store" };
	const runner = {
		async execute(...args: unknown[]) {
			runnerCalls.push({ method: "execute", args });
			return response("execute", true);
		},
		async status(...args: unknown[]) {
			runnerCalls.push({ method: "status", args });
			return response("status");
		},
		async resume(...args: unknown[]) {
			runnerCalls.push({ method: "resume", args });
			return response("resume", true);
		},
		async abort(...args: unknown[]) {
			runnerCalls.push({ method: "abort", args });
			return response("abort");
		},
	};

	const dependencies: Partial<OrchestratorExtensionDependencies> = {
		now: () => 1_000,
		orchestratorEntrypoint: "/package/extensions/orchestrator.ts",
		createRootResolver(options) {
			factoryCalls.push("root");
			processRunner = options.runProcess;
			return async (cwd, operation) => {
				rootCalls.push({ cwd, context: operation });
				return CANONICAL_ROOT;
			};
		},
		createReviewerExecutor(options) {
			factoryCalls.push("reviewer");
			assert.equal(options, undefined);
			return reviewerExecutor;
		},
		createGitRuntime(options) {
			factoryCalls.push("git");
			gitOptions = options;
			return git as never;
		},
		createHostRuntime(options) {
			factoryCalls.push("host");
			hostOptions = options;
			return host as never;
		},
		createRuntime(options) {
			factoryCalls.push("runtime");
			runtimeOptions = options;
			return runtime as never;
		},
		createStore() {
			factoryCalls.push("store");
			return store as never;
		},
		createRunner(receivedRuntime, receivedGit, receivedStore) {
			factoryCalls.push("runner");
			assert.equal(receivedRuntime, runtime);
			assert.equal(receivedGit, git);
			assert.equal(receivedStore, store);
			return runner as never;
		},
		...overrides,
	};
	registerOrchestratorExtension(pi, dependencies);

	return {
		pi,
		tools,
		handlers,
		factoryCalls,
		runnerCalls,
		rootCalls,
		execCalls,
		getGitOptions: () => gitOptions!,
		getHostOptions: () => hostOptions!,
		getRuntimeOptions: () => runtimeOptions!,
		getReviewerExecutor: () => reviewerExecutor,
		getRoleContext: () => runtimeOptions!.role.context(),
		getProcessRunner: () => processRunner!,
	};
}

function namedTool(harness: Harness, name: string): RegisteredTool {
	return harness.tools.find((tool) => tool.name === name)!;
}

async function executeTool(
	tool: RegisteredTool,
	params: unknown,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
) {
	return await tool.execute("tool-call", params as never, signal, undefined, ctx);
}

function expectedPublicState() {
	return {
		version: 1,
		id: "request-one",
		status: "needs_attention",
		accepted: false,
		tasks: [{ taskId: "unit-one", status: "needs_attention" }],
		final: { status: "pending" },
		createdAt: 100,
		updatedAt: 200,
	};
}

test("registers exactly four strict tools without constructing runtime components", () => {
	const harness = createHarness();
	assert.deepEqual(harness.tools.map(({ name }) => name), [
		"orchestrate_execute",
		"orchestrate_status",
		"orchestrate_resume",
		"orchestrate_abort",
	]);
	assert.deepEqual(harness.factoryCalls, []);

	const [execute, status, resume, abort] = harness.tools;
	assert.equal(execute!.parameters, ExecuteRequestSchema);
	assert.equal(execute!.prepareArguments, parseExecuteRequest);
	assert.equal(status!.parameters, IdOnlySchema);
	assert.equal(status!.prepareArguments, parseIdOnly);
	assert.equal(resume!.parameters, ResumeRequestSchema);
	assert.equal(resume!.prepareArguments, parseResumeRequest);
	assert.equal(abort!.parameters, IdOnlySchema);
	assert.equal(abort!.prepareArguments, parseIdOnly);
	assert.deepEqual(parseIdOnly({ id: "request-one" }), { id: "request-one" });
	assert.throws(() => parseIdOnly({ id: "request-one", extra: true }), /strict v1 schema/i);
	assert.throws(() => parseIdOnly({ id: "Request_One" }), /strict v1 schema/i);
	assert.throws(() => execute!.prepareArguments({ ...EXECUTE_REQUEST, extra: true }), /strict v1 schema/i);
	assert.throws(() => resume!.prepareArguments({ id: "request-one", action: "finalize", taskId: "unit-one" }), /strict v1 action/i);
});

test("Role child argv causes zero registration and dependency side effects", () => {
	const originalArgv = process.argv;
	let piAccesses = 0;
	let dependencyAccesses = 0;
	const pi = new Proxy({}, {
		get() {
			piAccesses += 1;
			throw new Error("child mode touched Pi");
		},
	}) as ExtensionAPI;
	const dependencies = new Proxy({}, {
		get() {
			dependencyAccesses += 1;
			throw new Error("child mode touched dependencies");
		},
	}) as Partial<OrchestratorExtensionDependencies>;
	try {
		process.argv = [...originalArgv, `--${ROLE_TOOL_POLICY_FLAG}`, "[]"];
		registerOrchestratorExtension(pi, dependencies);
	} finally {
		process.argv = originalArgv;
	}
	assert.equal(piAccesses, 0);
	assert.equal(dependencyAccesses, 0);
});

test("lazily wires one checked runtime graph, direct processes, Reviewer adapter, and fresh context", async () => {
	const harness = createHarness();
	const initial = context("/nested/initial", { id: "initial-model" });
	const executeSignal = new AbortController().signal;
	const result = await executeTool(namedTool(harness, "orchestrate_execute"), EXECUTE_REQUEST, executeSignal, initial);

	assert.deepEqual(harness.factoryCalls, ["root", "reviewer", "git", "host", "runtime", "store", "runner"]);
	assert.equal(harness.getRuntimeOptions().role.pi, harness.pi);
	assert.equal(harness.getRuntimeOptions().role.orchestratorEntrypoint, "/package/extensions/orchestrator.ts");
	assert.equal((harness.getRuntimeOptions().host as unknown as { marker: string }).marker, "herdr-host");
	assert.equal((harness.getRuntimeOptions().git as unknown as { marker: string }).marker, "checked-git");
	assert.equal(harness.getGitOptions().runProcess, harness.getHostOptions().runProcess);
	assert.equal(harness.getGitOptions().executeReview, harness.getReviewerExecutor());
	assert.equal(harness.getRoleContext(), initial);

	const operation: OperationContext = {
		signal: new AbortController().signal,
		timeoutMs: 321,
		deadline: 1_321,
	};
	const candidateInput = { root: CANONICAL_ROOT, task: { id: "unit-one" }, attempt: { number: 1 } };
	await harness.getHostOptions().inspectTaskCandidate(candidateInput as never, operation);
	const inspection = harness.runnerCalls.find(({ method }) => method === "inspectTaskCandidate")!;
	assert.equal(inspection.args[0], harness.getRuntimeOptions().git);
	assert.equal(inspection.args[1], candidateInput);
	assert.equal(inspection.args[2], operation);

	const processSignal = new AbortController().signal;
	assert.deepEqual(await harness.getProcessRunner()("git", ["status", "--short"], {
		cwd: CANONICAL_ROOT,
		signal: processSignal,
		timeoutMs: 432,
	}), { code: 0, killed: false, stdout: "ok\n", stderr: "" });
	assert.deepEqual(harness.execCalls, [{
		command: "git",
		args: ["status", "--short"],
		options: { cwd: CANONICAL_ROOT, signal: processSignal, timeout: 432 },
	}]);

	const session = context("/session", { id: "session-model" });
	harness.handlers.get("session_start")!({ type: "session_start" }, session);
	assert.equal(harness.getRoleContext(), session);
	const selectedModel = { id: "selected-model" };
	const staleModelContext = context("/model", { id: "stale-model" });
	harness.handlers.get("model_select")!({ type: "model_select", model: selectedModel }, staleModelContext);
	assert.notEqual(harness.getRoleContext(), staleModelContext);
	assert.equal(harness.getRoleContext().cwd, staleModelContext.cwd);
	assert.equal(harness.getRoleContext().model, selectedModel);
	const settled = context("/settled", { id: "settled-model" });
	harness.handlers.get("agent_settled")!({ type: "agent_settled" }, settled);
	assert.equal(harness.getRoleContext(), settled);

	await executeTool(namedTool(harness, "orchestrate_status"), { id: "request-one" }, undefined, settled);
	assert.deepEqual(harness.factoryCalls, ["root", "reviewer", "git", "host", "runtime", "store", "runner"]);
	assert.deepEqual(result, {
		content: [{ type: "text", text: "bounded execute result" }],
		details: {
			state: expectedPublicState(),
			continuation: { id: "request-one", action: "finalize" },
		},
	});
	assert.doesNotMatch(JSON.stringify(result.details), /PRIVATE|prompt|rawArgs|SECRET_TOKEN|command-line/i);
});

test("execute keeps raw cwd while lookup actions use canonical root, bounded context, and signals", async () => {
	const harness = createHarness();
	const nestedCwd = "/canonical/repository/nested/deeper";
	const ctx = context(nestedCwd);
	const signals = Array.from({ length: 4 }, () => new AbortController().signal);
	const execute = await executeTool(namedTool(harness, "orchestrate_execute"), EXECUTE_REQUEST, signals[0], ctx);
	assert.equal(harness.rootCalls.length, 0);
	assert.deepEqual(harness.runnerCalls[0], { method: "execute", args: [EXECUTE_REQUEST, nestedCwd, signals[0]] });

	const status = await executeTool(namedTool(harness, "orchestrate_status"), { id: "request-one" }, signals[1], ctx);
	const resumeRequest = { id: "request-one", action: "finalize" as const };
	const resume = await executeTool(namedTool(harness, "orchestrate_resume"), resumeRequest, signals[2], ctx);
	const abort = await executeTool(namedTool(harness, "orchestrate_abort"), { id: "request-one" }, signals[3], ctx);

	assert.deepEqual(harness.rootCalls.map(({ cwd }) => cwd), [nestedCwd, nestedCwd, nestedCwd]);
	assert.deepEqual(harness.rootCalls.map(({ context: operation }) => ({
		signal: operation.signal,
		timeoutMs: operation.timeoutMs,
		deadline: operation.deadline,
	})), [
		{ signal: signals[1], timeoutMs: 5_000, deadline: 6_000 },
		{ signal: signals[2], timeoutMs: 5_000, deadline: 6_000 },
		{ signal: signals[3], timeoutMs: 5_000, deadline: 6_000 },
	]);
	assert.deepEqual(harness.runnerCalls.filter(({ method }) => method !== "execute"), [
		{ method: "status", args: ["request-one", CANONICAL_ROOT] },
		{ method: "resume", args: [resumeRequest, CANONICAL_ROOT, signals[2]] },
		{ method: "abort", args: ["request-one", CANONICAL_ROOT, signals[3]] },
	]);
	assert.deepEqual(execute.content, [{ type: "text", text: "bounded execute result" }]);
	assert.deepEqual(status, { content: [{ type: "text", text: "bounded status result" }], details: { state: expectedPublicState() } });
	assert.deepEqual(resume, {
		content: [{ type: "text", text: "bounded resume result" }],
		details: { state: expectedPublicState(), continuation: { id: "request-one", action: "finalize" } },
	});
	assert.deepEqual(abort, { content: [{ type: "text", text: "bounded abort result" }], details: { state: expectedPublicState() } });
});

test("missing Role context and root preflight failures stay explicit", async () => {
	let contextGetter: (() => ExtensionContext) | undefined;
	const missing = createHarness({
		createRuntime(options) {
			contextGetter = options.role.context;
			contextGetter();
			throw new Error("unreachable");
		},
	});
	await assert.rejects(
		namedTool(missing, "orchestrate_execute").execute(
			"tool-call",
			EXECUTE_REQUEST as never,
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		),
		/Pi Orchestrator cannot resolve a Role before session context exists/i,
	);
	assert.equal(typeof contextGetter, "function");

	let statusCalls = 0;
	const failed = createHarness({
		createRootResolver() {
			return async () => {
				throw new Error("canonical root preflight failed closed");
			};
		},
		createRunner() {
			return {
				async status() {
					statusCalls += 1;
					return response("status");
				},
			} as never;
		},
	});
	await assert.rejects(
		executeTool(namedTool(failed, "orchestrate_status"), { id: "request-one" }, new AbortController().signal, context("/nested")),
		/canonical root preflight failed closed/i,
	);
	assert.equal(statusCalls, 0);
});

test("manifest entrypoint smoke-loads four tools in Main and none in a Role child", async () => {
	const manifest = JSON.parse(await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};
	assert.deepEqual(manifest.pi?.extensions, ["./extensions/orchestrator.ts"]);
	const entrypoint = resolve(PACKAGE_ROOT, manifest.pi.extensions[0]!);
	const loaded = await import(pathToFileURL(entrypoint).href) as { default(pi: ExtensionAPI): void };
	const mainTools: string[] = [];
	const mainEvents: string[] = [];
	loaded.default({
		registerTool(tool: { name: string }) {
			mainTools.push(tool.name);
		},
		on(name: string) {
			mainEvents.push(name);
		},
	} as unknown as ExtensionAPI);
	assert.deepEqual(mainTools, ["orchestrate_execute", "orchestrate_status", "orchestrate_resume", "orchestrate_abort"]);
	assert.deepEqual(mainEvents, ["session_start", "model_select", "agent_settled"]);

	const originalArgv = process.argv;
	let childSideEffects = 0;
	try {
		process.argv = [...originalArgv, `--${ROLE_TOOL_POLICY_FLAG}`, "[]"];
		loaded.default(new Proxy({}, {
			get() {
				childSideEffects += 1;
				throw new Error("Role child entrypoint caused a side effect");
			},
		}) as ExtensionAPI);
	} finally {
		process.argv = originalArgv;
	}
	assert.equal(childSideEffects, 0);
});

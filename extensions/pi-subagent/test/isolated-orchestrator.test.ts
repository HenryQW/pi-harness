import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { ROLE_TOOL_POLICY_FLAG } from "@henryqw/pi-subagent";
import {
	createIsolatedComponents,
	registerIsolatedExtension,
	workspaceWidgetLines,
	type CreateIsolatedComponents,
	type IsolatedExtensionComponents,
} from "../extensions/isolated.ts";
import type { OperationContext, RunResponse } from "../src/runner.ts";
import {
	ExecuteRequestSchema,
	IdOnlySchema,
	ResumeRequestSchema,
	StageRequestSchema,
	IntegrationActionSchema,
	parseIntegrationAction,
	parseStageRequest,
	parseExecuteRequest,
	parseIdOnly,
	parseResumeRequest,
	type ExecuteRequest,
	type RunState,
} from "../dist/schema.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_ROOT = "/canonical/repository";
const RECORDED_MAIN = {
	branch: "refs/heads/main",
	head: "a".repeat(40),
	index: "a".repeat(40),
	tree: "a".repeat(40),
};
const CURRENT_MAIN = {
	branch: "refs/heads/main",
	head: "b".repeat(40),
	index: "b".repeat(40),
	tree: "b".repeat(40),
};
const POLICY = {
	maxSubagents: 5,
	maxTurns: 50,
	childIdleMs: 600_000,
	childMaxMs: 1_800_000,
	maxCorrections: 1,
};

type WidgetContent = string[] | ((tui: TUI, theme: Theme) => Component) | undefined;
const plainTheme = { fg: (_color: string, text: string) => text } as Theme;
function renderWidget(content: WidgetContent, theme = plainTheme): string[] | undefined {
	return typeof content === "function" ? content({} as TUI, theme).render(200) : content;
}

const EXECUTE_REQUEST: ExecuteRequest = {
	id: "request-one",
	goal: "Deliver checked work.",
	mode: "isolated",
	tasks: [{
		id: "unit-one",
		kind: "changeset",
		role: "implementer",
		modelClass: "fast",
		requirements: "Implement the bounded unit.",
		deliverable: "A checked commit.",
		dependsOn: [],
		contextFrom: [],
		checks: [{ command: "pnpm", args: ["test"] }],
	}],
	finalChecks: [{ command: "pnpm", args: ["typecheck"] }],
};

const PRIVATE_STATE = {
	version: 5,
	request: EXECUTE_REQUEST,
	root: CANONICAL_ROOT,
	main: RECORDED_MAIN,
	status: "needs_attention",
	accepted: false,
	tasks: [{
		taskId: "unit-one",
		kind: "changeset",
		status: "needs_attention",
		failure: "The task needs a deliberate recovery decision.",
		attempts: [{
			prompts: [{ task: "PRIVATE IMPLEMENTER PROMPT" }],
			allocations: [{
				kind: "worktree",
				status: "owned",
				worktree: {
					path: "/tmp/pi-task",
					cwd: "/tmp/pi-task",
					branch: "subagent/unit-one",
					repoRoot: CANONICAL_ROOT,
					baseCommit: "a".repeat(40),
				},
			}],
			preliminaryChecks: {
				phase: "preliminary",
				candidate: RECORDED_MAIN,
				identityAfter: RECORDED_MAIN,
				passed: false,
				results: [{
					command: "node",
					args: ["--test", "focused.test.ts"],
					code: 1,
					killed: false,
					stdout: "",
					stderr: "focused check failed",
				}],
			},
			preliminaryReview: {
				phase: "preliminary",
				tip: RECORDED_MAIN,
				identityAfter: RECORDED_MAIN,
				passed: false,
				verdict: "NEEDS_WORK",
			},
			cleanup: [
				{ kind: "worker_tab", status: "completed" },
				{ kind: "workspace", status: "pending", failure: "workspace still busy" },
				{ kind: "worktree", status: "pending" },
				{ kind: "branch", status: "pending" },
			],
		}],
	}],
	final: { status: "pending" },
	integration: { candidates: [], generations: [] },
	launchRecords: {
		"implementer/fast": {
			env: { SECRET_TOKEN: "PRIVATE PROCESS ENVIRONMENT" },
			args: ["--private-command-line"],
		},
	},
	createdAt: 100,
	updatedAt: 200,
} as unknown as RunState;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function context(cwd: string, model: unknown = undefined): ExtensionContext {
	return { cwd, model } as unknown as ExtensionContext;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type RegisteredCommand = { handler(args: string, ctx: ExtensionContext): Promise<void> | void };
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
	surface: ReturnType<typeof registerIsolatedExtension>;
	pi: ExtensionAPI;
	tools: RegisteredTool[];
	commands: Map<string, RegisteredCommand>;
	handlers: Map<string, EventHandler>;
	runnerCalls: RunnerCall[];
	rootCalls: Array<{ cwd: string; context: OperationContext }>;
	getComponentCreations(): number;
	getRoleContext(): ExtensionContext;
	getStateSaved(): (state: RunState) => void;
	sent: Array<{ message: { content: string; details: unknown }; options: unknown }>;
}

function response(method: string, continuation = false, state: RunState = PRIVATE_STATE): RunResponse {
	return {
		text: `bounded ${method} result`,
		state,
		...(continuation ? { continuation: { id: "request-one", action: "finalize" as const } } : {}),
	};
}

function createHarness(options: {
	runner?: IsolatedExtensionComponents["runner"];
	resolveRoot?: IsolatedExtensionComponents["resolveRoot"];
	responseState?: RunState;
	onCreate?: (options: Parameters<CreateIsolatedComponents>[0]) => void;
} = {}): Harness {
	const tools: RegisteredTool[] = [];
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, EventHandler>();
	const runnerCalls: RunnerCall[] = [];
	const rootCalls: Array<{ cwd: string; context: OperationContext }> = [];
	const sent: Harness["sent"] = [];
	let componentCreations = 0;
	let componentOptions: Parameters<CreateIsolatedComponents>[0] | undefined;

	const pi = {
		on(name: string, handler: EventHandler) {
			handlers.set(name, handler);
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		sendMessage(message: { content: string; details: unknown }, deliveryOptions: unknown) {
			sent.push({ message, options: deliveryOptions });
		},
	} as unknown as ExtensionAPI;

	const runner = {
		async execute(...args: unknown[]) {
			runnerCalls.push({ method: "execute", args });
			const state = structuredClone(PRIVATE_STATE);
			state.status = "pending";
			state.createdAt = state.updatedAt;
			state.tasks[0]!.status = "pending";
			state.tasks[0]!.attempts = [];
			componentOptions!.onStateSaved(state);
			return response("execute", true, options.responseState);
		},
		async status(...args: unknown[]) {
			runnerCalls.push({ method: "status", args });
			return {
				...response("status", false, options.responseState),
				main: { status: "drifted" as const, expected: RECORDED_MAIN, actual: CURRENT_MAIN },
			};
		},
		async resume(...args: unknown[]) {
			runnerCalls.push({ method: "resume", args });
			const state = structuredClone(PRIVATE_STATE);
			state.recovery = { kind: "resume", action: "finalize" };
			componentOptions!.onStateSaved(state);
			return response("resume", true, options.responseState);
		},
		async stage(...args: unknown[]) {
			runnerCalls.push({ method: "stage", args });
			return response("stage", false, options.responseState);
		},
		async abort(...args: unknown[]) {
			runnerCalls.push({ method: "abort", args });
			return response("abort", false, options.responseState);
		},
		queueFollowup(...args: unknown[]) {
			runnerCalls.push({ method: "queueFollowup", args });
			return "follow-up queued";
		},
		listRequests(...args: unknown[]) {
			runnerCalls.push({ method: "listRequests", args });
			return { requests: [{ id: "request-one", name: "Goal", status: "working", tasks: [{ id: "unit-one", name: "Task", kind: "changeset", status: "working" }] }], invalidIds: ["damaged"] };
		},
		canFollowup(...args: unknown[]) {
			runnerCalls.push({ method: "canFollowup", args });
			return true;
		},
		drainFollowups(...args: unknown[]) {
			runnerCalls.push({ method: "drainFollowups", args });
			return ["first", "second"];
		},
	} as unknown as IsolatedExtensionComponents["runner"];

	const createComponents: CreateIsolatedComponents = (createdOptions) => {
		componentCreations += 1;
		componentOptions = createdOptions;
		options.onCreate?.(createdOptions);
		return {
			runner: options.runner ?? runner,
			resolveRoot: options.resolveRoot ?? (async (cwd, operation) => {
				rootCalls.push({ cwd, context: operation });
				return CANONICAL_ROOT;
			}),
		};
	};
	const isolated = registerIsolatedExtension(pi, {
		executor: {} as never,
		policy: POLICY,
		currentPolicy: () => POLICY,
		componentsFactory: createComponents,
	});
	tools.unshift({
		name: "delegate_task",
		parameters: ExecuteRequestSchema,
		prepareArguments: parseExecuteRequest,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => await isolated.execute(params, signal, ctx),
	});

	return {
		surface: isolated,
		pi,
		tools,
		commands,
		handlers,
		runnerCalls,
		rootCalls,
		sent,
		getComponentCreations: () => componentCreations,
		getRoleContext: () => componentOptions!.context(),
		getStateSaved: () => componentOptions!.onStateSaved,
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
		version: 5,
		id: "request-one",
		status: "needs_attention",
		accepted: false,
		main: RECORDED_MAIN,
		tasks: [{ taskId: "unit-one", status: "needs_attention" }],
		final: { status: "pending" },
		integration: { candidates: [], generations: [] },
		needsAttention: {
			scope: "task",
			taskId: "unit-one",
			failure: "The task needs a deliberate recovery decision.",
			retainedWorktree: {
				path: "/tmp/pi-task",
				cwd: "/tmp/pi-task",
				branch: "subagent/unit-one",
			},
			failedCheck: {
				phase: "preliminary",
				identityChanged: false,
				command: "node \"--test\" \"focused.test.ts\"",
				code: 1,
				killed: false,
				stderr: "focused check failed",
			},
			failedReview: {
				phase: "preliminary",
				verdict: "NEEDS_WORK",
				identityChanged: false,
			},
			cleanup: [
				{ kind: "workspace", status: "pending", failure: "workspace still busy" },
				{ kind: "worktree", status: "pending" },
				{ kind: "branch", status: "pending" },
			],
		},
		createdAt: 100,
		updatedAt: 200,
	};
}

function addWorkspace(state: RunState, label = "012345"): void {
	const task = state.tasks[0]!;
	if (task.kind !== "changeset") throw new Error("Expected a changeset task.");
	task.attempts[0]!.allocations.push({
		kind: "workspace",
		generation: 1,
		token: "0123456789abcdef",
		status: "owned",
		label,
		worktreeCwd: "/tmp/pi-task",
		mainRoot: CANONICAL_ROOT,
		repoKey: CANONICAL_ROOT,
		herdrRepoRoot: CANONICAL_ROOT,
		workspaceId: "workspace-one",
		rootTabId: "tab-one",
		rootPaneId: "pane-one",
	});
}

test("workspace widget lists every uncleaned workspace with status and agent context", () => {
	const state = structuredClone(PRIVATE_STATE);
	addWorkspace(state);
	const firstTask = state.tasks[0]!;
	assert.equal(firstTask.kind, "changeset");
	if (firstTask.kind !== "changeset") return;
	state.request.tasks.push({ ...state.request.tasks[0]!, id: "unit-two", role: "reviewer", modelClass: "balanced" });
	const secondTask = structuredClone(firstTask);
	secondTask.taskId = "unit-two";
	secondTask.status = "working";
	secondTask.attempts[0]!.allocations = secondTask.attempts[0]!.allocations.map((allocation) =>
		allocation.kind === "workspace"
			? { ...allocation, label: "fedcba", workspaceId: "workspace-two" }
			: allocation);
	state.tasks.push(secondTask);

	assert.deepEqual(workspaceWidgetLines(state), [
		"! I [I1] unit-one · attention · The task needs a deliberate rec~ · 012345",
		"◌ I [R2] unit-two · working · fedcba",
	]);

	state.status = "aborted";
	const firstWorkspace = firstTask.attempts[0]!.allocations.find((allocation) => allocation.kind === "workspace")!;
	firstWorkspace.label = "x".repeat(64);
	assert.deepEqual(workspaceWidgetLines(state), [
		"■ I request-one · request aborted",
		`! I [I1] unit-one · attention · The task needs a deliberate rec~ · ${"x".repeat(31)}~`,
		"◌ I [R2] unit-two · working · fedcba",
	]);
	state.status = "needs_attention";
	firstTask.status = "ready_to_integrate";
	assert.match(workspaceWidgetLines(state)![0]!, /candidate ready · Main not promoted/);
	firstTask.status = "needs_attention";

	firstTask.attempts[0]!.cleanup.find(({ kind }) => kind === "workspace")!.status = "completed";
	assert.deepEqual(workspaceWidgetLines(state), [
		"◌ I [R2] unit-two · working · fedcba",
	]);
	secondTask.attempts[0]!.cleanup.find(({ kind }) => kind === "workspace")!.status = "completed";
	assert.equal(workspaceWidgetLines(state), undefined);
});

test("status restores active workspace rows and provides the non-TUI fallback", async () => {
	const state = structuredClone(PRIVATE_STATE);
	addWorkspace(state);
	const widgets: Array<string[] | undefined> = [];
	const tuiContext = {
		cwd: "/repo",
		hasUI: true,
		ui: { setWidget: (_key: string, content: WidgetContent) => widgets.push(renderWidget(content)) },
	} as unknown as ExtensionContext;
	const harness = createHarness({ responseState: state });
	harness.handlers.get("session_start")!({}, tuiContext);
	assert.equal(widgets.at(-1), undefined);

	await executeTool(namedTool(harness, "subagent_status"), { id: "request-one" }, undefined, tuiContext);
	assert.deepEqual(widgets.at(-1), workspaceWidgetLines(state));

	const rpcResult = await executeTool(
		namedTool(harness, "subagent_status"),
		{ id: "request-one" },
		undefined,
		{ cwd: "/repo", hasUI: false } as ExtensionContext,
	);
	assert.equal(rpcResult.content[0]!.text, "bounded status result\n\nActive workspaces:\n! I [I1] unit-one · attention · The task needs a deliberate rec~ · 012345");
});

test("aborted request keeps mixed task evidence distinct in status and widget", async () => {
	const state = structuredClone(PRIVATE_STATE);
	state.status = "aborted";
	addWorkspace(state);
	const first = state.tasks[0]!;
	if (first.kind !== "changeset") throw new Error("Expected a changeset task.");
	first.failure = "Worker prompt outcome ambiguous";
	first.attempts[0]!.prompts[0]!.status = "ambiguous";
	state.request.tasks.push({ ...state.request.tasks[0]!, id: "unit-two", role: "reviewer" });
	state.tasks.push({ ...structuredClone(first), taskId: "unit-two", status: "working", failure: undefined });
	const widgets: Array<string[] | undefined> = [];
	const ctx = { cwd: "/repo", hasUI: true,
		ui: { setWidget: (_key: string, content: WidgetContent) => widgets.push(renderWidget(content)) } } as unknown as ExtensionContext;
	const harness = createHarness({ responseState: state });
	const result = await executeTool(namedTool(harness, "subagent_status"), { id: "request-one" }, undefined, ctx);
	assert.deepEqual(widgets.at(-1), [
		"■ I request-one · request aborted",
		"! I [I1] unit-one · attention · Worker prompt outcome ambiguous · 012345",
		"◌ I [R1] unit-two · working · 012345",
	]);
	const { status, tasks, integration } = (result.details as {
		state: { status: string; tasks: Array<{ taskId: string; status: string }>; integration: { candidates: unknown[] } };
	}).state;
	assert.deepEqual({ status, tasks, candidates: integration.candidates }, {
		status: "aborted",
		tasks: [{ taskId: "unit-one", status: "needs_attention" }, { taskId: "unit-two", status: "working" }],
		candidates: [],
	});
});

test("isolated widget colors status glyphs with the active TUI theme while retaining plain status text", async () => {
	let widget: WidgetContent;
	const ctx = { cwd: "/repo", hasUI: true,
		ui: { setWidget: (_key: string, content: WidgetContent) => { widget = content; } } } as unknown as ExtensionContext;
	const harness = createHarness();
	await executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, undefined, ctx);
	const state = structuredClone(PRIVATE_STATE);
	addWorkspace(state);
	const task = state.tasks[0]!;
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as Theme;
	const show = () => {
		harness.getStateSaved()(state);
		assert.equal(typeof widget, "function");
		return renderWidget(widget, theme)![0]!;
	};
	assert.match(show(), /^<error>!<\/error> I \[I1\] unit-one · attention · /);
	assert.match(renderWidget(widget)![0]!, /^! I \[I1\] unit-one · attention · /);
	const narrow = (widget as (tui: TUI, theme: Theme) => Component)({} as TUI, theme).render(24)[0]!;
	assert.match(narrow, /^<error>!<\/error>/);
	assert.ok(visibleWidth(narrow) <= 24);
	task.status = "working";
	assert.match(show(), /^<accent>◌<\/accent> I \[I1\] unit-one · working · /);
	task.status = "ready_to_integrate";
	assert.match(show(), /^<success>✓<\/success> I \[I1\] unit-one · candidate ready · Main not promoted/);
	task.status = "completed";
	assert.match(show(), /^<success>✓<\/success> I \[I1\] unit-one · completed · /);
	state.status = "aborted";
	assert.match(show(), /^<warning>■<\/warning> I request-one · request aborted$/);
});

test("isolated work remains visible before any workspace is allocated", () => {
	const state = structuredClone(PRIVATE_STATE);
	const changeset = state.tasks[0]!;
	changeset.status = "allocating";
	assert.deepEqual(workspaceWidgetLines(state), ["◌ I [I1] unit-one · allocating"]);
	state.request.tasks[0] = { id: "research", kind: "text", role: "scout", modelClass: "fast", requirements: "Investigate", deliverable: "Report", dependsOn: [], contextFrom: [] };
	state.tasks[0] = { taskId: "research", kind: "text", status: "running", attempts: [{ number: 1, status: "running" }] };
	assert.deepEqual(workspaceWidgetLines(state), ["◌ I [S1] research · running"]);
	const textTask = state.tasks[0]!;
	textTask.status = "needs_attention";
	textTask.failure = "Recover the task";
	assert.deepEqual(workspaceWidgetLines(state), ["! I [S1] research · attention · Recover the task"]);
	state.status = "aborted";
	assert.deepEqual(workspaceWidgetLines(state), [
		"■ I request-one · request aborted",
		"! I [S1] research · attention · Recover the task",
	]);
});

test("isolated widget caps rows and keeps attention visible", async () => {
	const widgets: Array<string[] | undefined> = [];
	const ctx = { cwd: "/repo", hasUI: true,
		ui: { setWidget: (_key: string, content: WidgetContent) => widgets.push(renderWidget(content)) } } as unknown as ExtensionContext;
	const harness = createHarness();
	await executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, undefined, ctx);
	const state = structuredClone(PRIVATE_STATE);
	addWorkspace(state);
	const original = state.tasks[0]!;
	if (original.kind !== "changeset") throw new Error("Expected a changeset task.");
	for (let index = 2; index <= 7; index++) {
		state.request.tasks.push({ ...state.request.tasks[0]!, id: `unit-${index}` });
		state.tasks.push({ ...structuredClone(original), taskId: `unit-${index}`, status: "working", failure: undefined });
	}
	harness.getStateSaved()(state);
	assert.equal(widgets.at(-1)?.length, 6);
	assert.match(widgets.at(-1)![0]!, /^! I /);
	assert.equal(widgets.at(-1)![5], "+2 more · /subagent");
});

test("saved state updates and clears the workspace widget", async () => {
	const widgets: Array<string[] | undefined> = [];
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		ui: { setWidget: (_key: string, content: WidgetContent) => widgets.push(renderWidget(content)) },
	} as unknown as ExtensionContext;
	const harness = createHarness();
	await executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, undefined, ctx);
	const state = structuredClone(PRIVATE_STATE);
	addWorkspace(state);

	harness.getStateSaved()(state);
	assert.deepEqual(widgets.at(-1), workspaceWidgetLines(state));
	const otherState = structuredClone(PRIVATE_STATE);
	otherState.request.id = "request-two";
	harness.getStateSaved()(otherState);
	assert.deepEqual(widgets.at(-1), [...workspaceWidgetLines(state)!, ...workspaceWidgetLines(otherState)!]);
	const task = state.tasks[0]!;
	if (task.kind !== "changeset") throw new Error("Expected a changeset task.");
	task.attempts[0]!.cleanup.find(({ kind }) => kind === "workspace")!.status = "completed";
	harness.getStateSaved()(state);
	assert.deepEqual(widgets.at(-1), workspaceWidgetLines(otherState));
});

test("registers six strict tools without constructing runtime components", () => {
	const harness = createHarness();
	assert.deepEqual(harness.tools.map(({ name }) => name), [
		"delegate_task",
		"subagent_status",
		"subagent_resume",
		"subagent_stage",
		"subagent_integrate",
		"subagent_abort",
	]);
	assert.deepEqual([...harness.commands.keys()], []);
	assert.equal(harness.getComponentCreations(), 0);

	const [execute, status, resume, stage, integrate, abort] = harness.tools;
	assert.equal(execute!.parameters, ExecuteRequestSchema);
	assert.equal(execute!.prepareArguments, parseExecuteRequest);
	assert.equal(status!.parameters, IdOnlySchema);
	assert.equal(status!.prepareArguments, parseIdOnly);
	assert.equal(resume!.parameters, ResumeRequestSchema);
	assert.equal(resume!.prepareArguments, parseResumeRequest);
	assert.equal(stage!.parameters, StageRequestSchema);
	assert.equal(stage!.prepareArguments, parseStageRequest);
	assert.throws(() => stage!.prepareArguments({ id: "request-one", action: "stage", taskId: "unit-one" }), /exact candidate and generation/);
	assert.equal(integrate!.parameters, IntegrationActionSchema);
	assert.equal(integrate!.prepareArguments, parseIntegrationAction);
	assert.throws(() => integrate!.prepareArguments({ id: "request-one", action: "promote" }), /exact generation and tip/);
	assert.equal(abort!.parameters, IdOnlySchema);
	assert.equal(abort!.prepareArguments, parseIdOnly);
	assert.deepEqual(parseIdOnly({ id: "request-one" }), { id: "request-one" });
	assert.throws(() => parseIdOnly({ id: "request-one", extra: true }), /strict schema/i);
	assert.throws(() => parseIdOnly({ id: "Request_One" }), /strict schema/i);
	assert.throws(() => execute!.prepareArguments({ ...EXECUTE_REQUEST, extra: true }), /strict task schema/i);
	assert.throws(() => resume!.prepareArguments({ id: "request-one", action: "finalize", taskId: "unit-one" }), /must match one strict action/i);
});

test("inventory and status remain read-only; synchronous mutations reject stale UI context", async () => {
	const harness = createHarness();
	const surface = harness.surface;
	assert.deepEqual((await surface.inventory("/repo/subdir")).invalidIds, ["damaged"]);
	assert.equal(harness.runnerCalls.filter(({ method }) => method === "listRequests").length, 1);
	assert.match((await surface.inspect(CANONICAL_ROOT, "request-one")).join("\n"), /\/tmp\/pi-task/);
	assert.equal(surface.canFollowup(CANONICAL_ROOT, "request-one", "unit-one"), true);
	assert.throws(() => surface.drain(CANONICAL_ROOT, "request-one", "unit-one", () => false), /Session or branch changed/);
	assert.deepEqual(harness.runnerCalls.filter(({ method }) => method === "drainFollowups"), []);
	assert.deepEqual(surface.drain(CANONICAL_ROOT, "request-one", "unit-one", () => true), ["first", "second"]);
	assert.equal(surface.enqueue(CANONICAL_ROOT, "request-one", "unit-one", "instruction", () => true), "follow-up queued");
	assert.deepEqual(harness.runnerCalls.filter(({ method }) => method === "queueFollowup"), [
		{ method: "queueFollowup", args: [CANONICAL_ROOT, "request-one", "unit-one", "instruction"] },
	]);
});

test("inspection distinguishes released saved records from partial cleanup and keeps retained paths", async () => {
	const state = structuredClone(PRIVATE_STATE);
	const task = state.tasks[0]!;
	if (task.kind !== "changeset") throw new Error("Expected changeset");
	const attempt = task.attempts[0]!;
	attempt.number = 1;
	addWorkspace(state);
	attempt.allocations.push(
		{ kind: "worker_tab", generation: 1, token: "0123456789abcdef", status: "owned", label: "worker-tab", workspaceId: "workspace-one", workspaceRootTabId: "root-tab", workspaceRootPaneId: "root-pane", tabId: "tab-one", paneId: "pane-one", leasePath: "/late/lease", worktreeCwd: "/tmp/pi-task" },
		{ kind: "agent", generation: 1, token: "0123456789abcdef", status: "owned", agentName: "saved-agent", workspaceId: "workspace-one", tabId: "tab-one", paneId: "pane-one", leasePath: "/late/lease", worktreeCwd: "/tmp/pi-task" },
	);
	attempt.termination = { status: "terminated", workerId: "saved-agent", candidate: RECORDED_MAIN } as typeof attempt.termination;
	const generation = {
		number: 1, status: "superseded", expectedMain: RECORDED_MAIN, integrationBase: RECORDED_MAIN, order: [], stages: [],
		worktree: { path: "/late/integration", cwd: "/late/integration", branch: "refs/heads/late-integration", repoRoot: CANONICAL_ROOT, baseCommit: "a".repeat(40) },
		cleanup: [{ kind: "worktree", status: "completed" }, { kind: "branch", status: "completed" }],
	} as RunState["integration"]["generations"][number];
	state.integration.generations.push(generation);
	for (const step of attempt.cleanup) step.status = "completed";
	const released = (await createHarness({ responseState: state }).surface.inspect(CANONICAL_ROOT, "request-one")).join("\n");
	assert.doesNotMatch(released, /\/tmp\/pi-task|\/late\/integration|\/late\/lease|agent \(owned\)/);

	attempt.cleanup.find((step) => step.kind === "workspace")!.status = "pending";
	attempt.cleanup.find((step) => step.kind === "branch")!.status = "pending";
	generation.cleanup![1]!.status = "pending";
	const partial = (await createHarness({ responseState: state }).surface.inspect(CANONICAL_ROOT, "request-one")).join("\n");
	assert.match(partial, /workspace \(owned\).*workspace-one/);
	assert.match(partial, /worktree \(owned; historical checkout; branch cleanup pending\).*\/tmp\/pi-task/);
	assert.match(partial, /Integration generation 1: superseded; historical checkout; branch cleanup pending:.*\/late\/integration/);
	assert.doesNotMatch(partial, /worker_tab \(owned\)|agent \(owned\)|Integration generation 1: superseded; worktree:/);
	assert.match(partial, /cleanup pending:.*"kind":"branch"/);

	attempt.cleanup.find((step) => step.kind === "worktree")!.status = "pending";
	attempt.cleanup.find((step) => step.kind === "branch")!.status = "completed";
	generation.cleanup![0]!.status = "pending";
	generation.cleanup![1]!.status = "completed";
	attempt.termination!.status = "unknown";
	const uncertain = (await createHarness({ responseState: state }).surface.inspect(CANONICAL_ROOT, "request-one")).join("\n");
	assert.match(uncertain, /worktree \(owned\).*\/tmp\/pi-task/);
	assert.match(uncertain, /Integration generation 1: superseded; worktree:.*\/late\/integration/);
	assert.match(uncertain, /agent \(owned\).*saved-agent/);

	attempt.cleanup.find((step) => step.kind === "worker_tab")!.status = "running";
	const tabPending = (await createHarness({ responseState: state }).surface.inspect(CANONICAL_ROOT, "request-one")).join("\n");
	assert.match(tabPending, /worker_tab \(owned\).*\/late\/lease/);
	assert.match(tabPending, /agent \(owned\).*saved-agent/);
});

test("inspection exposes late retained resources without dumping irrelevant state or mutating it", async () => {
	const state = structuredClone(PRIVATE_STATE);
	const task = state.tasks[0]!;
	if (task.kind !== "changeset") throw new Error("Expected changeset");
	const early = task.attempts[0]!;
	early.number = 1;
	early.preliminaryChecks!.results[0]!.stderr = "IRRELEVANT_PRIVATE_OUTPUT".repeat(1000);
	const late = structuredClone(early);
	late.preliminaryChecks = undefined;
	late.number = 2;
	late.allocations = [
		{ kind: "worktree", status: "owned", worktree: { path: "/late/retained-worktree", cwd: "/late/retained-worktree", branch: "refs/heads/late", repoRoot: CANONICAL_ROOT, baseCommit: "a".repeat(40) } },
		{ kind: "agent", status: "owned", agentName: "late-worker", workspaceId: "late-workspace", tabId: "late-tab", paneId: "late-pane", worktreeCwd: "/late/retained-worktree", leasePath: "/late/lease" },
	] as typeof late.allocations;
	task.attempts.push(late);
	const generations = state.integration.generations;
	for (let number = 1; number <= 32; number++) generations.push({
		number, status: "superseded", expectedMain: RECORDED_MAIN, integrationBase: RECORDED_MAIN, order: [], stages: [],
		...(number === 32 ? { worktree: { path: "/late/integration", cwd: "/late/integration", branch: "refs/heads/late-integration", repoRoot: CANONICAL_ROOT, baseCommit: "a".repeat(40) }, failure: "Blocked: inspect late integration checkout" } : {}),
	} as RunState["integration"]["generations"][number]);
	const harness = createHarness({ runner: { async status() { harness.runnerCalls.push({ method: "status", args: [] }); return { ...response("status", true, state), main: { status: "drifted" as const, expected: RECORDED_MAIN, actual: CURRENT_MAIN } }; } } as never });
	const notices = await harness.surface.inspect(CANONICAL_ROOT, "request-one");
	const text = notices.join("\n");
	assert.match(text, /\/late\/retained-worktree/);
	assert.match(text, /late-worker/);
	assert.match(text, /\/late\/lease/);
	assert.match(text, /\/late\/integration/);
	assert.match(text, /Blocked: inspect late integration checkout/);
	assert.match(text, /Reported continuation.*finalize/);
	assert.ok(notices.length < 15);
	assert.doesNotMatch(text, /IRRELEVANT_PRIVATE_OUTPUT|PRIVATE IMPLEMENTER PROMPT|SECRET_TOKEN/);
	assert.deepEqual(harness.runnerCalls.map(({ method }) => method), ["status"]);
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
	const createComponents: CreateIsolatedComponents = () => {
		dependencyAccesses += 1;
		throw new Error("child mode touched dependencies");
	};
	try {
		process.argv = [...originalArgv, `--${ROLE_TOOL_POLICY_FLAG}`, "[]"];
		registerIsolatedExtension(pi, {} as never);
	} finally {
		process.argv = originalArgv;
	}
	assert.equal(piAccesses, 0);
	assert.equal(dependencyAccesses, 0);
});

test("lazily creates one component graph and supplies fresh session context", async () => {
	const harness = createHarness();
	const initial = context("/nested/initial", { id: "initial-model" });
	const executeSignal = new AbortController().signal;
	const result = await executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, executeSignal, initial);

	assert.equal(harness.getComponentCreations(), 1);
	assert.equal(harness.getRoleContext(), initial);

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

	await executeTool(namedTool(harness, "subagent_status"), { id: "request-one" }, undefined, settled);
	assert.equal(harness.getComponentCreations(), 1);
	assert.match(result.content[0]!.text, /durable request accepted/);
	assert.equal((result.details as { state: { status: string } }).state.status, "pending");
	assert.doesNotMatch(JSON.stringify(result.details), /PRIVATE|prompt|rawArgs|SECRET_TOKEN|command-line/i);
});

test("delegate_task and resume acknowledge only saved state, then deliver one follow-up after work completes", async () => {
	const executeDone = deferred<RunResponse>();
	const resumeDone = deferred<RunResponse>();
	let save!: (state: RunState) => void;
	const harness = createHarness({
		onCreate(options) { save = options.onStateSaved; },
		runner: {
			async execute() {
				const pending = structuredClone(PRIVATE_STATE);
				pending.status = "pending";
				pending.updatedAt = pending.createdAt;
				pending.tasks[0]!.status = "pending";
				pending.tasks[0]!.attempts = [];
				save(pending);
				return await executeDone.promise;
			},
			async resume() {
				const recovering = structuredClone(PRIVATE_STATE);
				recovering.recovery = { kind: "resume", action: "finalize" };
				save(recovering);
				return await resumeDone.promise;
			},
		} as never,
	});
	const ctx = { ...context(CANONICAL_ROOT), sessionManager: { getSessionId: () => "origin" } } as ExtensionContext;
	harness.handlers.get("session_start")!({}, ctx);
	const turn = new AbortController();
	const handle = await executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, turn.signal, ctx);
	assert.match(handle.content[0]!.text, /durable request accepted/);
	assert.equal(harness.sent.length, 0);
	await assert.rejects(executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, undefined, ctx), /already active/);
	turn.abort(); // The tool's turn no longer owns the productive run.
	executeDone.resolve(response("execute", true));
	await new Promise(setImmediate);
	assert.equal(harness.sent.length, 1);
	assert.deepEqual(harness.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal((harness.sent[0]!.message.details as { state: { status: string } }).state.status, "needs_attention");
	assert.doesNotMatch(JSON.stringify(harness.sent[0]), /PRIVATE|SECRET_TOKEN|command-line/);
	const resumed = await executeTool(namedTool(harness, "subagent_resume"), { id: "request-one", action: "finalize" }, undefined, ctx);
	assert.match(resumed.content[0]!.text, /durable request accepted/);
	resumeDone.resolve(response("resume", true));
	await new Promise(setImmediate);
	assert.equal(harness.sent.length, 2);
});

test("a ready worker sends Main a stageable follow-up before the wave finishes", async () => {
	const done = deferred<RunResponse>();
	let save!: (state: RunState) => void;
	const harness = createHarness({
		onCreate(options) { save = options.onStateSaved; },
		runner: { async execute() {
			const pending = structuredClone(PRIVATE_STATE);
			pending.status = "pending";
			pending.updatedAt = pending.createdAt;
			pending.tasks[0]!.status = "pending";
			pending.tasks[0]!.attempts = [];
			save(pending);
			return await done.promise;
		} } as never,
	});
	const ctx = { ...context(CANONICAL_ROOT), sessionManager: { getSessionId: () => "origin" } } as ExtensionContext;
	harness.handlers.get("session_start")!({}, ctx);
	await executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, undefined, ctx);
	const ready = structuredClone(PRIVATE_STATE);
	ready.status = "running";
	ready.tasks[0]!.status = "ready_to_integrate";
	ready.integration.candidates = [{ taskId: "unit-one", attempt: 1, base: RECORDED_MAIN,
		tip: CURRENT_MAIN, checks: { phase: "preliminary", candidate: CURRENT_MAIN, identityAfter: CURRENT_MAIN,
			passed: true, results: [], at: 200 }, worker: "retained" }];
	save(ready);
	save(ready);
	assert.equal(harness.sent.length, 1);
	assert.match(harness.sent[0]!.message.content, /unit-one.*ready to integrate/);
	assert.deepEqual(harness.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal((harness.sent[0]!.message.details as { state: { status: string } }).state.status, "running");
	done.resolve(response("execute", true, ready));
	await new Promise(setImmediate);
});

test("advance acknowledges a dependent wave before its workers finish", async () => {
	const done = deferred<RunResponse>();
	let save!: (state: RunState) => void;
	const harness = createHarness({
		onCreate(options) { save = options.onStateSaved; },
		runner: { async integrate() {
			const running = structuredClone(PRIVATE_STATE);
			running.status = "running";
			running.waves = [{ number: 1, base: RECORDED_MAIN, taskIds: ["unit-one"], status: "dispatching" }];
			save(running);
			return await done.promise;
		} } as never,
	});
	const ctx = { ...context(CANONICAL_ROOT), sessionManager: { getSessionId: () => "origin" } } as ExtensionContext;
	harness.handlers.get("session_start")!({}, ctx);
	const result = await executeTool(namedTool(harness, "subagent_integrate"),
		{ id: "request-one", generation: 1, action: "advance", expectedTip: RECORDED_MAIN }, undefined, ctx);
	assert.match(result.content[0]!.text, /durable request accepted/);
	done.resolve(response("advance"));
	await new Promise(setImmediate);
	assert.equal(harness.sent.length, 1);
});

test("preflight errors reject before acknowledgement; post-save failures report durable recovery", async () => {
	const failedPreflight = createHarness({ runner: { async execute() { throw new Error("host preflight failed"); } } as never });
	await assert.rejects(executeTool(namedTool(failedPreflight, "delegate_task"), EXECUTE_REQUEST, undefined, context(CANONICAL_ROOT)), /host preflight failed/);
	assert.equal(failedPreflight.sent.length, 0);

	let save!: (state: RunState) => void;
	const failedRun = createHarness({
		onCreate(options) { save = options.onStateSaved; },
		runner: { async execute() {
			const pending = structuredClone(PRIVATE_STATE);
			pending.status = "pending";
			pending.updatedAt = pending.createdAt;
			pending.tasks[0]!.status = "pending";
			pending.tasks[0]!.attempts = [];
			save(pending);
			throw new Error("worker launch failed");
		} } as never,
	});
	await executeTool(namedTool(failedRun, "delegate_task"), EXECUTE_REQUEST, undefined, context(CANONICAL_ROOT));
	await new Promise(setImmediate);
	assert.equal(failedRun.sent.length, 1);
	assert.match(failedRun.sent[0]!.message.content, /worker launch failed.*subagent_status/);
});

test("session replacement and shutdown abort old work and suppress stale isolated delivery", async () => {
	const done = deferred<RunResponse>();
	let runSignal: AbortSignal | undefined;
	let save!: (state: RunState) => void;
	const harness = createHarness({
		onCreate(options) { save = options.onStateSaved; },
		runner: { async execute(_request: unknown, _cwd: string, signal: AbortSignal) {
			runSignal = signal;
			const pending = structuredClone(PRIVATE_STATE);
			pending.status = "pending";
			pending.updatedAt = pending.createdAt;
			pending.tasks[0]!.status = "pending";
			pending.tasks[0]!.attempts = [];
			save(pending);
			return await done.promise;
		} } as never,
	});
	const ctx = { ...context(CANONICAL_ROOT), sessionManager: { getSessionId: () => "origin" } } as ExtensionContext;
	harness.handlers.get("session_start")!({}, ctx);
	await executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, undefined, ctx);
	harness.handlers.get("session_shutdown")!({}, ctx);
	assert.equal(runSignal?.aborted, true);
	harness.handlers.get("session_start")!({}, { ...ctx, sessionManager: { getSessionId: () => "other" } } as ExtensionContext);
	done.resolve(response("execute", true));
	await new Promise(setImmediate);
	assert.equal(harness.sent.length, 0);
});

test("resume saved before session replacement cannot acknowledge or paint the new session", async () => {
	const done = deferred<RunResponse>();
	const widgets: Array<string[] | undefined> = [];
	const oldCtx = {
		...context(CANONICAL_ROOT), hasUI: true,
		ui: { setWidget: (_key: string, content: WidgetContent) => { widgets.push(renderWidget(content)); } },
		sessionManager: { getSessionId: () => "origin" },
	} as unknown as ExtensionContext;
	const newCtx = {
		...oldCtx, sessionManager: { getSessionId: () => "other" },
	} as ExtensionContext;
	let save!: (state: RunState) => void;
	let runSignal: AbortSignal | undefined;
	let harness!: Harness;
	harness = createHarness({
		onCreate(options) { save = options.onStateSaved; },
		runner: { async resume(_request: unknown, _root: string, signal: AbortSignal) {
			runSignal = signal;
			const recovering = structuredClone(PRIVATE_STATE);
			recovering.recovery = { kind: "resume", action: "finalize" };
			addWorkspace(recovering);
			save(recovering); // Durable save resolves the acknowledgement promise.
			harness.handlers.get("session_start")!({}, newCtx); // Switch before the tool can return it.
			save(recovering); // Late writes from the old job must not paint the new widget.
			return await done.promise;
		} } as never,
	});
	harness.handlers.get("session_start")!({}, oldCtx);
	await assert.rejects(
		executeTool(namedTool(harness, "subagent_resume"), { id: "request-one", action: "finalize" }, undefined, oldCtx),
		/saved.*launching session changed.*subagent_status/i,
	);
	assert.equal(runSignal?.aborted, true);
	assert.deepEqual(widgets, [undefined, ["! I [I1] unit-one · attention · The task needs a deliberate rec~ · 012345"], undefined]);
	assert.equal(harness.sent.length, 0);
	done.resolve(response("resume", true));
	await new Promise(setImmediate);
	assert.equal(harness.sent.length, 0);
});

test("production components complete host preflight before inspecting Main", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-components-")));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousPiEnv = process.env.PI_CODING_AGENT;
	const previousTitle = process.title;
	delete process.env.HERDR_ENV;
	process.env.PI_CODING_AGENT = "true";
	process.title = "pi";
	t.after(() => {
		process.title = previousTitle;
		if (previousPiEnv === undefined) delete process.env.PI_CODING_AGENT;
		else process.env.PI_CODING_AGENT = previousPiEnv;
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
	});
	const calls: Array<{ command: string; args: string[] }> = [];
	const pi = {
		events: { on() {}, emit() {} },
		async exec(command: string, args: string[]) {
			calls.push({ command, args });
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
				return { code: 0, killed: false, stdout: `${root}\n`, stderr: "" };
			}
			throw new Error(`Unexpected process: ${command} ${args.join(" ")}`);
		},
	} as unknown as ExtensionAPI;
	const { runner } = createIsolatedComponents({
		pi,
		context: () => context(root),
		executor: {} as never,
		policy: POLICY,
		currentPolicy: () => POLICY,
		onStateSaved() {},
	});

	await assert.rejects(runner.execute(EXECUTE_REQUEST, root), /requires HERDR_ENV=1/i);
	assert.deepEqual(calls, [{ command: "git", args: ["rev-parse", "--show-toplevel"] }]);
});

test("one-command recovery bounds the Main handoff across many retained requests", async () => {
	const state = structuredClone(PRIVATE_STATE);
	const harness = createHarness({ runner: { async recoverRepository() {
		return { requests: Array.from({ length: 90 }, (_, index) => ({
			...response("recover", false, { ...state, request: { ...state.request, id: `request-${index}` } }),
			main: { status: "drifted" as const, expected: RECORDED_MAIN, actual: CURRENT_MAIN },
		})), invalidIds: Array.from({ length: 20 }, (_, index) => `invalid-${index}`), leaseBusy: false };
	} } as never });
	const report = await harness.surface.recover("/workspace");
	assert.ok(Buffer.byteLength(report, "utf8") <= 8_192);
	assert.match(report, /report lines omitted; use subagent_status/);
	assert.match(report, /request-0: needs_attention/);
});

test("one-command recovery formats existing status, blockers, continuations and invalid IDs for Main", async () => {
	const state = structuredClone(PRIVATE_STATE);
	const harness = createHarness({
		runner: {
			async recoverRepository(root: string) {
				assert.equal(root, CANONICAL_ROOT);
				return { requests: [{ ...response("recover", true, state), main: { status: "drifted" } }],
					invalidIds: ["broken-state"], leaseBusy: false };
			},
		} as never,
	});
	const report = await harness.surface.recover("/workspace");
	assert.match(report, /request-one: needs_attention; Main drifted/);
	assert.match(report, /Blocker: unit-one:/);
	assert.match(report, /subagent_resume/);
	assert.match(report, /broken-state.*preserved|preserved.*broken-state/);
	assert.doesNotMatch(report, /SECRET_TOKEN|PRIVATE/);
});

test("public recovery evidence stays bounded and omits private durable state", async () => {
	const state = structuredClone(PRIVATE_STATE);
	const task = state.tasks[0]!;
	if (task.kind !== "changeset") throw new Error("Expected a changeset task.");
	task.attempts[0]!.preliminaryChecks!.results[0]!.stderr = `${"界".repeat(1_000)}UNEXPOSED_TAIL`;
	const harness = createHarness({
		runner: {
			async status() {
				return { text: "bounded recovery", state };
			},
		} as never,
	});
	const result = await executeTool(
		namedTool(harness, "subagent_status"),
		{ id: "request-one" },
		new AbortController().signal,
		context(CANONICAL_ROOT),
	);
	const details = result.details as {
		state: { needsAttention: { failedCheck: { stderr: string }; retainedWorktree: { cwd: string } } };
	};
	assert.ok(Buffer.byteLength(details.state.needsAttention.failedCheck.stderr, "utf8") < 600);
	assert.match(details.state.needsAttention.failedCheck.stderr, /\[truncated\]$/);
	assert.equal(details.state.needsAttention.retainedWorktree.cwd, "/tmp/pi-task");
	assert.doesNotMatch(JSON.stringify(result.details), /UNEXPOSED_TAIL|PRIVATE|prompt|rawArgs|SECRET_TOKEN|command-line/i);
	assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") < 8 * 1024);
});

test("text recovery exposes only bounded text attempt evidence", async () => {
	const taskFailure = `${"界".repeat(1_000)}UNEXPOSED_TASK_TAIL`;
	const attemptFailure = `${"界".repeat(1_000)}UNEXPOSED_ATTEMPT_TAIL`;
	const textAttempt = { number: 2, status: "failed", failure: attemptFailure };
	for (const field of [
		"allocations", "preliminaryChecks", "preliminaryReview", "cleanup", "output",
	]) {
		Object.defineProperty(textAttempt, field, {
			enumerable: true,
			get() {
				throw new Error(`Text recovery read ${field}.`);
			},
		});
	}
	const state = {
		...PRIVATE_STATE,
		request: {
			...EXECUTE_REQUEST,
			tasks: [{
				id: "text-one",
				kind: "text",
				role: "implementer",
				modelClass: "fast",
				requirements: "Provide a concise status.",
				deliverable: "A concise status.",
				dependsOn: [],
				contextFrom: [],
			}],
		},
		tasks: [{
			taskId: "text-one",
			kind: "text",
			status: "needs_attention",
			failure: taskFailure,
			attempts: [textAttempt],
		}],
	} as unknown as RunState;
	const harness = createHarness({
		runner: {
			async status() {
				return { text: "bounded text recovery", state };
			},
		} as never,
	});
	const result = await executeTool(
		namedTool(harness, "subagent_status"),
		{ id: "request-one" },
		new AbortController().signal,
		context(CANONICAL_ROOT),
	);
	const recovery = (result.details as {
		state: {
			needsAttention: {
				scope: string;
				taskId: string;
				failure: string;
				attempt: { number: number; status: string; failure: string };
			};
		};
	}).state.needsAttention;

	assert.deepEqual(Object.keys(recovery).sort(), ["attempt", "failure", "scope", "taskId"]);
	assert.equal(recovery.scope, "task");
	assert.equal(recovery.taskId, "text-one");
	assert.ok(Buffer.byteLength(recovery.failure, "utf8") < 600);
	assert.match(recovery.failure, /\[truncated\]$/);
	assert.doesNotMatch(recovery.failure, /UNEXPOSED_TASK_TAIL/);
	assert.deepEqual(Object.keys(recovery.attempt).sort(), ["failure", "number", "status"]);
	assert.equal(recovery.attempt.number, 2);
	assert.equal(recovery.attempt.status, "failed");
	assert.ok(Buffer.byteLength(recovery.attempt.failure, "utf8") < 600);
	assert.match(recovery.attempt.failure, /\[truncated\]$/);
	assert.doesNotMatch(recovery.attempt.failure, /UNEXPOSED_ATTEMPT_TAIL/);
});

test("execute keeps raw cwd while lookup actions use canonical root, bounded context, and signals", async () => {
	const harness = createHarness();
	const nestedCwd = "/canonical/repository/nested/deeper";
	const ctx = context(nestedCwd);
	const signals = Array.from({ length: 4 }, () => new AbortController().signal);
	const execute = await executeTool(namedTool(harness, "delegate_task"), EXECUTE_REQUEST, signals[0], ctx);
	assert.equal(harness.rootCalls.length, 1);
	assert.deepEqual(harness.runnerCalls[0]!.method, "execute");
	assert.deepEqual(harness.runnerCalls[0]!.args.slice(0, 2), [parseExecuteRequest(EXECUTE_REQUEST), nestedCwd]);
	assert.notEqual(harness.runnerCalls[0]!.args[2], signals[0]);

	const lookupStartedAt = Date.now();
	const status = await executeTool(namedTool(harness, "subagent_status"), { id: "request-one" }, signals[1], ctx);
	const resumeRequest = { id: "request-one", action: "finalize" as const };
	const resume = await executeTool(namedTool(harness, "subagent_resume"), resumeRequest, signals[2], ctx);
	const abort = await executeTool(namedTool(harness, "subagent_abort"), { id: "request-one" }, signals[3], ctx);
	const lookupFinishedAt = Date.now();

	assert.deepEqual(harness.rootCalls.map(({ cwd }) => cwd), [nestedCwd, nestedCwd, nestedCwd, nestedCwd]);
	for (const [index, { context: operation }] of harness.rootCalls.entries()) {
		assert.equal(operation.signal, signals[index]);
		assert.equal(operation.timeoutMs, 5_000);
		assert.ok(operation.deadline !== undefined && operation.deadline >= lookupStartedAt + (index === 0 ? -100 : 5_000));
		assert.ok(operation.deadline !== undefined && operation.deadline <= lookupFinishedAt + 5_000);
	}
	assert.deepEqual(harness.runnerCalls.filter(({ method }) => method !== "execute").map(({ method }) => method), ["status", "resume", "abort"]);
	assert.deepEqual(harness.runnerCalls.find(({ method }) => method === "resume")!.args.slice(0, 2), [resumeRequest, CANONICAL_ROOT]);
	assert.notEqual(harness.runnerCalls.find(({ method }) => method === "resume")!.args[2], signals[2]);
	assert.deepEqual(harness.runnerCalls.find(({ method }) => method === "status")!.args, ["request-one", CANONICAL_ROOT, signals[1]]);
	assert.deepEqual(harness.runnerCalls.find(({ method }) => method === "abort")!.args, ["request-one", CANONICAL_ROOT, signals[3]]);
	assert.match(execute.content[0]!.text, /durable request accepted/);
	assert.deepEqual(status, {
		content: [{ type: "text", text: "bounded status result" }],
		details: {
			state: expectedPublicState(),
			main: { status: "drifted", expected: RECORDED_MAIN, actual: CURRENT_MAIN },
		},
	});
	assert.match(resume.content[0]!.text, /durable request accepted/);
	assert.deepEqual(abort, { content: [{ type: "text", text: "bounded abort result" }], details: { state: expectedPublicState() } });
});

test("missing Role context and root preflight failures stay explicit", async () => {
	let contextGetter: (() => ExtensionContext) | undefined;
	const missing = createHarness({
		onCreate(options) {
			contextGetter = options.context;
			contextGetter();
		},
	});
	await assert.rejects(
		namedTool(missing, "delegate_task").execute(
			"tool-call",
			EXECUTE_REQUEST as never,
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		),
		/Pi Subagent cannot resolve a Role before session context exists/i,
	);
	assert.equal(contextGetter, undefined);
	assert.equal(missing.getComponentCreations(), 0);

	let statusCalls = 0;
	const failed = createHarness({
		resolveRoot: async () => {
			throw new Error("canonical root preflight failed closed");
		},
		runner: {
			async status() {
				statusCalls += 1;
				return response("status");
			},
		} as never,
	});
	await assert.rejects(
		executeTool(namedTool(failed, "subagent_status"), { id: "request-one" }, new AbortController().signal, context("/nested")),
		/canonical root preflight failed closed/i,
	);
	assert.equal(statusCalls, 0);
});

test("manifest entrypoint and Main-side Skill ship with the unified tools", async () => {
	const manifest = JSON.parse(await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
		files?: string[];
		pi?: { extensions?: string[]; skills?: string[] };
	};
	assert.equal(manifest.dependencies?.["@henryqw/pi-subagent"], undefined);
	assert.equal(manifest.dependencies?.["@henryqw/pi-herdr"], "^0.4.7");
	assert.deepEqual(manifest.pi?.extensions, ["./extensions/subagent.ts"]);
	assert.deepEqual(manifest.pi?.skills, ["./skills"]);
	for (const path of ["README.md", "CONTEXT.md", "skills"]) assert.ok(manifest.files?.includes(path));
	const skill = await readFile(resolve(PACKAGE_ROOT, "skills/pi-subagent/SKILL.md"), "utf8");
	for (const contract of [
		/^name: pi-subagent$/m,
		/`mode: direct`.*read-only.*research/is,
		/`mode: isolated`.*checked changes/is,
		/focused task checks.*`pnpm test`.*combined tip.*Main promotion/is,
		/`subagent_status`.*`subagent_resume`.*`subagent_abort`/is,
	]) assert.match(skill, contract);
	assert.doesNotMatch(skill, /delegate_flow|auto_dag|orchestrate_/i);

	const originalArgv = process.argv;
	let childSideEffects = 0;
	try {
		process.argv = [...originalArgv, `--${ROLE_TOOL_POLICY_FLAG}`, "[]"];
		const entrypoint = resolve(PACKAGE_ROOT, manifest.pi.extensions[0]!);
		const loaded = await import(pathToFileURL(entrypoint).href) as { default(pi: ExtensionAPI): void };
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

test("root active delegation sources smoke-load only the unified delegation tools", async () => {
	const repositoryRoot = resolve(PACKAGE_ROOT, "../..");
	const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};
	const active = rootManifest.pi?.extensions ?? [];
	assert.equal(active.filter((source) => source.includes("pi-subagent")).length, 1);
	assert.ok(active.includes("./extensions/pi-subagent/extensions/subagent.ts"));
	assert.ok(active.every((source) => !source.includes("pi-auto-dag")));

	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-smoke-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousActivePi = process.env.PI_CODING_AGENT;
	const previousTitle = process.title;
	const toolNames: string[] = [];
	const pi = {
		events: {
			on() { return () => {}; },
			emit() {},
		},
		registerMessageRenderer() {},
		on() {},
		registerTool(tool: { name: string }) { toolNames.push(tool.name); },
		registerCommand() {},
	} as unknown as ExtensionAPI;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_CODING_AGENT = "true";
		process.title = "pi";
		for (const source of active.filter((entry) => /pi-subagent\//.test(entry))) {
			const loaded = await import(pathToFileURL(resolve(repositoryRoot, source)).href) as { default(pi: ExtensionAPI): void };
			loaded.default(pi);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousActivePi === undefined) delete process.env.PI_CODING_AGENT;
		else process.env.PI_CODING_AGENT = previousActivePi;
		process.title = previousTitle;
		await rm(agentDir, { recursive: true, force: true });
	}

	assert.deepEqual([...toolNames].sort(), [
		"delegate_task",
		"subagent_abort",
		"subagent_integrate",
		"subagent_resume",
		"subagent_stage",
		"subagent_status",
	]);
	assert.ok(toolNames.every((name) => !name.startsWith("delegate_flow") && !name.startsWith("auto_dag_")));
});

test("subagent_stage routes one strict exact-identity Main action to the canonical repository", async () => {
	const harness = createHarness();
	const signal = new AbortController().signal;
	const action = {
		id: "request-one", action: "stage" as const, generation: 1,
		taskId: "unit-one", attempt: 1, candidate: CURRENT_MAIN, expectedTip: RECORDED_MAIN,
	};
	const stage = namedTool(harness, "subagent_stage");
	assert.deepEqual(stage.prepareArguments(action), action);
	assert.throws(() => stage.prepareArguments({ ...action, extra: true }), /exact candidate and generation/);
	const result = await executeTool(stage, action, signal, context("/canonical/repository/nested"));
	assert.deepEqual(harness.runnerCalls, [{ method: "stage", args: [action, CANONICAL_ROOT, signal] }]);
	assert.match(result.content[0]!.text, /bounded stage result/);
});

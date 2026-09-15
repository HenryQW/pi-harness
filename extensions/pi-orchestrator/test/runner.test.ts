import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EphemeralSubagentExecutor } from "@henryqw/pi-subagent";
import {
	OrchestratorRunner,
	withTransientLaunch,
	type CheckRunResult,
	type GitRuntime,
	type HostAllocationResult,
	type IntegrationResult,
	type OperationContext,
	type OrchestratorRuntime,
	type RebaseResult,
	type TaskCandidateInspector,
	type TransientLaunchHandle,
	type VerifiedLaunch,
	type WorkerResult,
	type WorktreeAllocationResult,
} from "../src/runner.ts";
import {
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	parseExecuteRequest,
	parseRunState,
	type ChangesetTaskRequest,
	type ExecuteRequest,
	type HostAllocationPlan,
	type ModelClass,
	type RunState,
	type TaskRequest,
	type WorkspaceIdentity,
} from "../src/schema.ts";
import { FileRunStore, type RunStateHandle } from "../src/store.ts";

const oid = (character: string): string => character.repeat(40);

function identity(character: string, branch = "refs/heads/main"): WorkspaceIdentity {
	const value = oid(character);
	return { branch, head: value, index: value, tree: value };
}

type RoleCall = { role: string; modelClass: ModelClass };

type WorkerCall = { taskId: string; kind: "initial" | "correction" };

class FakeRuntime {
	clock = 1_000;
	main = identity("a");
	workerBarrierSize = 0;
	maxConcurrentWorkers = 0;
	failFinalChecks = 0;
	failPreliminaryChecks = 0;
	readonly acquisitions: RoleCall[] = [];
	readonly launchCleanups: RoleCall[] = [];
	readonly workerCalls: WorkerCall[] = [];
	readonly workerAllocationCalls: string[] = [];
	readonly changesetCallOrder: string[] = [];
	readonly workerFailures: Error[] = [];
	readonly terminationCalls: Array<{ workerId: string; candidate: WorkspaceIdentity }> = [];
	readonly integrations: string[] = [];
	readonly reviewCalls: Array<RoleCall & { scope: "task" | "final"; taskId?: string; criterion: string }> = [];
	readonly inspectMainFailures: Error[] = [];
	readonly reviewVerdicts: string[] = [];
	private readonly workerBarrierResolvers: Array<() => void> = [];
	private activeWorkers = 0;
	private candidateNumber = 0;

	now(): number {
		return this.clock;
	}

	randomToken(): string {
		return `token-${String(this.candidateNumber + 1).padStart(16, "0")}`;
	}

	async preflight(input: Parameters<OrchestratorRuntime["preflight"]>[0], _context: OperationContext) {
		return { root: input.cwd, main: { ...this.main } };
	}

	async acquireLaunch(
		role: string,
		modelClass: ModelClass,
		_context: OperationContext,
	): Promise<TransientLaunchHandle<VerifiedLaunch>> {
		const call = { role, modelClass };
		this.acquisitions.push(call);
		return {
			launch: {
				role,
				modelClass,
				model: `${modelClass}-model`,
				thinkingLevel: "low",
				args: ["--model", `${modelClass}-model`],
				env: {},
				tools: [],
			},
			cleanup: async () => { this.launchCleanups.push(call); },
		};
	}

	async inspectMain(_input: Parameters<GitRuntime["inspectMain"]>[0], _context: OperationContext): Promise<WorkspaceIdentity> {
		const failure = this.inspectMainFailures.shift();
		if (failure) throw failure;
		return { ...this.main };
	}

	async inspectTaskCandidate(
		input: Parameters<TaskCandidateInspector["inspectTaskCandidate"]>[0],
		_context: OperationContext,
	): Promise<WorkspaceIdentity> {
		const worktree = input.attempt.allocations.find((allocation) => allocation.kind === "worktree");
		if (!worktree || worktree.kind !== "worktree" || !worktree.worktree) throw new Error("missing worktree");
		return input.attempt.candidate
			? { ...input.attempt.candidate }
			: { ...input.attempt.waveBase, branch: `refs/heads/${worktree.worktree.branch}` };
	}

	async planHostAllocation(
		input: Parameters<OrchestratorRuntime["planHostAllocation"]>[0],
		_context: OperationContext,
	): Promise<HostAllocationPlan> {
		const worktree = input.attempt.allocations.find((allocation) => allocation.kind === "worktree");
		if (!worktree || worktree.kind !== "worktree" || !worktree.worktree) throw new Error("missing worktree");
		if (input.kind === "workspace") {
			return {
				kind: "workspace",
				label: `${input.task.id}-workspace`,
				worktreeCwd: worktree.worktree.cwd,
				mainRoot: worktree.worktree.repoRoot,
				repoKey: worktree.worktree.repoRoot,
				herdrRepoRoot: worktree.worktree.repoRoot,
			};
		}
		const workspace = input.attempt.allocations.find((allocation) => allocation.kind === "workspace");
		if (!workspace || workspace.kind !== "workspace" || !workspace.workspaceId || !workspace.rootTabId || !workspace.rootPaneId) {
			throw new Error("missing workspace");
		}
		if (input.kind === "worker_tab") {
			return {
				kind: "worker_tab",
				label: `${input.task.id}-worker`,
				workspaceId: workspace.workspaceId,
				workspaceRootTabId: workspace.rootTabId,
				workspaceRootPaneId: workspace.rootPaneId,
				worktreeCwd: worktree.worktree.cwd,
				leasePath: `/leases/${input.task.id}`,
			};
		}
		const workerTab = input.attempt.allocations.find((allocation) => allocation.kind === "worker_tab");
		if (!workerTab || workerTab.kind !== "worker_tab" || !workerTab.tabId || !workerTab.paneId) {
			throw new Error("missing worker tab");
		}
		return {
			kind: "agent",
			agentName: `${input.task.id}-agent`,
			workspaceId: workspace.workspaceId,
			tabId: workerTab.tabId,
			paneId: workerTab.paneId,
			worktreeCwd: worktree.worktree.cwd,
			leasePath: workerTab.leasePath,
		};
	}

	async allocateWorktree(
		input: Parameters<GitRuntime["allocateWorktree"]>[0],
		_context: OperationContext,
	): Promise<WorktreeAllocationResult> {
		await input.onPrepared({
			path: `/worktrees/${input.task.id}`,
			cwd: `/worktrees/${input.task.id}`,
			branch: input.task.id,
			repoRoot: input.root,
			baseCommit: input.attempt.waveBase.head,
		});
		return { kind: "worktree", outcome: "owned" };
	}

	async allocateHost(
		input: Parameters<OrchestratorRuntime["allocateHost"]>[0],
		_context: OperationContext,
	): Promise<HostAllocationResult> {
		if (input.intent.kind === "workspace") {
			return {
				kind: "workspace",
				outcome: "owned",
				workspaceId: `${input.task.id}-workspace-id`,
				rootTabId: `${input.task.id}-root-tab`,
				rootPaneId: `${input.task.id}-root-pane`,
			};
		}
		if (input.intent.kind === "worker_tab") {
			return {
				kind: "worker_tab",
				outcome: "owned",
				tabId: `${input.task.id}-worker-tab`,
				paneId: `${input.task.id}-worker-pane`,
			};
		}
		if (!input.acquireLaunch) throw new Error("agent launch callback is required");
		this.workerAllocationCalls.push(input.intent.agentName);
		this.changesetCallOrder.push(`allocate:${input.intent.agentName}`);
		const handle = await input.acquireLaunch();
		return await withTransientLaunch(handle, async () => ({ kind: "agent" as const, outcome: "owned" as const }));
	}


	async runWorker(
		input: Parameters<OrchestratorRuntime["runWorker"]>[0],
		_context: OperationContext,
	): Promise<WorkerResult> {
		this.workerCalls.push({ taskId: input.task.id, kind: input.kind });
		this.changesetCallOrder.push(`worker:${input.kind}:${input.workerId}`);
		this.activeWorkers += 1;
		this.maxConcurrentWorkers = Math.max(this.maxConcurrentWorkers, this.activeWorkers);
		try {
			await this.waitForWorkerBarrier();
			const failure = this.workerFailures.shift();
			if (failure) throw failure;
			return {
				outcome: "candidate",
				candidate: identity("bcdef123456789"[this.candidateNumber++ % 15]!, `refs/heads/${input.task.id}`),
			};
		} finally {
			this.activeWorkers -= 1;
		}
	}

	async terminateWorker(
		input: Parameters<OrchestratorRuntime["terminateWorker"]>[0],
		_context: OperationContext,
	): Promise<{ outcome: "terminated" }> {
		this.terminationCalls.push({
			workerId: input.workerId,
			candidate: structuredClone(input.candidate),
		});
		this.changesetCallOrder.push(`terminate:${input.workerId}`);
		return { outcome: "terminated" };
	}

	async runChecks(input: Parameters<GitRuntime["runChecks"]>[0], _context: OperationContext): Promise<CheckRunResult> {
		if (input.scope === "final" && this.failFinalChecks > 0) {
			this.failFinalChecks -= 1;
			throw new Error("final check transport interrupted");
		}
		const preliminary = input.scope === "task" && !input.attempt?.termination;
		const failed = preliminary && this.failPreliminaryChecks > 0;
		if (failed) this.failPreliminaryChecks -= 1;
		if (input.scope === "task") {
			this.changesetCallOrder.push(`check:${preliminary ? "preliminary" : "authoritative"}:${failed ? "fail" : "pass"}`);
		}
		return {
			results: input.checks.map((check) => ({ ...check, code: failed ? 1 : 0, killed: false, stdout: "", stderr: "" })),
			identityAfter: { ...input.candidate },
		};
	}

	async review(input: Parameters<GitRuntime["review"]>[0], _context: OperationContext) {
		const handle = await input.acquireLaunch();
		return await withTransientLaunch(handle, async (launch) => {
			if (input.scope === "task") this.changesetCallOrder.push(`review:${input.phase}:${input.taskId}`);
			this.reviewCalls.push({
				role: launch.role,
				modelClass: launch.modelClass,
				scope: input.scope,
				...(input.taskId ? { taskId: input.taskId } : {}),
				criterion: input.criterion,
			});
			return {
				verdict: this.reviewVerdicts.shift() ?? "PASS",
				identityAfter: { ...input.tip },
			};
		});
	}

	async inspectRetainedTask(
		input: Parameters<GitRuntime["inspectRetainedTask"]>[0],
		_context: OperationContext,
	): Promise<WorkspaceIdentity> {
		if (!input.attempt.candidate) throw new Error("missing retained candidate");
		return { ...input.attempt.candidate };
	}

	async rebase(input: Parameters<GitRuntime["rebase"]>[0], _context: OperationContext): Promise<RebaseResult> {
		return { outcome: "ready", base: { ...input.onto }, candidate: { ...input.candidate } };
	}

	async integrate(input: Parameters<GitRuntime["integrate"]>[0], _context: OperationContext): Promise<IntegrationResult> {
		this.integrations.push(input.task.id);
		this.main = identity(input.candidate.head[0]!, input.expectedMain.branch);
		return { outcome: "integrated", main: { ...this.main } };
	}

	async cleanupHost(_input: Parameters<OrchestratorRuntime["cleanupHost"]>[0], _context: OperationContext) {
		return { outcome: "completed" as const };
	}

	async cleanupGit(_input: Parameters<GitRuntime["cleanupGit"]>[0], _context: OperationContext) {
		return { outcome: "completed" as const };
	}

	private async waitForWorkerBarrier(): Promise<void> {
		if (!this.workerBarrierSize || this.workerCalls.length > this.workerBarrierSize) return;
		await new Promise<void>((resolve) => {
			this.workerBarrierResolvers.push(resolve);
			if (this.workerBarrierResolvers.length === this.workerBarrierSize) {
				for (const release of this.workerBarrierResolvers.splice(0)) release();
			}
		});
	}
}

class RecordingStore extends FileRunStore {
	readonly snapshots: RunState[] = [];

	override async create(state: RunState): Promise<RunStateHandle> {
		return this.record(await super.create(state));
	}

	override async load(root: string, id: string): Promise<RunStateHandle> {
		return this.record(await super.load(root, id));
	}

	private record(handle: RunStateHandle): RunStateHandle {
		const save = handle.save.bind(handle);
		handle.save = async () => {
			const snapshot = structuredClone(handle.state);
			await save();
			this.snapshots.push(snapshot);
		};
		return handle;
	}
}

function changesetTask(
	id: string,
	options: {
		role?: string;
		modelClass?: ModelClass;
		dependsOn?: string[];
		judgment?: ChangesetTaskRequest["judgment"];
	} = {},
): ChangesetTaskRequest {
	return {
		id,
		kind: "changeset",
		role: options.role ?? "implementer",
		modelClass: options.modelClass ?? "fast",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: options.dependsOn ?? [],
		contextFrom: [],
		checks: [{ command: `check-${id}`, args: [] }],
		...(options.judgment ? { judgment: options.judgment } : {}),
	};
}

function textTask(id: string, role = "researcher"): TaskRequest {
	return {
		id,
		kind: "text",
		role,
		modelClass: "fast",
		requirements: `Research ${id}.`,
		deliverable: `Return ${id}.`,
		dependsOn: [],
		contextFrom: [],
	};
}

function request(
	id: string,
	tasks: TaskRequest[],
	finalJudgment?: ExecuteRequest["finalJudgment"],
): ExecuteRequest {
	return parseExecuteRequest({
		id,
		goal: "Deliver checked work.",
		budgetMs: 10_000,
		tasks,
		finalChecks: [{ command: "check-final", args: [] }],
		...(finalJudgment ? { finalJudgment } : {}),
	});
}

const unusedTextExecutor: EphemeralSubagentExecutor = {
	run: async () => { throw new Error("Unexpected text executor invocation."); },
};

async function harness(
	t: test.TestContext,
	options: {
		executor?: EphemeralSubagentExecutor;
		createStore?: (agentDir: string) => FileRunStore;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-runner-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	await mkdir(root);
	const runtime = new FakeRuntime();
	const store = options.createStore?.(join(directory, "agent")) ?? new FileRunStore(join(directory, "agent"));
	return {
		root,
		runtime,
		store,
		runner: new OrchestratorRunner(
			runtime as unknown as OrchestratorRuntime,
			runtime as unknown as GitRuntime & TaskCandidateInspector,
			store,
			options.executor ?? unusedTextExecutor,
		),
	};
}

function changesetState(state: RunState, id: string) {
	const task = state.tasks.find((candidate) => candidate.taskId === id);
	if (task?.kind !== "changeset") throw new Error(`Expected changeset task ${id}.`);
	return task;
}

function textState(state: RunState, id: string) {
	const task = state.tasks.find((candidate) => candidate.taskId === id);
	if (task?.kind !== "text") throw new Error(`Expected text task ${id}.`);
	return task;
}

function assertParsed(state: RunState): void {
	assert.doesNotThrow(() => parseRunState(structuredClone(state)));
}

function sortedCalls(calls: readonly RoleCall[]): RoleCall[] {
	return [...calls].sort((left, right) => `${left.role}/${left.modelClass}`.localeCompare(`${right.role}/${right.modelClass}`));
}

test("ready changeset waves run concurrently, integrate in request order, and retain exact PASS evidence", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerBarrierSize = 2;
	const definition = request("parallel-changes", [
		changesetTask("first", {
			role: "author/one",
			judgment: { role: "judge/first", modelClass: "balanced", criterion: "First change is correct." },
		}),
		changesetTask("second", {
			role: "author/two",
			modelClass: "frontier",
			judgment: { role: "judge/second", modelClass: "fav", criterion: "Second change is correct." },
		}),
		changesetTask("after", { role: "author/after", dependsOn: ["first", "second"] }),
	], { role: "judge/final", modelClass: "balanced", criterion: "The request is correct." });

	const result = await runner.execute(definition, root);
	const first = changesetState(result.state, "first").attempts[0]!;

	assert.equal(result.state.accepted, true);
	assert.deepEqual(result.state.waves.map(({ taskIds }) => taskIds), [["first", "second"], ["after"]]);
	assert.equal(runtime.maxConcurrentWorkers, 2);
	assert.deepEqual(runtime.integrations, ["first", "second", "after"]);
	assert.deepEqual(first.authoritativeChecks?.results, [{
		command: "check-first", args: [], code: 0, killed: false, stdout: "", stderr: "",
	}]);
	assert.equal(first.authoritativeReview?.verdict, "PASS");
	assert.equal(first.authoritativeReview?.passed, true);
	assert.equal(result.state.final.checks?.passed, true);
	assert.equal(result.state.final.review?.verdict, "PASS");
	assert.equal(result.state.final.review?.passed, true);
	assert.deepEqual(sortedCalls(runtime.acquisitions), sortedCalls([
		{ role: "author/one", modelClass: "fast" },
		{ role: "author/two", modelClass: "frontier" },
		{ role: "author/after", modelClass: "fast" },
		{ role: "judge/first", modelClass: "balanced" },
		{ role: "judge/second", modelClass: "fav" },
		{ role: "judge/final", modelClass: "balanced" },
	]));
	assert.deepEqual(sortedCalls(runtime.launchCleanups), sortedCalls(runtime.acquisitions));
	assertParsed(result.state);
});

test("a failed preliminary changeset check gets one same-worker correction before authoritative review", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.failPreliminaryChecks = 1;
	const definition = request("preliminary-correction", [changesetTask("change", {
		judgment: { role: "judge/correction", modelClass: "balanced", criterion: "The corrected change is correct." },
	})]);

	const result = await runner.execute(definition, root);
	const attempt = changesetState(result.state, "change").attempts[0]!;
	const agent = attempt.allocations.find((allocation) => allocation.kind === "agent");
	if (!agent?.agentName) throw new Error("Expected one allocated worker.");

	assert.equal(result.state.version, 2);
	assert.equal(result.state.accepted, true);
	assert.deepEqual(runtime.workerCalls, [
		{ taskId: "change", kind: "initial" },
		{ taskId: "change", kind: "correction" },
	]);
	assert.deepEqual(runtime.workerAllocationCalls, [agent.agentName]);
	assert.deepEqual(runtime.changesetCallOrder, [
		`allocate:${agent.agentName}`,
		`worker:initial:${agent.agentName}`,
		"check:preliminary:fail",
		`worker:correction:${agent.agentName}`,
		"check:preliminary:pass",
		`terminate:${agent.agentName}`,
		"check:authoritative:pass",
		"review:authoritative:change",
	]);
	assert.equal(attempt.preliminaryChecks?.passed, true);
	assert.equal(attempt.authoritativeChecks?.passed, true);
	assert.equal(attempt.authoritativeReview?.passed, true);
	assertParsed(result.state);
});

test("changeset dispatch failure terminates the exact allocated worker", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerFailures.push(new Error("worker transport failed"));
	const definition = request("dispatch-failure", [changesetTask("change")]);

	const stopped = await runner.execute(definition, root);
	const attempt = changesetState(stopped.state, "change").attempts[0]!;
	const agent = attempt.allocations.find((allocation) => allocation.kind === "agent");
	const preCandidate = attempt.prompts[0]?.preCandidate;
	if (!agent?.agentName || !preCandidate) throw new Error("Expected an allocated worker with a submitted prompt.");

	assert.equal(stopped.state.status, "needs_attention");
	assert.equal(attempt.prompts[0]?.status, "ambiguous");
	assert.equal(attempt.termination?.status, "terminated");
	assert.deepEqual(runtime.terminationCalls, [{ workerId: agent.agentName, candidate: preCandidate }]);
	assertParsed(stopped.state);
});

test("abort terminates only the exact active worker without replay", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	const definition = request("abort-active", [changesetTask("active"), changesetTask("settled")]);
	runtime.workerFailures.push(new Error("active worker transport failed"));
	const stopped = await runner.execute(definition, root);
	const activeTaskId = stopped.state.tasks.find((task) => task.kind === "changeset"
		&& task.attempts[0]?.prompts[0]?.status === "ambiguous")?.taskId;
	const settledTaskId = stopped.state.tasks.find((task) => task.taskId !== activeTaskId)?.taskId;
	if (!activeTaskId || !settledTaskId) throw new Error("Expected one active and one settled worker fixture.");

	const handle = await store.load(root, definition.id);
	const activeAttempt = changesetState(handle.state, activeTaskId).attempts[0]!;
	const activeAgent = activeAttempt.allocations.find((allocation) => allocation.kind === "agent");
	const activeCandidate = activeAttempt.prompts[0]?.preCandidate;
	if (!activeAgent?.agentName || !activeCandidate) throw new Error("Expected an exact active worker fixture.");
	delete activeAttempt.termination;
	await handle.save();
	assertParsed(handle.state);

	runtime.terminationCalls.length = 0;
	const workerCallsBeforeAbort = structuredClone(runtime.workerCalls);
	const aborted = await runner.abort(definition.id, root);
	const abortedActive = changesetState(aborted.state, activeTaskId).attempts[0]!;
	const abortedSettled = changesetState(aborted.state, settledTaskId).attempts[0]!;

	assert.equal(aborted.state.status, "aborted");
	assert.deepEqual(runtime.terminationCalls, [{ workerId: activeAgent.agentName, candidate: activeCandidate }]);
	assert.deepEqual(runtime.workerCalls, workerCallsBeforeAbort);
	assert.equal(abortedActive.termination?.status, "terminated");
	assert.equal(abortedSettled.termination?.status, "terminated");
	assertParsed(aborted.state);
});

test("failures enter needs_attention; retry, verify, and finalize require explicit actions", async (t) => {
	await t.test("retry", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const definition = request("retry-change", [changesetTask("change")]);
		runtime.inspectMainFailures.push(new Error("Main inspection unavailable"));

		const stopped = await runner.execute(definition, root);
		assert.equal(stopped.state.status, "needs_attention");
		assert.equal(changesetState(stopped.state, "change").attempts.length, 0);
		assert.equal(runtime.workerCalls.length, 0);
		assert.deepEqual(stopped.continuation, { id: definition.id, action: "retry", taskId: "change" });

		const resumed = await runner.resume({ id: definition.id, action: "retry", taskId: "change" }, root);
		assert.equal(resumed.state.accepted, true);
		assert.deepEqual(runtime.workerCalls, [{ taskId: "change", kind: "initial" }]);
		assertParsed(resumed.state);
	});

	await t.test("verify", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const definition = request("verify-change", [changesetTask("change", {
			judgment: { role: "judge/manual", modelClass: "frontier", criterion: "The retained change is correct." },
		})]);
		runtime.reviewVerdicts.push("NEEDS_WORK", "PASS");

		const stopped = await runner.execute(definition, root);
		assert.equal(stopped.state.status, "needs_attention");
		assert.deepEqual(stopped.continuation, { id: definition.id, action: "verify", taskId: "change" });
		await assert.rejects(
			runner.resume({ id: definition.id, action: "retry", taskId: "change" }, root),
			/correction is unavailable/,
		);

		const verified = await runner.resume({ id: definition.id, action: "verify", taskId: "change" }, root);
		assert.equal(verified.state.accepted, true);
		assert.deepEqual(runtime.workerCalls, [{ taskId: "change", kind: "initial" }]);
		assert.deepEqual(runtime.reviewCalls.map(({ scope, taskId }) => ({ scope, taskId })), [
			{ scope: "task", taskId: "change" },
			{ scope: "task", taskId: "change" },
		]);
		assertParsed(verified.state);
	});

	await t.test("finalize", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const definition = request("finalize-change", [changesetTask("change")]);
		runtime.failFinalChecks = 1;

		const stopped = await runner.execute(definition, root);
		assert.equal(stopped.state.status, "needs_attention");
		assert.equal(stopped.state.final.status, "interrupted");
		assert.deepEqual(stopped.continuation, { id: definition.id, action: "finalize" });

		const finalized = await runner.resume({ id: definition.id, action: "finalize" }, root);
		assert.equal(finalized.state.accepted, true);
		assertParsed(finalized.state);
	});
});

test("text dispatch uses the injected executor and persists a valid running intent and atomic completion", async (t) => {
	let store: RecordingStore | undefined;
	let persistedAtLaunch: RunState | undefined;
	let preparedTask: string | undefined;
	const executor: EphemeralSubagentExecutor = {
		run: async ({ prepare }) => {
			const prepared = await prepare();
			preparedTask = prepared.task;
			persistedAtLaunch = (await store!.load(prepared.cwd, "text-success")).state;
			return {
				outcome: "success",
				exitCode: 0,
				output: "  concise text result.  ",
				outputTruncated: false,
				stderr: "",
			};
		},
	};
	const { root, runtime, runner } = await harness(t, {
		executor,
		createStore: (agentDir) => (store = new RecordingStore(agentDir)),
	});
	const definition = request("text-success", [textTask("research", "researcher/brief")]);

	const result = await runner.execute(definition, root);
	const task = textState(result.state, "research");
	if (!persistedAtLaunch) throw new Error("Expected persisted state before text executor launch.");
	const running = textState(persistedAtLaunch, "research");
	assert.match(preparedTask ?? "", /^Task: research$/m);
	assert.equal(persistedAtLaunch.status, "running");
	assert.equal(running.status, "running");
	assert.deepEqual(running.attempts, [{ number: 1, status: "running" }]);
	assert.equal(result.state.accepted, true);
	assert.equal(task.attempts[0]?.number, 1);
	assert.equal(task.attempts[0]?.status, "completed");
	assert.deepEqual(task.attempts[0]?.output, { text: "concise text result." });
	assert.deepEqual(runtime.launchCleanups, [{ role: "researcher/brief", modelClass: "fast" }]);
	const outputSnapshots = store!.snapshots.filter((snapshot) => Boolean(textState(snapshot, "research").attempts.at(-1)?.output));
	assert.ok(outputSnapshots.length > 0);
	assert.ok(outputSnapshots.every((snapshot) => {
		const saved = textState(snapshot, "research");
		return saved.status === "completed"
			&& saved.attempts.at(-1)?.status === "completed"
			&& saved.attempts.at(-1)?.output?.text === "concise text result.";
	}));
	for (const snapshot of store!.snapshots) assertParsed(snapshot);
	assertParsed(result.state);
});

test("text dispatch rejects empty, truncated, oversized, and Main-drifted output", async (t) => {
	const cases = [
		{ name: "empty", output: "   ", truncated: false },
		{ name: "truncated", output: "result", truncated: true },
		{ name: "oversized", output: "x".repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES + 1), truncated: false },
		{ name: "Main drift", output: "result", truncated: false, drift: true },
	];
	for (const plan of cases) {
		await t.test(plan.name, async (t) => {
			let runtime: FakeRuntime | undefined;
			const executor: EphemeralSubagentExecutor = {
				run: async () => {
					if (plan.drift) runtime!.main = identity("f");
					return {
						outcome: "success",
						exitCode: 0,
						output: plan.output,
						outputTruncated: plan.truncated,
						stderr: "",
					};
				},
			};
			const created = await harness(t, { executor });
			runtime = created.runtime;
			const definition = request(`text-${plan.name.toLowerCase().replace(" ", "-")}`, [textTask("research")]);

			const stopped = await created.runner.execute(definition, created.root);
			const task = textState(stopped.state, "research");
			assert.equal(stopped.state.status, "needs_attention");
			assert.equal(task.status, "needs_attention");
			assert.equal(task.attempts.at(-1)?.status, "failed");
			assert.ok(task.failure);
			assertParsed(stopped.state);
		});
	}
});

test("an interrupted text task remains failed until its explicit retry", async (t) => {
	let calls = 0;
	const executor: EphemeralSubagentExecutor = {
		run: async () => {
			calls += 1;
			if (calls === 1) throw new Error("executor interrupted");
			return {
				outcome: "success",
				exitCode: 0,
				output: "Retry result.",
				outputTruncated: false,
				stderr: "",
			};
		},
	};
	const { root, runtime, runner } = await harness(t, { executor });
	const definition = request("text-retry", [textTask("research")]);

	const stopped = await runner.execute(definition, root);
	const failed = textState(stopped.state, "research");
	assert.equal(stopped.state.status, "needs_attention");
	assert.equal(stopped.continuation, undefined);
	assert.deepEqual(failed.attempts, [{
		number: 1,
		status: "failed",
		failure: "Task dispatch was interrupted: executor interrupted",
	}]);
	assert.equal(calls, 1);

	const retried = await runner.resume({ id: definition.id, action: "retry", taskId: "research" }, root);
	const completed = textState(retried.state, "research");
	assert.equal(retried.state.accepted, true);
	assert.equal(calls, 2);
	assert.deepEqual(completed.attempts.map(({ number, status }) => ({ number, status })), [
		{ number: 1, status: "failed" },
		{ number: 2, status: "completed" },
	]);
	assert.deepEqual(runtime.launchCleanups, [
		{ role: "researcher", modelClass: "fast" },
		{ role: "researcher", modelClass: "fast" },
	]);
	assertParsed(retried.state);
});

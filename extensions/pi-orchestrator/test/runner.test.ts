import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	OrchestratorRunner,
	type AllocationReconciliation,
	type AllocationResult,
	type CheckRunResult,
	type CleanupRuntime,
	type CommandResult,
	type IntegrationResult,
	type OperationContext,
	type OrchestratorRuntime,
	type RebaseResult,
	type ReviewResult,
	type WorkerResult,
} from "../src/runner.ts";
import {
	parseRunState,
	requiredLaunchKeys,
	type AllocationKind,
	type CheckCommand,
	type CleanupKind,
	type ExecuteRequest,
	type LaunchRecord,
	type ModelClass,
	type TaskAttempt,
	type TaskRequest,
	type WorkspaceIdentity,
} from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

const oid = (character: string) => character.repeat(40);
const MAIN_A = identity("a");

function identity(character: string, branch = "refs/heads/main"): WorkspaceIdentity {
	const value = oid(character);
	return { branch, head: value, index: value, tree: value };
}

function task(
	id: string,
	dependsOn: string[] = [],
	modelClass: ModelClass = "fast",
	judgment?: { criterion: string; modelClass: ModelClass },
): TaskRequest {
	return {
		id,
		modelClass,
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn,
		checks: [{ command: `check-${id}`, args: [] }],
		...(judgment ? { judgment } : {}),
	};
}

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
	return {
		id: "request-one",
		goal: "Deliver checked work.",
		budgetMs: 10_000,
		tasks: [task("task-a")],
		finalChecks: [{ command: "check-final", args: [] }],
		...overrides,
	};
}

type WorkerPlan = {
	outcome?: WorkerResult["outcome"];
	candidate?: WorkspaceIdentity;
	diagnostic?: string;
	error?: Error;
	expire?: boolean;
};
type CheckPlan = {
	code?: number;
	identityAfter?: WorkspaceIdentity;
	error?: Error;
	expire?: boolean;
	mutateMain?: WorkspaceIdentity;
};
type ReviewPlan = { verdict?: string; identityAfter?: WorkspaceIdentity; error?: Error; expire?: boolean };
type CleanupPlan = { outcome?: "completed" | "absent" | "blocked"; failure?: string; error?: Error; expire?: boolean };
type InspectionPlan = { identity?: WorkspaceIdentity; error?: Error };

class FakeRuntime implements OrchestratorRuntime, CleanupRuntime {
	clock = 1_000;
	main = { ...MAIN_A };
	preflightCalls = 0;
	recoverCalls: Record<string, LaunchRecord>[] = [];
	allocationCalls: AllocationKind[] = [];
	reconciliationCalls: AllocationKind[] = [];
	workerCalls: { taskId: string; workerId: string; kind: "initial" | "correction"; launchKey: string }[] = [];
	checkCalls: { scope: "task" | "final"; taskId?: string }[] = [];
	reviewCalls: { scope: "task" | "final"; taskId?: string; launchKey: string }[] = [];
	terminationCalls: string[] = [];
	rebaseCalls: { taskId: string; onto: WorkspaceIdentity }[] = [];
	integrationCalls: string[] = [];
	cleanupCalls: CleanupKind[] = [];
	contexts: { hook: string; context: OperationContext }[] = [];
	workerPlans: WorkerPlan[] = [];
	checkPlans: CheckPlan[] = [];
	reviewPlans: ReviewPlan[] = [];
	cleanupPlans: CleanupPlan[] = [];
	inspectionPlans: InspectionPlan[] = [];
	retainedCandidate?: WorkspaceIdentity;
	allocationFailure?: { kind: AllocationKind; error?: Error; result?: AllocationResult };
	reconciliation: AllocationReconciliation = { outcome: "absent" };
	preflightAction?: () => Promise<void>;
	workerBarrierSize = 0;
	expireHook?: string;
	private barrierResolvers: (() => void)[] = [];
	private token = 0;
	private candidate = 0;

	now(): number { return this.clock; }
	randomToken(): string { return `token-${String(++this.token).padStart(16, "0")}`; }

	private observe(hook: string, context: OperationContext, expire = false): void {
		this.contexts.push({ hook, context });
		if (expire || this.expireHook === hook) this.clock = context.deadline;
	}

	private nextOidCharacter(): string {
		return "bcdef1234567890"[this.candidate++ % 15]!;
	}

	private launchRecords(input: ExecuteRequest): LaunchRecord[] {
		return [...requiredLaunchKeys(input).entries()].map(([key, route], index) => ({
			key,
			...route,
			fingerprint: String((index % 9) + 1).repeat(64),
		}));
	}

	async preflight(input: { request: ExecuteRequest }, context: OperationContext) {
		this.preflightCalls += 1;
		this.observe("preflight", context);
		await this.preflightAction?.();
		return { main: { ...this.main }, launchRecords: this.launchRecords(input.request) };
	}

	async recoverLaunchRecords(
		input: { request: ExecuteRequest; records: Record<string, LaunchRecord> },
		context: OperationContext,
	): Promise<LaunchRecord[]> {
		this.observe("recover-launches", context);
		this.recoverCalls.push(structuredClone(input.records));
		return Object.values(input.records).map((record) => ({ ...record }));
	}

	async inspectMain(_input: { root: string }, context: OperationContext): Promise<WorkspaceIdentity> {
		this.observe("inspect-main", context);
		const plan = this.inspectionPlans.shift();
		if (plan?.error) throw plan.error;
		return { ...(plan?.identity ?? this.main) };
	}

	async planAllocation(
		input: { kind: AllocationKind; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<string> {
		this.observe("plan-allocation", context);
		return `${input.task.id}/${input.kind}/${input.attempt.allocationGeneration}`;
	}

	async allocate(
		input: { intent: { kind: AllocationKind }; task: TaskRequest },
		context: OperationContext,
	): Promise<AllocationResult> {
		this.observe("allocate", context);
		this.allocationCalls.push(input.intent.kind);
		if (this.allocationFailure?.kind === input.intent.kind) {
			const failure = this.allocationFailure;
			this.allocationFailure = undefined;
			if (failure.error) throw failure.error;
			return failure.result!;
		}
		return { outcome: "owned", resourceId: `${input.task.id}-${input.intent.kind}` };
	}

	async reconcileAllocation(
		input: { intent: { kind: AllocationKind } },
		context: OperationContext,
	): Promise<AllocationReconciliation> {
		this.observe("reconcile-allocation", context);
		this.reconciliationCalls.push(input.intent.kind);
		return this.reconciliation;
	}

	async runWorker(
		input: {
			task: TaskRequest;
			workerId: string;
			launch: LaunchRecord;
			kind: "initial" | "correction";
		},
		context: OperationContext,
	): Promise<WorkerResult> {
		const plan = this.workerPlans.shift() ?? {};
		this.observe("worker", context, plan.expire);
		this.workerCalls.push({
			taskId: input.task.id,
			workerId: input.workerId,
			kind: input.kind,
			launchKey: input.launch.key,
		});
		if (this.workerBarrierSize > 0 && this.workerCalls.length <= this.workerBarrierSize) {
			await new Promise<void>((resolve) => {
				this.barrierResolvers.push(resolve);
				if (this.barrierResolvers.length === this.workerBarrierSize) {
					for (const release of this.barrierResolvers) release();
				}
			});
		}
		if (plan.error) throw plan.error;
		if (plan.outcome === "blocked") return { outcome: "blocked", diagnostic: plan.diagnostic ?? "blocked" };
		if (plan.outcome === "unknown" || plan.outcome === "interrupted") {
			return { outcome: plan.outcome, diagnostic: plan.diagnostic ?? plan.outcome };
		}
		return {
			outcome: "candidate",
			candidate: plan.candidate ?? identity(this.nextOidCharacter(), `refs/heads/${input.task.id}`),
			diagnostic: plan.diagnostic,
		};
	}

	async runChecks(
		input: { scope: "task" | "final"; taskId?: string; checks: CheckCommand[]; candidate: WorkspaceIdentity },
		context: OperationContext,
	): Promise<CheckRunResult> {
		const plan = this.checkPlans.shift() ?? {};
		this.observe(input.scope === "final" ? "final-checks" : "checks", context, plan.expire);
		this.checkCalls.push({ scope: input.scope, ...(input.taskId ? { taskId: input.taskId } : {}) });
		if (plan.mutateMain) this.main = { ...plan.mutateMain };
		if (plan.error) throw plan.error;
		const results: CommandResult[] = input.checks.map((check) => ({
			...check,
			code: plan.code ?? 0,
			stdout: "",
			stderr: plan.code ? "failed" : "",
		}));
		return { results, identityAfter: plan.identityAfter ?? { ...input.candidate } };
	}

	async review(
		input: {
			scope: "task" | "final";
			taskId?: string;
			tip: WorkspaceIdentity;
			launch: LaunchRecord;
		},
		context: OperationContext,
	): Promise<ReviewResult> {
		const plan = this.reviewPlans.shift() ?? {};
		this.observe("review", context, plan.expire);
		this.reviewCalls.push({
			scope: input.scope,
			...(input.taskId ? { taskId: input.taskId } : {}),
			launchKey: input.launch.key,
		});
		if (plan.error) throw plan.error;
		return { verdict: plan.verdict ?? "PASS", identityAfter: plan.identityAfter ?? { ...input.tip } };
	}

	async terminateWorker(
		input: { workerId: string },
		context: OperationContext,
	): Promise<{ outcome: "terminated" }> {
		this.observe("terminate", context);
		this.terminationCalls.push(input.workerId);
		return { outcome: "terminated" };
	}

	async inspectRetainedTask(
		input: { attempt: TaskAttempt },
		context: OperationContext,
	): Promise<WorkspaceIdentity> {
		this.observe("inspect-retained", context);
		return { ...(this.retainedCandidate ?? input.attempt.candidate!) };
	}

	async rebase(
		input: { task: TaskRequest; candidate: WorkspaceIdentity; onto: WorkspaceIdentity },
		context: OperationContext,
	): Promise<RebaseResult> {
		this.observe("rebase", context);
		this.rebaseCalls.push({ taskId: input.task.id, onto: { ...input.onto } });
		const candidate = input.onto.head === MAIN_A.head
			? input.candidate
			: identity(this.nextOidCharacter(), input.candidate.branch);
		return { outcome: "ready", base: { ...input.onto }, candidate: { ...candidate } };
	}

	async integrate(
		input: { task: TaskRequest; candidate: WorkspaceIdentity },
		context: OperationContext,
	): Promise<IntegrationResult> {
		this.observe("integration", context);
		this.integrationCalls.push(input.task.id);
		this.main = identity(input.candidate.head[0]!);
		return { outcome: "integrated", main: { ...this.main } };
	}

	async cleanup(
		input: { kind: CleanupKind },
		context: OperationContext,
	): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }> {
		const plan = this.cleanupPlans.shift() ?? {};
		this.observe("cleanup", context, plan.expire);
		this.cleanupCalls.push(input.kind);
		if (plan.error) throw plan.error;
		if (plan.outcome === "blocked") return { outcome: "blocked", failure: plan.failure ?? "blocked" };
		return { outcome: plan.outcome ?? "completed" };
	}
}

async function harness(t: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-test-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	const agentDir = join(directory, "agent");
	await mkdir(root);
	const runtime = new FakeRuntime();
	const store = new FileRunStore(agentDir);
	return { root, runtime, store, runner: new OrchestratorRunner(runtime, runtime, store) };
}

function productiveCallCount(runtime: FakeRuntime): number {
	return runtime.contexts.filter(({ hook }) => hook !== "cleanup").length;
}

test("existing valid, malformed, and intervening state files are never replaced", async (t) => {
	{
		const { root, runtime, runner } = await harness(t);
		await runner.execute(request(), root);
		await assert.rejects(runner.execute(request(), root), /already exists/);
		assert.equal(runtime.preflightCalls, 1);
	}
	{
		const { root, runtime, store, runner } = await harness(t);
		const path = store.statePath(root, "request-one");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "malformed state\n");
		await assert.rejects(runner.execute(request(), root), /already exists/);
		await assert.rejects(store.load(root, "request-one"));
		assert.equal(await readFile(path, "utf8"), "malformed state\n");
		assert.equal(runtime.preflightCalls, 0);
	}
	{
		const { root, runtime, store, runner } = await harness(t);
		const path = store.statePath(root, "request-one");
		runtime.preflightAction = async () => await writeFile(path, "intervening state\n");
		await assert.rejects(runner.execute(request(), root), /already exists/);
		assert.equal(await readFile(path, "utf8"), "intervening state\n");
	}
});

test("ready tasks dispatch in parallel, then integrate in declared dependency-wave order", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerBarrierSize = 2;
	const result = await runner.execute(request({
		tasks: [task("task-a"), task("task-b"), task("task-c", ["task-a", "task-b"])],
	}), root);

	assert.equal(result.state.accepted, true);
	assert.deepEqual(result.state.waves.map(({ taskIds }) => taskIds), [["task-a", "task-b"], ["task-c"]]);
	assert.deepEqual(runtime.integrationCalls, ["task-a", "task-b", "task-c"]);
	assert.deepEqual(runtime.workerCalls.slice(0, 2).map(({ taskId }) => taskId).sort(), ["task-a", "task-b"]);
	assert.equal(result.state.waves[1]!.base.head, runtime.rebaseCalls[2]!.onto.head);
});

test("mixed Role/model launches remain keyed and recover exactly before finalization", async (t) => {
	const { root, runtime, runner } = await harness(t);
	const definition = request({
		tasks: [
			task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" }),
			task("task-b", ["task-a"], "frontier"),
		],
		finalJudgment: { criterion: "Review all work.", modelClass: "fav" },
	});
	runtime.checkPlans.push({}, {}, {}, {}, { error: new Error("lost final check result") });
	const interrupted = await runner.execute(definition, root);
	assert.equal(interrupted.state.final.status, "interrupted");
	assert.deepEqual(Object.keys(interrupted.state.launchRecords).sort(), [
		"implementer/fast", "implementer/frontier", "reviewer/balanced", "reviewer/fav",
	]);

	const completed = await runner.resume({ id: definition.id, action: "finalize" }, root);
	assert.equal(completed.state.accepted, true);
	assert.deepEqual(runtime.recoverCalls, [interrupted.state.launchRecords]);
	assert.deepEqual(runtime.workerCalls.map(({ launchKey }) => launchKey), ["implementer/fast", "implementer/frontier"]);
	assert.deepEqual(runtime.reviewCalls.map(({ launchKey }) => launchKey), ["reviewer/balanced", "reviewer/balanced", "reviewer/fav"]);
});

test("completed task and request states require exact authoritative evidence and termination", async (t) => {
	const { root, runner } = await harness(t);
	const valid = (await runner.execute(request(), root)).state;
	assert.doesNotThrow(() => parseRunState(structuredClone(valid)));

	const missingTermination = structuredClone(valid);
	missingTermination.tasks[0]!.attempts[0]!.termination!.status = "unknown";
	assert.throws(() => parseRunState(missingTermination), /worker termination/i);

	const preliminaryOnly = structuredClone(valid);
	preliminaryOnly.tasks[0]!.attempts[0]!.authoritativeChecks!.phase = "preliminary";
	assert.throws(() => parseRunState(preliminaryOnly), /authoritative/i);

	const malformedCleanup = structuredClone(valid);
	malformedCleanup.tasks[0]!.attempts[0]!.cleanup[1]!.kind = "worker_tab";
	assert.throws(() => parseRunState(malformedCleanup), /cleanup sequence/i);

	const dirtyFinal = structuredClone(valid);
	const dirtyIdentity = { ...dirtyFinal.final.identity!, index: oid("f") };
	dirtyFinal.main = dirtyIdentity;
	dirtyFinal.final.identity = dirtyIdentity;
	dirtyFinal.final.checks!.candidate = dirtyIdentity;
	dirtyFinal.final.checks!.identityAfter = dirtyIdentity;
	assert.throws(() => parseRunState(dirtyFinal), /final checks|clean/i);

	const uncheckedCompletion = structuredClone(valid);
	uncheckedCompletion.accepted = false;
	delete uncheckedCompletion.acceptedAt;
	uncheckedCompletion.final = { status: "pending" };
	assert.throws(() => parseRunState(uncheckedCompletion), /completed.*accepted|accepted.*completed/i);
});

test("one absolute deadline bounds workers, checks, reviews, integration, and final checks", async (t) => {
	for (const target of ["worker", "checks", "review", "integration", "final-checks"] as const) {
		await t.test(target, async (t) => {
			const { root, runtime, runner } = await harness(t);
			const definition = request({
				budgetMs: 1_000,
				tasks: [task("task-a", [], "fast", target === "review" ? { criterion: "Review A.", modelClass: "balanced" } : undefined)],
			});
			if (target === "worker") runtime.workerPlans.push({ expire: true });
			if (target === "checks") runtime.checkPlans.push({ expire: true });
			if (target === "review") runtime.reviewPlans.push({ expire: true });
			if (target === "integration") runtime.expireHook = "integration";
			if (target === "final-checks") runtime.checkPlans.push({}, {}, { expire: true });

			const result = await runner.execute(definition, root);
			assert.equal(result.state.accepted, false);
			assert.ok(runtime.contexts.some(({ hook }) => hook === target));
			const productive = runtime.contexts.filter(({ hook }) => hook !== "cleanup");
			assert.equal(new Set(productive.map(({ context }) => context.deadline)).size, 1);
			assert.equal(new Set(productive.map(({ context }) => context.signal)).size, 1);
			assert.ok(productive.every(({ context }) => context.timeoutMs > 0 && context.timeoutMs <= definition.budgetMs));
		});
	}
});

test("a failed preliminary gate gets one correction in the same recorded worker", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.checkPlans.push({ code: 1 }, {}, {});
	const result = await runner.execute(request(), root);
	assert.equal(result.state.accepted, true);
	assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial", "correction"]);
	assert.equal(new Set(runtime.workerCalls.map(({ workerId }) => workerId)).size, 1);
	assert.equal(runtime.allocationCalls.filter((kind) => kind === "agent").length, 1);
});

test("preliminary review drift, throws, and ambiguous verdicts terminate in attention without correction", async (t) => {
	const cases: [string, ReviewPlan][] = [
		["drift", { verdict: "PASS", identityAfter: identity("f", "refs/heads/task-a") }],
		["throw", { error: new Error("review transport lost") }],
		["ambiguity", { verdict: "UNCLEAR" }],
	];
	for (const [name, plan] of cases) {
		await t.test(name, async (t) => {
			const { root, runtime, runner } = await harness(t);
			runtime.reviewPlans.push(plan);
			const result = await runner.execute(request({
				tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
			}), root);
			assert.equal(result.state.tasks[0]!.status, "needs_attention");
			assert.equal(result.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
			await assert.rejects(
				runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
				/correction is unavailable/,
			);
			assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
		});
	}
});

test("verify accepts a manually repaired candidate only after recorded worker termination", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.checkPlans.push({ code: 1 }, { code: 1 });
	const blocked = await runner.execute(request(), root);
	assert.equal(blocked.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
	runtime.retainedCandidate = identity("f", "refs/heads/task-a");
	const verified = await runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root);
	assert.equal(verified.state.accepted, true);
	assert.equal(verified.state.tasks[0]!.attempts[0]!.integrationCandidate!.head, oid("f"));
});

test("manual verify rejects a clean retained candidate with the wave-base head", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.checkPlans.push({ code: 1 }, { code: 1 });
	await runner.execute(request(), root);
	runtime.retainedCandidate = identity("a", "refs/heads/task-a");
	await assert.rejects(
		runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root),
		/must differ from its wave base/,
	);
	assert.equal(runtime.integrationCalls.length, 0);
});

test("an interrupted prompt enters attention and is never replayed", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerPlans.push({ error: new Error("transport interrupted") });
	const interrupted = await runner.execute(request(), root);
	assert.equal(interrupted.state.tasks[0]!.status, "needs_attention");
	assert.equal(interrupted.state.tasks[0]!.attempts[0]!.prompts[0]!.status, "ambiguous");
	await assert.rejects(
		runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
		/never replayed/,
	);
	assert.equal(runtime.workerCalls.length, 1);
});

test("unknown allocations block adoption, while a proved-absent unprompted start gets one fresh allocation", async (t) => {
	{
		const { root, runtime, runner } = await harness(t);
		runtime.allocationFailure = { kind: "agent", error: new Error("lost result") };
		const interrupted = await runner.execute(request(), root);
		const intent = interrupted.state.tasks[0]!.attempts[0]!.allocations.at(-1)!;
		assert.equal(intent.status, "unknown");
		assert.equal(intent.kind, "agent");
		assert.ok(intent.token);
		runtime.reconciliation = { outcome: "possible", failure: "matching agent exists", possibleResources: ["candidate-agent"] };
		await assert.rejects(
			runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
			/was not adopted or closed/,
		);
		assert.equal(runtime.allocationCalls.filter((kind) => kind === "agent").length, 1);
	}
	{
		const { root, runtime, runner } = await harness(t);
		runtime.allocationFailure = { kind: "agent", error: new Error("lost result") };
		await runner.execute(request(), root);
		runtime.reconciliation = { outcome: "absent" };
		const completed = await runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root);
		assert.equal(completed.state.accepted, true);
		assert.equal(runtime.allocationCalls.filter((kind) => kind === "agent").length, 2);
		assert.equal(runtime.allocationCalls.filter((kind) => kind === "worktree").length, 1);
	}
});

test("pre-wave drift and inspection failure remain actionable without creating an attempt", async (t) => {
	for (const [name, plan] of [
		["drift", { identity: identity("f") }],
		["inspection failure", { error: new Error("inspection unavailable") }],
	] satisfies [string, InspectionPlan][]) {
		await t.test(name, async (t) => {
			const { root, runtime, runner } = await harness(t);
			runtime.inspectionPlans.push(plan);
			const waiting = await runner.execute(request(), root);
			assert.equal(waiting.state.tasks[0]!.status, "needs_attention");
			assert.equal(waiting.state.tasks[0]!.attempts.length, 0);
			assert.deepEqual(waiting.continuation, { id: "request-one", action: "retry", taskId: "task-a" });
			assert.equal(runtime.workerCalls.length, 0);

			const completed = await runner.resume(waiting.continuation!, root);
			assert.equal(completed.state.accepted, true);
		});
	}
});

test("an initial persisted pending scheduler state recovers to a no-attempt retry", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	runtime.inspectionPlans.push({ error: new Error("inspection unavailable") });
	await runner.execute(request(), root);
	const handle = await store.load(root, "request-one");
	handle.state.status = "pending";
	handle.state.tasks[0]!.status = "pending";
	handle.state.tasks[0]!.failure = undefined;
	await handle.save();

	const recovered = await runner.status("request-one", root);
	assert.equal(recovered.state.tasks[0]!.status, "needs_attention");
	assert.deepEqual(recovered.continuation, { id: "request-one", action: "retry", taskId: "task-a" });
	const completed = await runner.resume(recovered.continuation!, root);
	assert.equal(completed.state.accepted, true);
});

test("cleanup accepts only explicit completed or absent outcomes", async (t) => {
	await t.test("absent", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.cleanupPlans.push({ outcome: "absent" });
		const result = await runner.execute(request(), root);
		assert.equal(result.state.accepted, true);
	});

	await t.test("unexpected", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.cleanupPlans.push({ outcome: "unexpected" as never });
		const result = await runner.execute(request(), root);
		assert.equal(result.state.tasks[0]!.status, "needs_attention");
		assert.equal(result.state.tasks[0]!.attempts[0]!.cleanup[0]!.status, "pending");
		assert.match(result.state.tasks[0]!.failure!, /failed closed/);
		assert.deepEqual(runtime.cleanupCalls, ["worker_tab"]);
	});
});

test("cleanup-only verify finishes exact cleanup after expiry without productive hooks or acceptance", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.cleanupPlans.push({}, { expire: true });
	const interrupted = await runner.execute(request({ budgetMs: 1_000 }), root);
	const attempt = interrupted.state.tasks[0]!.attempts[0]!;
	assert.equal(attempt.integration?.status, "integrated");
	assert.deepEqual(attempt.cleanup.map(({ status }) => status), ["completed", "pending", "pending", "pending"]);
	const beforeProductive = productiveCallCount(runtime);

	const cleaned = await runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root);
	assert.equal(cleaned.state.tasks[0]!.status, "completed");
	assert.equal(cleaned.state.accepted, false);
	assert.equal(cleaned.state.final.status, "pending");
	assert.ok(cleaned.state.tasks[0]!.attempts[0]!.cleanup.every(({ status }) => status === "completed"));
	assert.equal(productiveCallCount(runtime), beforeProductive);
	assert.equal(cleaned.state.recovery, undefined);
	assert.deepEqual(cleaned.continuation, { id: "request-one", action: "finalize" });
});

test("cleanup-only verify exposes a runnable pending-wave continuation without productive work", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.cleanupPlans.push({ outcome: "blocked", failure: "workspace still busy" });
	const definition = request({
		tasks: [task("task-a"), task("task-b", ["task-a"])],
	});
	await runner.execute(definition, root);
	const beforeProductive = productiveCallCount(runtime);

	const cleaned = await runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root);
	assert.equal(productiveCallCount(runtime), beforeProductive);
	assert.equal(cleaned.state.tasks[1]!.status, "needs_attention");
	assert.deepEqual(cleaned.continuation, { id: "request-one", action: "retry", taskId: "task-b" });

	const completed = await runner.resume(cleaned.continuation!, root);
	assert.equal(completed.state.accepted, true);
});

test("cleanup-only verify exposes a retained same-wave peer for later verification", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.cleanupPlans.push({ outcome: "blocked", failure: "workspace still busy" });
	const interrupted = await runner.execute(request({
		tasks: [task("task-a"), task("task-b")],
	}), root);
	assert.equal(interrupted.state.tasks[0]!.status, "needs_attention");
	assert.equal(interrupted.state.tasks[1]!.status, "needs_attention");
	assert.equal(interrupted.state.tasks[1]!.attempts[0]!.termination?.status, "terminated");
	assert.deepEqual(interrupted.continuation, { id: "request-one", action: "verify", taskId: "task-a" });
	const beforeProductive = productiveCallCount(runtime);

	const cleaned = await runner.resume(interrupted.continuation!, root);
	assert.equal(productiveCallCount(runtime), beforeProductive);
	assert.equal(cleaned.state.tasks[0]!.status, "completed");
	assert.equal(cleaned.state.tasks[1]!.status, "needs_attention");
	assert.deepEqual(cleaned.continuation, { id: "request-one", action: "verify", taskId: "task-b" });

	const completed = await runner.resume(cleaned.continuation!, root);
	assert.equal(completed.state.accepted, true);
	assert.deepEqual(runtime.integrationCalls, ["task-a", "task-b"]);
});

test("cleanup verification never reintegrates an already accepted task tip", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	await runner.execute(request(), root);
	const handle = await store.load(root, "request-one");
	handle.state.status = "running";
	handle.state.accepted = false;
	delete handle.state.acceptedAt;
	handle.state.final = { status: "pending" };
	handle.state.tasks[0]!.status = "cleanup";
	await handle.save();
	await runner.status("request-one", root);
	const integrations = runtime.integrationCalls.length;
	const productive = productiveCallCount(runtime);

	const recovered = await runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root);
	assert.equal(recovered.state.tasks[0]!.status, "completed");
	assert.equal(recovered.state.accepted, false);
	assert.equal(runtime.integrationCalls.length, integrations);
	assert.equal(productiveCallCount(runtime), productive);
});

test("definitive final failure and Main drift are terminal, while exact final evidence accepts", async (t) => {
	await t.test("definitive failure", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push({}, {}, { code: 1 });
		const failed = await runner.execute(request(), root);
		assert.equal(failed.state.status, "final_failed");
		const checks = runtime.checkCalls.length;
		await assert.rejects(runner.resume({ id: "request-one", action: "finalize" }, root), /terminal/);
		assert.equal(runtime.checkCalls.length, checks);
	});

	await t.test("final check mutation", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push({}, {}, { identityAfter: identity("f") });
		const superseded = await runner.execute(request(), root);
		assert.equal(superseded.state.status, "superseded");
		await assert.rejects(runner.resume({ id: "request-one", action: "finalize" }, root), /terminal/);
	});

	await t.test("Main drift after final checks", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push({}, {}, { mutateMain: identity("f") });
		const superseded = await runner.execute(request(), root);
		assert.equal(superseded.state.status, "superseded");
		assert.match(superseded.state.final.failure!, /drifted after final checks/);
	});

	await t.test("acceptance", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const completed = await runner.execute(request({
			finalJudgment: { criterion: "The whole request is correct.", modelClass: "balanced" },
		}), root);
		assert.equal(completed.state.status, "completed");
		assert.equal(completed.state.accepted, true);
		assert.equal(completed.state.final.status, "passed");
		assert.doesNotThrow(() => parseRunState(structuredClone(completed.state)));
		assert.deepEqual(runtime.reviewCalls.map(({ scope }) => scope), ["final"]);
	});
});

import { lstat, realpath } from "node:fs/promises";
import {
	createChildWorktree,
	inspectIndexFlags,
	inspectWorktreeDirty,
	WorktreeSetupError,
	type WorktreeInfo,
} from "./worktree.ts";
import { prepareExactReviewEvidence } from "./review-evidence.ts";
import {
	sameIdentity,
	type CheckCommand,
	type ReviewEvidence,
	type TaskAttempt,
	type TaskRequest,
	type WorktreeAllocationIntent,
	type WorktreeAllocationPlan,
	type WorkspaceIdentity,
} from "./schema.ts";
import {
	type AllocationReconciliation,
	type CheckRunResult,
	type CommandResult,
	type GitRuntime,
	type InFlightTaskCandidateInspection,
	type InFlightTaskCandidateInspector,
	type TaskCandidateInspector,
	type OperationContext,
	type ReviewResult,
	type TransientLaunchHandle,
	type WorktreeAllocationResult,
	type VerifiedLaunch,
	withTransientLaunch,
} from "./runner.ts";
import { runProcess as defaultRunProcess } from "./process.ts";

const GIT_OPERATION_CAP_MS = 30_000;
const DIAGNOSTIC_LIMIT = 1_000;

type ProcessResult = { code: number; killed: boolean; stdout: string; stderr: string };

export interface DirectProcessOptions {
	cwd: string;
	signal: AbortSignal;
	timeoutMs?: number;
	stdin?: string;
}

export type DirectProcessRunner = (
	command: string,
	args: string[],
	options: DirectProcessOptions,
) => Promise<ProcessResult>;

export interface ExactReviewPacket {
	base: string;
	tip: string;
	patchPath: string;
}

export interface ExactReviewExecutorInput {
	scope: "task" | "final";
	taskId?: string;
	criterion: string;
	launch: VerifiedLaunch;
	cwd: string;
	packet: ExactReviewPacket;
}

export type ExactReviewExecutor = (
	input: ExactReviewExecutorInput,
	context: OperationContext,
) => Promise<{ verdict: string }>;

export interface CheckedGitRuntimeOptions {
	runProcess?: DirectProcessRunner;
	executeReview?: ExactReviewExecutor;
}

function text(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, DIAGNOSTIC_LIMIT);
}

function oneLine(value: string, field: string): string {
	const line = value.replace(/\r?\n$/, "");
	if (!line || /[\r\n\0]/.test(line)) throw new Error(`Git returned malformed ${field}.`);
	return line;
}

function oid(value: string, field: string): string {
	const result = oneLine(value, field).toLowerCase();
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result)) throw new Error(`Git returned invalid ${field}.`);
	return result;
}

function commandFailure(args: readonly string[], result: ProcessResult): string {
	const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, DIAGNOSTIC_LIMIT);
	return `git ${args.map((arg) => JSON.stringify(arg)).join(" ")} failed with exit ${result.code}${detail ? `: ${detail}` : ""}`;
}

function worktreeIntent(attempt: TaskAttempt): WorktreeAllocationPlan {
	const intent = [...attempt.allocations].reverse().find(
		(candidate): candidate is WorktreeAllocationIntent => candidate.kind === "worktree" && candidate.status === "owned",
	);
	if (!intent?.worktree || intent.worktree.path !== intent.worktree.cwd) {
		throw new Error("Task has no exact owned worktree allocation metadata.");
	}
	return intent.worktree;
}

function cloneWorktree(info: WorktreeInfo): WorktreeAllocationPlan {
	return {
		path: info.path,
		cwd: info.cwd,
		branch: info.branch,
		repoRoot: info.repoRoot,
		baseCommit: info.baseCommit.toLowerCase(),
	};
}

function pathMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (pathMissing(error)) return false;
		throw error;
	}
}

export class CheckedGitRuntime implements GitRuntime, TaskCandidateInspector, InFlightTaskCandidateInspector {
	private readonly execute: DirectProcessRunner;
	private readonly executeReview?: ExactReviewExecutor;
	private readonly mainOperationTails = new Map<string, Promise<void>>();

	constructor(options: CheckedGitRuntimeOptions = {}) {
		this.execute = options.runProcess ?? defaultRunProcess;
		this.executeReview = options.executeReview;
	}

	async inspectMain(input: { root: string }, context: OperationContext): Promise<WorkspaceIdentity> {
		return await this.serializeMainOperation(input.root, context.signal, async () => {
			return await this.inspectWorkspace(input.root, false, context);
		});
	}

	async allocateWorktree(input: {
		root: string;
		baseRoot?: string;
		intent: WorktreeAllocationIntent;
		task: TaskRequest;
		attempt: TaskAttempt;
		onPrepared(worktree: WorktreeAllocationPlan): Promise<void>;
	}, context: OperationContext): Promise<WorktreeAllocationResult> {
		return await this.serializeMainOperation(input.root, context.signal, async () => {
			return await this.allocateWorktreeExclusive(input, context);
		});
	}

	private async allocateWorktreeExclusive(
		input: Parameters<GitRuntime["allocateWorktree"]>[0],
		context: OperationContext,
	): Promise<WorktreeAllocationResult> {
		let prepared: WorktreeAllocationPlan | undefined;
		let createdWorktree: WorktreeAllocationPlan | undefined;
		const baseRoot = input.baseRoot ?? input.root;
		const before = await this.inspectWorkspace(baseRoot, false, context);
		if (!sameIdentity(before, input.attempt.waveBase)) {
			return { kind: "worktree", outcome: "absent", failure: "Recorded wave snapshot drifted before worktree allocation." };
		}
		try {
			const created = await createChildWorktree(
				baseRoot,
				`isolated-${input.task.id}-${input.intent.token}`,
				this.gitRunner(context),
				context.signal,
				async (info) => {
					prepared = cloneWorktree(info);
					if (prepared.baseCommit !== input.attempt.waveBase.head) {
						throw new Error("pi-subagent prepared a worktree from a base other than the recorded wave base.");
					}
					await input.onPrepared(prepared);
					const current = await this.inspectWorkspace(baseRoot, false, context);
					if (!sameIdentity(current, input.attempt.waveBase)) {
						throw new Error("Recorded wave snapshot drifted after worktree preparation and before git worktree add.");
					}
				},
			);
			if (!created) return { kind: "worktree", outcome: "absent", failure: "Git worktree allocation requires a committed repository." };
			const worktree = cloneWorktree(created);
			createdWorktree = worktree;
			if (!prepared || worktree.baseCommit !== input.attempt.waveBase.head
				|| JSON.stringify(worktree) !== JSON.stringify(prepared)) {
				return {
					kind: "worktree",
					outcome: "unknown",
					failure: "Created worktree did not match its exact persisted preparation metadata.",
					possibleResources: [worktree.path, worktree.branch],
				};
			}
			const after = await this.inspectWorkspace(baseRoot, false, context);
			if (!sameIdentity(after, input.attempt.waveBase)) {
				return {
					kind: "worktree",
					outcome: "unknown",
					failure: "Main drifted during worktree setup; the created worktree remains retained.",
					possibleResources: [worktree.path, worktree.branch],
				};
			}
			return { kind: "worktree", outcome: "owned" };
		} catch (error) {
			if (error instanceof WorktreeSetupError) {
				const attempted = cloneWorktree(error.worktree);
				return {
					kind: "worktree",
					outcome: "unknown",
					failure: text(error),
					possibleResources: [attempted.path, attempted.branch],
				};
			}
			if (createdWorktree) {
				return {
					kind: "worktree",
					outcome: "unknown",
					failure: `Created worktree could not be verified: ${text(error)}`,
					possibleResources: [createdWorktree.path, createdWorktree.branch],
				};
			}
			if (prepared) return { kind: "worktree", outcome: "absent", failure: text(error) };
			throw error;
		}
	}

	private async serializeMainOperation<T>(root: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		const previous = this.mainOperationTails.get(root) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(async () => await current);
		this.mainOperationTails.set(root, tail);
		const clearTail = () => {
			if (this.mainOperationTails.get(root) === tail) this.mainOperationTails.delete(root);
		};
		void tail.then(clearTail, clearTail);
		let onAbort!: () => void;
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal.reason ?? new Error("Main Git operation was interrupted."));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			signal.throwIfAborted();
			await Promise.race([previous, aborted]);
			signal.throwIfAborted();
			return await operation();
		} finally {
			signal.removeEventListener("abort", onAbort);
			release();
		}
	}

	async reconcileWorktreeAllocation(input: {
		root: string;
		intent: WorktreeAllocationIntent;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<AllocationReconciliation<"worktree">> {
		const worktree = input.intent.worktree;
		if (!worktree) return { kind: "worktree", outcome: "absent" };
		const [registered, branch, checkout] = await Promise.all([
			this.registeredWorktreePaths(input.root, context),
			this.branchExists(input.root, worktree.branch, context),
			pathExists(worktree.path),
		]);
		const possible = [
			...(registered.includes(worktree.path) ? [`registered worktree ${worktree.path}`] : []),
			...(checkout ? [`checkout path ${worktree.path}`] : []),
			...(branch ? [`branch ${worktree.branch}`] : []),
		];
		return possible.length
			? { kind: "worktree", outcome: "possible", failure: "A possible prior Git allocation remains and was not adopted or removed.", possibleResources: possible }
			: { kind: "worktree", outcome: "absent" };
	}

	async runChecks(input: {
		root: string;
		scope: "task" | "final";
		taskId?: string;
		attempt?: TaskAttempt;
		checks: CheckCommand[];
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<CheckRunResult> {
		const cwd = await this.requireScopeIdentity(input, context);
		const results: CommandResult[] = [];
		for (const check of input.checks) {
			context.signal.throwIfAborted();
			const result = await this.execute(check.command, [...check.args], {
				cwd,
				signal: context.signal,
				timeoutMs: context.timeoutMs,
			});
			results.push({ ...check, ...result });
		}
		const identityAfter = await this.requireScopeCurrent(input, context);
		return { results, identityAfter };
	}

	async review(input: {
		root: string;
		scope: "task" | "final";
		phase: ReviewEvidence["phase"];
		taskId?: string;
		attempt?: TaskAttempt;
		criterion: string;
		base: WorkspaceIdentity;
		tip: WorkspaceIdentity;
		acquireLaunch(): Promise<TransientLaunchHandle<VerifiedLaunch>>;
	}, context: OperationContext): Promise<ReviewResult> {
		if (!this.executeReview) throw new Error("Exact Judgment execution is not configured.");
		if (input.scope === "final") {
			if (input.phase !== "final" || input.attempt) throw new Error("Final review received task-scoped evidence.");
		} else {
			if (!input.attempt || input.phase !== "preliminary") {
				throw new Error("Task review requires exact preliminary attempt evidence.");
			}
			const { candidateBase, candidate, preliminaryChecks, termination } = input.attempt;
			if (!candidateBase || !candidate || termination || preliminaryChecks?.phase !== "preliminary"
				|| !preliminaryChecks.passed || !sameIdentity(preliminaryChecks.candidate, candidate)
				|| !sameIdentity(preliminaryChecks.identityAfter, candidate)
				|| !sameIdentity(input.base, candidateBase) || !sameIdentity(input.tip, candidate)) {
				throw new Error("Preliminary review requires a live worker and exact passing candidate evidence.");
			}
		}
		const cwd = await this.requireScopeIdentity({ ...input, candidate: input.tip }, context);
		const evidenceWorktree = input.scope === "final"
			? await realpath(oneLine(await this.requireGit(["rev-parse", "--show-toplevel"], input.root, context), "Main worktree root"))
			: worktreeIntent(input.attempt!).path;
		const evidence = await prepareExactReviewEvidence({
			base: input.base.head,
			tip: input.tip.head,
			worktree: evidenceWorktree,
		}, context.signal);
		let reviewError: unknown;
		try {
			if (evidence.base !== input.base.head || evidence.tip !== input.tip.head) {
				throw new Error("Exact review evidence resolved an unexpected base or tip.");
			}
			const handle = await input.acquireLaunch();
			const reviewed = await withTransientLaunch(handle, async (launch) => await this.executeReview!({
				scope: input.scope,
				...(input.taskId ? { taskId: input.taskId } : {}),
				criterion: input.criterion,
				launch,
				cwd,
				packet: { base: evidence.base, tip: evidence.tip, patchPath: evidence.patchPath },
			}, context));
			const identityAfter = await this.requireScopeCurrent({ ...input, candidate: input.tip }, context);
			return { verdict: reviewed.verdict, identityAfter };
		} catch (error) {
			reviewError = error;
			throw error;
		} finally {
			try {
				await evidence.cleanup();
			} catch (cleanupError) {
				if (reviewError) {
					throw new AggregateError([reviewError, cleanupError], "Judgment execution failed and exact evidence cleanup also failed.");
				}
				throw cleanupError;
			}
		}
	}

	async inspectTaskCandidate(input: { root: string; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<WorkspaceIdentity> {
		const priorPrompt = input.attempt.prompts.at(-1);
		const expected = priorPrompt
			? input.attempt.candidate ?? priorPrompt.candidate ?? priorPrompt.preCandidate
			: undefined;
		const candidate = await this.inspectTask(
			input.root,
			input.task,
			input.attempt,
			expected,
			input.attempt.waveBase.head,
			context,
			false,
		);
		if (!priorPrompt && (candidate.head !== input.attempt.waveBase.head
			|| candidate.index !== input.attempt.waveBase.index
			|| candidate.tree !== input.attempt.waveBase.tree)) {
			throw new Error(`Task ${input.task.id} initial prompt no longer starts from its recorded wave base.`);
		}
		return candidate;
	}

	async inspectInFlightTaskCandidate(
		input: { root: string; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<InFlightTaskCandidateInspection> {
		const worktree = await this.requireTaskWorktree(input.root, input.task, input.attempt, context);
		const inspected = await this.inspectInFlightWorkspace(worktree.cwd, context);
		const expectedBranch = `refs/heads/${worktree.branch}`;
		const branchTip = inspected.candidate.branch === expectedBranch
			? await this.branchTip(worktree.cwd, worktree.branch, context)
			: undefined;
		const descendsFromBase = await this.isAncestor(
			input.attempt.waveBase.head,
			inspected.candidate.head,
			worktree.cwd,
			context,
		);
		return {
			candidate: inspected.candidate,
			clean: inspected.clean,
			valid: inspected.supported
				&& inspected.candidate.branch === expectedBranch
				&& branchTip === inspected.candidate.head
				&& descendsFromBase,
		};
	}

	async inspectRetainedTask(input: { root: string; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<WorkspaceIdentity> {
		return await this.inspectTask(input.root, input.task, input.attempt, undefined, input.attempt.waveBase.head, context);
	}

	private async requireScopeIdentity(input: {
		root: string;
		scope: "task" | "final";
		attempt?: TaskAttempt;
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<string> {
		const actual = await this.requireScopeCurrent(input, context);
		if (!sameIdentity(actual, input.candidate)) throw new Error(`${input.scope} candidate drifted before the operation.`);
		return input.scope === "final" ? input.root : worktreeIntent(input.attempt!).cwd;
	}

	private async requireScopeCurrent(input: {
		root: string;
		scope: "task" | "final";
		attempt?: TaskAttempt;
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<WorkspaceIdentity> {
		if (input.scope === "final") return await this.inspectMain({ root: input.root }, context);
		if (!input.attempt) throw new Error("Task Git operation requires exact worktree metadata.");
		return await this.inspectTask(input.root, { id: "recorded-task" } as TaskRequest, input.attempt, undefined, undefined, context);
	}

	private async inspectTask(
		root: string,
		task: Pick<TaskRequest, "id">,
		attempt: TaskAttempt,
		expected: WorkspaceIdentity | undefined,
		base: string | undefined,
		context: OperationContext,
		requireChange = true,
	): Promise<WorkspaceIdentity> {
		const worktree = await this.requireTaskWorktree(root, task, attempt, context);
		const identity = await this.inspectWorkspace(worktree.cwd, false, context);
		if (identity.branch !== `refs/heads/${worktree.branch}`) throw new Error(`Task ${task.id} moved off its owned branch.`);
		const branch = await this.branchTip(worktree.cwd, worktree.branch, context);
		if (branch !== identity.head) throw new Error(`Task ${task.id} branch no longer names its checked-out HEAD.`);
		if (expected && !sameIdentity(identity, expected)) throw new Error(`Task ${task.id} candidate identity drifted.`);
		const requiredBase = base ?? attempt.waveBase.head;
		if (!await this.isAncestor(requiredBase, identity.head, worktree.cwd, context)) {
			throw new Error(`Task ${task.id} tip does not descend from its recorded base ${requiredBase}.`);
		}
		if (requireChange) {
			const count = Number.parseInt(oneLine(await this.requireGit(["rev-list", "--count", `${requiredBase}..${identity.head}`], worktree.cwd, context), "task commit count"), 10);
			if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Task ${task.id} has no committed change from its recorded base.`);
		}
		return identity;
	}

	private async requireTaskWorktree(
		root: string,
		task: Pick<TaskRequest, "id">,
		attempt: TaskAttempt,
		context: OperationContext,
	): Promise<WorktreeAllocationPlan> {
		const worktree = worktreeIntent(attempt);
		if (worktree.baseCommit !== attempt.waveBase.head) {
			throw new Error(`Task ${task.id} worktree was not created from its recorded wave base.`);
		}
		if (await realpath(worktree.path) !== worktree.path) throw new Error(`Task ${task.id} worktree path changed.`);
		if (!(await this.registeredWorktreePaths(root, context)).includes(worktree.path)) {
			throw new Error(`Task ${task.id} worktree is not registered in the recorded repository.`);
		}
		return worktree;
	}

	private async inspectInFlightWorkspace(
		cwd: string,
		context: OperationContext,
	): Promise<{ candidate: WorkspaceIdentity; clean: boolean; supported: boolean }> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const branch = oneLine(await this.requireGit(["symbolic-ref", "--quiet", "HEAD"], cwd, context), "branch reference");
			const head = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd, context), "HEAD");
			const hadGitlinks = await this.hasGitlinks(cwd, context);
			const inspection = await inspectWorktreeDirty(cwd, this.gitRunner(context), false);
			if (inspection.failure) throw new Error(`Worktree inspection failed: ${inspection.failure}`);
			const index = oid(await this.requireGit(["write-tree"], cwd, context), "index tree");
			const tree = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{tree}"], cwd, context), "HEAD tree");
			const hasGitlinks = hadGitlinks || await this.hasGitlinks(cwd, context);
			const finalBranch = oneLine(await this.requireGit(["symbolic-ref", "--quiet", "HEAD"], cwd, context), "branch reference");
			const finalHead = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd, context), "HEAD");
			if (branch !== finalBranch || head !== finalHead) continue;
			return {
				candidate: { branch, head, index, tree },
				clean: !inspection.dirty,
				supported: !hasGitlinks,
			};
		}
		throw new Error("Git workspace changed during in-flight identity inspection.");
	}

	private async inspectWorkspace(cwd: string, strictIgnored: boolean, context: OperationContext): Promise<WorkspaceIdentity> {
		const branch = oneLine(await this.requireGit(["symbolic-ref", "--quiet", "HEAD"], cwd, context), "branch reference");
		const head = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd, context), "HEAD");
		await this.assertNoGitlinks(cwd, context);
		if (strictIgnored) {
			const inspection = await inspectWorktreeDirty(cwd, this.gitRunner(context));
			if (inspection.failure) throw new Error(`Worktree inspection failed: ${inspection.failure}`);
			if (inspection.dirty) throw new Error("Worktree contains tracked, untracked, ignored, or nested submodule changes.");
		} else {
			const refreshed = await this.git(["update-index", "--really-refresh"], cwd, context);
			if (refreshed.code !== 0 && refreshed.code !== 1) throw new Error(commandFailure(["update-index", "--really-refresh"], refreshed));
			const status = await this.requireGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], cwd, context);
			if (refreshed.code === 1 || status) throw new Error("Git workspace is not clean; no stash, reset, or discard was attempted.");
			const flags = await inspectIndexFlags(cwd, this.gitRunner(context), context.signal);
			if (flags.failure) throw new Error(`Git index inspection failed: ${flags.failure}`);
			if (flags.hidden) throw new Error("Git index contains assume-unchanged or skip-worktree entries.");
		}
		await this.assertNoGitlinks(cwd, context);
		const index = oid(await this.requireGit(["write-tree"], cwd, context), "index tree");
		const tree = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{tree}"], cwd, context), "HEAD tree");
		if (index !== tree) throw new Error("Git index does not match committed HEAD.");
		const finalBranch = oneLine(await this.requireGit(["symbolic-ref", "--quiet", "HEAD"], cwd, context), "branch reference");
		const finalHead = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd, context), "HEAD");
		if (branch !== finalBranch || head !== finalHead) throw new Error("Git workspace changed during identity inspection.");
		return { branch, head, index, tree };
	}

	private async hasGitlinks(cwd: string, context: OperationContext): Promise<boolean> {
		const index = await this.requireGit(["ls-files", "--stage", "-z"], cwd, context);
		return index.split("\0").some((entry) => entry.startsWith("160000 "));
	}

	private async assertNoGitlinks(cwd: string, context: OperationContext): Promise<void> {
		if (await this.hasGitlinks(cwd, context)) {
			throw new Error("Pi Subagent does not support Git repositories containing mode-160000 gitlinks.");
		}
	}

	private async branchExists(cwd: string, branch: string, context: OperationContext): Promise<boolean> {
		const result = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd, context);
		if (result.code === 0) return true;
		if (result.code === 1 && !result.killed) return false;
		throw new Error(commandFailure(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], result));
	}

	private async branchTip(cwd: string, branch: string, context: OperationContext): Promise<string | undefined> {
		const args = ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`];
		const result = await this.git(args, cwd, context);
		if (result.code === 0 && !result.killed) return oid(result.stdout, "branch tip");
		if (result.code === 1 && !result.killed) return;
		throw new Error(commandFailure(args, result));
	}

	private async isAncestor(base: string, tip: string, cwd: string, context: OperationContext): Promise<boolean> {
		const result = await this.git(["merge-base", "--is-ancestor", base, tip], cwd, context);
		if (result.code === 0) return true;
		if (result.code === 1 && !result.killed) return false;
		throw new Error(commandFailure(["merge-base", "--is-ancestor", base, tip], result));
	}

	private async registeredWorktreePaths(cwd: string, context: OperationContext): Promise<string[]> {
		const output = await this.requireGit(["worktree", "list", "--porcelain", "-z"], cwd, context);
		const paths = output.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice("worktree ".length));
		return await Promise.all(paths.map(async (path) => {
			try {
				return await realpath(path);
			} catch (error) {
				if (pathMissing(error)) return path;
				throw error;
			}
		}));
	}

	private gitRunner(context: OperationContext): (
		args: string[],
		cwd: string,
		signal?: AbortSignal,
	) => Promise<{ code: number; stdout: string; stderr: string }> {
		return async (args, cwd, signal) => {
			const result = await this.execute("git", [...args], {
				cwd,
				signal: signal ?? context.signal,
				timeoutMs: Math.min(GIT_OPERATION_CAP_MS, context.timeoutMs ?? GIT_OPERATION_CAP_MS),
			});
			return { code: result.code, stdout: result.stdout, stderr: result.stderr };
		};
	}

	private async git(args: string[], cwd: string, context: OperationContext): Promise<ProcessResult> {
		context.signal.throwIfAborted();
		const result = await this.execute("git", [...args], {
			cwd,
			signal: context.signal,
			timeoutMs: Math.min(GIT_OPERATION_CAP_MS, context.timeoutMs ?? GIT_OPERATION_CAP_MS),
		});
		context.signal.throwIfAborted();
		return result;
	}

	private async requireGit(args: string[], cwd: string, context: OperationContext): Promise<string> {
		const result = await this.git(args, cwd, context);
		if (result.code !== 0 || result.killed) throw new Error(commandFailure(args, result));
		return result.stdout.replace(/\r?\n$/, "");
	}
}

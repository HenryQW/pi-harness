import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createChildWorktree,
	inspectIndexFlags,
	inspectWorktreeDirty,
	prepareExactReviewEvidence,
	WorktreeSetupError,
	type WorktreeInfo,
} from "@henryqw/pi-subagent";
import {
	checkBatchPasses,
	isCleanCommitted,
	reviewEvidencePasses,
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
	type GitCleanupKind,
	type GitRuntime,
	type InFlightTaskCandidateInspection,
	type InFlightTaskCandidateInspector,
	type IntegrationResult,
	type TaskCandidateInspector,
	type OperationContext,
	type RebaseResult,
	type ReviewResult,
	type TransientLaunchHandle,
	type WorktreeAllocationResult,
	type VerifiedLaunch,
	withTransientLaunch,
} from "./runner.ts";
import { runProcess as defaultRunProcess } from "./process.ts";

const GIT_OPERATION_CAP_MS = 30_000;
const DIAGNOSTIC_LIMIT = 1_000;
const REF_TRANSACTION_MISMATCH = "pi-orchestrator: guarded fast-forward rejected unexpected ref transaction";

type ProcessResult = { code: number; killed: boolean; stdout: string; stderr: string };

export interface DirectProcessOptions {
	cwd: string;
	signal: AbortSignal;
	timeoutMs: number;
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

function referenceTransactionGuard(expectedBranch: string, expectedHead: string, candidateHead: string): string {
	return `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const mismatch = ${JSON.stringify(REF_TRANSACTION_MISMATCH)};
const expectedBranch = ${JSON.stringify(expectedBranch)};
const expectedHead = ${JSON.stringify(expectedHead)};
const candidateHead = ${JSON.stringify(candidateHead)};
const state = process.argv[2];
if (state !== "preparing" && state !== "prepared") process.exit(0);
const input = readFileSync(0, "utf8");
function reject() {
	process.stderr.write(mismatch + "\\n");
	process.exit(1);
}
if (!input.endsWith("\\n")) reject();
const updates = input.slice(0, -1).split("\\n").map((line) => {
	const first = line.indexOf(" ");
	const second = line.indexOf(" ", first + 1);
	if (first < 1 || second <= first + 1 || second === line.length - 1) reject();
	return { oldValue: line.slice(0, first), newValue: line.slice(first + 1, second), ref: line.slice(second + 1) };
});
if (new Set(updates.map((update) => update.ref)).size !== updates.length) reject();
if (updates.some((update) => update.ref !== "ORIG_HEAD"
	&& update.ref !== "AUTO_MERGE"
	&& update.ref !== "HEAD"
	&& !update.ref.startsWith("refs/"))) reject();
const originalHead = updates.filter((update) => update.ref === "ORIG_HEAD");
if (originalHead.some((update) => update.newValue !== expectedHead)) reject();
const moving = updates.filter((update) => update.ref === "HEAD" || update.ref.startsWith("refs/"));
if (moving.length === 0) process.exit(0);
function exact(update, ref) {
	return update.ref === ref && update.oldValue === expectedHead && update.newValue === candidateHead;
}
const valid = state === "preparing"
	? moving.length === 1 && exact(moving[0], "HEAD")
	: moving.length === 1
		? exact(moving[0], expectedBranch)
		: moving.length === 2
			&& moving.some((update) => exact(update, "HEAD"))
			&& moving.some((update) => exact(update, expectedBranch));
if (!valid) reject();
`;
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
		const before = await this.inspectWorkspace(input.root, false, context);
		if (!sameIdentity(before, input.attempt.waveBase)) {
			return { kind: "worktree", outcome: "absent", failure: "Main drifted before worktree allocation." };
		}
		try {
			const created = await createChildWorktree(
				input.root,
				`orchestrator-${input.task.id}-${input.intent.token}`,
				this.gitRunner(context),
				context.signal,
				async (info) => {
					prepared = cloneWorktree(info);
					if (prepared.baseCommit !== input.attempt.waveBase.head) {
						throw new Error("pi-subagent prepared a worktree from a base other than the recorded wave base.");
					}
					await input.onPrepared(prepared);
					const current = await this.inspectWorkspace(input.root, false, context);
					if (!sameIdentity(current, input.attempt.waveBase)) {
						throw new Error("Main drifted after worktree preparation and before git worktree add.");
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
			const after = await this.inspectWorkspace(input.root, false, context);
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
			if (!input.attempt || input.phase !== "authoritative") {
				throw new Error("Task review requires exact authoritative attempt evidence.");
			}
			if (!input.attempt.readiness || input.attempt.termination) {
				throw new Error("Authoritative review requires exact durable readiness and a live worker.");
			}
			const expectedBase = input.attempt.integrationBase;
			const expectedTip = input.attempt.integrationCandidate;
			if (!expectedBase || !expectedTip || !sameIdentity(input.base, expectedBase) || !sameIdentity(input.tip, expectedTip)) {
				throw new Error("Authoritative review base or tip does not match the exact persisted task evidence.");
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

	async rebase(input: {
		root: string;
		task: TaskRequest;
		attempt: TaskAttempt;
		candidate: WorkspaceIdentity;
		sourceBase: WorkspaceIdentity;
		onto: WorkspaceIdentity;
	}, context: OperationContext): Promise<RebaseResult> {
		const main = await this.inspectMain({ root: input.root }, context);
		if (!sameIdentity(main, input.onto)) return { outcome: "blocked", failure: "Main drifted before task rebase." };
		const current = await this.inspectTask(input.root, input.task, input.attempt, input.candidate, input.sourceBase.head, context);
		if (input.sourceBase.head === input.onto.head) {
			return { outcome: "ready", base: input.onto, candidate: current };
		}
		const worktree = worktreeIntent(input.attempt);
		const args = ["rebase", "--no-update-refs", "--no-autostash", input.onto.head];
		const rebased = await this.git(args, worktree.cwd, context);
		if (rebased.code !== 0 || rebased.killed) {
			return {
				outcome: "blocked",
				failure: `${commandFailure(args, rebased)} The exact rebase worktree and conflict state were retained without abort, reset, stash, or discard.`,
			};
		}
		const candidate = await this.inspectTask(input.root, input.task, input.attempt, undefined, input.onto.head, context);
		const after = await this.inspectMain({ root: input.root }, context);
		return sameIdentity(after, input.onto)
			? { outcome: "ready", base: input.onto, candidate }
			: { outcome: "drift", base: input.onto, candidate, failure: "Main drifted during task rebase." };
	}

	async reconcileRebase(
		input: Parameters<GitRuntime["reconcileRebase"]>[0],
		context: OperationContext,
	): Promise<import("./runner.ts").RebaseReconciliation> {
		const transition = input.transition;
		if (transition.status !== "rebasing") {
			return { outcome: "unknown", failure: "Only a persisted rebasing intent can be reconciled." };
		}
		try {
			await this.inspectTask(input.root, input.task, input.attempt, transition.from, transition.sourceBase.head, context);
			return { outcome: "not_started" };
		} catch {
			// A changed exact worktree may be the completed rebase; prove it below.
		}
		try {
			const current = await this.inspectTask(input.root, input.task, input.attempt, undefined, transition.onto.head, context);
			if (!isCleanCommitted(current)) {
				return { outcome: "unknown", failure: "Interrupted rebase candidate is not clean and committed." };
			}
			const worktree = worktreeIntent(input.attempt);
			const [before, after] = await Promise.all([
				this.stablePatchIds(transition.sourceBase.head, transition.from.head, worktree.cwd, context),
				this.stablePatchIds(transition.onto.head, current.head, worktree.cwd, context),
			]);
			if (before.length !== after.length || before.some((patch, index) => patch !== after[index])) {
				return { outcome: "unknown", failure: "Interrupted rebase patch identity or commit order could not be proved." };
			}
			return { outcome: "rebased", candidate: current };
		} catch (error) {
			return { outcome: "unknown", failure: `Interrupted rebase could not be reconciled exactly: ${text(error)}` };
		}
	}

	async integrate(input: {
		root: string;
		task: TaskRequest;
		attempt: TaskAttempt;
		expectedMain: WorkspaceIdentity;
		candidate: WorkspaceIdentity;
		checks: import("./schema.ts").CheckBatchEvidence;
		review?: ReviewEvidence;
	}, context: OperationContext): Promise<IntegrationResult> {
		if (input.task.kind !== "changeset") {
			return { outcome: "failed", failure: "Integration requires a changeset task." };
		}
		if (!input.attempt.readiness || input.attempt.termination) {
			return { outcome: "failed", failure: "Integration requires exact durable readiness and a live worker." };
		}
		if (!input.attempt.integrationBase || !sameIdentity(input.attempt.integrationBase, input.expectedMain)
			|| !input.attempt.integrationCandidate || !sameIdentity(input.attempt.integrationCandidate, input.candidate)) {
			return { outcome: "failed", failure: "Integration inputs do not match the persisted base and candidate." };
		}
		if (!checkBatchPasses(input.checks, input.task.checks, input.candidate)
			|| !checkBatchPasses(input.attempt.authoritativeChecks, input.task.checks, input.candidate)) {
			return { outcome: "failed", failure: "Integration requires exact persisted authoritative passing checks." };
		}
		if (input.task.judgment) {
			if (!reviewEvidencePasses(
				input.review,
				"authoritative",
				input.task.judgment.criterion,
				input.expectedMain,
				input.candidate,
			) || !reviewEvidencePasses(
				input.attempt.authoritativeReview,
				"authoritative",
				input.task.judgment.criterion,
				input.expectedMain,
				input.candidate,
			)) return { outcome: "failed", failure: "Integration requires exact persisted authoritative PASS review evidence." };
		}

		const main = await this.inspectMain({ root: input.root }, context);
		if (!sameIdentity(main, input.expectedMain)) return { outcome: "drift", failure: "Main drifted before fast-forward integration." };
		await this.inspectTask(input.root, input.task, input.attempt, input.candidate, input.expectedMain.head, context);
		const hookDirectory = await mkdtemp(join(tmpdir(), "pi-orchestrator-ref-guard-"));
		const hookPath = join(hookDirectory, "reference-transaction");
		const args = ["-c", `core.hooksPath=${hookDirectory}`, "merge", "--no-overwrite-ignore", "--no-autostash", "--ff-only", input.candidate.head];
		let merged: ProcessResult;
		try {
			await writeFile(hookPath, referenceTransactionGuard(input.expectedMain.branch, input.expectedMain.head, input.candidate.head));
			await chmod(hookPath, 0o700);
			merged = await this.git(args, input.root, context);
		} finally {
			await rm(hookDirectory, { recursive: true });
		}
		if (merged.code !== 0 || merged.killed) {
			if (merged.stderr.includes(REF_TRANSACTION_MISMATCH)) {
				return { outcome: "drift", failure: "Main drifted at the guarded fast-forward ref transaction." };
			}
			try {
				const afterFailure = await this.inspectMain({ root: input.root }, context);
				if (sameIdentity(afterFailure, input.expectedMain)) {
					return { outcome: "failed", failure: commandFailure(args, merged) };
				}
			} catch {
				// The failed operation is uncertain; preserve all task resources below.
			}
			return { outcome: "unknown", failure: `Fast-forward integration result is uncertain. ${commandFailure(args, merged)}` };
		}
		let integrated: WorkspaceIdentity;
		try {
			integrated = await this.inspectMain({ root: input.root }, context);
		} catch (error) {
			return { outcome: "unknown", failure: `Fast-forward returned success but Main could not be verified: ${text(error)}` };
		}
		if (integrated.branch !== input.expectedMain.branch || integrated.head !== input.candidate.head) {
			return { outcome: "unknown", failure: "Fast-forward returned success with an unexpected Main identity." };
		}
		return { outcome: "integrated", main: integrated };
	}

	async cleanupGit(input: {
		root: string;
		kind: GitCleanupKind;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }> {
		try {
			const worktree = worktreeIntent(input.attempt);
			const integrationBase = input.attempt.integrationBase;
			const integrationCandidate = input.attempt.integrationCandidate;
			const integration = input.attempt.integration;
			if (!integrationBase || !integrationCandidate || integration?.status !== "integrated"
				|| !sameIdentity(integration.expectedMain, integrationBase)
				|| !sameIdentity(integration.candidate, integrationCandidate)
				|| !integration.mainAfter
				|| integration.mainAfter.branch !== integrationBase.branch
				|| integration.mainAfter.head !== integrationCandidate.head
				|| !isCleanCommitted(integration.mainAfter)) {
				return { outcome: "blocked", failure: "Git cleanup requires complete exact integration evidence." };
			}
			const approvedTip = integrationCandidate.head;
			const registered = await this.registeredWorktreePaths(input.root, context);
			const checkout = await pathExists(worktree.path);
			const branch = await this.branchTip(input.root, worktree.branch, context);

			if (input.kind === "worktree") {
				if (!checkout && !registered.includes(worktree.path)) return { outcome: "absent" };
				if (!checkout || !registered.includes(worktree.path)) {
					return { outcome: "blocked", failure: "Worktree path and Git registration disagree; cleanup refused." };
				}
				if (branch !== approvedTip) return { outcome: "blocked", failure: "Worktree branch no longer names the approved tip." };
				await this.inspectTask(input.root, input.task, input.attempt, integrationCandidate, integrationBase.head, context);
				const currentMain = await this.inspectMain({ root: input.root }, context);
				if (!sameIdentity(currentMain, integration.mainAfter)) {
					return { outcome: "blocked", failure: "Main no longer matches the exact recorded post-integration identity." };
				}
				const removed = await this.git(["worktree", "remove", worktree.path], input.root, context);
				if (removed.code !== 0 || removed.killed) return { outcome: "blocked", failure: commandFailure(["worktree", "remove", worktree.path], removed) };
				if (await pathExists(worktree.path)
					|| (await this.registeredWorktreePaths(input.root, context)).includes(worktree.path)) {
					return { outcome: "blocked", failure: "git worktree remove returned success but the exact worktree still exists." };
				}
				return { outcome: "completed" };
			}

			if (checkout || registered.includes(worktree.path)) {
				return { outcome: "blocked", failure: "Branch cleanup requires the exact worktree to be absent first." };
			}
			if (branch === undefined) return { outcome: "absent" };
			if (branch !== approvedTip) return { outcome: "blocked", failure: "Task branch no longer names the approved tip." };
			const currentMain = await this.inspectMain({ root: input.root }, context);
			if (!sameIdentity(currentMain, integration.mainAfter)) {
				return { outcome: "blocked", failure: "Main no longer matches the exact recorded post-integration identity." };
			}
			const deleted = await this.git(["branch", "-d", "--", worktree.branch], input.root, context);
			if (deleted.code !== 0 || deleted.killed) return { outcome: "blocked", failure: commandFailure(["branch", "-d", "--", worktree.branch], deleted) };
			if (await this.branchExists(input.root, worktree.branch, context)) {
				return { outcome: "blocked", failure: "git branch -d returned success but the exact branch still exists." };
			}
			return { outcome: "completed" };
		} catch (error) {
			return { outcome: "blocked", failure: text(error) };
		}
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
		const branch = oneLine(await this.requireGit(["symbolic-ref", "--quiet", "HEAD"], cwd, context), "branch reference");
		const head = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd, context), "HEAD");
		const hadGitlinks = await this.hasGitlinks(cwd, context);
		const inspection = await inspectWorktreeDirty(cwd, this.gitRunner(context));
		if (inspection.failure) throw new Error(`Worktree inspection failed: ${inspection.failure}`);
		const index = oid(await this.requireGit(["write-tree"], cwd, context), "index tree");
		const tree = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{tree}"], cwd, context), "HEAD tree");
		const hasGitlinks = hadGitlinks || await this.hasGitlinks(cwd, context);
		const finalBranch = oneLine(await this.requireGit(["symbolic-ref", "--quiet", "HEAD"], cwd, context), "branch reference");
		const finalHead = oid(await this.requireGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd, context), "HEAD");
		if (branch !== finalBranch || head !== finalHead) throw new Error("Git workspace changed during in-flight identity inspection.");
		return {
			candidate: { branch, head, index, tree },
			clean: !inspection.dirty,
			supported: !hasGitlinks,
		};
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
			throw new Error("Pi Orchestrator does not support Git repositories containing mode-160000 gitlinks.");
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

	private async stablePatchIds(base: string, tip: string, cwd: string, context: OperationContext): Promise<string[]> {
		const listed = await this.requireGit(["rev-list", "--reverse", `${base}..${tip}`], cwd, context);
		const commits = listed.trim() ? listed.trim().split(/\r?\n/).map((value) => oid(value, "rebase commit")) : [];
		const patches: string[] = [];
		for (const commit of commits) {
			const patch = await this.requireGit([
				"show", "--pretty=email", "--binary", "--no-ext-diff", "--no-textconv", commit,
			], cwd, context);
			const result = await this.execute("git", ["patch-id", "--stable"], {
				cwd,
				signal: context.signal,
				timeoutMs: Math.min(GIT_OPERATION_CAP_MS, context.timeoutMs),
				stdin: patch,
			});
			if (result.code !== 0 || result.killed || result.stderr.trim()) {
				throw new Error(commandFailure(["patch-id", "--stable"], result));
			}
			const match = /^([0-9a-f]{40}|[0-9a-f]{64})\s+(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\r?\n)?$/.exec(result.stdout);
			if (!match) throw new Error("git patch-id --stable returned malformed exact evidence.");
			patches.push(match[1]!);
		}
		return patches;
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
				timeoutMs: Math.min(GIT_OPERATION_CAP_MS, context.timeoutMs),
			});
			return { code: result.code, stdout: result.stdout, stderr: result.stderr };
		};
	}

	private async git(args: string[], cwd: string, context: OperationContext): Promise<ProcessResult> {
		context.signal.throwIfAborted();
		const result = await this.execute("git", [...args], {
			cwd,
			signal: context.signal,
			timeoutMs: Math.min(GIT_OPERATION_CAP_MS, context.timeoutMs),
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

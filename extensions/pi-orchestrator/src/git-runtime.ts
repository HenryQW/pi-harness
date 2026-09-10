import { execFile } from "node:child_process";
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
	launchKey,
	reviewEvidencePasses,
	sameIdentity,
	type AllocationIntent,
	type CheckCommand,
	type LaunchRecord,
	type ReviewEvidence,
	type TaskAttempt,
	type TaskRequest,
	type WorktreeRecord,
	type WorkspaceIdentity,
} from "./schema.ts";
import type {
	AllocationReconciliation,
	AllocationResult,
	CheckRunResult,
	CommandResult,
	GitCleanupKind,
	GitRuntime,
	IntegrationResult,
	TaskCandidateInspector,
	OperationContext,
	RebaseResult,
	ReviewResult,
} from "./runner.ts";

const GIT_OPERATION_CAP_MS = 30_000;
const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const DIAGNOSTIC_LIMIT = 1_000;
const REF_TRANSACTION_MISMATCH = "pi-orchestrator: guarded fast-forward rejected unexpected ref transaction";

type ProcessResult = { code: number; killed: boolean; stdout: string; stderr: string };

export interface DirectProcessOptions {
	cwd: string;
	signal: AbortSignal;
	timeoutMs: number;
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
	launch: LaunchRecord;
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

const runProcess: DirectProcessRunner = (command, args, options) => new Promise((resolve) => {
	execFile(command, args, {
		cwd: options.cwd,
		signal: options.signal,
		timeout: options.timeoutMs,
		maxBuffer: COMMAND_OUTPUT_LIMIT,
		shell: false,
	}, (error, stdout, stderr) => {
		resolve({
			code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
			killed: Boolean(error && "killed" in error && error.killed),
			stdout: String(stdout),
			stderr: String(stderr),
		});
	});
});

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
const originalHead = updates.filter((update) => update.ref === "ORIG_HEAD");
if (originalHead.some((update) => update.newValue !== expectedHead)) reject();
const moving = updates.filter((update) => update.ref === "HEAD" || update.ref.startsWith("refs/"));
if (moving.length === 0) process.exit(0);
const expectedRef = state === "preparing" ? "HEAD" : expectedBranch;
if (moving.length !== 1 || moving[0].oldValue !== expectedHead || moving[0].newValue !== candidateHead || moving[0].ref !== expectedRef) reject();
`;
}

function worktreeIntent(attempt: TaskAttempt): AllocationIntent & { worktree: WorktreeRecord } {
	const intent = [...attempt.allocations].reverse().find((candidate) => candidate.kind === "worktree" && candidate.status === "owned");
	if (!intent?.worktree || intent.resourceId !== intent.worktree.path) {
		throw new Error("Task has no exact owned worktree allocation metadata.");
	}
	return intent as AllocationIntent & { worktree: WorktreeRecord };
}

function cloneWorktree(info: WorktreeInfo): WorktreeRecord {
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

export class CheckedGitRuntime implements GitRuntime, TaskCandidateInspector {
	private readonly execute: DirectProcessRunner;
	private readonly executeReview?: ExactReviewExecutor;

	constructor(options: CheckedGitRuntimeOptions = {}) {
		this.execute = options.runProcess ?? runProcess;
		this.executeReview = options.executeReview;
	}

	async inspectMain(input: { root: string }, context: OperationContext): Promise<WorkspaceIdentity> {
		return await this.inspectWorkspace(input.root, false, context);
	}

	async allocateWorktree(input: {
		root: string;
		intent: AllocationIntent;
		task: TaskRequest;
		attempt: TaskAttempt;
		onPrepared(worktree: WorktreeRecord): Promise<void>;
	}, context: OperationContext): Promise<AllocationResult> {
		let prepared: WorktreeRecord | undefined;
		let createdWorktree: WorktreeRecord | undefined;
		const before = await this.inspectMain({ root: input.root }, context);
		if (!sameIdentity(before, input.attempt.waveBase)) {
			return { outcome: "absent", failure: "Main drifted before worktree allocation." };
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
					const current = await this.inspectMain({ root: input.root }, context);
					if (!sameIdentity(current, input.attempt.waveBase)) {
						throw new Error("Main drifted after worktree preparation and before git worktree add.");
					}
				},
			);
			if (!created) return { outcome: "absent", failure: "Git worktree allocation requires a committed repository." };
			const worktree = cloneWorktree(created);
			createdWorktree = worktree;
			if (!prepared || worktree.baseCommit !== input.attempt.waveBase.head
				|| JSON.stringify(worktree) !== JSON.stringify(prepared)) {
				return {
					outcome: "unknown",
					failure: "Created worktree did not match its exact persisted preparation metadata.",
					possibleResources: [worktree.path, worktree.branch],
				};
			}
			const after = await this.inspectMain({ root: input.root }, context);
			if (!sameIdentity(after, input.attempt.waveBase)) {
				return {
					outcome: "unknown",
					failure: "Main drifted during worktree setup; the created worktree remains retained.",
					possibleResources: [worktree.path, worktree.branch],
				};
			}
			return { outcome: "owned", resourceId: worktree.path };
		} catch (error) {
			if (error instanceof WorktreeSetupError) {
				const attempted = cloneWorktree(error.worktree);
				return {
					outcome: "unknown",
					failure: text(error),
					possibleResources: [attempted.path, attempted.branch],
				};
			}
			if (createdWorktree) {
				return {
					outcome: "unknown",
					failure: `Created worktree could not be verified: ${text(error)}`,
					possibleResources: [createdWorktree.path, createdWorktree.branch],
				};
			}
			if (prepared) return { outcome: "absent", failure: text(error) };
			throw error;
		}
	}

	async reconcileWorktreeAllocation(input: {
		root: string;
		intent: AllocationIntent;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<AllocationReconciliation> {
		const worktree = input.intent.worktree;
		if (!worktree) return { outcome: "absent" };
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
			? { outcome: "possible", failure: "A possible prior Git allocation remains and was not adopted or removed.", possibleResources: possible }
			: { outcome: "absent" };
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
		launch: LaunchRecord;
	}, context: OperationContext): Promise<ReviewResult> {
		if (!this.executeReview) throw new Error("Exact Reviewer execution is not configured.");
		if (input.scope === "final") {
			if (input.phase !== "final" || input.attempt) throw new Error("Final review received task-scoped evidence.");
		} else {
			if (!input.attempt || input.phase === "final") throw new Error("Task review requires exact attempt evidence.");
			if (input.phase === "authoritative" && input.attempt.termination?.status !== "terminated") {
				throw new Error("Authoritative review requires exact recorded worker termination.");
			}
			const expectedBase = input.phase === "preliminary" ? input.attempt.waveBase : input.attempt.integrationBase;
			const expectedTip = input.phase === "preliminary" ? input.attempt.candidate : input.attempt.integrationCandidate;
			if (!expectedBase || !expectedTip || !sameIdentity(input.base, expectedBase) || !sameIdentity(input.tip, expectedTip)) {
				throw new Error(`${input.phase} review base or tip does not match the exact persisted task evidence.`);
			}
		}
		const cwd = await this.requireScopeIdentity({ ...input, candidate: input.tip }, context);
		const evidenceWorktree = input.scope === "final"
			? await realpath(oneLine(await this.requireGit(["rev-parse", "--show-toplevel"], input.root, context), "Main worktree root"))
			: worktreeIntent(input.attempt!).worktree.path;
		const evidence = await prepareExactReviewEvidence({
			base: input.base.head,
			tip: input.tip.head,
			worktree: evidenceWorktree,
		}, context.signal);
		try {
			if (evidence.base !== input.base.head || evidence.tip !== input.tip.head) {
				throw new Error("Exact review evidence resolved an unexpected base or tip.");
			}
			const reviewed = await this.executeReview({
				scope: input.scope,
				...(input.taskId ? { taskId: input.taskId } : {}),
				criterion: input.criterion,
				launch: input.launch,
				cwd,
				packet: { base: evidence.base, tip: evidence.tip, patchPath: evidence.patchPath },
			}, context);
			const identityAfter = await this.requireScopeCurrent({ ...input, candidate: input.tip }, context);
			return { verdict: reviewed.verdict, identityAfter };
		} finally {
			await evidence.cleanup();
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

	async inspectRetainedTask(input: { root: string; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<WorkspaceIdentity> {
		return await this.inspectTask(input.root, input.task, input.attempt, undefined, input.attempt.waveBase.head, context);
	}

	async rebase(input: {
		root: string;
		task: TaskRequest;
		attempt: TaskAttempt;
		candidate: WorkspaceIdentity;
		onto: WorkspaceIdentity;
	}, context: OperationContext): Promise<RebaseResult> {
		if (input.attempt.termination?.status !== "terminated"
			|| !sameIdentity(input.attempt.termination.candidate, input.candidate)) {
			return { outcome: "blocked", failure: "Task rebase requires exact recorded worker termination on the candidate." };
		}
		const main = await this.inspectMain({ root: input.root }, context);
		if (!sameIdentity(main, input.onto)) return { outcome: "drift", failure: "Main drifted before task rebase." };
		const current = await this.inspectTask(input.root, input.task, input.attempt, input.candidate, input.attempt.waveBase.head, context);
		if (input.attempt.waveBase.head === input.onto.head) {
			return { outcome: "ready", base: input.onto, candidate: current };
		}
		const worktree = worktreeIntent(input.attempt).worktree;
		const args = ["rebase", "--no-update-refs", "--no-autostash", input.onto.head];
		const rebased = await this.git(args, worktree.cwd, context);
		if (rebased.code !== 0 || rebased.killed) {
			let abortFailure = "The shared deadline expired before git rebase --abort could run.";
			if (!context.signal.aborted) {
				const aborted = await this.git(["rebase", "--abort"], worktree.cwd, context);
				abortFailure = aborted.code === 0 && !aborted.killed
					? "git rebase --abort restored the retained worktree."
					: `git rebase --abort failed; the retained worktree may still contain conflict state. ${commandFailure(["rebase", "--abort"], aborted)}`;
			}
			return { outcome: "blocked", failure: `${commandFailure(args, rebased)} ${abortFailure}` };
		}
		const candidate = await this.inspectTask(input.root, input.task, input.attempt, undefined, input.onto.head, context);
		const after = await this.inspectMain({ root: input.root }, context);
		if (!sameIdentity(after, input.onto)) return { outcome: "drift", failure: "Main drifted during task rebase." };
		return { outcome: "ready", base: input.onto, candidate };
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
		if (input.attempt.termination?.status !== "terminated") {
			return { outcome: "failed", failure: "Integration requires exact recorded worker termination." };
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
			const reviewerLaunchKey = launchKey("reviewer", input.task.judgment.modelClass);
			if (!reviewEvidencePasses(
				input.review,
				"authoritative",
				input.task.judgment.criterion,
				reviewerLaunchKey,
				input.expectedMain,
				input.candidate,
			) || !reviewEvidencePasses(
				input.attempt.authoritativeReview,
				"authoritative",
				input.task.judgment.criterion,
				reviewerLaunchKey,
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
			const intent = worktreeIntent(input.attempt);
			const worktree = intent.worktree;
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
		return input.scope === "final" ? input.root : worktreeIntent(input.attempt!).worktree.cwd;
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
		const worktree = worktreeIntent(attempt).worktree;
		if (worktree.baseCommit !== attempt.waveBase.head) {
			throw new Error(`Task ${task.id} worktree was not created from its recorded wave base.`);
		}
		if (await realpath(worktree.path) !== worktree.path) throw new Error(`Task ${task.id} worktree path changed.`);
		if (!(await this.registeredWorktreePaths(root, context)).includes(worktree.path)) {
			throw new Error(`Task ${task.id} worktree is not registered in the recorded repository.`);
		}
		const identity = await this.inspectWorkspace(worktree.cwd, true, context);
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

	private async assertNoGitlinks(cwd: string, context: OperationContext): Promise<void> {
		const index = await this.requireGit(["ls-files", "--stage", "-z"], cwd, context);
		if (index.split("\0").some((entry) => entry.startsWith("160000 "))) {
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
		if (!await this.branchExists(cwd, branch, context)) return;
		return oid(await this.requireGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], cwd, context), "branch tip");
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

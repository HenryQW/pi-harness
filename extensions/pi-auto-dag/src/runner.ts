import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import {
	addUsage,
	EphemeralSubagentError,
	type EphemeralSubagentResult,
} from "@henryqw/pi-subagent";
import { lock } from "proper-lockfile";
import {
	parseExecuteRequest,
	parseId,
	parseResumeRequest,
	parseRunState,
	RUN_STATE_VERSION,
	validateGraph,
	type CheckCommand,
	type CheckEvidence,
	type ExecuteRequest,
	type RunState,
	type TaskRequest,
	type TaskState,
	type WorkspaceIdentity,
} from "./schema.ts";

const STATE_MAX_BYTES = 2 * 1024 * 1024;
const EVIDENCE_MAX_BYTES = 8 * 1024;
const DEPENDENCY_OUTPUT_MAX_BYTES = 4 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const LOCK_OPTIONS = { realpath: false, stale: 30_000, update: 5_000, retries: 0 } as const;

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export interface ChildRunInput {
	kind: "worker" | "reviewer";
	role: string;
	modelClass: "fast" | "balanced";
	task: string;
	cwd: string;
	signal: AbortSignal;
	onLaunch?: () => Promise<void>;
}

export interface RunnerRuntime {
	now(): number;
	resolveRoot(cwd: string, signal?: AbortSignal): Promise<string>;
	assertClean(root: string, signal?: AbortSignal): Promise<void>;
	identifyWorkspace(root: string, signal?: AbortSignal): Promise<WorkspaceIdentity>;
	runChild(input: ChildRunInput): Promise<EphemeralSubagentResult>;
	exec(command: string, args: string[], options: { cwd: string; signal: AbortSignal; timeout: number }): Promise<CommandResult>;
}

export class PrelaunchFailure extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PrelaunchFailure";
	}
}

export interface RunResponse {
	text: string;
	state: RunState;
	usage?: Usage;
	drift?: { expected: WorkspaceIdentity; actual: WorkspaceIdentity };
}

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function bounded(value: string, maxBytes = EVIDENCE_MAX_BYTES): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
	return `${value.slice(0, end)}\n[truncated]`;
}

function errorText(error: unknown): string {
	return bounded(error instanceof Error ? error.message : String(error));
}

function sameWorkspace(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
	return left.branch === right.branch && left.head === right.head && left.index === right.index && left.tree === right.tree;
}

function sameCheck(left: CheckCommand, right: CheckCommand): boolean {
	return left.command === right.command
		&& left.args.length === right.args.length
		&& left.args.every((arg, index) => arg === right.args[index]);
}

function commandLabel(check: CheckCommand): string {
	return JSON.stringify({ command: check.command, args: check.args });
}

function taskById(state: RunState, id: string): TaskState {
	const task = state.tasks.find(({ request }) => request.id === id);
	if (!task) throw new Error(`Unknown task ID: ${id}.`);
	return task;
}

function runningElapsed(state: RunState, now: number): number {
	return state.elapsedMs + (state.activeSince === undefined ? 0 : Math.max(0, now - state.activeSince));
}

function remainingBudget(state: RunState, now: number): number {
	return Math.max(0, state.request.budgetMs - runningElapsed(state, now));
}

function errorUsage(error: unknown): Usage | undefined {
	return error instanceof EphemeralSubagentError ? error.usage : undefined;
}

export function taskPacket(state: RunState, task: TaskState): string {
	const dependencies = task.request.dependsOn.map((id) => {
		const dependency = taskById(state, id);
		return [
			`Dependency ${JSON.stringify(id)} deliverable: ${dependency.request.deliverable}`,
			`Accepted output:\n${bounded(dependency.output ?? "(no worker text)", DEPENDENCY_OUTPUT_MAX_BYTES)}`,
		].join("\n");
	});
	return [
		`Auto DAG task ${JSON.stringify(task.request.id)} for request ${JSON.stringify(state.request.id)}.`,
		`Goal: ${state.request.goal}`,
		"",
		"Original requirements:",
		task.request.requirements,
		"",
		`Expected deliverable: ${task.request.deliverable}`,
		...(dependencies.length ? ["", "Completed direct dependencies:", ...dependencies] : []),
		...(task.failure ? ["", "Actual prior failure evidence:", task.failure] : []),
		"",
		`Current workspace identity: ${JSON.stringify(state.workspace)}`,
		"Work directly in this shared managed Git workspace. One child runs at a time. Preserve completed dependency work.",
		state.request.commitsAllowed
			? "Commits are allowed. Stay on the current branch. Do not create worktrees, stash, reset, discard changes, push, or open a pull request."
			: "Commits are not allowed. Do not create worktrees, commit, stash, reset, discard changes, push, or open a pull request.",
		"Do not delegate recursively. Implement the deliverable, then report what changed. Your report is not acceptance; Auto DAG runs the declared checks.",
	].join("\n");
}

function reviewPacket(state: RunState, task: TaskState): string {
	return [
		`Review Auto DAG task ${JSON.stringify(task.request.id)} against this explicit criterion:`,
		task.request.judgment!.criterion,
		"",
		`Requirements: ${task.request.requirements}`,
		`Expected deliverable: ${task.request.deliverable}`,
		`Verified workspace: ${JSON.stringify(state.workspace)}`,
		"Declared checks passed:",
		...task.request.checks.map(commandLabel),
		"",
		"This is a read-only review in the shared workspace. Do not modify files or Git state.",
		"Reply with exactly PASS when the criterion is satisfied. Otherwise return concrete findings.",
	].join("\n");
}

function finalReviewPacket(state: RunState): string {
	return [
		`Review Auto DAG request ${JSON.stringify(state.request.id)} against this explicit final criterion:`,
		state.request.finalJudgment!.criterion,
		"",
		`Goal: ${state.request.goal}`,
		`Verified combined workspace: ${JSON.stringify(state.workspace)}`,
		"Final checks passed:",
		...state.request.finalChecks.map(commandLabel),
		"",
		"This is a read-only review in the shared workspace. Do not modify files or Git state.",
		"Reply with exactly PASS when the criterion is satisfied. Otherwise return concrete findings.",
	].join("\n");
}

export class FileRunStore {
	private readonly agentDir?: string;

	constructor(agentDir?: string) {
		this.agentDir = agentDir;
	}

	stateDirectory(root: string): string {
		const canonicalRoot = realpathSync.native(root);
		const directory = join(
			extensionConfigDir("pi-auto-dag", this.agentDir),
			"state",
			createHash("sha256").update(canonicalRoot).digest("hex"),
		);
		const fromRoot = relative(canonicalRoot, resolve(directory));
		if (fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
			throw new Error("Auto DAG state directory must be outside the Git workspace.");
		}
		return directory;
	}

	statePath(root: string, id: string): string {
		return join(this.stateDirectory(root), `${id}.json`);
	}

	private lockPath(root: string): string {
		return join(this.stateDirectory(root), "lifecycle.lock");
	}

	async withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
		await mkdir(this.stateDirectory(root), { recursive: true, mode: 0o700 });
		const release = await lock(this.lockPath(root), { ...LOCK_OPTIONS, lockfilePath: `${this.lockPath(root)}.lock` });
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	async load(root: string, id: string): Promise<RunState> {
		const raw = await readFile(this.statePath(root, id));
		if (raw.byteLength > STATE_MAX_BYTES) throw new Error(`pi-auto-dag state exceeds ${STATE_MAX_BYTES} bytes.`);
		const state = parseRunState(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
		if (state.root !== root || state.request.id !== id) throw new Error("pi-auto-dag state identity does not match its workspace and filename.");
		return state;
	}

	async loadIfPresent(root: string, id: string): Promise<RunState | undefined> {
		try {
			return await this.load(root, id);
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
	}

	async list(root: string): Promise<RunState[]> {
		let entries;
		try {
			entries = await readdir(this.stateDirectory(root), { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
		const states: RunState[] = [];
		for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
			states.push(await this.load(root, entry.name.slice(0, -5)));
		}
		return states;
	}

	async save(state: RunState): Promise<void> {
		const contents = `${JSON.stringify(state, null, 2)}\n`;
		if (Buffer.byteLength(contents, "utf8") > STATE_MAX_BYTES) throw new Error(`pi-auto-dag state exceeds ${STATE_MAX_BYTES} bytes.`);
		await mkdir(this.stateDirectory(state.root), { recursive: true, mode: 0o700 });
		const temporary = `${this.statePath(state.root, state.request.id)}.${process.pid}.${randomUUID()}.tmp`;
		let handle: import("node:fs/promises").FileHandle | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(contents, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, this.statePath(state.root, state.request.id));
		} finally {
			await handle?.close();
			await rm(temporary, { force: true });
		}
	}
}

class BudgetExpired extends Error {
	constructor() {
		super("The total Auto DAG elapsed budget is exhausted.");
	}
}

class AbortRequested extends Error {
	constructor() {
		super("Auto DAG abort requested by Main.");
	}
}

type UsageMeter = { usage?: Usage };
type ActiveRun = { id: string; controller: AbortController; state: RunState };
type VerificationFailure = { message: string; correctable: boolean };

export class AutoDagRunner {
	private readonly active = new Map<string, ActiveRun>();

	private readonly runtime: RunnerRuntime;
	private readonly store: FileRunStore;

	constructor(runtime: RunnerRuntime, store = new FileRunStore()) {
		this.runtime = runtime;
		this.store = store;
	}

	async execute(value: unknown, cwd: string, signal?: AbortSignal): Promise<RunResponse> {
		const request = parseExecuteRequest(value);
		const root = await this.runtime.resolveRoot(cwd, signal);
		return await this.store.withLock(root, async () => {
			if (await this.store.loadIfPresent(root, request.id)) throw new Error(`Auto DAG request ${request.id} already exists.`);
			await this.runtime.assertClean(root, signal);
			const workspace = await this.runtime.identifyWorkspace(root, signal);
			const now = this.runtime.now();
			const state: RunState = {
				version: RUN_STATE_VERSION,
				request,
				root,
				baseHead: workspace.head,
				status: "pending",
				tasks: request.tasks.map((task) => ({ request: task, status: "pending", attempts: 0, checks: [] })),
				final: { status: "pending", checks: [] },
				workspace,
				elapsedMs: 0,
				manualInterventions: 0,
				accepted: false,
				createdAt: now,
				updatedAt: now,
			};
			await this.store.save(state);
			return await this.runLocked(state, signal);
		});
	}

	async resume(value: unknown, cwd: string, signal?: AbortSignal): Promise<RunResponse> {
		const request = parseResumeRequest(value);
		const root = await this.runtime.resolveRoot(cwd, signal);
		return await this.store.withLock(root, async () => {
			const state = await this.store.load(root, request.id);
			this.recoverState(state);
			if (state.accepted) throw new Error(`Auto DAG request ${request.id} is already accepted.`);
			state.manualInterventions += 1;
			const actual = await this.runtime.identifyWorkspace(root, signal);
			if (actual.branch !== state.workspace.branch) {
				state.status = "needs_attention";
				state.updatedAt = this.runtime.now();
				await this.store.save(state);
				throw new Error(`Workspace branch drifted from ${state.workspace.branch} to ${actual.branch}; Auto DAG will not switch it.`);
			}
			if (!state.request.commitsAllowed && actual.head !== state.baseHead) {
				state.status = "needs_attention";
				state.updatedAt = this.runtime.now();
				await this.store.save(state);
				throw new Error("Workspace HEAD changed although this request forbids commits.");
			}

			if (request.action === "approve_final_judgment") {
				if (!state.request.finalJudgment) throw new Error("This request has no final judgment criterion.");
				if (!state.final.verifiedWorkspace || !sameWorkspace(actual, state.final.verifiedWorkspace)) {
					throw new Error("Final judgment cannot be approved because the workspace differs from the final checked state.");
				}
				if (!state.final.checks.length || state.request.finalChecks.some((check) =>
					!state.final.checks.some((evidence) => evidence.passed && sameCheck(evidence, check) && sameWorkspace(evidence.workspace, actual)))) {
					throw new Error("Final judgment cannot be approved before every final check passes on this workspace.");
				}
				state.accepted = true;
				state.acceptedAt = this.runtime.now();
				state.status = "completed";
				state.final.status = "completed";
				state.final.failure = undefined;
				state.updatedAt = this.runtime.now();
				await this.store.save(state);
				return this.response(state, {});
			}

			state.workspace = actual;
			if (request.action === "retry") {
				const task = taskById(state, request.taskId);
				this.requireUnfinishedAttention(task);
				if (task.attempts >= 2) throw new Error(`Task ${task.request.id} already used both launched attempts; repair it manually and use verify.`);
				task.status = "pending";
			} else if (request.action === "replace") {
				const task = taskById(state, request.task.id);
				this.requireUnfinishedAttention(task);
				if (task.attempts >= 2) throw new Error(`Task ${task.request.id} already used both launched attempts; repair it manually and use verify.`);
				const definitions = state.request.tasks.map((candidate) => candidate.id === request.task.id ? request.task : candidate);
				validateGraph(definitions);
				state.request = { ...state.request, tasks: definitions };
				task.request = request.task;
				task.status = "pending";
			} else if (request.action === "verify") {
				const task = taskById(state, request.taskId);
				this.requireUnfinishedAttention(task);
				state.updatedAt = this.runtime.now();
				await this.store.save(state);
				return await this.runLocked(state, signal, task);
			} else {
				if (state.tasks.some(({ status }) => status !== "completed")) throw new Error("Final verification requires every task to be completed.");
				state.final.status = "pending";
			}
			state.status = "pending";
			state.updatedAt = this.runtime.now();
			await this.store.save(state);
			return await this.runLocked(state, signal);
		});
	}

	async status(value: unknown, cwd: string): Promise<RunResponse> {
		const id = parseId(value);
		const root = await this.runtime.resolveRoot(cwd);
		if (!this.active.has(root)) {
			try {
				await this.store.withLock(root, async () => {
					const state = await this.store.load(root, id);
					if (this.recoverState(state)) await this.store.save(state);
				});
			} catch (error) {
				if (!(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ELOCKED")) throw error;
			}
		}
		const state = await this.store.load(root, id);
		const actual = await this.runtime.identifyWorkspace(root);
		return this.response(state, {}, sameWorkspace(actual, state.workspace) ? {} : {
			drift: { expected: state.workspace, actual },
		});
	}

	async abort(value: unknown, cwd: string): Promise<RunResponse> {
		const id = parseId(value);
		const root = await this.runtime.resolveRoot(cwd);
		const active = this.active.get(root);
		if (active?.id === id) {
			active.controller.abort(new AbortRequested());
			return { text: `Abort requested for Auto DAG ${id}.`, state: active.state };
		}
		return await this.store.withLock(root, async () => {
			const state = await this.store.load(root, id);
			this.recoverState(state);
			if (!state.accepted) {
				const unfinished = state.tasks.find(({ status }) => status !== "completed");
				if (unfinished) {
					unfinished.status = "needs_attention";
					unfinished.failure = "Auto DAG aborted by Main before this task completed.";
				} else {
					state.final.status = "needs_attention";
					state.final.failure = "Auto DAG aborted by Main before request acceptance.";
				}
				state.status = "needs_attention";
				state.manualInterventions += 1;
				state.updatedAt = this.runtime.now();
				await this.store.save(state);
			}
			return this.response(state, {});
		});
	}

	async recover(cwd: string): Promise<void> {
		const root = await this.runtime.resolveRoot(cwd);
		try {
			await this.store.withLock(root, async () => {
				for (const state of await this.store.list(root)) {
					if (this.recoverState(state)) await this.store.save(state);
				}
			});
		} catch (error) {
			if (!(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ELOCKED")) throw error;
		}
	}

	private requireUnfinishedAttention(task: TaskState): void {
		if (task.status === "completed") throw new Error(`Completed task ${task.request.id} cannot be retried or replaced.`);
		if (task.status !== "needs_attention") throw new Error(`Task ${task.request.id} is not waiting for deliberate attention.`);
	}

	private recoverState(state: RunState): boolean {
		if (state.status !== "running" && !state.tasks.some(({ status }) => status === "running") && state.final.status !== "running") return false;
		const now = this.runtime.now();
		if (state.activeSince !== undefined) state.elapsedMs += Math.max(0, now - state.activeSince);
		state.activeSince = undefined;
		const running = state.tasks.filter(({ status }) => status === "running");
		for (const task of running) {
			task.status = "needs_attention";
			task.failure = "Execution was interrupted while this task might have changed the shared workspace. It will not replay automatically.";
		}
		if (!running.length) {
			const pending = state.tasks.find(({ status }) => status === "pending");
			if (pending) {
				pending.status = "needs_attention";
				pending.failure = "Execution stopped at an uncertain boundary. This task will not replay automatically.";
			} else if (state.final.status !== "completed") {
				state.final.status = "needs_attention";
				state.final.failure = "Execution stopped during final verification. It will not replay automatically.";
			}
		}
		state.status = "needs_attention";
		state.updatedAt = now;
		return true;
	}

	private async runLocked(state: RunState, outerSignal?: AbortSignal, manualTask?: TaskState): Promise<RunResponse> {
		const meter: UsageMeter = {};
		const controller = new AbortController();
		const signals = [controller.signal, ...(outerSignal ? [outerSignal] : [])];
		const signal = signals.length === 1 ? controller.signal : AbortSignal.any(signals);
		const remaining = remainingBudget(state, this.runtime.now());
		if (remaining <= 0) {
			this.markBudgetFailure(state, manualTask);
			await this.store.save(state);
			return this.response(state, meter);
		}
		if (manualTask) manualTask.status = "running";
		const timer = setTimeout(() => controller.abort(new BudgetExpired()), remaining);
		timer.unref();
		this.active.set(state.root, { id: state.request.id, controller, state });
		state.status = "running";
		state.activeSince = this.runtime.now();
		state.updatedAt = this.runtime.now();
		await this.store.save(state);
		try {
			if (manualTask) {
				const failure = await this.verifyTask(state, manualTask, signal, meter);
				if (failure) {
					manualTask.status = "needs_attention";
					manualTask.failure = failure.message;
					state.status = "needs_attention";
					return this.response(state, meter);
				}
				manualTask.status = "completed";
				manualTask.output = "Manually verified by Main; declared checks and any explicit review passed.";
				manualTask.failure = undefined;
				manualTask.verifiedWorkspace = state.workspace;
				await this.store.save(state);
			}

			while (state.tasks.some(({ status }) => status !== "completed")) {
				signal.throwIfAborted();
				const ready = state.tasks.find((task) => task.status === "pending"
					&& task.request.dependsOn.every((dependency) => taskById(state, dependency).status === "completed"));
				if (!ready) {
					state.status = "needs_attention";
					return this.response(state, meter);
				}
				const drift = await this.runtime.identifyWorkspace(state.root, signal);
				if (!sameWorkspace(drift, state.workspace)) {
					ready.status = "needs_attention";
					ready.failure = `Workspace drift before launch. Expected ${JSON.stringify(state.workspace)}; actual ${JSON.stringify(drift)}.`;
					state.status = "needs_attention";
					return this.response(state, meter);
				}
				const result = await this.attemptTask(state, ready, signal, meter);
				if (result === "completed") continue;
				if (result === "correctable" && ready.attempts < 2 && remainingBudget(state, this.runtime.now()) > 0) {
					ready.status = "pending";
					await this.store.save(state);
					continue;
				}
				ready.status = "needs_attention";
				state.status = "needs_attention";
				return this.response(state, meter);
			}

			const finalFailure = await this.verifyFinal(state, signal, meter);
			if (finalFailure) {
				state.final.status = "needs_attention";
				state.final.failure = finalFailure;
				state.status = "needs_attention";
				state.accepted = false;
				return this.response(state, meter);
			}
			state.final.status = "completed";
			state.final.failure = undefined;
			state.final.verifiedWorkspace = state.workspace;
			state.status = "completed";
			state.accepted = true;
			state.acceptedAt = this.runtime.now();
			return this.response(state, meter);
		} catch (error) {
			const nestedUsage = errorUsage(error);
			meter.usage = addUsage(meter.usage, nestedUsage);
			state.usage = addUsage(state.usage, nestedUsage);
			const task = state.tasks.find(({ status }) => status === "running");
			if (task) {
				task.status = "needs_attention";
				task.failure = error instanceof BudgetExpired || signal.reason instanceof BudgetExpired
					? "The total elapsed run budget was exhausted."
					: `Execution stopped: ${errorText(error)}`;
			} else {
				state.final.status = "needs_attention";
				state.final.failure = error instanceof BudgetExpired || signal.reason instanceof BudgetExpired
					? "The total elapsed run budget was exhausted."
					: `Execution stopped: ${errorText(error)}`;
			}
			state.status = "needs_attention";
			state.accepted = false;
			return this.response(state, meter);
		} finally {
			clearTimeout(timer);
			if (state.activeSince !== undefined) {
				state.elapsedMs += Math.max(0, this.runtime.now() - state.activeSince);
				state.activeSince = undefined;
			}
			if (controller.signal.reason instanceof AbortRequested) {
				state.manualInterventions += 1;
				if (state.status !== "needs_attention") {
					const task = state.tasks.find(({ status }) => status === "running");
					if (task) {
						task.status = "needs_attention";
						task.failure = "Execution stopped: Auto DAG abort requested by Main.";
					} else {
						state.final.status = "needs_attention";
						state.final.failure = "Execution stopped: Auto DAG abort requested by Main.";
					}
					state.status = "needs_attention";
					state.accepted = false;
				}
			}
			state.updatedAt = this.runtime.now();
			this.active.delete(state.root);
			await this.store.save(state);
		}
	}

	private markBudgetFailure(state: RunState, task?: TaskState): void {
		const target = task ?? state.tasks.find(({ status }) => status !== "completed");
		if (target) {
			target.status = "needs_attention";
			target.failure = "The total elapsed run budget is exhausted.";
		} else {
			state.final.status = "needs_attention";
			state.final.failure = "The total elapsed run budget is exhausted.";
		}
		state.status = "needs_attention";
		state.accepted = false;
		state.updatedAt = this.runtime.now();
	}

	private async attemptTask(
		state: RunState,
		task: TaskState,
		signal: AbortSignal,
		meter: UsageMeter,
	): Promise<"completed" | "correctable" | "attention"> {
		task.status = "running";
		state.updatedAt = this.runtime.now();
		await this.store.save(state);
		let child: EphemeralSubagentResult;
		try {
			child = await this.runtime.runChild({
				kind: "worker",
				role: task.request.role,
				modelClass: task.request.modelClass,
				task: taskPacket(state, task),
				cwd: state.root,
				signal,
				onLaunch: async () => {
					task.attempts += 1;
					state.updatedAt = this.runtime.now();
					await this.store.save(state);
				},
			});
		} catch (error) {
			const nestedUsage = errorUsage(error);
			meter.usage = addUsage(meter.usage, nestedUsage);
			state.usage = addUsage(state.usage, nestedUsage);
			task.failure = signal.reason instanceof BudgetExpired
				? "The total elapsed run budget was exhausted."
				: `${error instanceof PrelaunchFailure ? "Prelaunch" : "Child infrastructure"} failure: ${errorText(error)}`;
			await this.store.save(state);
			return "attention";
		}
		meter.usage = addUsage(meter.usage, child.usage);
		state.usage = addUsage(state.usage, child.usage);
		if (child.outcome === "success") task.output = bounded(child.output);
		await this.store.save(state);
		const after = await this.runtime.identifyWorkspace(state.root, signal);
		const transitionFailure = this.workspaceTransitionFailure(state, after);
		state.workspace = after;
		if (transitionFailure) {
			task.failure = transitionFailure;
			return "attention";
		}
		if (child.outcome === "failure") {
			task.failure = `Child infrastructure failure: ${bounded(child.errorMessage || child.stderr || child.output || `exit ${child.exitCode}`)}`;
			return "attention";
		}
		const failure = await this.verifyTask(state, task, signal, meter);
		if (failure) {
			task.failure = failure.message;
			return failure.correctable ? "correctable" : "attention";
		}
		task.status = "completed";
		task.failure = undefined;
		task.verifiedWorkspace = state.workspace;
		state.updatedAt = this.runtime.now();
		await this.store.save(state);
		return "completed";
	}

	private workspaceTransitionFailure(state: RunState, after: WorkspaceIdentity): string | undefined {
		if (after.branch !== state.workspace.branch) return `Worker changed branches from ${state.workspace.branch} to ${after.branch}.`;
		if (!state.request.commitsAllowed && after.head !== state.workspace.head) return "Worker committed although commits are forbidden.";
		return;
	}

	private async verifyTask(
		state: RunState,
		task: TaskState,
		signal: AbortSignal,
		meter: UsageMeter,
	): Promise<VerificationFailure | undefined> {
		const checkFailure = await this.runChecks(state, task.request.checks, task.checks, signal);
		if (checkFailure) return checkFailure;
		if (!task.request.judgment) return;
		const before = state.workspace;
		let review: EphemeralSubagentResult;
		try {
			review = await this.runtime.runChild({
				kind: "reviewer",
				role: task.request.judgment.role,
				modelClass: task.request.judgment.modelClass,
				task: reviewPacket(state, task),
				cwd: state.root,
				signal,
			});
		} catch (error) {
			const nestedUsage = errorUsage(error);
			meter.usage = addUsage(meter.usage, nestedUsage);
			state.usage = addUsage(state.usage, nestedUsage);
			await this.store.save(state);
			if (signal.reason instanceof BudgetExpired) throw signal.reason;
			return {
				message: `${error instanceof PrelaunchFailure ? "Reviewer prelaunch" : "Reviewer infrastructure"} failure: ${errorText(error)}`,
				correctable: false,
			};
		}
		meter.usage = addUsage(meter.usage, review.usage);
		state.usage = addUsage(state.usage, review.usage);
		await this.store.save(state);
		const after = await this.runtime.identifyWorkspace(state.root, signal);
		state.workspace = after;
		if (!sameWorkspace(before, after)) {
			return { message: `Reviewer mutated the workspace. Before ${JSON.stringify(before)}; after ${JSON.stringify(after)}.`, correctable: false };
		}
		if (review.outcome === "failure") {
			return { message: `Reviewer infrastructure failure: ${bounded(review.errorMessage || review.stderr || review.output || `exit ${review.exitCode}`)}`, correctable: false };
		}
		if (review.output.trim() !== "PASS") {
			return { message: `Reviewer did not approve the explicit criterion:\n${bounded(review.output)}`, correctable: true };
		}
		return;
	}

	private async verifyFinal(
		state: RunState,
		signal: AbortSignal,
		meter: UsageMeter,
	): Promise<string | undefined> {
		state.final.status = "running";
		await this.store.save(state);
		const drift = await this.runtime.identifyWorkspace(state.root, signal);
		if (!sameWorkspace(drift, state.workspace)) return `Workspace drift before final checks. Expected ${JSON.stringify(state.workspace)}; actual ${JSON.stringify(drift)}.`;
		const checkFailure = await this.runChecks(state, state.request.finalChecks, state.final.checks, signal);
		if (checkFailure) return `Final verification failed: ${checkFailure.message}`;
		state.final.verifiedWorkspace = state.workspace;
		if (!state.request.finalJudgment) return;
		const before = state.workspace;
		let review: EphemeralSubagentResult;
		try {
			review = await this.runtime.runChild({
				kind: "reviewer",
				role: state.request.finalJudgment.role,
				modelClass: state.request.finalJudgment.modelClass,
				task: finalReviewPacket(state),
				cwd: state.root,
				signal,
			});
		} catch (error) {
			const nestedUsage = errorUsage(error);
			meter.usage = addUsage(meter.usage, nestedUsage);
			state.usage = addUsage(state.usage, nestedUsage);
			await this.store.save(state);
			if (signal.reason instanceof BudgetExpired) throw signal.reason;
			return `${error instanceof PrelaunchFailure ? "Final Reviewer prelaunch" : "Final Reviewer infrastructure"} failure: ${errorText(error)}`;
		}
		meter.usage = addUsage(meter.usage, review.usage);
		state.usage = addUsage(state.usage, review.usage);
		await this.store.save(state);
		const after = await this.runtime.identifyWorkspace(state.root, signal);
		state.workspace = after;
		if (!sameWorkspace(before, after)) return `Final Reviewer mutated the workspace. Before ${JSON.stringify(before)}; after ${JSON.stringify(after)}.`;
		if (review.outcome === "failure") return `Final Reviewer infrastructure failure: ${bounded(review.errorMessage || review.stderr || review.output || `exit ${review.exitCode}`)}`;
		if (review.output.trim() !== "PASS") return `Final judgment remains unverified:\n${bounded(review.output)}`;
		return;
	}

	private async runChecks(
		state: RunState,
		checks: readonly CheckCommand[],
		evidence: CheckEvidence[],
		signal: AbortSignal,
	): Promise<VerificationFailure | undefined> {
		for (const check of checks) {
			const before = await this.runtime.identifyWorkspace(state.root, signal);
			if (!sameWorkspace(before, state.workspace)) {
				return {
					message: `Workspace drift before check ${commandLabel(check)}. Expected ${JSON.stringify(state.workspace)}; actual ${JSON.stringify(before)}.`,
					correctable: false,
				};
			}
			const existing = [...state.tasks.flatMap((task) => task.checks), ...state.final.checks]
				.find((candidate) => candidate.passed && sameCheck(candidate, check) && sameWorkspace(candidate.workspace, before));
			if (existing) {
				if (!evidence.includes(existing)) evidence.push(existing);
				continue;
			}
			const remaining = remainingBudget(state, this.runtime.now());
			if (remaining <= 0) throw new BudgetExpired();
			let result: CommandResult;
			let executionFailed = false;
			try {
				result = await this.runtime.exec(check.command, [...check.args], { cwd: state.root, signal, timeout: remaining });
			} catch (error) {
				executionFailed = true;
				result = { code: -1, stdout: "", stderr: errorText(error), killed: signal.aborted };
			}
			const after = await this.runtime.identifyWorkspace(state.root, signal);
			const unchanged = sameWorkspace(before, after);
			const passed = result.code === 0 && !result.killed && unchanged;
			const record: CheckEvidence = {
				...check,
				args: [...check.args],
				workspace: before,
				code: result.code,
				stdout: bounded(result.stdout),
				stderr: bounded(result.stderr),
				passed,
				at: this.runtime.now(),
			};
			evidence.push(record);
			state.workspace = after;
			state.updatedAt = this.runtime.now();
			await this.store.save(state);
			if (!unchanged) {
				return {
					message: `Check ${commandLabel(check)} mutated the workspace. Before ${JSON.stringify(before)}; after ${JSON.stringify(after)}.`,
					correctable: false,
				};
			}
			if (!passed) {
				return {
					message: `Check ${commandLabel(check)} failed with exit ${result.code}${result.killed ? " (killed)" : ""}.\n${bounded(result.stderr || result.stdout)}`,
					correctable: !executionFailed,
				};
			}
		}
		return;
	}

	private response(state: RunState, meter: UsageMeter, extra: Pick<RunResponse, "drift"> = {}): RunResponse {
		const completed = state.tasks.filter(({ status }) => status === "completed").length;
		const attention = state.tasks.find(({ status }) => status === "needs_attention");
		const text = [
			`Auto DAG ${state.request.id}: ${state.status}.`,
			`Tasks: ${completed}/${state.tasks.length} completed. Attempts: ${state.tasks.reduce((sum, task) => sum + task.attempts, 0)}.`,
			`Elapsed: ${runningElapsed(state, this.runtime.now())}/${state.request.budgetMs} ms. Accepted: ${state.accepted}.`,
			...(attention?.failure ? [`Needs attention (${attention.request.id}): ${attention.failure}`] : []),
			...(state.final.failure ? [`Final: ${state.final.failure}`] : []),
			...(extra.drift ? ["Workspace drift detected; resume must be deliberate."] : []),
		].join("\n");
		return { text: bounded(text), state, ...(meter.usage === undefined ? {} : { usage: meter.usage }), ...extra };
	}
}

export type ExecCommand = (
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<CommandResult>;

async function requireCommand(
	exec: ExecCommand,
	command: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeout = GIT_TIMEOUT_MS,
): Promise<string> {
	const result = await exec(command, args, { cwd, signal, timeout });
	if (result.code !== 0 || result.killed) {
		throw new Error(`${command} ${args.join(" ")} failed: ${bounded(result.stderr || result.stdout || `exit ${result.code}`)}`);
	}
	return result.stdout.trim();
}

function oid(value: string, field: string): string {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error(`Git returned invalid ${field}.`);
	return value;
}

export async function resolveGitRoot(exec: ExecCommand, cwd: string, signal?: AbortSignal): Promise<string> {
	const root = await requireCommand(exec, "git", ["rev-parse", "--show-toplevel"], cwd, signal);
	if (!root || /[\r\n\0]/.test(root)) throw new Error("Git returned an invalid workspace root.");
	return root;
}

export async function assertCleanGitWorkspace(exec: ExecCommand, root: string, signal?: AbortSignal): Promise<void> {
	const index = await requireCommand(exec, "git", ["ls-files", "--stage"], root, signal);
	if (index.split("\n").some((line) => line.startsWith("160000 "))) {
		throw new Error("Auto DAG does not support Git repositories containing submodules.");
	}
	await requireCommand(exec, "git", ["update-index", "--really-refresh"], root, signal).catch((error) => {
		if (!String(error).includes("exit 1")) throw error;
	});
	const status = await requireCommand(exec, "git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], root, signal);
	if (status) throw new Error(`Auto DAG requires a clean Git workspace. It will not stash, reset, or discard changes.\n${bounded(status)}`);
	const flags = await requireCommand(exec, "git", ["ls-files", "-v"], root, signal);
	if (flags.split("\n").some((line) => /^[a-zS]/.test(line))) {
		throw new Error("Auto DAG requires a Git index without assume-unchanged or skip-worktree entries.");
	}
}

async function requireGitWithIndex(args: string[], root: string, index: string, signal?: AbortSignal): Promise<string> {
	return await new Promise<string>((resolveOutput, reject) => {
		execFile("git", args, {
			cwd: root,
			env: { ...process.env, GIT_INDEX_FILE: index },
			signal,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: EVIDENCE_MAX_BYTES,
			encoding: "utf8",
		}, (error, stdout, stderr) => {
			if (!error) return resolveOutput(stdout.trim());
			if (signal?.aborted) return reject(signal.reason);
			reject(new Error(`git ${args.join(" ")} failed: ${bounded(stderr || stdout || error.message)}`));
		});
	});
}

export async function identifyGitWorkspace(exec: ExecCommand, root: string, signal?: AbortSignal): Promise<WorkspaceIdentity> {
	const branch = await requireCommand(exec, "git", ["symbolic-ref", "--quiet", "HEAD"], root, signal);
	if (!branch || /[\r\n\0]/.test(branch)) throw new Error("Git returned an invalid branch reference.");
	const head = oid(await requireCommand(exec, "git", ["rev-parse", "--verify", "HEAD^{commit}"], root, signal), "HEAD");
	const indexPath = await requireCommand(exec, "git", ["rev-parse", "--git-path", "index"], root, signal);
	if (!indexPath || /[\r\n\0]/.test(indexPath)) throw new Error("Git returned an invalid index path.");
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-dag-index-"));
	const indexCopy = join(directory, "real-index");
	const workspaceIndex = join(directory, "workspace-index");
	try {
		await copyFile(resolve(root, indexPath), indexCopy);
		const index = oid(await requireGitWithIndex(["write-tree"], root, indexCopy, signal), "index tree");
		await requireGitWithIndex(["read-tree", "HEAD"], root, workspaceIndex, signal);
		await requireGitWithIndex(["add", "-A", "--", "."], root, workspaceIndex, signal);
		const tree = oid(await requireGitWithIndex(["write-tree"], root, workspaceIndex, signal), "workspace tree");
		return { branch, head, index, tree };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EphemeralSubagentExecutor } from "../src/ephemeral.ts";
import { ROLE_TOOL_POLICY_FLAG } from "../src/index.ts";
import type { EffectiveExecutionPolicy } from "./config.ts";
import {
	createCanonicalGitRootResolver,
	createExactJudgmentExecutor,
} from "../src/composition.ts";
import {
	CheckedGitRuntime,
	type DirectProcessRunner,
} from "../src/git-runtime.ts";
import { HerdrHostRuntime } from "../src/herdr-runtime.ts";
import { runProcess as directRunProcess } from "../src/process.ts";
import { RoleLaunchRuntime, type LaunchRuntimeOptions } from "../src/launch-runtime.ts";
import { IsolatedRunner, type OperationContext, type RunResponse } from "../src/runner.ts";
import {
	IdOnlySchema,
	ResumeRequestSchema,
	StageRequestSchema,
	IntegrationActionSchema,
	parseIntegrationAction,
	parseStageRequest,
	parseExecuteRequest,
	parseIdOnly,
	parseResumeRequest,
	sameIdentity,
	type CheckBatchEvidence,
	type ModelClass,
	type ReviewEvidence,
	type RunState,
	type WorktreeAllocationIntent,
	type WorkspaceAllocationIntent,
} from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

const LOOKUP_ROOT_TIMEOUT_MS = 5_000;
const PUBLIC_EVIDENCE_MAX_BYTES = 512;
const WORKSPACE_WIDGET_KEY = "pi-subagent-workspaces";
const WIDGET_FIELD_MAX_CHARS = 32;

export interface IsolatedExtensionComponents {
	runner: IsolatedRunner;
	resolveRoot: LaunchRuntimeOptions["resolveRoot"];
}

export type CreateIsolatedComponents = (options: {
	pi: ExtensionAPI;
	context(): ExtensionContext;
	executor: EphemeralSubagentExecutor;
	policy: EffectiveExecutionPolicy;
	currentPolicy(): EffectiveExecutionPolicy;
	onStateSaved(state: RunState): void;
}) => IsolatedExtensionComponents;

/** Construct the checked runtime while reusing the unified productive-assignment executor. */
export const createIsolatedComponents: CreateIsolatedComponents = ({
	pi, context, executor, policy, currentPolicy, onStateSaved,
}) => {
	const runProcess: DirectProcessRunner = async (command, args, options) => options.stdin === undefined
		? await pi.exec(command, args, { cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs })
		: await directRunProcess(command, args, options);
	const resolveRoot = createCanonicalGitRootResolver({ runProcess });
	const git = new CheckedGitRuntime({ runProcess, executeReview: createExactJudgmentExecutor(executor) });
	const host = new HerdrHostRuntime({ inspectInFlightTaskCandidate: git.inspectInFlightTaskCandidate.bind(git), runProcess });
	const coordinator = new RoleLaunchRuntime({
		pi,
		context,
		resolveRoot,
		preflightHost: async ({ root }, operation) => await host.preflightHost({ root }, operation),
		inspectMain: async (input, operation) => await git.inspectMain(input, operation),
		executionBudget: () => ({
			maxTurns: policy.maxTurns,
			maxMs: null,
			...(policy.maxTokens === undefined ? {} : { maxTokens: policy.maxTokens }),
		}),
	});
	return {
		resolveRoot,
		runner: new IsolatedRunner(
			coordinator,
			host,
			git,
			new FileRunStore(undefined, onStateSaved),
			executor,
			policy,
			currentPolicy,
		),
	};
};

function compactWidgetField(value: string): string {
	const characters = [...value];
	return characters.length <= WIDGET_FIELD_MAX_CHARS
		? value
		: `${characters.slice(0, WIDGET_FIELD_MAX_CHARS - 1).join("")}~`;
}

function workspaceBadge(role: string, modelClass: ModelClass): string {
	const modelCode = { fast: "1", balanced: "2", frontier: "3", fav: "*" }[modelClass];
	return `[${Array.from(role)[0]!.toUpperCase()}${modelCode}]`;
}

function workspaceStatus(status: RunState["tasks"][number]["status"]): string {
	switch (status) {
		case "ready_to_integrate": return "ready";
		case "needs_attention": return "attention";
		default: return status;
	}
}

export function workspaceWidgetLines(state: RunState): string[] | undefined {
	const rows = state.tasks.flatMap((taskState) => {
		if (taskState.kind !== "changeset") return [];
		const attempt = taskState.attempts.at(-1);
		const allocation = [...(attempt?.allocations ?? [])].reverse().find(
			(candidate): candidate is WorkspaceAllocationIntent =>
				candidate.kind === "workspace" && candidate.status !== "absent",
		);
		const workspaceCleanup = attempt?.cleanup.find((step) => step.kind === "workspace");
		if (!allocation || workspaceCleanup?.status === "completed") return [];
		const task = state.request.tasks.find((candidate) => candidate.id === taskState.taskId);
		if (!task || task.kind !== "changeset") return [];
		const status = state.status === "aborted" ? "aborted" : workspaceStatus(taskState.status);
		return `${workspaceBadge(task.role, task.modelClass)} ${compactWidgetField(allocation.label)} · ${status} · ${compactWidgetField(task.id)}`;
	});
	return rows.length ? rows : undefined;
}

function updateWorkspaceWidget(ctx: ExtensionContext, state: RunState, rowsByRequest: Map<string, string[]>): void {
	const key = `${state.root}\0${state.request.id}`;
	const rows = workspaceWidgetLines(state);
	if (rows) rowsByRequest.set(key, rows);
	else rowsByRequest.delete(key);
	if (!ctx.hasUI) return;
	const allRows = [...rowsByRequest.values()].flat();
	ctx.ui.setWidget(WORKSPACE_WIDGET_KEY, allRows.length ? allRows : undefined);
}

function updateWorkspaceWidgetSafely(ctx: ExtensionContext, state: RunState, rowsByRequest: Map<string, string[]>): void {
	try {
		updateWorkspaceWidget(ctx, state, rowsByRequest);
	} catch (error) {
		console.error("Pi Subagent workspace widget update failed.", error);
	}
}

function boundedPublicText(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= PUBLIC_EVIDENCE_MAX_BYTES) return value;
	let end = Math.min(value.length, PUBLIC_EVIDENCE_MAX_BYTES);
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > PUBLIC_EVIDENCE_MAX_BYTES) end -= 1;
	return `${value.slice(0, end)}\n[truncated]`;
}

function publicFailedCheck(evidence: CheckBatchEvidence | undefined) {
	if (!evidence || evidence.passed) return undefined;
	const result = evidence.results.find((candidate) => candidate.code !== 0 || candidate.killed)
		?? evidence.results.at(-1);
	return {
		phase: evidence.phase,
		identityChanged: !sameIdentity(evidence.candidate, evidence.identityAfter),
		...(result ? {
			command: boundedPublicText([result.command, ...result.args.map((arg) => JSON.stringify(arg))].join(" ")),
			code: result.code,
			killed: result.killed,
			...(result.stdout ? { stdout: boundedPublicText(result.stdout) } : {}),
			...(result.stderr ? { stderr: boundedPublicText(result.stderr) } : {}),
		} : {}),
	};
}

function publicFailedReview(evidence: ReviewEvidence | undefined) {
	if (!evidence || evidence.passed) return undefined;
	return {
		phase: evidence.phase,
		verdict: boundedPublicText(evidence.verdict),
		identityChanged: !sameIdentity(evidence.tip, evidence.identityAfter),
	};
}

function publicTaskRecovery(task: RunState["tasks"][number]) {
	if (task.kind === "text") {
		const attempt = task.attempts.at(-1);
		return {
			scope: "task" as const,
			taskId: task.taskId,
			...(task.failure ? { failure: boundedPublicText(task.failure) } : {}),
			...(attempt ? { attempt: {
				number: attempt.number,
				status: attempt.status,
				...(attempt.failure ? { failure: boundedPublicText(attempt.failure) } : {}),
			} } : {}),
		};
	}

	const attempt = task.attempts.at(-1);
	const failedCheck = publicFailedCheck(
		attempt?.authoritativeChecks?.passed === false
			? attempt.authoritativeChecks
			: attempt?.preliminaryChecks?.passed === false ? attempt.preliminaryChecks : undefined,
	);
	const failedReview = publicFailedReview(attempt?.authoritativeReview);
	const cleanup = attempt?.cleanup
		.filter((step) => step.status !== "completed")
		.map((step) => ({
			kind: step.kind,
			status: step.status,
			...(step.failure ? { failure: boundedPublicText(step.failure) } : {}),
		}));
	const worktreeCleanupPending = attempt?.cleanup.find((step) => step.kind === "worktree")?.status !== "completed";
	const worktree = worktreeCleanupPending
		? [...(attempt?.allocations ?? [])].reverse().find(
			(intent): intent is WorktreeAllocationIntent => intent.kind === "worktree" && intent.status === "owned" && Boolean(intent.worktree),
		)?.worktree
		: undefined;
	return {
		scope: "task" as const,
		taskId: task.taskId,
		...(task.failure ? { failure: boundedPublicText(task.failure) } : {}),
		...(worktree ? { retainedWorktree: {
			path: boundedPublicText(worktree.path),
			cwd: boundedPublicText(worktree.cwd),
			branch: boundedPublicText(worktree.branch),
		} } : {}),
		...(failedCheck ? { failedCheck } : {}),
		...(failedReview ? { failedReview } : {}),
		...(cleanup?.length ? { cleanup } : {}),
	};
}

function publicNeedsAttention(state: RunState, preferredTaskId?: string) {
	if (state.status !== "needs_attention") return undefined;
	const task = state.tasks.find((candidate) => candidate.status === "needs_attention" && candidate.taskId === preferredTaskId)
		?? state.tasks.find((candidate) => candidate.status === "needs_attention");
	if (task) return publicTaskRecovery(task);
	if (state.final.failure || state.final.checks?.passed === false || state.final.review?.passed === false) {
		const failedCheck = publicFailedCheck(state.final.checks);
		const failedReview = publicFailedReview(state.final.review);
		return {
			scope: "final" as const,
			...(state.final.failure ? { failure: boundedPublicText(state.final.failure) } : {}),
			...(failedCheck ? { failedCheck } : {}),
			...(failedReview ? { failedReview } : {}),
		};
	}
	return {
		scope: "request" as const,
		failure: "Request needs attention without a task or final failure.",
	};
}

function publicState(state: RunState, preferredTaskId?: string) {
	const needsAttention = publicNeedsAttention(state, preferredTaskId);
	return {
		version: state.version,
		id: state.request.id,
		status: state.status,
		accepted: state.accepted,
		tasks: state.tasks.map(({ taskId, status }) => ({ taskId, status })),
		final: { status: state.final.status },
		integration: {
			candidates: state.integration.candidates.map(({ taskId, attempt, tip, base, checks, decision }) => ({ taskId, attempt, tip, base, checked: checks.passed, ...(decision ? { decision } : {}) })),
			generations: state.integration.generations.map(({ number, status, worktree, integrationBase, combinedTip, correction, checks, review, promotion, failure, stages }) => ({
				number, status, integrationBase,
				...(combinedTip ? { combinedTip } : {}),
				...(correction ? { correction } : {}),
				...(checks ? { checked: checks.passed, failedCheck: publicFailedCheck(checks) } : {}),
				...(review ? { reviewed: review.passed, failedReview: publicFailedReview(review) } : {}),
				...(promotion ? { promotion: promotion.status, ...(promotion.mainAfter ? { mainAfter: promotion.mainAfter } : {}),
					...(promotion.failure ? { promotionFailure: boundedPublicText(promotion.failure) } : {}) } : {}),
				...(failure ? { failure: boundedPublicText(failure) } : {}),
				...(worktree ? { retainedWorktree: { path: worktree.path, branch: worktree.branch } } : {}),
				stages: stages.map(({ taskId, attempt, source, onto, status, tip, failure }) => ({
					taskId, attempt, source, onto, status, ...(tip ? { tip } : {}), ...(failure ? { failure: boundedPublicText(failure) } : {}),
				})),
			})),
		},
		...(needsAttention ? { needsAttention } : {}),
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
	};
}

function toolResult(response: RunResponse, ctx: ExtensionContext, rowsByRequest: Map<string, string[]>) {
	updateWorkspaceWidgetSafely(ctx, response.state, rowsByRequest);
	const preferredTaskId = response.continuation && "taskId" in response.continuation
		? response.continuation.taskId
		: undefined;
	const workspaces = workspaceWidgetLines(response.state);
	const text = ctx.hasUI === false && workspaces
		? `${response.text}\n\nActive workspaces:\n${workspaces.join("\n")}`
		: response.text;
	return {
		content: [{ type: "text" as const, text }],
		details: {
			state: publicState(response.state, preferredTaskId),
			...(response.main ? { main: response.main } : {}),
			...(response.continuation ? { continuation: response.continuation } : {}),
		},
	};
}

export interface IsolatedSurface {
	execute(params: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ReturnType<typeof toolResult>>;
}

export interface RegisterIsolatedOptions {
	executor: EphemeralSubagentExecutor;
	policy: EffectiveExecutionPolicy;
	currentPolicy(): EffectiveExecutionPolicy;
	componentsFactory?: CreateIsolatedComponents;
}

/** Register lifecycle surfaces; delegate_task remains the only start tool. */
export function registerIsolatedExtension(pi: ExtensionAPI, options: RegisterIsolatedOptions): IsolatedSurface {
	if (process.argv.includes(`--${ROLE_TOOL_POLICY_FLAG}`)) {
		return { execute: async () => { throw new Error("Child Roles cannot start isolated delegation."); } };
	}
	const componentsFactory = options.componentsFactory ?? createIsolatedComponents;
	let latestCtx: ExtensionContext | undefined;
	let components: IsolatedExtensionComponents | undefined;
	const workspaceRowsByRequest = new Map<string, string[]>();
	const stateListeners = new Set<(state: RunState) => void>();
	const activeJobs = new Set<AbortController>();
	const jobOwners = new Map<string, () => boolean>();
	let sessionEpoch = 0;
	let sessionClosed = false;

	const latestContext = (): ExtensionContext => {
		if (!latestCtx) throw new Error("Pi Subagent cannot resolve a Role before session context exists.");
		return latestCtx;
	};
	const getComponents = () => components ??= componentsFactory({
		pi,
		context: latestContext,
		executor: options.executor,
		policy: options.policy,
		currentPolicy: options.currentPolicy,
		onStateSaved: (state) => {
			for (const listener of stateListeners) listener(state);
			const owner = jobOwners.get(`${state.root}\0${state.request.id}`);
			if (!sessionClosed && (owner === undefined || owner())) {
				updateWorkspaceWidgetSafely(latestContext(), state, workspaceRowsByRequest);
			}
		},
	});
	const lookupRoot = async (cwd: string, signal?: AbortSignal): Promise<string> => {
		const startedAt = Date.now();
		const context: OperationContext = {
			signal: signal ?? new AbortController().signal,
			timeoutMs: LOOKUP_ROOT_TIMEOUT_MS,
			deadline: startedAt + LOOKUP_ROOT_TIMEOUT_MS,
		};
		return await getComponents().resolveRoot(cwd, context);
	};

	pi.on("session_start", (_event, ctx) => {
		for (const controller of activeJobs) controller.abort();
		sessionEpoch += 1;
		sessionClosed = false;
		latestCtx = ctx;
		workspaceRowsByRequest.clear();
		if (ctx.hasUI) ctx.ui.setWidget(WORKSPACE_WIDGET_KEY, undefined);
	});
	pi.on("session_shutdown", () => {
		for (const controller of activeJobs) controller.abort();
		sessionEpoch += 1;
		sessionClosed = true;
		workspaceRowsByRequest.clear();
	});
	pi.on("model_select", (event, ctx) => { latestCtx = { ...ctx, model: event.model } as ExtensionContext; });
	pi.on("agent_settled", (_event, ctx) => { latestCtx = ctx; });

	pi.registerCommand("subagent-followup", {
		description: "Queue a revision for an active isolated changeset task",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(args.trim());
			if (!match) throw new Error("Usage: /subagent-followup <request-id> <task-id> <message>");
			const [, requestId, taskId, instruction] = match;
			const root = await lookupRoot(ctx.cwd);
			ctx.ui.notify(getComponents().runner.queueFollowup(root, requestId!, taskId!, instruction!), "info");
		},
	});
	// FileRunStore emits the initial state only after fsync. A resumed run emits its
	// recovery record after saving it. Neither the tool call nor its abort signal
	// owns productive work after that durable boundary.
	const startInSession = async (
		id: string,
		root: string,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		acknowledged: (state: RunState) => boolean,
		start: (signal: AbortSignal) => Promise<RunResponse>,
	): Promise<ReturnType<typeof toolResult>> => {
		const epoch = sessionEpoch;
		const sessionId = ctx.sessionManager?.getSessionId();
		const key = `${root}\0${id}`;
		if (jobOwners.has(key)) throw new Error(`Pi Subagent request ${id} is already active in this session runtime.`);
		const canDeliver = () => !sessionClosed && sessionEpoch === epoch
			&& ctx.sessionManager?.getSessionId() === sessionId
			&& latestCtx?.sessionManager?.getSessionId() === sessionId;
		const controller = new AbortController();
		activeJobs.add(controller);
		jobOwners.set(key, canDeliver);
		const finish = () => {
			activeJobs.delete(controller);
			if (jobOwners.get(key) === canDeliver) jobOwners.delete(key);
		};
		const abortBeforeAck = () => controller.abort(signal?.reason);
		if (signal?.aborted) abortBeforeAck();
		else signal?.addEventListener("abort", abortBeforeAck, { once: true });
		let latestState: RunState | undefined;
		let accept!: (state: RunState) => void;
		let reject!: (error: unknown) => void;
		const durable = new Promise<RunState>((resolve, fail) => { accept = resolve; reject = fail; });
		const removeTurnAbort = () => signal?.removeEventListener("abort", abortBeforeAck);
		const listener = (state: RunState) => {
			if (state.root !== root || state.request.id !== id) return;
			latestState = state;
			if (!acknowledged(state)) return;
			stateListeners.delete(listener);
			removeTurnAbort();
			accept(state);
		};
		stateListeners.add(listener);
		const deliver = (text: string, response?: RunResponse) => {
			if (!canDeliver()) return;
			const state = response?.state ?? latestState;
			try {
				const details = state ? {
					state: publicState(state, response?.continuation && "taskId" in response.continuation
						? response.continuation.taskId : undefined),
					...(response?.continuation ? { continuation: response.continuation } : {}),
				} : { id };
				pi.sendMessage({
					customType: "pi-subagent-isolated-result",
					content: text,
					display: true,
					details,
				}, { triggerTurn: true, deliverAs: "followUp" });
			} catch {
				console.error(`Pi Subagent ${id} result delivery failed; use subagent_status to recover.`);
				if (ctx.hasUI) ctx.ui.notify(`Pi Subagent ${id} result delivery failed; use subagent_status to recover.`, "error");
			}
		};
		void Promise.resolve().then(() => start(controller.signal)).then(
			(response) => {
				finish();
				stateListeners.delete(listener);
				removeTurnAbort();
				if (!latestState || !acknowledged(latestState)) {
					reject(new Error(`Pi Subagent ${id} finished without a durable acknowledgement.`));
					return;
				}
				deliver(`${response.text}\n\nState: ${JSON.stringify(publicState(response.state))}`, response);
			},
			(error: unknown) => {
				finish();
				stateListeners.delete(listener);
				removeTurnAbort();
				if (!latestState || !acknowledged(latestState)) {
					reject(error);
					return;
				}
				deliver(`Pi Subagent ${id} stopped: ${boundedPublicText(error instanceof Error ? error.message : String(error))}. Use subagent_status to inspect the durable request and subagent_resume or subagent_abort for recovery.`);
			},
		);
		const state = await durable;
		if (!canDeliver()) throw new Error(`Pi Subagent ${id} was saved, but its launching session changed before acknowledgement. Use subagent_status to inspect the durable request.`);
		return toolResult({ text: `Pi Subagent ${id}: durable request accepted; productive work continues. Use subagent_status to inspect progress.`, state }, ctx, workspaceRowsByRequest);
	};

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent status",
		description: "Read one durable isolated request without reconciling or changing resources.",
		parameters: IdOnlySchema,
		prepareArguments: parseIdOnly,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const root = await lookupRoot(ctx.cwd, signal);
			return toolResult(await getComponents().runner.status(params.id, root, signal), ctx, workspaceRowsByRequest);
		},
	});
	pi.registerTool({
		name: "subagent_resume",
		label: "Subagent resume",
		description: "Resume one unfinished isolated request without resetting its recorded policy or correction count.",
		parameters: ResumeRequestSchema,
		prepareArguments: parseResumeRequest,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const root = await lookupRoot(ctx.cwd, signal);
			return await startInSession(params.id, root, signal, ctx,
				(state) => state.recovery?.kind === "resume" && state.recovery.action === params.action
					&& (!("taskId" in params) || state.recovery.taskId === params.taskId),
				(runSignal) => getComponents().runner.resume(params, root, runSignal));
		},
	});
	pi.registerTool({
		name: "subagent_stage",
		label: "Subagent stage",
		description: "Main stages/resolves an exact candidate, or rejects/revises one. Rejection of a staged candidate freezes the old generation; explicitly restage chosen candidates in a new generation. Never writes Main.",
		parameters: StageRequestSchema,
		prepareArguments: parseStageRequest,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const root = await lookupRoot(ctx.cwd, signal);
			return toolResult(await getComponents().runner.stage(params, root, signal), ctx, workspaceRowsByRequest);
		},
	});
	pi.registerTool({
		name: "subagent_integrate",
		label: "Subagent integrate",
		description: "Validate the exact combined tip, record Main's single committed correction after a failed check, promote after revalidation, or reconcile an interrupted promotion. Never replays an uncertain promotion.",
		parameters: IntegrationActionSchema,
		prepareArguments: parseIntegrationAction,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const root = await lookupRoot(ctx.cwd, signal);
			return toolResult(await getComponents().runner.integrate(params, root, signal), ctx, workspaceRowsByRequest);
		},
	});
	pi.registerTool({
		name: "subagent_abort",
		label: "Subagent abort",
		description: "Explicitly terminate owned workers and abort one unfinished isolated request.",
		parameters: IdOnlySchema,
		prepareArguments: parseIdOnly,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const root = await lookupRoot(ctx.cwd, signal);
			return toolResult(await getComponents().runner.abort(params.id, root, signal), ctx, workspaceRowsByRequest);
		},
	});
	return {
		async execute(params, signal, ctx) {
			latestCtx = ctx;
			latestContext();
			const request = parseExecuteRequest(params);
			const root = await lookupRoot(ctx.cwd, signal);
			return await startInSession(request.id, root, signal, ctx,
				(state) => state.status === "pending" && state.createdAt === state.updatedAt
					&& state.tasks.every((task) => task.status === "pending" && task.attempts.length === 0),
				(runSignal) => getComponents().runner.execute(request, ctx.cwd, runSignal));
		},
	};
}

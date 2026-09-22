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
	onInteractiveWait(requestId: string, taskId: string): void;
	onStateSaved(state: RunState): void;
}) => IsolatedExtensionComponents;

/** Construct the checked runtime while reusing the unified productive-assignment executor. */
export const createIsolatedComponents: CreateIsolatedComponents = ({
	pi, context, executor, policy, currentPolicy, onInteractiveWait, onStateSaved,
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
			maxMs: policy.childMaxMs,
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
			onInteractiveWait,
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
		case "awaiting_acceptance": return "accept";
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
		onInteractiveWait: (requestId, taskId) => {
			latestContext().ui.notify(
				`Task ${requestId}/${taskId} is ready. Use /subagent-followup ${requestId} ${taskId} <message> or /subagent-accept ${requestId} ${taskId}.`,
				"info",
			);
		},
		onStateSaved: (state) => updateWorkspaceWidgetSafely(latestContext(), state, workspaceRowsByRequest),
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
		latestCtx = ctx;
		workspaceRowsByRequest.clear();
		if (ctx.hasUI) ctx.ui.setWidget(WORKSPACE_WIDGET_KEY, undefined);
	});
	pi.on("model_select", (event, ctx) => { latestCtx = { ...ctx, model: event.model } as ExtensionContext; });
	pi.on("agent_settled", (_event, ctx) => { latestCtx = ctx; });

	pi.registerCommand("subagent-followup", {
		description: "Queue a revision for an active supervised isolated changeset task",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(args.trim());
			if (!match) throw new Error("Usage: /subagent-followup <request-id> <task-id> <message>");
			const [, requestId, taskId, instruction] = match;
			const root = await lookupRoot(ctx.cwd);
			ctx.ui.notify(getComponents().runner.queueFollowup(root, requestId!, taskId!, instruction!), "info");
		},
	});
	pi.registerCommand("subagent-accept", {
		description: "Accept the exact checked candidate for a supervised isolated changeset task",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const parts = args.trim().split(/\s+/);
			if (parts.length !== 2 || parts.some((part) => !part)) throw new Error("Usage: /subagent-accept <request-id> <task-id>");
			const root = await lookupRoot(ctx.cwd);
			ctx.ui.notify(getComponents().runner.acceptCandidate(root, parts[0]!, parts[1]!), "info");
		},
	});

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
			return toolResult(await getComponents().runner.resume(params, root, signal), ctx, workspaceRowsByRequest);
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
			return toolResult(await getComponents().runner.execute(parseExecuteRequest(params), ctx.cwd, signal), ctx, workspaceRowsByRequest);
		},
	};
}

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ROLE_TOOL_POLICY_FLAG } from "@henryqw/pi-subagent";
import {
	ComposedOrchestratorRuntime,
	createCanonicalGitRootResolver,
	createComposedOrchestratorRuntime,
	createExactReviewerExecutor,
	type CanonicalGitRootResolverOptions,
	type ComposeOrchestratorRuntimeOptions,
	type ExactReviewerExecutorOptions,
} from "../src/composition.ts";
import {
	CheckedGitRuntime,
	type CheckedGitRuntimeOptions,
	type DirectProcessRunner,
} from "../src/git-runtime.ts";
import { HerdrHostRuntime, type HerdrHostRuntimeOptions } from "../src/herdr-runtime.ts";
import { OrchestratorRunner, type OperationContext, type RunResponse } from "../src/runner.ts";
import {
	ExecuteRequestSchema,
	IdOnlySchema,
	ResumeRequestSchema,
	parseExecuteRequest,
	parseIdOnly,
	parseResumeRequest,
	sameIdentity,
	type CheckBatchEvidence,
	type ReviewEvidence,
	type RunState,
	type TaskAttempt,
} from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

const LOOKUP_ROOT_TIMEOUT_MS = 5_000;
const PUBLIC_EVIDENCE_MAX_BYTES = 512;

export interface OrchestratorExtensionDependencies {
	now(): number;
	createRootResolver(options: CanonicalGitRootResolverOptions): NonNullable<ComposeOrchestratorRuntimeOptions["resolveRoot"]>;
	createReviewerExecutor(options?: ExactReviewerExecutorOptions): ReturnType<typeof createExactReviewerExecutor>;
	createGitRuntime(options: CheckedGitRuntimeOptions): CheckedGitRuntime;
	createHostRuntime(options: HerdrHostRuntimeOptions): HerdrHostRuntime;
	createRuntime(options: ComposeOrchestratorRuntimeOptions): ComposedOrchestratorRuntime;
	createStore(): FileRunStore;
	createRunner(runtime: ComposedOrchestratorRuntime, git: CheckedGitRuntime, store: FileRunStore): OrchestratorRunner;
	orchestratorEntrypoint: string;
}

const DEFAULT_DEPENDENCIES: OrchestratorExtensionDependencies = {
	now: Date.now,
	createRootResolver: createCanonicalGitRootResolver,
	createReviewerExecutor: createExactReviewerExecutor,
	createGitRuntime: (options) => new CheckedGitRuntime(options),
	createHostRuntime: (options) => new HerdrHostRuntime(options),
	createRuntime: createComposedOrchestratorRuntime,
	createStore: () => new FileRunStore(),
	createRunner: (runtime, git, store) => new OrchestratorRunner(runtime, git, store),
	orchestratorEntrypoint: fileURLToPath(import.meta.url),
};

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

function publicTaskRecovery(task: RunState["tasks"][number], attempt: TaskAttempt | undefined) {
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
		? [...(attempt?.allocations ?? [])].reverse().find((intent) => intent.kind === "worktree"
			&& intent.status === "owned" && intent.worktree)?.worktree
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
	if (task) return publicTaskRecovery(task, task.attempts.at(-1));
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
		scope: "launch" as const,
		...(state.launchMaterialization.failure
			? { failure: boundedPublicText(state.launchMaterialization.failure) }
			: {}),
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

function toolResult(response: RunResponse) {
	const preferredTaskId = response.continuation && "taskId" in response.continuation
		? response.continuation.taskId
		: undefined;
	return {
		content: [{ type: "text" as const, text: response.text }],
		details: {
			state: publicState(response.state, preferredTaskId),
			...(response.main ? { main: response.main } : {}),
			...(response.continuation ? { continuation: response.continuation } : {}),
		},
	};
}

/** Register the Main-only Pi Orchestrator tools with injectable construction seams for tests. */
export function registerOrchestratorExtension(
	pi: ExtensionAPI,
	injected: Partial<OrchestratorExtensionDependencies> = {},
): void {
	if (process.argv.includes(`--${ROLE_TOOL_POLICY_FLAG}`)) return;

	const dependencies = { ...DEFAULT_DEPENDENCIES, ...injected };
	let latestCtx: ExtensionContext | undefined;
	let components: {
		runner: OrchestratorRunner;
		resolveRoot: NonNullable<ComposeOrchestratorRuntimeOptions["resolveRoot"]>;
	} | undefined;

	const latestContext = (): ExtensionContext => {
		if (!latestCtx) throw new Error("Pi Orchestrator cannot resolve a Role before session context exists.");
		return latestCtx;
	};

	const getComponents = () => {
		if (components) return components;
		const runProcess: DirectProcessRunner = async (command, args, options) => await pi.exec(command, args, {
			cwd: options.cwd,
			signal: options.signal,
			timeout: options.timeoutMs,
		});
		const resolveRoot = dependencies.createRootResolver({ runProcess, now: dependencies.now });
		const git = dependencies.createGitRuntime({
			runProcess,
			executeReview: dependencies.createReviewerExecutor(),
		});
		const host = dependencies.createHostRuntime({
			inspectInFlightTaskCandidate: git.inspectInFlightTaskCandidate.bind(git),
			runProcess,
		});
		const runtime = dependencies.createRuntime({
			role: {
				pi,
				context: latestContext,
				orchestratorEntrypoint: dependencies.orchestratorEntrypoint,
			},
			host,
			git,
			resolveRoot,
		});
		const store = dependencies.createStore();
		const runner = dependencies.createRunner(runtime, git, store);
		return components = { runner, resolveRoot };
	};

	const lookupRoot = async (cwd: string, signal?: AbortSignal): Promise<string> => {
		const startedAt = dependencies.now();
		const context: OperationContext = {
			signal: signal ?? new AbortController().signal,
			timeoutMs: LOOKUP_ROOT_TIMEOUT_MS,
			deadline: startedAt + LOOKUP_ROOT_TIMEOUT_MS,
		};
		return await getComponents().resolveRoot(cwd, context);
	};

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
	});
	pi.on("model_select", (event, ctx) => {
		latestCtx = { ...ctx, model: event.model } as ExtensionContext;
	});
	pi.on("agent_settled", (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.registerTool({
		name: "orchestrate_execute",
		label: "Orchestrate execute",
		description: "Start one durable checked task graph in the current clean Git repository.",
		promptSnippet: "Run a durable checked task graph with isolated Implementer Roles",
		promptGuidelines: [
			"Use orchestrate_execute for non-trivial implementation work with explicit dependencies and authoritative checks.",
			"Add a Reviewer judgment only when direct checks cannot establish the criterion.",
		],
		parameters: ExecuteRequestSchema,
		prepareArguments: parseExecuteRequest,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			return toolResult(await getComponents().runner.execute(params, ctx.cwd, signal));
		},
	});

	pi.registerTool({
		name: "orchestrate_status",
		label: "Orchestrate status",
		description: "Read one durable Pi Orchestrator request in the current Git repository.",
		parameters: IdOnlySchema,
		prepareArguments: parseIdOnly,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const root = await lookupRoot(ctx.cwd, signal);
			return toolResult(await getComponents().runner.status(params.id, root, signal));
		},
	});

	pi.registerTool({
		name: "orchestrate_resume",
		label: "Orchestrate resume",
		description: "Deliberately resume one unfinished Pi Orchestrator request.",
		parameters: ResumeRequestSchema,
		prepareArguments: parseResumeRequest,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const root = await lookupRoot(ctx.cwd, signal);
			return toolResult(await getComponents().runner.resume(params, root, signal));
		},
	});

	pi.registerTool({
		name: "orchestrate_abort",
		label: "Orchestrate abort",
		description: "Terminate owned workers and abort one unfinished Pi Orchestrator request.",
		parameters: IdOnlySchema,
		prepareArguments: parseIdOnly,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const root = await lookupRoot(ctx.cwd, signal);
			return toolResult(await getComponents().runner.abort(params.id, root, signal));
		},
	});
}

export default function orchestratorExtension(pi: ExtensionAPI): void {
	registerOrchestratorExtension(pi);
}

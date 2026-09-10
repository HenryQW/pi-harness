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
	type RunState,
} from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

const LOOKUP_ROOT_TIMEOUT_MS = 5_000;

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

function publicState(state: RunState) {
	return {
		version: state.version,
		id: state.request.id,
		status: state.status,
		accepted: state.accepted,
		tasks: state.tasks.map(({ taskId, status }) => ({ taskId, status })),
		final: { status: state.final.status },
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
	};
}

function toolResult(response: RunResponse) {
	return {
		content: [{ type: "text" as const, text: response.text }],
		details: {
			state: publicState(response.state),
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
			inspectTaskCandidate: git.inspectTaskCandidate.bind(git),
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
			return toolResult(await getComponents().runner.status(params.id, root));
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

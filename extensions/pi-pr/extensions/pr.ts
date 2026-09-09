import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
	isBashToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@henryqw/pi-herdr";
import { Type } from "typebox";
import { PullRequestCiFixer, type PullRequestCiFixOptions } from "./pr-ci.ts";
import { PullRequestCommentSweep, type PullRequestCommentSweepOptions } from "./pr-comment-sweep.ts";
import {
	createPrCommandHandler,
	type PrCommandDependencies,
	type PrCommandInvocation,
	type WorkflowReservation,
} from "./pr-command.ts";
import { PullRequestCreator, type CreatePullRequestOptions } from "./pr-create.ts";
import {
	hasLocalCommit,
	loadCurrentPullRequest,
	parsePullRequestObservation,
	pullRequestObservation,
	samePullRequestObservation,
	type PullRequestObservation,
} from "./pr-github.ts";
import { runChecked, spawnBounded } from "./pr-execution.ts";
import {
	discoveryIssueKey,
	discoveryIssueMessage,
	formatPrFooter,
	formatPrWidget,
	projectPrDisplay,
	unavailablePrDisplay,
	type PrDisplay,
} from "./pr-ui.ts";
import { PullRequestBranchUpdater, type UpdateBranchOptions } from "./pr-update-branch.ts";

const POLL_INTERVAL_MS = 30_000;
const HERDR_TIMEOUT_MS = 10_000;
const UI_KEY = "pi-pr";
const OBSERVATION_ENTRY = "pi-pr-observation";
const GH_PR_CREATE = /(?:^|[;&|]\s*|\n\s*)gh\s+pr\s+create(?=\s|$|[;&|])/;
const GIT_COMMIT = /(?:^|[;&|]\s*|\n\s*)git\s+commit(?=\s|$|[;&|])/;
const GIT_PUSH = /(?:^|[;&|]\s*|\n\s*)git\s+push(?=\s|$|[;&|])/;
const WORKFLOW_ROUTES = new Set(["create", "update-branch", "sweep", "fix-ci"]);
const DELEGATED_TOOLS = new Set(["delegate_task", "delegate_flow", "delegate_flow_continue"]);
const CLOSED = { additionalProperties: false } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RouteRunId = Type.String({ minLength: 36, maxLength: 36, pattern: UUID.source });
const ResolvedPaths = Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { minItems: 1, maxItems: 128 });
const OwnedPaths = Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 128 });
const SweepGuard = Type.Object({
	epoch: Type.Integer({ minimum: 1 }),
	runId: Type.String({ minLength: 1, maxLength: 128 }),
	generation: Type.Integer({ minimum: 1 }),
	fingerprint: Type.String({ minLength: 64, maxLength: 64 }),
}, CLOSED);
const SweepLedgerEntry = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 1_024 }),
	kind: Type.Union([
		Type.Literal("conversation_comment"), Type.Literal("review"), Type.Literal("thread"), Type.Literal("thread_comment"),
	]),
	disposition: Type.Union([Type.Literal("addressed"), Type.Literal("non-actionable"), Type.Literal("blocked")]),
	note: Type.String({ maxLength: 2_048 }),
}, CLOSED);
const SweepLedger = Type.Array(SweepLedgerEntry, { maxItems: 1_000 });
const SweepProjection = Type.Object({
	generation: Type.Integer({ minimum: 1 }),
	contentFingerprint: Type.String({ minLength: 64, maxLength: 64 }),
	items: Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 1_024 }),
		kind: Type.Union([
			Type.Literal("conversation_comment"), Type.Literal("review"), Type.Literal("thread"), Type.Literal("thread_comment"),
		]),
	}, CLOSED), { maxItems: 1_000 }),
	threads: Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 1_024 }),
		isResolved: Type.Boolean(),
	}, CLOSED), { maxItems: 1_000 }),
}, CLOSED);
const SweepChecks = Type.Array(Type.Object({
	command: Type.String({ minLength: 1, maxLength: 1_024 }),
	args: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 256 }),
}, CLOSED), { maxItems: 32 });

const UpdateBranchParameters = Type.Union([
	Type.Object({ runId: RouteRunId, action: Type.Literal("merge") }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("continue"), resolvedPaths: ResolvedPaths }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("publish") }, CLOSED),
]);
const CreateParameters = Type.Union([
	Type.Object({ runId: RouteRunId, action: Type.Literal("prepare") }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("merge") }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("continue"), resolvedPaths: ResolvedPaths }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("push") }, CLOSED),
	Type.Object({
		runId: RouteRunId,
		action: Type.Literal("publish"),
		title: Type.String({ minLength: 1, maxLength: 256 }),
		body: Type.String({ maxLength: 65_536 }),
	}, CLOSED),
]);
const SweepParameters = Type.Union([
	Type.Object({ runId: RouteRunId, action: Type.Literal("start") }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("resume") }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("show"), guard: SweepGuard, id: Type.String({ minLength: 1, maxLength: 1_024 }) }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("record"), guard: SweepGuard, ledger: SweepLedger, ownedPaths: OwnedPaths }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("publish"), guard: SweepGuard }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("refresh"), guard: SweepGuard, ledger: SweepLedger }, CLOSED),
	Type.Object({
		runId: RouteRunId,
		action: Type.Literal("resolve"),
		guard: SweepGuard,
		threadIds: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { maxItems: 1_000 }),
	}, CLOSED),
	Type.Object({
		runId: RouteRunId,
		action: Type.Literal("finalize"),
		guard: SweepGuard,
		projection: SweepProjection,
		checks: SweepChecks,
	}, CLOSED),
]);
const FixCiParameters = Type.Union([
	Type.Object({ runId: RouteRunId, action: Type.Literal("collect") }, CLOSED),
	Type.Object({ runId: RouteRunId, action: Type.Literal("publish") }, CLOSED),
]);

type UpdateBranchWorkflow = Pick<PullRequestBranchUpdater, "state" | "merge" | "continue" | "publish">;
type CreateWorkflow = Pick<PullRequestCreator, "state" | "prepare" | "merge" | "continue" | "push" | "publish">;
type SweepWorkflow = Pick<PullRequestCommentSweep, "start" | "resume" | "show" | "record" | "publish" | "refresh" | "resolve" | "finalize">;
type FixCiWorkflow = Pick<PullRequestCiFixer, "collect" | "publish">;

type WorkflowContextBase = {
	runId: string;
	sessionGeneration: number;
	worktree: string;
	controller: AbortController;
	usedSinceSettlement: boolean;
	promptQueued: boolean;
	conflictRetained: boolean;
};
type WorkflowContext =
	| (WorkflowContextBase & { route: "update-branch"; workflow: UpdateBranchWorkflow })
	| (WorkflowContextBase & { route: "create"; base?: string; workflow: CreateWorkflow })
	| (WorkflowContextBase & { route: "sweep"; workflow: SweepWorkflow })
	| (WorkflowContextBase & { route: "fix-ci"; workflow: FixCiWorkflow });

type PullRequestExtensionDependencies = {
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
	hasLocalCommit?: typeof hasLocalCommit;
	createPrCommandHandler?: typeof createPrCommandHandler;
	createBranchUpdater?: (options: UpdateBranchOptions) => UpdateBranchWorkflow;
	createPullRequestCreator?: (options: CreatePullRequestOptions) => CreateWorkflow;
	createCommentSweep?: (options: PullRequestCommentSweepOptions) => SweepWorkflow;
	createCiFixer?: (options: PullRequestCiFixOptions) => FixCiWorkflow;
	canonicalWorktree?: (cwd: string, signal?: AbortSignal) => Promise<string>;
	newRunId?: () => string;
};

async function canonicalWorktree(cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await runChecked(spawnBounded, "git", ["rev-parse", "--show-toplevel"], { cwd, signal });
	const normalized = result.stdout.replace(/\r\n/g, "\n");
	const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
	if (lines.length !== 1 || !lines[0]) throw new Error("Git worktree root resolution returned invalid output");
	return await realpath(lines[0]);
}

function toolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: value,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkspaceLabel(response: Record<string, unknown>, workspaceId: string): string {
	const result = response.result;
	const workspace = isRecord(result) && isRecord(result.workspace) ? result.workspace : undefined;
	if (!workspace || workspace.workspace_id !== workspaceId) {
		throw new Error("workspace get returned a different workspace_id");
	}
	const label = workspace.label;
	if (typeof label !== "string" || !label.trim()) {
		throw new Error("workspace get returned an empty label");
	}
	return label;
}

function latestObservation(ctx: ExtensionContext): PullRequestObservation | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== OBSERVATION_ENTRY) continue;
		const observation = parsePullRequestObservation(entry.data);
		if (observation !== null) return observation;
	}
}

export default function pullRequestExtension(
	pi: ExtensionAPI,
	dependencies: PullRequestExtensionDependencies = {},
): void {
	const herdr = createHerdrClient(pi.exec.bind(pi));
	const renameHerdrWorkspace = async (
		cwd: string,
		signal: AbortSignal,
		workspaceId: string,
		pullRequestNumber: number,
	): Promise<void> => {
		signal.throwIfAborted();
		const current = await herdr.json(["workspace", "get", workspaceId], {
			cwd,
			signal,
			timeout: HERDR_TIMEOUT_MS,
		});
		signal.throwIfAborted();
		const label = parseWorkspaceLabel(current, workspaceId);
		const workspaceName = label
			.replace(/^(?:#[1-9][0-9]* • )+/, "")
			.replace(/(?: · PR #[1-9][0-9]*)+$/, "");
		if (!workspaceName.trim()) throw new Error("workspace label has no name after removing PR labels");
		const normalized = `#${pullRequestNumber} • ${workspaceName}`;
		if (normalized === label) return;

		signal.throwIfAborted();
		await herdr.run(["workspace", "rename", workspaceId, normalized], {
			cwd,
			signal,
			timeout: HERDR_TIMEOUT_MS,
		});
		signal.throwIfAborted();
	};

	const discover = dependencies.loadCurrentPullRequest ?? loadCurrentPullRequest;
	const detectLocalCommit = dependencies.hasLocalCommit ?? hasLocalCommit;
	const createCommandHandler = dependencies.createPrCommandHandler ?? createPrCommandHandler;
	const createBranchUpdater = dependencies.createBranchUpdater ?? ((options) => new PullRequestBranchUpdater(options));
	const createPullRequestCreator = dependencies.createPullRequestCreator ?? ((options) => new PullRequestCreator(options));
	const createCommentSweep = dependencies.createCommentSweep ?? ((options) => new PullRequestCommentSweep(options));
	const createCiFixer = dependencies.createCiFixer ?? ((options) => new PullRequestCiFixer(options));
	const resolveCanonicalWorktree = dependencies.canonicalWorktree ?? canonicalWorktree;
	const newRunId = dependencies.newRunId ?? randomUUID;
	let context: ExtensionContext | undefined;
	let observation: PullRequestObservation | undefined;
	const load: typeof loadCurrentPullRequest = async (api, loadContext, inspectedLocal) => {
		const generation = sessionGeneration;
		const discovery = await discover(api, loadContext, inspectedLocal, observation);
		if (generation !== sessionGeneration) return discovery;
		if (discovery.kind === "current") {
			const current = pullRequestObservation(discovery.pullRequest);
			if (current !== null && !samePullRequestObservation(observation, current)) {
				pi.appendEntry(OBSERVATION_ENTRY, current);
				observation = current;
			}
		}
		return discovery;
	};
	let sessionGeneration = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let active: AbortController | undefined;
	let queued = false;
	let refreshFailureReported = false;
	let displayEstablished = false;
	let lastDiscovery: "configured" | "inferred" | "absent" | "blocked" | "inactive" | undefined;
	let lastBlockedIssueKey: string | undefined;
	let delegatedWorkPending = false;
	let pendingWorkspaceRename = false;
	let mergeCompleted = false;
	let displayedWidget: PrDisplay | undefined;
	let commandGeneration = 0;
	let workflowContext: WorkflowContext | undefined;
	const activeInvocations = new Map<number, "routing" | "create-workflow" | "workflow">();

	const clearWorkflow = (selected: WorkflowContext | undefined): void => {
		if (!selected || workflowContext !== selected) return;
		workflowContext = undefined;
		selected.controller.abort();
	};

	const reserveWorkflow: NonNullable<PrCommandDependencies["reserveWorkflow"]> = async (reservation, ctx, invocation) => {
		if (!invocation) throw new Error("PR workflow command generation is unavailable");
		invocation.assertCurrent();
		const worktree = await resolveCanonicalWorktree(ctx.cwd, ctx.signal);
		invocation.assertCurrent();
		if (workflowContext) throw new Error(`PR workflow ${workflowContext.runId} is still active`);
		const runId = newRunId();
		if (!UUID.test(runId)) throw new Error("PR workflow runId generator returned an invalid UUID");
		const common: WorkflowContextBase = {
			runId,
			sessionGeneration: invocation.sessionGeneration,
			worktree,
			controller: new AbortController(),
			usedSinceSettlement: false,
			promptQueued: false,
			conflictRetained: false,
		};
		switch (reservation.route) {
			case "update-branch":
				workflowContext = {
					...common,
					route: "update-branch",
					workflow: createBranchUpdater({
						cwd: worktree,
						authority: reservation.pullRequest,
						signal: common.controller.signal,
						loadCurrentPullRequest: load,
					}),
				};
				break;
			case "create":
				workflowContext = {
					...common,
					route: "create",
					...(reservation.base === undefined ? {} : { base: reservation.base }),
					workflow: createPullRequestCreator({
						cwd: worktree,
						target: reservation.target,
						signal: common.controller.signal,
						loadCurrentPullRequest: load,
					}),
				};
				break;
			case "sweep":
				workflowContext = {
					...common,
					route: "sweep",
					workflow: createCommentSweep({
						cwd: worktree,
						authority: reservation.pullRequest,
						signal: common.controller.signal,
						loadCurrentPullRequest: load,
					}),
				};
				break;
			case "fix-ci":
				workflowContext = {
					...common,
					route: "fix-ci",
					workflow: createCiFixer({
						cwd: worktree,
						authority: reservation.pullRequest,
						signal: common.controller.signal,
						loadCurrentPullRequest: load,
					}),
				};
				break;
		}
		return common.runId;
	};

	const markWorkflowPromptQueued: NonNullable<PrCommandDependencies["markWorkflowPromptQueued"]> = (runId, queued) => {
		if (workflowContext?.runId !== runId) throw new Error("PR workflow reservation is wrong or stale");
		workflowContext.promptQueued = queued;
	};

	const releaseWorkflow: NonNullable<PrCommandDependencies["releaseWorkflow"]> = (runId, invocation) => {
		const selected = workflowContext;
		if (
			invocation && selected?.runId === runId &&
			selected.sessionGeneration === invocation.sessionGeneration
		) clearWorkflow(selected);
	};

	const executeWorkflowAction = async <Route extends WorkflowContext["route"]>(
		runId: string,
		route: Route,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		action: (selected: Extract<WorkflowContext, { route: Route }>) => Promise<unknown>,
	) => {
		signal?.throwIfAborted();
		const selected = workflowContext;
		if (!selected) throw new Error("No PR workflow is active");
		if (selected.runId !== runId) throw new Error("PR workflow runId is wrong or stale");
		if (selected.sessionGeneration !== sessionGeneration) throw new Error("PR workflow session is stale");
		if (selected.route !== route) throw new Error(`PR workflow route is ${selected.route}, not ${route}`);
		const abortRun = () => selected.controller.abort(signal?.reason);
		if (signal?.aborted) abortRun();
		else signal?.addEventListener("abort", abortRun, { once: true });
		try {
			selected.controller.signal.throwIfAborted();
			const worktree = await resolveCanonicalWorktree(ctx.cwd, selected.controller.signal);
			if (workflowContext !== selected || selected.sessionGeneration !== sessionGeneration) {
				throw new Error("PR workflow session changed during validation");
			}
			selected.controller.signal.throwIfAborted();
			if (worktree !== selected.worktree) throw new Error("PR workflow worktree is wrong or stale");
			selected.usedSinceSettlement = true;
			return toolResult(await action(selected as Extract<WorkflowContext, { route: Route }>));
		} finally {
			signal?.removeEventListener("abort", abortRun);
		}
	};

	pi.registerTool({
		name: "pi_pr_update_branch",
		label: "Update PR Branch",
		description: "Run one guarded action for the /pr branch-update route.",
		parameters: UpdateBranchParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeWorkflowAction(params.runId, "update-branch", ctx, signal, async (selected) => {
				switch (params.action) {
					case "merge": return await selected.workflow.merge();
					case "continue": return await selected.workflow.continue(params.resolvedPaths);
					case "publish": return await selected.workflow.publish();
				}
			});
		},
	});

	pi.registerTool({
		name: "pi_pr_create",
		label: "Create Pull Request",
		description: "Run one guarded action for the /pr creation route.",
		parameters: CreateParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeWorkflowAction(params.runId, "create", ctx, signal, async (selected) => {
				switch (params.action) {
					case "prepare": return await selected.workflow.prepare(selected.base);
					case "merge": return await selected.workflow.merge();
					case "continue": return await selected.workflow.continue(params.resolvedPaths);
					case "push": return await selected.workflow.push();
					case "publish": return await selected.workflow.publish(params.title, params.body);
				}
			});
		},
	});

	pi.registerTool({
		name: "pi_pr_sweep",
		label: "Sweep PR Feedback",
		description: "Run one guarded action for the /pr feedback route.",
		parameters: SweepParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeWorkflowAction(params.runId, "sweep", ctx, signal, async (selected) => {
				switch (params.action) {
					case "start": return await selected.workflow.start();
					case "resume": return await selected.workflow.resume();
					case "show": return await selected.workflow.show(params.guard, params.id);
					case "record": return await selected.workflow.record(params.guard, params.ledger, params.ownedPaths);
					case "publish": return await selected.workflow.publish(params.guard);
					case "refresh": return await selected.workflow.refresh(params.guard, params.ledger);
					case "resolve": return await selected.workflow.resolve(params.guard, params.threadIds);
					case "finalize": return await selected.workflow.finalize(params.guard, params.projection, params.checks);
				}
			});
		},
	});

	pi.registerTool({
		name: "pi_pr_fix_ci",
		label: "Fix PR CI",
		description: "Run one guarded action for the /pr failed-CI route.",
		parameters: FixCiParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeWorkflowAction(params.runId, "fix-ci", ctx, signal, async (selected) => {
				switch (params.action) {
					case "collect": return await selected.workflow.collect();
					case "publish": return await selected.workflow.publish();
				}
			});
		},
	});

	const setWidget = (ctx: ExtensionContext, display: PrDisplay | undefined): void => {
		if (display?.widget === undefined) {
			ctx.ui.setWidget(UI_KEY, undefined);
			return;
		}
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(UI_KEY, (_tui, theme) => ({
				invalidate() {},
				render: (width) => formatPrWidget(display, theme, width)!,
			}));
			return;
		}
		ctx.ui.setWidget(UI_KEY, formatPrWidget(display));
	};

	const render = (
		ctx: ExtensionContext,
		discovery: Awaited<ReturnType<typeof loadCurrentPullRequest>>,
		localCommit: boolean,
	): void => {
		if (discovery.kind === "inactive") {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			displayEstablished = true;
			lastDiscovery = "inactive";
			displayedWidget = undefined;
			ctx.ui.setStatus(UI_KEY, undefined);
			setWidget(ctx, undefined);
			return;
		}
		const display = projectPrDisplay(discovery, localCommit);
		const footer = formatPrFooter(display, ctx.ui.theme);
		if ((discovery.kind === "current" || discovery.kind === "blocked") && footer === undefined) {
			throw new Error("Pull request display is missing a footer");
		}
		displayedWidget = display.widget === undefined ? undefined : display;
		const widget = activeInvocations.size > 0 ? undefined : displayedWidget;
		ctx.ui.setStatus(UI_KEY, footer);
		setWidget(ctx, widget);
		if (discovery.kind === "blocked") {
			const key = discoveryIssueKey(discovery.issue);
			if (lastBlockedIssueKey !== key) {
				ctx.ui.notify(discoveryIssueMessage(discovery.issue), "warning");
				lastBlockedIssueKey = key;
			}
		} else {
			lastBlockedIssueKey = undefined;
		}
		displayEstablished = true;
		lastDiscovery = discovery.kind === "current"
			? discovery.pullRequest.target.provenance
			: discovery.kind === "none"
			? "absent"
			: discovery.kind;
	};

	const stop = (): void => {
		sessionGeneration += 1;
		context = undefined;
		observation = undefined;
		queued = false;
		refreshFailureReported = false;
		displayEstablished = false;
		lastDiscovery = undefined;
		lastBlockedIssueKey = undefined;
		delegatedWorkPending = false;
		pendingWorkspaceRename = false;
		mergeCompleted = false;
		displayedWidget = undefined;
		commandGeneration = 0;
		clearWorkflow(workflowContext);
		activeInvocations.clear();
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		active?.abort();
		active = undefined;
	};

	const reportRefreshFailure = (): void => {
		const ctx = context;
		if (!ctx || refreshFailureReported) return;
		refreshFailureReported = true;
		try {
			ctx.ui.notify("PR status refresh failed: status unavailable", "error");
		} catch {
			console.error("PR status refresh failed and could not be reported");
		}
	};

	const reportHerdrRenameFailure = (ctx: ExtensionContext, error: unknown): void => {
		try {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Herdr workspace rename failed: ${message.slice(0, 500)}`, "warning");
		} catch (reportError) {
			console.error("Herdr workspace rename failed and could not be reported", error, reportError);
		}
	};

	const refresh = async (): Promise<void> => {
		const ctx = context;
		if (!ctx || [...activeInvocations.values()].includes("create-workflow")) return;
		const generation = sessionGeneration;
		if (active) {
			queued = true;
			return;
		}

		const controller = new AbortController();
		const loadContext = { cwd: ctx.cwd, signal: controller.signal };
		active = controller;
		try {
			let discovery: Awaited<ReturnType<typeof loadCurrentPullRequest>>;
			let localCommit = false;
			try {
				discovery = await load(pi, loadContext);
				if (controller.signal.aborted || sessionGeneration !== generation) return;
				if (discovery.kind === "none") {
					localCommit = !mergeCompleted && await detectLocalCommit(pi, loadContext);
				}
			} catch {
				// Keep an established display. A cold Git-worktree failure gets a sanitized placeholder.
				if (!controller.signal.aborted && sessionGeneration === generation) {
					if (!displayEstablished) {
						const unavailable = unavailablePrDisplay();
						ctx.ui.setStatus(UI_KEY, formatPrFooter(unavailable, ctx.ui.theme));
						setWidget(ctx, undefined);
						displayEstablished = true;
					}
					reportRefreshFailure();
				}
				return;
			}
			if (controller.signal.aborted || sessionGeneration !== generation) return;
			render(ctx, discovery, localCommit);
			refreshFailureReported = false;

			const pullRequest = discovery.kind === "current" ? discovery.pullRequest : undefined;
			if (pendingWorkspaceRename && pullRequest?.target.provenance === "configured") {
				pendingWorkspaceRename = false;
				const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
				if (process.env.HERDR_ENV === "1" && workspaceId) {
					try {
						await renameHerdrWorkspace(ctx.cwd, controller.signal, workspaceId, pullRequest.number);
					} catch (error) {
						if (!controller.signal.aborted && sessionGeneration === generation) {
							reportHerdrRenameFailure(ctx, error);
						}
					}
				}
			}
		} finally {
			if (active !== controller) return;
			active = undefined;
			if (queued) {
				queued = false;
				refreshInBackground();
			}
		}
	};

	const refreshInBackground = (): void => {
		void refresh().catch(reportRefreshFailure);
	};

	const cancelRefresh = (): void => {
		active?.abort();
		active = undefined;
		queued = false;
	};

	pi.on("before_agent_start", (event) => {
		const selected = workflowContext;
		if (selected?.promptQueued && event.prompt.includes(selected.runId)) {
			selected.promptQueued = false;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		stop();
		const generation = sessionGeneration;
		observation = latestObservation(ctx);
		if (!ctx.hasUI) return;
		context = ctx;
		await refresh();
		if (sessionGeneration === generation && lastDiscovery !== "inactive") {
			timer = setInterval(refreshInBackground, POLL_INTERVAL_MS);
		}
	});

	pi.on("session_shutdown", stop);

	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI || !ctx.isIdle() || !context) return;
		const selected = workflowContext;
		const helperSettled = selected?.usedSinceSettlement ?? false;
		const queuedHelperPending = selected?.promptQueued === true && !helperSettled;
		let workflowSettled = false;
		let createWorkflowSettled = false;
		for (const [invocation, phase] of activeInvocations) {
			if (phase !== "workflow" && phase !== "create-workflow") continue;
			if (queuedHelperPending) continue;
			activeInvocations.delete(invocation);
			workflowSettled = true;
			if (phase === "create-workflow") createWorkflowSettled = true;
		}
		if (selected) {
			const conflictPending = (selected.route === "create" || selected.route === "update-branch") &&
				selected.workflow.state.phase === "conflict-awaiting-user";
			if (!queuedHelperPending) {
				if (helperSettled && conflictPending && !selected.conflictRetained) {
					selected.usedSinceSettlement = false;
					selected.conflictRetained = true;
				} else clearWorkflow(selected);
			}
		}
		const delegatedRefresh = delegatedWorkPending && lastDiscovery !== "inactive";
		delegatedWorkPending = false;
		if (!workflowSettled && !helperSettled && !delegatedRefresh) return;
		cancelRefresh();
		if (createWorkflowSettled || helperSettled && selected?.route === "create") pendingWorkspaceRename = true;
		await refresh().catch(reportRefreshFailure);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || event.isError || lastDiscovery === "inactive") return;
		if (DELEGATED_TOOLS.has(event.toolName)) delegatedWorkPending = true;
		if (!isBashToolResult(event)) return;
		const command = event.input.command;
		if (typeof command === "string" && (GH_PR_CREATE.test(command) || GIT_COMMIT.test(command) || GIT_PUSH.test(command))) {
			if (GIT_COMMIT.test(command)) mergeCompleted = false;
			await refresh().catch(reportRefreshFailure);
		}
	});

	const commandHandler = createCommandHandler(pi, {
		loadCurrentPullRequest: load,
		reserveWorkflow,
		markWorkflowPromptQueued,
		releaseWorkflow,
	});
	pi.registerCommand("pr", {
		description: "[--base=<host>/<owner>/<repository>:<ref>] — Run the current branch pull request next step",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || !context) return;
			const generation = sessionGeneration;
			const invocation = ++commandGeneration;
			activeInvocations.set(invocation, "routing");
			if (displayedWidget !== undefined) setWidget(ctx, undefined);
			const commandInvocation: PrCommandInvocation = {
				sessionGeneration: generation,
				assertCurrent() {
					if (sessionGeneration !== generation) {
						throw new Error("PR command session changed during dispatch");
					}
				},
			};
			let nextStep: Awaited<ReturnType<typeof commandHandler>>;
			try {
				nextStep = await commandHandler(args, ctx, commandInvocation);
			} catch (error) {
				if (sessionGeneration === generation) {
					cancelRefresh();
					activeInvocations.delete(invocation);
					if (!activeInvocations.size) {
						setWidget(ctx, displayedWidget);
					}
					refreshInBackground();
				}
				throw error;
			}
			if (sessionGeneration !== generation) return;
			cancelRefresh();
			if (WORKFLOW_ROUTES.has(nextStep)) {
				activeInvocations.set(invocation, nextStep === "create" ? "create-workflow" : "workflow");
				if (nextStep === "create") ctx.ui.setStatus(UI_KEY, undefined);
				setWidget(ctx, undefined);
			} else {
				if (nextStep === "merge") mergeCompleted = true;
				activeInvocations.delete(invocation);
				refreshInBackground();
			}
		},
	});
}

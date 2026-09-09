import {
	isBashToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@henryqw/pi-herdr";
import { createPrCommandHandler } from "./pr-command.ts";
import {
	loadCurrentPullRequest,
	parsePullRequestObservation,
	pullRequestObservation,
	samePullRequestObservation,
	type PullRequestObservation,
} from "./pr-github.ts";
import {
	discoveryIssueKey,
	discoveryIssueMessage,
	formatPrFooter,
	formatPrWidget,
	projectPrDisplay,
	unavailablePrDisplay,
	type PrDisplay,
} from "./pr-ui.ts";

const POLL_INTERVAL_MS = 30_000;
const HERDR_TIMEOUT_MS = 10_000;
const UI_KEY = "pi-pr";
const OBSERVATION_ENTRY = "pi-pr-observation";
const GH_PR_CREATE = /(?:^|[;&|]\s*|\n\s*)gh\s+pr\s+create(?=\s|$|[;&|])/;
const GIT_COMMIT = /(?:^|[;&|]\s*|\n\s*)git\s+commit(?=\s|$|[;&|])/;
const GIT_PUSH = /(?:^|[;&|]\s*|\n\s*)git\s+push(?=\s|$|[;&|])/;
const WORKFLOW_ROUTES = new Set(["create", "update-branch", "sweep", "fix-ci"]);
const DELEGATED_TOOLS = new Set(["delegate_task", "delegate_flow", "delegate_flow_continue"]);

type PullRequestExtensionDependencies = {
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
	createPrCommandHandler?: typeof createPrCommandHandler;
};

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
	const createCommandHandler = dependencies.createPrCommandHandler ?? createPrCommandHandler;
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
	let displayedWidget: PrDisplay | undefined;
	let commandGeneration = 0;
	const activeInvocations = new Map<number, "routing" | "create-workflow" | "workflow">();

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
		const display = projectPrDisplay(discovery);
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
		displayedWidget = undefined;
		commandGeneration = 0;
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
			try {
				discovery = await load(pi, loadContext);
				if (controller.signal.aborted || sessionGeneration !== generation) return;
				render(ctx, discovery);
			} catch {
				if (!controller.signal.aborted && sessionGeneration === generation) {
					const hadAction = displayedWidget !== undefined;
					displayedWidget = undefined;
					if (!displayEstablished) {
						const unavailable = unavailablePrDisplay();
						ctx.ui.setStatus(UI_KEY, formatPrFooter(unavailable, ctx.ui.theme));
						setWidget(ctx, undefined);
						displayEstablished = true;
					} else if (hadAction) {
						setWidget(ctx, undefined);
					}
					reportRefreshFailure();
				}
				return;
			}
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
		let workflowSettled = false;
		let createWorkflowSettled = false;
		for (const [invocation, phase] of activeInvocations) {
			if (phase !== "workflow" && phase !== "create-workflow") continue;
			activeInvocations.delete(invocation);
			workflowSettled = true;
			if (phase === "create-workflow") createWorkflowSettled = true;
		}
		const delegatedRefresh = delegatedWorkPending && lastDiscovery !== "inactive";
		delegatedWorkPending = false;
		if (!workflowSettled && !delegatedRefresh) return;
		cancelRefresh();
		if (createWorkflowSettled) pendingWorkspaceRename = true;
		await refresh().catch(reportRefreshFailure);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || event.isError || lastDiscovery === "inactive") return;
		if (DELEGATED_TOOLS.has(event.toolName)) delegatedWorkPending = true;
		if (!isBashToolResult(event)) return;
		const command = event.input.command;
		if (typeof command === "string" && (GH_PR_CREATE.test(command) || GIT_COMMIT.test(command) || GIT_PUSH.test(command))) {
			await refresh().catch(reportRefreshFailure);
		}
	});

	const commandHandler = createCommandHandler(pi, { loadCurrentPullRequest: load });
	pi.registerCommand("pr", {
		description: "[instructions] — Run the current branch pull request next step",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || !context) return;
			const generation = sessionGeneration;
			const invocation = ++commandGeneration;
			activeInvocations.set(invocation, "routing");
			if (displayedWidget !== undefined) setWidget(ctx, undefined);
			let nextStep: Awaited<ReturnType<typeof commandHandler>>;
			try {
				nextStep = await commandHandler(args, ctx);
			} catch (error) {
				if (sessionGeneration === generation) {
					cancelRefresh();
					activeInvocations.delete(invocation);
					displayedWidget = undefined;
					setWidget(ctx, undefined);
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
				activeInvocations.delete(invocation);
				refreshInBackground();
			}
		},
	});
}

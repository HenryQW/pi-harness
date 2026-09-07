import {
	isBashToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@henryqw/pi-herdr";
import { createPrCommandHandler } from "./pr-command.ts";
import {
	hasLocalCommit,
	loadCurrentPullRequest,
} from "./pr-github.ts";
import {
	formatPrFooter,
	formatPrWidget,
	projectPrDisplay,
	type PrDisplay,
} from "./pr-ui.ts";

const POLL_INTERVAL_MS = 30_000;
const HERDR_TIMEOUT_MS = 10_000;
const UI_KEY = "pi-pr";
const GH_PR_CREATE = /(?:^|[;&|]\s*|\n\s*)gh\s+pr\s+create(?=\s|$|[;&|])/;
const GIT_COMMIT = /(?:^|[;&|]\s*|\n\s*)git\s+commit(?=\s|$|[;&|])/;
const GIT_PUSH = /(?:^|[;&|]\s*|\n\s*)git\s+push(?=\s|$|[;&|])/;

type PullRequestExtensionDependencies = {
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
	hasLocalCommit?: typeof hasLocalCommit;
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

	const load = dependencies.loadCurrentPullRequest ?? loadCurrentPullRequest;
	const detectLocalCommit = dependencies.hasLocalCommit ?? hasLocalCommit;
	const createCommandHandler = dependencies.createPrCommandHandler ?? createPrCommandHandler;
	let context: ExtensionContext | undefined;
	let sessionGeneration = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let active: AbortController | undefined;
	let queued = false;
	let refreshFailureReported = false;
	let pendingWorkspaceRename = false;
	let mergeCompleted = false;
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
		pullRequest: Awaited<ReturnType<typeof loadCurrentPullRequest>>,
		localCommit: boolean,
	): void => {
		const display = projectPrDisplay(pullRequest, localCommit);
		const footer = pullRequest === null ? undefined : formatPrFooter(display, ctx.ui.theme);
		if (pullRequest !== null && footer === undefined) {
			throw new Error("Current pull request display is missing a footer");
		}
		displayedWidget = display.widget === undefined ? undefined : display;
		const widget = activeInvocations.size > 0 ? undefined : displayedWidget;
		ctx.ui.setStatus(UI_KEY, footer);
		setWidget(ctx, widget);
	};

	const stop = (): void => {
		sessionGeneration += 1;
		context = undefined;
		queued = false;
		refreshFailureReported = false;
		pendingWorkspaceRename = false;
		mergeCompleted = false;
		displayedWidget = undefined;
		commandGeneration = 0;
		activeInvocations.clear();
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		active?.abort();
		active = undefined;
	};

	const reportRefreshFailure = (error: unknown): void => {
		const ctx = context;
		if (!ctx || refreshFailureReported) return;
		refreshFailureReported = true;
		try {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`PR status refresh failed: ${message.slice(0, 500)}`, "error");
		} catch (reportError) {
			console.error("PR status refresh failed and could not be reported", error, reportError);
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
		if (!ctx) return;
		const generation = sessionGeneration;
		if (active) {
			queued = true;
			return;
		}

		const controller = new AbortController();
		const loadContext = { cwd: ctx.cwd, signal: controller.signal };
		active = controller;
		try {
			let pullRequest: Awaited<ReturnType<typeof loadCurrentPullRequest>>;
			let localCommit = false;
			try {
				pullRequest = await load(pi, loadContext);
				if (controller.signal.aborted || sessionGeneration !== generation) return;
				if (pullRequest === null) {
					localCommit = !mergeCompleted && await detectLocalCommit(pi, loadContext);
				}
			} catch (error) {
				// Keep the last known display when lookup is unavailable.
				if (!controller.signal.aborted && sessionGeneration === generation) reportRefreshFailure(error);
				return;
			}
			if (controller.signal.aborted || sessionGeneration !== generation) return;
			render(ctx, pullRequest, localCommit);
			refreshFailureReported = false;

			if (pendingWorkspaceRename && pullRequest?.lifecycle === "open") {
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
		if (!ctx.hasUI) return;
		context = ctx;
		await refresh();
		if (sessionGeneration === generation) timer = setInterval(refreshInBackground, POLL_INTERVAL_MS);
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
		if (!workflowSettled) return;
		cancelRefresh();
		if (createWorkflowSettled) pendingWorkspaceRename = true;
		await refresh().catch(reportRefreshFailure);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || event.isError || !isBashToolResult(event)) return;
		const command = event.input.command;
		if (typeof command === "string" && (GH_PR_CREATE.test(command) || GIT_COMMIT.test(command) || GIT_PUSH.test(command))) {
			if (GIT_COMMIT.test(command)) mergeCompleted = false;
			await refresh().catch(reportRefreshFailure);
		}
	});

	const commandHandler = createCommandHandler(pi);
	pi.registerCommand("pr", {
		description: "Run the current branch pull request next step",
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
					if (!activeInvocations.size) {
						setWidget(ctx, displayedWidget);
					}
					refreshInBackground();
				}
				throw error;
			}
			if (sessionGeneration !== generation) return;
			cancelRefresh();
			if (nextStep !== "none" && nextStep !== "merge") {
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

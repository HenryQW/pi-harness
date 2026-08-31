import {
	isBashToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createPrCommandHandler } from "./pr-command.ts";
import { loadCurrentPullRequest } from "./pr-github.ts";
import {
	formatPrFooter,
	formatPrWidget,
	projectPrDisplay,
} from "./pr-ui.ts";

const POLL_INTERVAL_MS = 30_000;
const UI_KEY = "pi-pr";
const GH_PR_CREATE = /(?:^|[;&|]\s*|\n\s*)gh\s+pr\s+create(?=\s|$|[;&|])/;
const GIT_PUSH = /(?:^|[;&|]\s*|\n\s*)git\s+push(?=\s|$|[;&|])/;

type PullRequestExtensionDependencies = {
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
	createPrCommandHandler?: typeof createPrCommandHandler;
};

export default function pullRequestExtension(
	pi: ExtensionAPI,
	dependencies: PullRequestExtensionDependencies = {},
): void {
	const load = dependencies.loadCurrentPullRequest ?? loadCurrentPullRequest;
	const createCommandHandler = dependencies.createPrCommandHandler ?? createPrCommandHandler;
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let active: AbortController | undefined;
	let queued = false;
	let refreshFailureReported = false;

	const render = (ctx: ExtensionContext, pullRequest: Awaited<ReturnType<typeof loadCurrentPullRequest>>): void => {
		const display = projectPrDisplay(pullRequest);
		const footer = pullRequest === null ? undefined : formatPrFooter(display, ctx.ui.theme);
		if (pullRequest !== null && footer === undefined) {
			throw new Error("Current pull request display is missing a footer");
		}
		const widget = formatPrWidget(display);
		ctx.ui.setStatus(UI_KEY, footer);
		ctx.ui.setWidget(UI_KEY, widget === undefined ? undefined : [widget]);
	};

	const stop = (): void => {
		context = undefined;
		queued = false;
		refreshFailureReported = false;
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

	const refresh = async (): Promise<void> => {
		const ctx = context;
		if (!ctx) return;
		if (active) {
			queued = true;
			return;
		}

		const controller = new AbortController();
		const loadContext = { cwd: ctx.cwd, signal: controller.signal };
		active = controller;
		try {
			let pullRequest: Awaited<ReturnType<typeof loadCurrentPullRequest>>;
			try {
				pullRequest = await load(pi, loadContext);
			} catch {
				// Keep the last known display when lookup is unavailable.
				return;
			}
			if (controller.signal.aborted || context !== ctx) return;
			render(ctx, pullRequest);
			refreshFailureReported = false;
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

	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (!ctx.hasUI) return;
		context = ctx;
		await refresh();
		if (context === ctx) timer = setInterval(refreshInBackground, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", stop);

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || event.isError || !isBashToolResult(event)) return;
		const command = event.input.command;
		if (typeof command === "string" && (GH_PR_CREATE.test(command) || GIT_PUSH.test(command))) {
			await refresh().catch(reportRefreshFailure);
		}
	});

	const commandHandler = createCommandHandler(pi);
	pi.registerCommand("pr", {
		description: "Run the current branch pull request next step",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			try {
				await commandHandler(args, ctx);
			} finally {
				refreshInBackground();
			}
		},
	});
}

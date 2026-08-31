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

	const render = (ctx: ExtensionContext, pullRequest: Awaited<ReturnType<typeof loadCurrentPullRequest>>): void => {
		const display = projectPrDisplay(pullRequest);
		if (pullRequest === null) {
			ctx.ui.setStatus(UI_KEY, undefined);
		} else {
			const footer = formatPrFooter(display, ctx.ui.theme);
			if (footer === undefined) throw new Error("Current pull request display is missing a footer");
			ctx.ui.setStatus(UI_KEY, footer);
		}
		const widget = formatPrWidget(display);
		ctx.ui.setWidget(UI_KEY, widget === undefined ? undefined : [widget]);
	};

	const stop = (): void => {
		context = undefined;
		queued = false;
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		active?.abort();
		active = undefined;
	};

	const refresh = async (): Promise<void> => {
		const ctx = context;
		if (!ctx) return;
		if (active) {
			queued = true;
			return;
		}

		const controller = new AbortController();
		active = controller;
		try {
			const pullRequest = await load(pi, {
				cwd: ctx.cwd,
				signal: controller.signal,
			});
			if (controller.signal.aborted || context !== ctx) return;
			render(ctx, pullRequest);
		} catch {
			// Keep the last known display when lookup is unavailable.
		} finally {
			if (active !== controller) return;
			active = undefined;
			if (queued) {
				queued = false;
				void refresh();
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (!ctx.hasUI) return;
		context = ctx;
		await refresh();
		if (context === ctx) timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", stop);

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || event.isError || !isBashToolResult(event)) return;
		const command = event.input.command;
		if (typeof command === "string" && (GH_PR_CREATE.test(command) || GIT_PUSH.test(command))) {
			await refresh();
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
				void refresh();
			}
		},
	});
}

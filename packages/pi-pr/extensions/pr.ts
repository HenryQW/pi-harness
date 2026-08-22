import {
	isBashToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";

const POLL_INTERVAL_MS = 30_000;
const PR_FIELDS = "number,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup";
const GH_PR_CREATE = /(?:^|[;&|]\s*|\n\s*)gh\s+pr\s+create(?=\s|$|[;&|])/;
const FAILED_CHECK_STATES = new Set(["ACTION_REQUIRED", "CANCELLED", "ERROR", "FAILURE", "STALE", "STARTUP_FAILURE", "TIMED_OUT"]);
const SUCCESSFUL_CHECK_STATES = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"]);

type Lifecycle = "D" | "O" | "M" | "C";
type CiStatus = "success" | "running" | "failure" | "none";
type PullRequest = {
	number: number;
	url: string;
	lifecycle: Lifecycle;
	mergeable: string;
	reviewDecision: string | null;
	statusCheckRollup: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pullRequestUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function parsePullRequest(value: unknown): PullRequest | undefined {
	if (!isRecord(value)) return undefined;

	const number = value.number;
	const url = pullRequestUrl(value.url);
	const state = value.state;
	const isDraft = value.isDraft;
	const mergeable = value.mergeable;
	const reviewDecision = value.reviewDecision;
	const statusCheckRollup = value.statusCheckRollup;
	if (
		typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || !url || typeof state !== "string" ||
		typeof isDraft !== "boolean" || typeof mergeable !== "string" ||
		(reviewDecision !== null && typeof reviewDecision !== "string") ||
		(statusCheckRollup !== null && !Array.isArray(statusCheckRollup))
	) return undefined;

	const lifecycle = state === "MERGED" ? "M" : state === "CLOSED" ? "C" : state === "OPEN" ? isDraft ? "D" : "O" : undefined;
	if (!lifecycle) return undefined;

	return { number, url, lifecycle, mergeable, reviewDecision, statusCheckRollup: statusCheckRollup ?? [] };
}

function ciStatus(rollup: unknown[]): CiStatus {
	if (!rollup.length) return "none";
	let running = false;
	for (const check of rollup) {
		const record = isRecord(check) ? check : undefined;
		const value = record?.conclusion ?? record?.state ?? record?.status;
		const state = typeof value === "string" ? value.toUpperCase() : undefined;
		if (state && FAILED_CHECK_STATES.has(state)) return "failure";
		if (!state || !SUCCESSFUL_CHECK_STATES.has(state)) running = true;
	}
	return running ? "running" : "success";
}

type Status = {
	text: string;
	color: "accent" | "warning" | "success" | "error" | "dim";
};

function statusFor(pullRequest: PullRequest, ci: CiStatus): Status {
	if (pullRequest.lifecycle === "M") return { text: "merged", color: "success" };
	if (pullRequest.lifecycle === "C") return { text: "closed", color: "dim" };
	if (pullRequest.mergeable === "CONFLICTING") return { text: "merge conflict", color: "error" };
	if (pullRequest.reviewDecision === "CHANGES_REQUESTED") return { text: "changes requested", color: "error" };
	if (ci === "failure") return { text: "CI failed", color: "error" };
	if (ci === "running") return { text: "CI running", color: "warning" };
	if (pullRequest.lifecycle === "D") return { text: "draft", color: "warning" };
	if (pullRequest.reviewDecision === "APPROVED") return { text: "approved", color: "success" };
	return { text: "open", color: "accent" };
}

export function formatPullRequest(pullRequest: PullRequest, theme: ExtensionContext["ui"]["theme"]): string {
	const link = hyperlink(theme.fg("text", `PR #${pullRequest.number}`), pullRequest.url);
	const status = statusFor(pullRequest, ciStatus(pullRequest.statusCheckRollup));
	return `${link} · ${theme.fg(status.color, status.text)}`;
}

export default function pullRequestExtension(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let active: AbortController | undefined;
	let queued = false;

	const stop = () => {
		context = undefined;
		queued = false;
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		active?.abort();
		active = undefined;
	};

	const refresh = async (afterActive = false): Promise<void> => {
		const ctx = context;
		if (!ctx) return;
		if (active) {
			queued ||= afterActive;
			return;
		}

		const controller = new AbortController();
		active = controller;
		try {
			const result = await pi.exec(
				"gh",
				["pr", "view", "--json", PR_FIELDS],
				{ cwd: ctx.cwd, signal: controller.signal, timeout: 10_000 },
			);
			if (controller.signal.aborted || context !== ctx) return;
			if (result.code !== 0) {
				ctx.ui.setStatus("pi-pr", undefined);
				return;
			}

			const pullRequest = parsePullRequest(JSON.parse(result.stdout));
			ctx.ui.setStatus("pi-pr", pullRequest ? formatPullRequest(pullRequest, ctx.ui.theme) : undefined);
		} catch {
			if (!controller.signal.aborted && context === ctx) ctx.ui.setStatus("pi-pr", undefined);
		} finally {
			if (active !== controller) return;
			active = undefined;
			if (queued) {
				queued = false;
				await refresh();
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		stop();
		context = ctx;
		await refresh();
		if (context === ctx) timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", stop);

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || event.isError || !isBashToolResult(event)) return;
		const command = event.input.command;
		if (typeof command === "string" && GH_PR_CREATE.test(command)) await refresh(true);
	});

	pi.registerCommand("pr", {
		description: "Open the pull request for the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			let result;
			try {
				result = await pi.exec("gh", ["pr", "view", "--web"], { cwd: ctx.cwd, signal: ctx.signal, timeout: 10_000 });
			} catch (error) {
				void refresh(true);
				throw new Error(`Open pull request failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			void refresh(true);
			if (result.code !== 0) {
				const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "command was cancelled" : `exit code ${result.code}`);
				throw new Error(`Open pull request failed: ${detail}`);
			}
		},
	});
}

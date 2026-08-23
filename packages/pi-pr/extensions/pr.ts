import {
	isBashToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";

const POLL_INTERVAL_MS = 30_000;
const REVIEW_POLL_WINDOW_MS = 20 * 60_000;
const PR_FIELDS = "id,number,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup";
const REVIEW_THREADS_QUERY = "query($id:ID!,$endCursor:String){node(id:$id){...on PullRequest{reviewThreads(first:100,after:$endCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}";
const GH_PR_CREATE = /(?:^|[;&|]\s*|\n\s*)gh\s+pr\s+create(?=\s|$|[;&|])/;
const GIT_PUSH = /(?:^|[;&|]\s*|\n\s*)git\s+push(?=\s|$|[;&|])/;
const CREATE_PR_SKILL_COMMAND = "skill:pi-pr-create";
const FAILED_CHECK_STATES = new Set(["ACTION_REQUIRED", "CANCELLED", "ERROR", "FAILURE", "STALE", "STARTUP_FAILURE", "TIMED_OUT"]);
const SUCCESSFUL_CHECK_STATES = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"]);

type Lifecycle = "D" | "O" | "M" | "C";
type CiStatus = "success" | "running" | "failure" | "none";
type PullRequest = {
	id: string;
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

	const id = value.id;
	const number = value.number;
	const url = pullRequestUrl(value.url);
	const state = value.state;
	const isDraft = value.isDraft;
	const mergeable = value.mergeable;
	const reviewDecision = value.reviewDecision;
	const statusCheckRollup = value.statusCheckRollup;
	if (
		typeof id !== "string" || !id ||
		typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || !url || typeof state !== "string" ||
		typeof isDraft !== "boolean" || typeof mergeable !== "string" ||
		(reviewDecision !== null && typeof reviewDecision !== "string") ||
		(statusCheckRollup !== null && !Array.isArray(statusCheckRollup))
	) return undefined;

	const lifecycle = state === "MERGED" ? "M" : state === "CLOSED" ? "C" : state === "OPEN" ? isDraft ? "D" : "O" : undefined;
	if (!lifecycle) return undefined;

	return { id, number, url, lifecycle, mergeable, reviewDecision, statusCheckRollup: statusCheckRollup ?? [] };
}

function parseUnresolvedReviewCount(value: string): number {
	if (!value.trim()) throw new Error("Read review comments failed: invalid GitHub CLI output");
	const pages = value.trim().split(/\s+/).map(Number);
	const count = pages.reduce((total, page) => total + page, 0);
	if (pages.some((page) => !Number.isSafeInteger(page) || page < 0) || !Number.isSafeInteger(count)) {
		throw new Error("Read review comments failed: invalid GitHub CLI output");
	}
	return count;
}

function parseRepositoryName(json: string): string {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new Error("Read push repository failed: invalid GitHub CLI output");
	}
	const nameWithOwner = isRecord(value) ? value.nameWithOwner : undefined;
	if (typeof nameWithOwner !== "string" || !nameWithOwner) {
		throw new Error("Read push repository failed: invalid GitHub CLI output");
	}
	return nameWithOwner.toLowerCase();
}

function parseOpenPullRequestNumbers(json: string, headRepository: string): number[] {
	let values: unknown;
	try {
		values = JSON.parse(json);
	} catch {
		throw new Error("Find pull requests failed: invalid GitHub CLI output");
	}
	if (!Array.isArray(values)) throw new Error("Find pull requests failed: invalid GitHub CLI output");
	return values.flatMap((value) => {
		const number = isRecord(value) ? value.number : undefined;
		const repository = isRecord(value) ? value.headRepository : undefined;
		if (repository === null) return [];
		const nameWithOwner = isRecord(repository) ? repository.nameWithOwner : undefined;
		if (
			typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 ||
			typeof nameWithOwner !== "string" || !nameWithOwner
		) throw new Error("Find pull requests failed: invalid GitHub CLI output");
		return nameWithOwner.toLowerCase() === headRepository ? [number] : [];
	});
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
	let reviewState: { id: string; unresolved: number } | undefined;
	let reviewWindow: { id: string; until: number } | undefined;

	const stop = () => {
		context = undefined;
		queued = false;
		reviewState = undefined;
		reviewWindow = undefined;
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
			if (!pullRequest || pullRequest.lifecycle === "M" || pullRequest.lifecycle === "C") {
				reviewState = undefined;
				reviewWindow = undefined;
				return;
			}
			if (reviewWindow?.id !== pullRequest.id) {
				reviewWindow = { id: pullRequest.id, until: Date.now() + REVIEW_POLL_WINDOW_MS };
			}
			if (Date.now() >= reviewWindow.until) return;

			try {
				const reviews = await pi.exec(
					"gh",
					[
						"api", "graphql", "--hostname", new URL(pullRequest.url).hostname, "--paginate",
						"-f", `query=${REVIEW_THREADS_QUERY}`, "-F", `id=${pullRequest.id}`,
						"--jq", "[.data.node.reviewThreads.nodes[] | select(.isResolved == false)] | length",
					],
					{ cwd: ctx.cwd, signal: controller.signal, timeout: 10_000 },
				);
				if (controller.signal.aborted || context !== ctx || reviews.code !== 0) return;
				const unresolved = parseUnresolvedReviewCount(reviews.stdout);
				if (unresolved > 0 && (reviewState?.id !== pullRequest.id || unresolved > reviewState.unresolved)) {
					ctx.ui.notify(`PR #${pullRequest.number} has ${unresolved} unresolved review thread${unresolved === 1 ? "" : "s"}`, "warning");
				}
				reviewState = { id: pullRequest.id, unresolved };
			} catch {
				// Keep known PR status when review lookup fails.
			}
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
		if (typeof command === "string" && (GH_PR_CREATE.test(command) || GIT_PUSH.test(command))) {
			reviewState = undefined;
			if (reviewWindow) reviewWindow.until = Date.now() + REVIEW_POLL_WINDOW_MS;
			await refresh(true);
		}
	});

	pi.registerCommand("pr", {
		description: "Open current branch pull request, or run creation workflow when absent",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const execute = async (action: string, command: string, args: string[]) => {
				let result;
				try {
					result = await pi.exec(command, args, { cwd: ctx.cwd, signal: ctx.signal, timeout: 10_000 });
				} catch (error) {
					throw new Error(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (result.code !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "command was cancelled" : `exit code ${result.code}`);
					throw new Error(`${action} failed: ${detail}`);
				}
				return result;
			};

			try {
				const branch = (await execute("Read current branch", "git", ["branch", "--show-current"])).stdout.trim();
				if (!branch) throw new Error("Create pull request failed: current checkout has no branch");
				const remote = (await execute("Read push remote", "git", ["remote", "get-url", "--push", "origin"])).stdout.trim();
				if (!remote) throw new Error("Read push remote failed: origin has no push URL");
				const repository = await execute("Read push repository", "gh", ["repo", "view", remote, "--json", "nameWithOwner"]);
				const listed = await execute("Find pull requests", "gh", [
					"pr", "list", "--head", branch, "--state", "open", "--limit", "100", "--json", "number,headRepository",
				]);
				const numbers = parseOpenPullRequestNumbers(listed.stdout, parseRepositoryName(repository.stdout));
				if (numbers.length > 1) throw new Error("Open pull request failed: multiple open pull requests found for current branch");

				if (numbers.length === 1) {
					await execute("Open pull request", "gh", ["pr", "view", String(numbers[0]), "--web"]);
					return;
				}

				const workflow = pi.getCommands().find((command) =>
					command.name === CREATE_PR_SKILL_COMMAND && command.source === "skill" && command.sourceInfo.origin === "package",
				);
				if (!workflow) throw new Error("Create pull request failed: bundled workflow is unavailable");
				if (ctx.isIdle()) {
					pi.sendUserMessage(`/${CREATE_PR_SKILL_COMMAND}`, { expandPromptTemplates: true });
				} else {
					pi.sendUserMessage(`/${CREATE_PR_SKILL_COMMAND}`, { deliverAs: "followUp", expandPromptTemplates: true });
				}
			} finally {
				void refresh(true);
			}
		},
	});
}

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { configuredOpenUri } from "@henryqw/pi-open-in/open-uri";

const THINKING_COLORS = {
	minimal: 46,
	low: 82,
	medium: 118,
	high: 220,
	xhigh: 208,
	max: 196,
} as const;
const HENRY_STATUS_KEY = "pi-multi-codex";
const AGENT_TIME_ENTRY = "pi-footer:agent-work";
const SUBAGENT_BACKGROUND_RESULT = "subagent-background-result";

type CountedUsage = { input: number; output: number; cost: { total: number } };
type GitSummary = { badges: string; detachedOid?: string };

const EMPTY_GIT_SUMMARY: GitSummary = { badges: "" };

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function subagentBackgroundUsage(details: unknown): CountedUsage | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return;
	const usage = (details as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
	const record = usage as Record<string, unknown>;
	const cost = record.cost;
	if (!cost || typeof cost !== "object" || Array.isArray(cost)) return;
	const total = (cost as Record<string, unknown>).total;
	if (!isNonNegativeNumber(record.input) || !isNonNegativeNumber(record.output) || !isNonNegativeNumber(total)) return;
	return { input: record.input, output: record.output, cost: { total } };
}

function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor(totalSeconds % 3_600 / 60);
	const seconds = totalSeconds % 60;
	return hours ? `${hours}h ${minutes}m ${seconds}s` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

function summarizeGitStatus(output: string, operation?: string): GitSummary {
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let conflicts = 0;
	let ahead = 0;
	let behind = 0;
	let detachedOid: string | undefined;

	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith("# branch.oid ")) {
			const oid = line.slice(13).trim();
			if (oid !== "(initial)") detachedOid = oid.slice(0, 7);
		} else if (line.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
		} else if (line.startsWith("? ")) {
			untracked++;
		} else if (line.startsWith("u ")) {
			conflicts++;
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const xy = line.slice(2, 4);
			if (xy[0] !== ".") staged++;
			if (xy[1] !== ".") unstaged++;
		}
	}

	const badges = [
		operation,
		conflicts ? `!${conflicts}` : undefined,
		staged ? `+${staged}` : undefined,
		unstaged ? `~${unstaged}` : undefined,
		untracked ? `?${untracked}` : undefined,
		ahead ? `↑${ahead}` : undefined,
		behind ? `↓${behind}` : undefined,
	].filter(Boolean).join(" ");
	return { badges: badges ? `[${badges}]` : "", detachedOid };
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

function operationProgress(current: string | undefined, total: string | undefined): string {
	const currentStep = Number.parseInt(current ?? "", 10);
	const totalSteps = Number.parseInt(total ?? "", 10);
	return currentStep > 0 && totalSteps > 0 ? ` ${currentStep}/${totalSteps}` : "";
}

async function readGitOperation(gitDir: string): Promise<string | undefined> {
	const [
		rebaseMergeCurrent,
		rebaseMergeTotal,
		rebaseApplyCurrent,
		rebaseApplyTotal,
		applying,
		mergeHead,
		cherryPickHead,
		revertHead,
		bisectLog,
	] = await Promise.all([
		readOptional(join(gitDir, "rebase-merge", "msgnum")),
		readOptional(join(gitDir, "rebase-merge", "end")),
		readOptional(join(gitDir, "rebase-apply", "next")),
		readOptional(join(gitDir, "rebase-apply", "last")),
		readOptional(join(gitDir, "rebase-apply", "applying")),
		readOptional(join(gitDir, "MERGE_HEAD")),
		readOptional(join(gitDir, "CHERRY_PICK_HEAD")),
		readOptional(join(gitDir, "REVERT_HEAD")),
		readOptional(join(gitDir, "BISECT_LOG")),
	]);
	if (rebaseMergeCurrent !== undefined) return `REBASE${operationProgress(rebaseMergeCurrent, rebaseMergeTotal)}`;
	if (rebaseApplyCurrent !== undefined) {
		return `${applying === undefined ? "REBASE" : "AM"}${operationProgress(rebaseApplyCurrent, rebaseApplyTotal)}`;
	}
	if (mergeHead !== undefined) return "MERGING";
	if (cherryPickHead !== undefined) return "CHERRY-PICKING";
	if (revertHead !== undefined) return "REVERTING";
	if (bisectLog !== undefined) return "BISECTING";
}

function align(left: string, right: string, width: number, ellipsis: string): string {
	const available = width - visibleWidth(left) - 2;
	if (available <= 0) return truncateToWidth(left, width, ellipsis);
	const clippedRight = truncateToWidth(right, available, "");
	return left + " ".repeat(width - visibleWidth(left) - visibleWidth(clippedRight)) + clippedRight;
}

// Mirrors align but reserves the right side (runtime) and truncates the left status first.
function alignRightReserved(left: string, right: string, width: number, ellipsis: string): string {
	const available = Math.max(width - visibleWidth(right) - 2, 0);
	const clippedLeft = truncateToWidth(left, available, ellipsis);
	return clippedLeft + " ".repeat(Math.max(width - visibleWidth(clippedLeft) - visibleWidth(right), 0)) + truncateToWidth(right, width, "");
}

function color(text: string, ansi256: number): string {
	return `\x1b[38;5;${ansi256}m${text}\x1b[39m`;
}

function rainbow(text: string): string {
	const colors = [196, 220, 46, 39, 201];
	return [...text].map((character, index) => color(character, colors[index % colors.length]!)).join("");
}

export default function footerExtension(pi: ExtensionAPI): void {
	let activeMilliseconds = 0;
	let activeStartedAt: number | undefined;
	let promptPaused = false;
	let runtimeTimer: ReturnType<typeof setInterval> | undefined;
	let requestRuntimeRender: (() => void) | undefined;
	let refreshGitStatus: (() => Promise<void>) | undefined;
	const stopRuntimeTimer = () => {
		if (runtimeTimer === undefined) return;
		clearInterval(runtimeTimer);
		runtimeTimer = undefined;
	};

	const startActive = () => {
		if (activeStartedAt !== undefined || promptPaused) return;
		activeStartedAt = performance.now();
		if (requestRuntimeRender) runtimeTimer = setInterval(requestRuntimeRender, 1_000);
		requestRuntimeRender?.();
	};
	const pauseActive = () => {
		if (activeStartedAt === undefined) return;
		activeMilliseconds += performance.now() - activeStartedAt;
		activeStartedAt = undefined;
		promptPaused = true;
		stopRuntimeTimer();
		requestRuntimeRender?.();
	};
	const resumeActive = () => {
		if (!promptPaused) return;
		promptPaused = false;
		activeStartedAt = performance.now();
		if (requestRuntimeRender) runtimeTimer = setInterval(requestRuntimeRender, 1_000);
		requestRuntimeRender?.();
	};
	const finalizeActive = (): boolean => {
		if (activeStartedAt === undefined && !promptPaused) return false;
		if (activeStartedAt !== undefined) activeMilliseconds += performance.now() - activeStartedAt;
		activeStartedAt = undefined;
		promptPaused = false;
		stopRuntimeTimer();
		requestRuntimeRender?.();
		return true;
	};

	pi.on("agent_start", (_event) => {
		startActive();
	});
	pi.on("ui_prompt_start", () => {
		pauseActive();
	});
	pi.on("ui_prompt_end", () => {
		resumeActive();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.isIdle()) return;
		if (finalizeActive()) pi.appendEntry(AGENT_TIME_ENTRY, activeMilliseconds);
		await refreshGitStatus?.();
	});
	pi.on("session_shutdown", () => {
		stopRuntimeTimer();
		activeStartedAt = undefined;
		promptPaused = false;
		refreshGitStatus = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		stopRuntimeTimer();
		activeStartedAt = undefined;
		promptPaused = false;
		requestRuntimeRender = undefined;
		refreshGitStatus = undefined;
		// Latest valid entry wins; stored data is untrusted.
		activeMilliseconds = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === AGENT_TIME_ENTRY && isNonNegativeNumber(entry.data)) {
				activeMilliseconds = entry.data;
			}
		}
		if (ctx.mode !== "tui") return;

		const git = await pi.exec(
			"git",
			["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"],
			{ cwd: ctx.cwd },
		);
		const [root, commonDir, gitDir] = git.stdout.trim().split(/\r?\n/);
		const rootName = basename(root || ctx.cwd);
		const commonName = commonDir && basename(commonDir) === ".git" ? basename(dirname(commonDir)) : undefined;
		const repo = git.code === 0 ? commonName && commonName !== rootName ? commonName : rootName : basename(ctx.cwd);
		let gitSummary = EMPTY_GIT_SUMMARY;
		if (git.code === 0 && gitDir) {
			refreshGitStatus = async () => {
				const [status, operation] = await Promise.all([
					pi.exec("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], { cwd: ctx.cwd }),
					readGitOperation(gitDir),
				]);
				gitSummary = status.code === 0 ? summarizeGitStatus(status.stdout, operation) : EMPTY_GIT_SUMMARY;
				requestRuntimeRender?.();
			};
			await refreshGitStatus();
		}

		let tps: number | undefined;
		let assistantStartedAt: number | undefined;
		pi.on("message_start", async (event) => {
			if (event.message.role === "assistant") assistantStartedAt = performance.now();
		});
		pi.on("message_end", async (event) => {
			if (event.message.role !== "assistant") return;
			const output = event.message.usage?.output ?? 0;
			const seconds = assistantStartedAt === undefined ? 0 : (performance.now() - assistantStartedAt) / 1000;
			assistantStartedAt = undefined;
			tps = seconds > 0 ? output / seconds : undefined;
		});

		// ponytail: keyed on length + last entry (sessions are append-only); revisit if entries ever mutate in place.
		let usageKey: string | undefined;
		let input = 0;
		let output = 0;
		let cost = 0;
		let cacheRate: number | undefined;
		const computeUsage = () => {
			input = 0;
			output = 0;
			cost = 0;
			cacheRate = undefined;
			const add = (usage: CountedUsage | undefined) => {
				if (!usage) return;
				input += usage.input;
				output += usage.output;
				cost += usage.cost.total;
			};

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const usage = entry.message.usage;
					const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
					cacheRate = prompt ? usage.cacheRead / prompt * 100 : 0;
					add(usage);
				} else if (entry.type === "message" && entry.message.role === "toolResult") {
					add(entry.message.usage);
				} else if (entry.type === "custom_message" && entry.customType === SUBAGENT_BACKGROUND_RESULT) {
					add(subagentBackgroundUsage(entry.details));
				} else if (entry.type === "branch_summary" || entry.type === "compaction") {
					add(entry.usage);
				}
			}
		};

		ctx.ui.setFooter((tui, theme, data) => {
			requestRuntimeRender = () => tui.requestRender();
			const unsubscribe = data.onBranchChange(() => {
				void refreshGitStatus?.();
				requestRuntimeRender?.();
			});
			return {
				dispose() {
					unsubscribe();
					requestRuntimeRender = undefined;
					stopRuntimeTimer();
				},
				invalidate() { },
				render(width: number): string[] {
					const entries = ctx.sessionManager.getEntries();
					const key = `${entries.length}:${entries.at(-1)?.type}`;
					if (key !== usageKey) {
						usageKey = key;
						computeUsage();
					}

					const reportedBranch = data.getGitBranch()?.replace(/^worktree\//, "");
					const branch = reportedBranch === "detached" && gitSummary.detachedOid ? `@${gitSummary.detachedOid}` : reportedBranch;
					const context = ctx.getContextUsage()?.percent;
					const openUri = configuredOpenUri(ctx.cwd);
					const extensionStatuses = data.getExtensionStatuses();
					const prStatus = sanitizeStatus(extensionStatuses.get("pi-pr") ?? "");
					const statuses = [...extensionStatuses]
						.filter(([key]) => key !== "pi-pr")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([key, text]) => [key, sanitizeStatus(text)] as const)
						.filter(([, text]) => Boolean(text));
					const henryStatuses = statuses
						.filter(([key]) => key === HENRY_STATUS_KEY)
						.map(([, text]) => text);
					const externalStatuses = statuses
						.filter(([key]) => key !== HENRY_STATUS_KEY)
						.map(([, text]) => text);
					const thinking = String(ctx.thinkingLevel ?? "off");
					const thinkingColor = THINKING_COLORS[thinking as keyof typeof THINKING_COLORS];
					const ellipsis = theme.fg("dim", "…");
					const usage = theme.fg("dim", [
						`↑ ${formatTokens(input)}`,
						`↓ ${formatTokens(output)}`,
						`↺ ${cacheRate === undefined ? "—" : `${cacheRate.toFixed(1)}%`}`,
						`⚡ ${tps === undefined ? "—" : `${tps.toFixed(1)} t/s`}`,
					`$ ${cost.toFixed(3)}`,
						`◔ ${context == null ? "—" : `${context.toFixed(1)}%`}`,
					].join(" · "));
					const thinkingText = thinking === "ultra"
						? rainbow(thinking)
						: thinkingColor === undefined ? theme.fg("dim", thinking) : color(thinking, thinkingColor);
					const model = theme.fg("dim", `${ctx.model?.id ?? "no-model"} • `) + thinkingText;
					const elapsed = activeMilliseconds + (activeStartedAt === undefined ? 0 : performance.now() - activeStartedAt);
					const runtime = theme.fg("dim", `◷ ${formatDuration(elapsed)}`);
					const identity = branch ? theme.fg("dim", `${repo} · `) : "";
					const checkout = branch ?? repo;
					const checkoutLink = openUri && getCapabilities().hyperlinks
						? hyperlink(theme.fg("accent", checkout), openUri)
						: theme.fg("dim", checkout);
					const checkoutStatus = gitSummary.badges ? `${checkoutLink} ${theme.fg("dim", gitSummary.badges)}` : checkoutLink;
					const identityLine = prStatus ? `${identity}${checkoutStatus} · ${prStatus}` : `${identity}${checkoutStatus}`;
					const firstLine = henryStatuses.length ? align(identityLine, henryStatuses.join(" "), width, ellipsis) : identityLine;
					const lines = [
						firstLine,
						align(usage, model, width, ellipsis),
						alignRightReserved(externalStatuses.join(" "), runtime, width, ellipsis),
					];
					return lines.map((line) => truncateToWidth(line, width, ellipsis));
				},
			};
		});
	});
}

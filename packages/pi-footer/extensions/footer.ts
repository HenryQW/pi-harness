import { basename, dirname } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { configuredOpenUri, loadOpenInConfig } from "@henryqw/pi-open-in/open-uri";

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

function isValidMilliseconds(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
	let openInWarningShown = false;
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
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle() && finalizeActive()) pi.appendEntry(AGENT_TIME_ENTRY, activeMilliseconds);
	});
	pi.on("session_shutdown", () => {
		stopRuntimeTimer();
		activeStartedAt = undefined;
		promptPaused = false;
		openInWarningShown = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		stopRuntimeTimer();
		activeStartedAt = undefined;
		promptPaused = false;
		requestRuntimeRender = undefined;
		// Latest valid entry wins; stored data is untrusted.
		activeMilliseconds = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === AGENT_TIME_ENTRY && isValidMilliseconds(entry.data)) {
				activeMilliseconds = entry.data;
			}
		}
		if (!openInWarningShown) {
			openInWarningShown = true;
			try {
				if (loadOpenInConfig().source === "missing") {
					ctx.ui.notify("Open-in config is missing; defaults are used.", "warning");
				}
			} catch {
				// Invalid owner config must not prevent footer setup; rendering omits its URI.
			}
		}
		if (ctx.mode !== "tui") return;

		const git = await pi.exec(
			"git",
			["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
			{ cwd: ctx.cwd },
		);
		const [root, commonDir] = git.stdout.trim().split(/\r?\n/);
		const rootName = basename(root || ctx.cwd);
		const commonName = commonDir && basename(commonDir) === ".git" ? basename(dirname(commonDir)) : undefined;
		const repo = git.code === 0 ? commonName && commonName !== rootName ? commonName : rootName : basename(ctx.cwd);

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
			const add = (usage: Usage | undefined) => {
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
				} else if (entry.type === "branch_summary" || entry.type === "compaction") {
					add(entry.usage);
				}
			}
		};

		ctx.ui.setFooter((tui, theme, data) => {
			requestRuntimeRender = () => tui.requestRender();
			const unsubscribe = data.onBranchChange(requestRuntimeRender);
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

					const branch = data.getGitBranch()?.replace(/^worktree\//, "");
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
					const identityLine = prStatus ? `${identity}${checkoutLink} · ${prStatus}` : `${identity}${checkoutLink}`;
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

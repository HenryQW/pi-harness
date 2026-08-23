import { basename, dirname } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { configuredOpenUri } from "@henryqw/pi-open-in/open-uri";

const THINKING_COLORS = {
	minimal: 46,
	low: 82,
	medium: 118,
	high: 220,
	xhigh: 208,
	max: 196,
} as const;

function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
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

function color(text: string, ansi256: number): string {
	return `\x1b[38;5;${ansi256}m${text}\x1b[39m`;
}

function rainbow(text: string): string {
	const colors = [196, 220, 46, 39, 201];
	return [...text].map((character, index) => color(character, colors[index % colors.length]!)).join("");
}

export default function footerExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
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
			if (event.message.role === "assistant") assistantStartedAt = Date.now();
		});
		pi.on("message_end", async (event) => {
			if (event.message.role !== "assistant") return;
			const output = event.message.usage?.output ?? 0;
			const seconds = assistantStartedAt === undefined ? 0 : (Date.now() - assistantStartedAt) / 1000;
			assistantStartedAt = undefined;
			tps = output > 0 && seconds > 0 ? output / seconds : undefined;
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
			const unsubscribe = data.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
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
						.map(([, text]) => sanitizeStatus(text))
						.filter(Boolean);
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
					const identity = branch ? theme.fg("dim", `${repo} · `) : "";
					const checkout = branch ?? repo;
					const checkoutLink = openUri ? hyperlink(theme.fg("accent", checkout), openUri) : theme.fg("dim", checkout);
					const firstLine = prStatus ? `${identity}${checkoutLink} · ${prStatus}` : `${identity}${checkoutLink}`;
					const lines = [
						firstLine,
						align(usage, model, width, ellipsis),
					];
					if (statuses.length) lines.push(statuses.join(" "));
					return lines.map((line) => truncateToWidth(line, width, ellipsis));
				},
			};
		});
	});
}

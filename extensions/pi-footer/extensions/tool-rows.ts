import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { registerConfigReporting } from "@henryqw/pi-config-store";
import { formatDuration } from "./format-duration.ts";
import { formatTokens } from "./format-tokens.ts";
import { createToolRowsConfigStore, TOOL_ROW_MODES, type ToolRowMode } from "./tool-rows-config.ts";

const FALLBACK_PREVIEW_LINES = 10;

// Each wrapper keeps the base renderer's component in `inner`, so the base always gets back its own last component.
class Framed extends Container {
	readonly inner: Component;
	constructor(inner: Component, bg: (text: string) => string, pad: number, top: boolean, bottom: () => boolean) {
		super();
		this.inner = inner;
		const blank: Component = { render: (width) => [bg(" ".repeat(width))], invalidate() {} };
		const box = new Box(pad, 0, bg);
		box.addChild(inner);
		if (top) this.addChild(blank);
		this.addChild(box);
		this.addChild({ render: (width) => (bottom() ? blank.render(width) : []), invalidate() {} });
	}
}

class Clip implements Component {
	readonly inner: Component;
	constructor(inner: Component) {
		this.inner = inner;
	}
	render(width: number): string[] {
		// Some calls (edit) start with a blank line, so keep the first line that has visible text.
		const lines = this.inner.render(width).filter((line) => stripTerminalSequences(line).trim());
		if (lines.length === 0) return [];
		// Drop the background padding before the marker, so it sits after the text and not at the right edge.
		const first = lines[0]!.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
		return lines.length > 1 ? [truncateToWidth(`${first} …`, width, "…")] : [lines[0]!];
	}
	invalidate(): void {
		this.inner.invalidate();
	}
}

class Hidden implements Component {
	readonly inner: Component | undefined;
	constructor(inner?: Component) {
		this.inner = inner;
	}
	render(): string[] {
		return [];
	}
	invalidate(): void {
		this.inner?.invalidate();
	}
}

class Summary implements Component {
	readonly text: () => string;
	constructor(text: () => string) {
		this.text = text;
	}
	render(width: number): string[] {
		return [truncateToWidth(this.text(), width, "…")];
	}
	invalidate(): void {}
}

function unwrap(component: Component | undefined): Component | undefined {
	let current = component;
	while (current instanceof Framed || current instanceof Clip || current instanceof Hidden) current = current.inner;
	return current instanceof Summary ? undefined : current;
}

type RowState = "running" | "done" | "failed";
/** The tool calls between two boundaries: a user message or agent text. */
interface Group {
	rows: Map<string, { name: string; state: RowState; startedAt?: number }>;
	redraw?: () => void;
	/** Skills that the agent read in this group, by SKILL.md folder name. */
	skills: Set<string>;
	/** Token usage of the assistant messages that made the calls, counted as the footer counts it. */
	input: number;
	output: number;
}

type Theme = {
	fg(color: "muted" | "error" | "accent" | "dim" | "toolTitle" | "toolOutput", text: string): string;
	bg(color: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg", text: string): string;
	bold(text: string): string;
};
type KeyHint = (keybinding: "app.tools.expand", description: string) => string;

function summaryLine(group: Group, theme: Theme, pad: number, keyHint: KeyHint): string {
	const rows = [...group.rows.values()];
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
	const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
	const failed = rows.filter((row) => row.state === "failed").length;
	const pending = rows.filter((row) => row.state === "running");
	const running = pending.filter((row) => row.startedAt !== undefined).at(-1) ?? pending.at(-1);
	let text = theme.fg("muted", "▸ ");
	if (running) {
		const elapsed = running.startedAt === undefined ? "" : ` ${formatDuration(performance.now() - running.startedAt)}`;
		text += theme.fg("accent", `running ${running.name}${elapsed} · `);
	}
	text += theme.fg("muted", `${rows.length} tool${rows.length === 1 ? "" : "s"}: ${names}`);
	if (group.skills.size > 0) text += theme.fg("muted", ` · skills: ${[...group.skills].join(", ")}`);
	if (group.input + group.output > 0) text += theme.fg("dim", ` · ↑ ${formatTokens(group.input)} ↓ ${formatTokens(group.output)}`);
	if (failed > 0) text += theme.fg("error", ` · ${failed} failed`);
	text += theme.fg("dim", " · ") + keyHint("app.tools.expand", "to expand");
	return " ".repeat(pad) + text;
}

function skillName(toolName: string, args: unknown): string | undefined {
	const path = toolName === "read" ? (args as { path?: unknown } | undefined)?.path : undefined;
	return typeof path === "string" ? /(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/.exec(path)?.[1] : undefined;
}

type Usage = { input: number; output: number };
type AssistantContent = ReadonlyArray<
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown }
	| { type: "thinking" }
>;

function resultText(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** Folds tool rows in the transcript by the configured mode; `/tool-rows` changes and saves the mode. */
export default function toolRowsExtension(pi: ExtensionAPI): void {
	const store = createToolRowsConfigStore();
	registerConfigReporting(pi, [store]);
	// Pi can resolve renderers before session_start while it reloads the transcript.
	const loaded = store.loadSync();
	let mode: ToolRowMode = loaded.status === "ok" ? loaded.value.mode : "off";
	let pendingCalls = mode === "group" ? new Map<string, () => void>() : undefined;

	const newGroup = (): Group => ({ rows: new Map(), skills: new Set(), input: 0, output: 0 });
	const groupOf = new Map<string, Group>();
	const activeCalls = new Map<string, Group>();
	let redrawTimer: ReturnType<typeof setInterval> | undefined;
	let current = newGroup();
	let manager: ExtensionContext["sessionManager"] | undefined;
	let observedLeaf: string | null = null;

	const join = (id: string, name: string, args: unknown): Group => {
		let group = groupOf.get(id);
		if (!group) {
			group = current;
			groupOf.set(id, group);
		}
		if (!group.rows.has(id)) group.rows.set(id, { name, state: "running" });
		const skill = skillName(name, args);
		if (skill) group.skills.add(skill);
		return group;
	};

	// A message's usage counts once, in the group of its first tool call; a reply without tools counts nowhere.
	const recordMessage = (content: AssistantContent, usage: Usage | undefined, restored = false) => {
		let first: Group | undefined;
		for (const part of content) {
			if (part.type === "text" && restored && part.text.trim()) current = newGroup();
			if (part.type !== "toolCall") continue;
			const group = join(part.id, part.name, part.arguments);
			first ??= group;
		}
		if (first && usage) {
			first.input += usage.input;
			first.output += usage.output;
		}
	};

	const stopTimer = () => {
		clearInterval(redrawTimer);
		redrawTimer = undefined;
		activeCalls.clear();
	};

	const setState = (id: string, state: RowState) => {
		const row = groupOf.get(id)?.rows.get(id);
		if (row) row.state = state;
		if (activeCalls.delete(id) && activeCalls.size === 0) stopTimer();
	};

	const grouping = (ctx: ExtensionContext) => ctx.mode === "tui" && mode === "group";
	const rebuild = () => {
		if (!manager) return;
		stopTimer();
		observedLeaf = manager.getLeafId();
		groupOf.clear();
		current = newGroup();
		for (const entry of manager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") current = newGroup();
			if (message.role === "assistant") {
				recordMessage(message.content, message.usage, true);
				for (const part of message.content) {
					if (part.type === "toolCall") {
						setState(part.id, message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "done");
					}
				}
			}
			if (message.role === "toolResult") setState(message.toolCallId, message.isError ? "failed" : "done");
		}
	};

	// Boundary hooks can append compactions without emitting session_compact.
	const observeNewEntries = () => {
		if (!manager) return;
		const leaf = manager.getLeafId();
		for (let id = leaf; id && id !== observedLeaf;) {
			const entry = manager.getEntry(id);
			if (entry?.type === "compaction") {
				rebuild();
				return;
			}
			id = entry?.parentId ?? null;
		}
		observedLeaf = leaf;
	};

	pi.on("session_start", (_event, ctx) => {
		const calls = pendingCalls;
		pendingCalls = undefined;
		if (!grouping(ctx)) return;
		manager = ctx.sessionManager;
		rebuild();
		for (const invalidate of calls?.values() ?? []) invalidate();
		ctx.ui.setHiddenThinkingLabel("");
	});
	pi.on("session_tree", rebuild);
	pi.on("session_compact", rebuild);
	pi.on("session_shutdown", stopTimer);

	// Pi dispatches these events before drawing the corresponding rows.
	pi.on("message_start", (event, ctx) => {
		if (!grouping(ctx)) return;
		observeNewEntries();
		if (event.message.role === "user") current = newGroup();
	});
	pi.on("message_end", (event, ctx) => {
		if (!grouping(ctx) || event.message.role !== "assistant") return;
		const message = event.message;
		recordMessage(message.content, message.usage);
		if (message.stopReason !== "aborted" && message.stopReason !== "error") return;
		for (const part of message.content) {
			if (part.type === "toolCall") setState(part.id, "failed");
		}
	});
	pi.on("message_update", (event, ctx) => {
		if (!grouping(ctx)) return;
		const update = event.assistantMessageEvent;
		if (update.type === "text_end" && update.content.trim()) current = newGroup();
		if (update.type === "toolcall_start" || update.type === "toolcall_end") {
			const part = update.partial.content[update.contentIndex];
			if (part?.type === "toolCall") join(part.id, part.name, part.arguments);
		}
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (!grouping(ctx) || event.parentToolCallId) return;
		const group = join(event.toolCallId, event.toolName, event.args);
		group.rows.get(event.toolCallId)!.startedAt ??= performance.now();
		activeCalls.set(event.toolCallId, group);
		redrawTimer ??= setInterval(() => {
			for (const activeGroup of new Set(activeCalls.values())) activeGroup.redraw?.();
		}, 1_000).unref();
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (grouping(ctx)) setState(event.toolCallId, event.isError ? "failed" : "done");
	});

	pi.registerCommand("tool-rows", {
		description: "Fold tool rows: group (one line between agent replies), line (one line per tool), or off",
		getArgumentCompletions: (prefix) =>
			TOOL_ROW_MODES.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const next = args.trim();
			if (!next) {
				ctx.ui.notify(`Tool rows: ${mode}. Use /tool-rows group|line|off.`, "info");
				return;
			}
			if (!(TOOL_ROW_MODES as readonly string[]).includes(next)) throw new Error("Usage: /tool-rows group|line|off");
			const reload = ctx.mode === "tui" && next !== mode;
			if (reload && !ctx.isIdle()) throw new Error("Wait for Pi to finish before changing the tool-row mode.");
			// update() refuses a file with issues, so a bad file is never overwritten.
			const saved = await store.update(() => ({ mode: next as ToolRowMode }));
			ctx.ui.notify(`Tool rows: ${saved.mode}.`, "info");
			// Pi picks the renderer when it creates a row. Reload to apply the mode to existing rows.
			if (reload) {
				await ctx.reload();
				return;
			}
			mode = saved.mode;
		},
	});

	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (mode === "off") return base;
		observeNewEntries();
		const selfFramed = base?.renderShell === "self";
		const frame = (
			inner: Component,
			theme: Theme,
			context: { isPartial: boolean; isError: boolean; outputPad: number; state: Record<string, unknown> },
			top: boolean,
		) => {
			if (selfFramed) return inner;
			const color = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
			// Pi draws the call before the result in one pass and paints later. The call frame owns the bottom
			// padding until a result frame takes it, so a row without a result keeps Pi's padding.
			const state = context.state;
			state.resultFramed = !top;
			const bottom = top ? () => state.resultFramed !== true : () => true;
			return new Framed(inner, (text) => theme.bg(color, text), context.outputPad, top, bottom);
		};

		return {
			...base,
			// The extension draws Pi's frame itself, so a folded row can take no lines at all.
			renderShell: "self",
			renderCall(args, theme, context) {
				const lastComponent = unwrap(context.lastComponent);
				const baseCall = () =>
					base?.renderCall
						? base.renderCall(args, theme, { ...context, lastComponent })
						: new Text(`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("muted", JSON.stringify(args))}`, 0, 0);

				if (pendingCalls) {
					pendingCalls.set(context.toolCallId, context.invalidate);
					return frame(baseCall(), theme, context, true);
				}
				const group = groupOf.get(context.toolCallId);
				if (group?.rows.keys().next().value === context.toolCallId) {
					group.redraw = context.expanded ? undefined : context.invalidate;
					if (!context.expanded) return new Summary(() => summaryLine(group, theme, context.outputPad, context.keyHint));
				} else if (group && !context.expanded) {
					return new Hidden();
				}
				const clip = mode === "line" && !context.expanded && !context.isPartial && !context.isError;
				return frame(clip ? new Clip(baseCall()) : baseCall(), theme, context, true);
			},
			renderResult(result, options, theme, context) {
				const foldedGroup = !context.expanded && groupOf.has(context.toolCallId);
				const foldedLine = mode === "line" && !context.expanded && !context.isPartial && !context.isError;
				const lastComponent = unwrap(context.lastComponent);
				// Give the base renderer the final result even when folded so it can stop its redraw timer.
				const baseResult = !foldedGroup || !context.isPartial
					? base?.renderResult?.(result, options, theme, { ...context, lastComponent })
					: lastComponent;
				if (foldedGroup) return new Hidden(baseResult);
				if (foldedLine) return frame(new Hidden(baseResult), theme, context, false);
				if (baseResult) return frame(baseResult, theme, context, false);
				const lines = resultText(result).split("\n");
				const shown = options.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
				let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
				if (lines.length > shown.length) {
					text += `${theme.fg("muted", `\n... (${lines.length - shown.length} more lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
				}
				return frame(new Text(text, 0, 0), theme, context, false);
			},
		};
	});
}

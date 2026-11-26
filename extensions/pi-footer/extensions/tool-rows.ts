import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { registerConfigReporting } from "@henryqw/pi-config-store";
import { formatTokens } from "./footer.ts";
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

// Visible text only: drops SGR colors and OSC 8 links.
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

class Clip implements Component {
	readonly inner: Component;
	constructor(inner: Component) {
		this.inner = inner;
	}
	render(width: number): string[] {
		// Some calls (edit) start with a blank line, so keep the first line that has visible text.
		const lines = this.inner.render(width).filter((line) => visibleWidth(line.trimEnd()) > 0 && stripAnsi(line).trim());
		if (lines.length === 0) return [];
		// Drop the background padding before the marker, so it sits after the text and not at the right edge.
		const first = lines[0]!.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
		return lines.length > 1 ? [truncateToWidth(`${first} …`, width, "…")] : [lines[0]!];
	}
	invalidate(): void {
		this.inner.invalidate();
	}
}

class Hidden extends Container {}

class Summary implements Component {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		return [truncateToWidth(this.text, width, "…")];
	}
	invalidate(): void {}
}

function unwrap(component: Component | undefined): Component | undefined {
	let current = component;
	while (current instanceof Framed || current instanceof Clip) current = current.inner;
	return current instanceof Hidden || current instanceof Summary ? undefined : current;
}

type RowState = "running" | "done" | "failed";
/** The tool calls between two boundaries: a user message or agent text. */
interface Group {
	rows: Map<string, { name: string; state: RowState }>;
	/** Skills that the agent read in this group, by SKILL.md folder name. */
	skills: Set<string>;
	/** Token usage of the assistant messages that made the calls, counted as the footer counts it. */
	input: number;
	output: number;
	refresh?: () => void;
	queued: boolean;
}

type Theme = {
	fg(color: "muted" | "error" | "accent" | "dim" | "toolTitle" | "toolOutput", text: string): string;
	bg(color: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg", text: string): string;
	bold(text: string): string;
};
type KeyHint = (keybinding: "app.tools.expand", description: string) => string;

function summaryLine(group: Group, theme: Theme, pad: number, keyHint: KeyHint): Summary {
	const rows = [...group.rows.values()];
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
	const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
	const failed = rows.filter((row) => row.state === "failed").length;
	const running = rows.filter((row) => row.state === "running").at(-1);
	let text = theme.fg("muted", `▸ ${rows.length} tool${rows.length === 1 ? "" : "s"}: ${names}`);
	if (group.skills.size > 0) text += theme.fg("muted", ` · skills: ${[...group.skills].join(", ")}`);
	if (group.input + group.output > 0) text += theme.fg("dim", ` · ↑ ${formatTokens(group.input)} ↓ ${formatTokens(group.output)}`);
	if (failed > 0) text += theme.fg("error", ` · ${failed} failed`);
	if (running) text += theme.fg("accent", ` · running ${running.name}`);
	text += theme.fg("dim", " · ") + keyHint("app.tools.expand", "to expand");
	return new Summary(" ".repeat(pad) + text);
}

function skillName(toolName: string, args: unknown): string | undefined {
	const path = toolName === "read" ? (args as { path?: unknown } | undefined)?.path : undefined;
	return typeof path === "string" ? /(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/.exec(path)?.[1] : undefined;
}

type Usage = { input: number; output: number };
type AssistantContent = ReadonlyArray<{ type: string; id?: string; name?: string; arguments?: unknown }>;

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
	let mode: ToolRowMode = "off";

	const newGroup = (): Group => ({ rows: new Map(), skills: new Set(), input: 0, output: 0, queued: false });
	const groupOf = new Map<string, Group>();
	let current = newGroup();

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
	const count = (content: AssistantContent, usage: Usage | undefined): Group | undefined => {
		let first: Group | undefined;
		for (const part of content) {
			if (part.type === "toolCall" && part.id && part.name) first ??= join(part.id, part.name, part.arguments);
		}
		if (first && usage) {
			first.input += usage.input;
			first.output += usage.output;
		}
		return first;
	};

	// The summary line lives in the group's first row, so a change in a later row redraws the first row.
	const refreshLater = (group: Group) => {
		if (group.queued || !group.refresh) return;
		group.queued = true;
		queueMicrotask(() => {
			group.queued = false;
			group.refresh?.();
		});
	};

	const rebuild = (ctx: ExtensionContext) => {
		groupOf.clear();
		current = newGroup();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") current = newGroup();
			if (message.role !== "assistant") continue;
			if (message.content.some((part) => part.type === "text" && part.text.trim())) current = newGroup();
			count(message.content, message.usage);
			for (const part of message.content) {
				if (part.type === "toolCall") groupOf.get(part.id)!.rows.get(part.id)!.state = "done";
			}
		}
	};

	const apply = (ctx: ExtensionContext) => {
		// An empty label hides the "Thinking..." line of a hidden thinking block, so group mode leaves no trace.
		ctx.ui.setHiddenThinkingLabel(mode === "group" ? "" : undefined);
		// Toggling the expansion state twice makes Pi redraw every tool row.
		const expanded = ctx.ui.getToolsExpanded();
		ctx.ui.setToolsExpanded(!expanded);
		ctx.ui.setToolsExpanded(expanded);
	};

	const restart = async (_event: unknown, ctx: ExtensionContext) => {
		const loaded = store.loadSync();
		mode = loaded.status === "ok" ? loaded.value.mode : "off";
		rebuild(ctx);
		if (ctx.hasUI) apply(ctx);
	};
	pi.on("session_start", restart);
	pi.on("session_tree", restart);

	// Extensions get each event before the interface draws it, so a boundary is in place before the next tool row exists.
	pi.on("message_start", async (event) => {
		if (event.message.role === "user") current = newGroup();
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const group = count(event.message.content, event.message.usage);
		if (group) refreshLater(group);
	});
	pi.on("message_update", async (event) => {
		const update = event.assistantMessageEvent;
		if (update.type === "text_end" && update.content.trim()) current = newGroup();
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
			// update() refuses a file with issues, so a bad file is never overwritten.
			await store.update(() => ({ mode: next as ToolRowMode }));
			mode = next as ToolRowMode;
			apply(ctx);
			ctx.ui.notify(`Tool rows: ${mode}.`, "info");
		},
	});

	pi.registerToolRenderer((toolName, next) => {
		const base = next();
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

				if (mode === "group") {
					const group = join(context.toolCallId, toolName, args);
					const row = group.rows.get(context.toolCallId)!;
					const state: RowState = context.isPartial ? "running" : context.isError ? "failed" : "done";
					const leader = group.rows.keys().next().value === context.toolCallId;
					if (row.state !== state || row.name !== toolName) {
						row.state = state;
						row.name = toolName;
						if (!leader) refreshLater(group);
					}
					if (leader) group.refresh = context.invalidate;
					if (!context.expanded) return leader ? summaryLine(group, theme, context.outputPad, context.keyHint) : new Hidden();
				}
				const clip = mode === "line" && !context.expanded && !context.isPartial && !context.isError;
				return frame(clip ? new Clip(baseCall()) : baseCall(), theme, context, true);
			},
			renderResult(result, options, theme, context) {
				if (mode === "group" && !context.expanded) return new Hidden();
				if (mode === "line" && !context.expanded && !context.isPartial && !context.isError) {
					return frame(new Hidden(), theme, context, false);
				}
				const lastComponent = unwrap(context.lastComponent);
				if (base?.renderResult) {
					return frame(base.renderResult(result, options, theme, { ...context, lastComponent }), theme, context, false);
				}
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

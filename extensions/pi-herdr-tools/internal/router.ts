import { TOOL_MODES } from "./config.ts";

export function completeBtwCommand(prefix: string, sideThread = false) {
	const words = prefix.trimStart().split(/\s+/);
	const partial = words.pop()!;
	const parent = words.join(" ");
	const options: Record<string, readonly (readonly [string, string])[]> = sideThread ? {
		"": [["merge", "Review a prompt and send this side thread to Main"], ["help", "Show command grammar"]],
	} : {
		"": [["ask", "Open a side thread with a question"], ["config", "Show or change side-thread defaults"],
			["merge", "Check pending side-thread deliveries"], ["help", "Show command grammar"]],
		config: [["show", "Show current defaults"], ["reset", "Restore side-thread defaults"],
			["auto-submit", "Choose whether to send the draft automatically"], ["tools", "Choose side-thread tool access"], ["split", "Choose the pane direction"]],
		"config auto-submit": [["on", "Send the draft automatically"], ["off", "Keep the draft in the editor"]],
		"config tools": TOOL_MODES.map((mode) => [mode, {
			inherit: "Use Main's active tools", all: "Use all available tools", "read-only": "Use only read tools", none: "Use no tools",
		}[mode]] as const),
		"config split": [["right", "Open the pane to the right"], ["down", "Open the pane below"]],
	};
	return (Object.hasOwn(options, parent) ? options[parent]! : []).filter(([value]) => value.startsWith(partial))
		.map(([value, description]) => ({ value: prefix.slice(0, prefix.length - partial.length) + value, label: value, description }));
}

type BtwRoute =
	| { kind: "open" }
	| { kind: "ask"; question: string }
	| { kind: "config"; args: string }
	| { kind: "merge"; text: string }
	| { kind: "help" };

export const HELP_TEXT = `/btw usage:
/btw                        open an empty side pane
/btw <question...>          open a side pane with a draft question
/btw ask <question...>      explicit form for questions starting with a reserved word
/btw config [...]           show or change defaults (auto-submit, tools, split, reset)
/btw merge <prompt...>      fold this side thread into the parent and continue with the prompt
/btw help                   show this grammar`;

/**
 * Exact first-word routing. Only the reserved words `ask`, `config`, `merge`,
 * and `help` are subcommands; any other first word keeps the whole input as a
 * question. `/btw ask ...` is the escape hatch for questions that begin with a
 * reserved word.
 */
export function parseBtwCommand(input: string): BtwRoute {
	const trimmed = input.trim();
	if (!trimmed) return { kind: "open" };

	const spaceIndex = trimmed.search(/\s/);
	const first = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();

	switch (first) {
		case "ask":
			return rest ? { kind: "ask", question: rest } : { kind: "open" };
		case "config":
			return { kind: "config", args: rest };
		case "merge":
			return { kind: "merge", text: rest };
		case "help":
			return { kind: "help" };
		default:
			return { kind: "ask", question: trimmed };
	}
}

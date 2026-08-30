import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askQuestionExtension from "../extensions/ask-question.ts";
import { askQuestion } from "../src/index.ts";

type Details = { answer: string | null; selectedIndex?: number };
type RegisteredTool = {
	execute(
		toolCallId: string,
		params: { question: string; options: Array<{ label: string; description?: string }> },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>>;
};

function loadTool(): RegisteredTool {
	let tool: RegisteredTool | undefined;
	askQuestionExtension({
		registerTool(definition) {
			tool = definition as unknown as RegisteredTool;
		},
	} as ExtensionAPI);
	assert.ok(tool);
	return tool;
}

test("returns the selected source option when display labels would otherwise collide", async () => {
	const ctx = {
		mode: "tui",
		ui: {
			select: async (_title: string, choices: string[]) => choices[1],
			input: async () => undefined,
		},
	} as unknown as ExtensionContext;
	const result = await loadTool().execute("call-1", {
		question: "Choose one",
		options: [{ label: "A" }, { label: "A (Recommended)" }],
	}, new AbortController().signal, undefined, ctx);

	assert.equal(result.details?.answer, "A (Recommended)");
	assert.equal(result.details?.selectedIndex, 2);
});

test("reusable helper has the registered tool's validated interactive behavior", async () => {
	const params = {
		question: "Choose one",
		options: [{ label: "First" }, { label: "Second", description: "Alternative" }],
	};
	const context = () => ({
		mode: "tui",
		ui: {
			select: async (_title: string, choices: string[]) => choices[2],
			input: async () => "  custom answer  ",
		},
	}) as unknown as ExtensionContext;
	const signal = new AbortController().signal;

	const direct = await askQuestion(params, context(), signal);
	const result = await loadTool().execute("call-2", params, signal, undefined, context());

	assert.deepEqual(result.details, direct);
	const content = result.content[0];
	assert.ok(content && content.type === "text");
	assert.equal(content.text, "User wrote: custom answer");

	const nonInteractive = await askQuestion(params, { mode: "print", ui: {} } as ExtensionContext, signal);
	assert.equal(nonInteractive.error, "UI not available (running in non-interactive mode)");
});

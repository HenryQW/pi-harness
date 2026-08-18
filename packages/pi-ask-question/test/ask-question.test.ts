import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askQuestionExtension from "../extensions/ask-question.ts";

type Params = {
	question: string;
	options: Array<{ label: string; description?: string }>;
};

type Result = {
	content: Array<{ type: string; text: string }>;
	details: { question: string; options: string[]; answer: string | null; wasCustom?: boolean; selectedIndex?: number; error?: string };
};

type RegisteredTool = {
	name: string;
	executionMode?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute(toolCallId: string, params: Params, signal: AbortSignal, onUpdate: () => void, ctx: unknown): Promise<Result>;
	renderResult(result: Result, options: unknown, theme: unknown, context: unknown): { render(width: number): string[] };
};

function loadTool(): RegisteredTool {
	let registered: RegisteredTool | undefined;
	askQuestionExtension({
		registerTool(tool) {
			registered = tool as unknown as RegisteredTool;
		},
	} as ExtensionAPI);
	assert.ok(registered);
	return registered;
}

function tuiContext(inputs: string[], rendered: string[] = []): unknown {
	const tui = { requestRender() {} };
	const theme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	return {
		mode: "tui",
		ui: {
			custom: (factory: Function) => new Promise((resolve) => {
				let component: { render(width: number): string[]; handleInput(data: string): void; dispose?(): void } | undefined;
				const done = (result: unknown) => {
					component?.dispose?.();
					resolve(result);
				};
				component = factory(tui, theme, {}, done);
				assert.ok(component);
				rendered.push(...component.render(60));
				for (const input of inputs) component.handleInput(input);
			}),
		},
	};
}

async function execute(tool: RegisteredTool, params: Params, ctx: unknown, signal = new AbortController().signal): Promise<Result> {
	return tool.execute("call-1", params, signal, () => {}, ctx);
}

test("ask_question validates context and options", async () => {
	const tool = loadTool();
	const params = { question: "Continue?", options: [{ label: "Yes" }, { label: "No" }, { label: "Later" }] };
	assert.match((await execute(tool, params, { mode: "rpc" })).content[0]!.text, /UI not available/);
	assert.match((await execute(tool, { question: "Continue?", options: [] }, tuiContext([]))).content[0]!.text, /1 to 3 options required/);
	assert.match((await execute(tool, { question: "Continue?", options: [...params.options, { label: "Never" }] }, tuiContext([]))).content[0]!.text, /1 to 3 options required/);
	const invalid = await execute(tool, { question: "   ", options: params.options }, tuiContext([]));
	assert.match(invalid.content[0]!.text, /Question must not be blank/);
	assert.equal(invalid.details.error, "Question must not be blank");
	const renderedError = tool.renderResult(invalid, {}, {
		fg(_color: string, text: string) { return text; },
	}, {}).render(80).join("\n");
	assert.equal(renderedError.trimEnd(), "Error: Question must not be blank");
	assert.match((await execute(tool, { question: "Continue?", options: [{ label: "   " }] }, tuiContext([]))).content[0]!.text, /Option labels must not be blank/);
	assert.match((await execute(tool, { question: "Continue?", options: [{ label: "Yes" }, { label: " yes " }] }, tuiContext([]))).content[0]!.text, /Option labels must be unique/);
	assert.match((await execute(tool, { question: "Continue?", options: [{ label: " something ELSE. " }] }, tuiContext([]))).content[0]!.text, /is reserved/);
});

test("ask_question closes pending UI when tool call aborts", async () => {
	const tool = loadTool();
	const controller = new AbortController();
	let disposed = false;
	const tui = { requestRender() {} };
	const theme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory: Function) => new Promise((resolve) => {
				let component: { dispose?(): void } | undefined;
				component = factory(tui, theme, {}, (result: unknown) => {
					component?.dispose?.();
					resolve(result);
				});
				const dispose = component?.dispose;
				component!.dispose = () => {
					disposed = true;
					dispose?.();
				};
			}),
		},
	};
	const pending = execute(tool, { question: "Continue?", options: [{ label: "Yes" }] }, ctx, controller.signal);
	controller.abort();

	assert.equal((await pending).details.answer, null);
	assert.equal(disposed, true);
});

test("ask_question returns selected and custom answers", async () => {
	const tool = loadTool();
	const params = {
		question: "Choose storage",
		options: [
			{ label: "PostgreSQL", description: "Shared server database" },
			{ label: "SQLite" },
			{ label: "File" },
		],
	};
	const rendered: string[] = [];
	const selected = await execute(tool, params, tuiContext(["2"], rendered));
	assert.equal(selected.content[0]!.text, "User selected: 2. SQLite");
	assert.deepEqual(selected.details, {
		question: "Choose storage",
		options: ["PostgreSQL", "SQLite", "File"],
		answer: "SQLite",
		wasCustom: false,
		selectedIndex: 2,
	});
	assert.ok(rendered.some((line) => line.includes("1. PostgreSQL (Recommended)")));
	assert.ok(rendered.some((line) => line.includes("Shared server database")));
	assert.ok(rendered.some((line) => line.includes("4. Something else.")));

	const customInputs = ["4", ..."Local file", "\r"];
	const custom = await execute(tool, params, tuiContext(customInputs));
	assert.equal(custom.content[0]!.text, "User wrote: Local file");
	assert.equal(custom.details.answer, "Local file");
	assert.equal(custom.details.wasCustom, true);
});

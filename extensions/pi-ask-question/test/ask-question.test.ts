import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askQuestionExtension from "../extensions/ask-question.ts";
import { askQuestion, type AskQuestionRequest, type AskQuestionResult, type AskQuestionsResult } from "../src/index.ts";

type Execute<Params, Details> = (
	toolCallId: string,
	params: Params,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: ExtensionContext,
) => Promise<AgentToolResult<Details>>;
type RegisteredTool = {
	exposure?: string;
	promptGuidelines: string[];
	parameters: { type: string; properties: object; anyOf?: unknown; oneOf?: unknown };
	execute: Execute<AskQuestionRequest, AskQuestionResult> & Execute<{ questions: AskQuestionRequest[] }, AskQuestionsResult>;
};

function loadTool(events: Pick<ExtensionAPI["events"], "emit"> = { emit() {} }): RegisteredTool {
	let tool: RegisteredTool | undefined;
	askQuestionExtension({
		events,
		registerTool(definition) {
			tool = definition as unknown as RegisteredTool;
		},
	} as ExtensionAPI);
	assert.ok(tool);
	return tool;
}

test("stays a direct model tool with tool-specific prompt guidelines", () => {
	const tool = loadTool();
	assert.equal(tool.exposure, "model-only");
	assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes("ask_question")));
});

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

test("publishes input status around interactive prompts, including errors", async () => {
	const active = { channel: "herdr:blocked", payload: { active: true, label: "Input required" } };
	const inactive = { channel: "herdr:blocked", payload: { active: false } };
	const published: Array<{ channel: string; payload: unknown }> = [];
	const publisher = {
		emit(channel: string, payload: unknown) {
			published.push({ channel, payload });
		},
	};
	let releaseSelection!: (selection: string | undefined) => void;
	const selection = new Promise<string | undefined>((resolve) => { releaseSelection = resolve; });
	let firstChoice: string | undefined;
	const pending = loadTool(publisher).execute("call-3", {
		question: "Choose one",
		options: [{ label: "First" }],
	}, new AbortController().signal, undefined, {
		mode: "tui",
		ui: {
			select(_title: string, choices: string[]) {
				firstChoice = choices[0];
				assert.deepEqual(published, [active]);
				return selection;
			},
			input: async () => undefined,
		},
	} as unknown as ExtensionContext);
	assert.deepEqual(published, [active]);
	assert.ok(firstChoice);
	releaseSelection(firstChoice);
	await pending;
	assert.deepEqual(published, [active, inactive]);

	const failed: Array<{ channel: string; payload: unknown }> = [];
	await assert.rejects(
		() => loadTool({
			emit(channel: string, payload: unknown) {
				failed.push({ channel, payload });
			},
		}).execute("call-4", {
			question: "Choose one",
			options: [{ label: "First" }],
		}, new AbortController().signal, undefined, {
			mode: "tui",
			ui: {
				select: async () => {
					assert.deepEqual(failed, [active]);
					throw new Error("prompt failed");
				},
				input: async () => undefined,
			},
		} as unknown as ExtensionContext),
		/prompt failed/,
	);
	assert.deepEqual(failed, [active, inactive]);
});

test("exposes a plain object schema and rejects invalid request variants before prompting", async () => {
	const tool = loadTool();
	const schema = JSON.parse(JSON.stringify(tool.parameters));
	assert.equal(schema.type, "object");
	assert.deepEqual(Object.keys(schema.properties), ["question", "options", "questions"]);
	assert.equal(schema.anyOf, undefined);
	assert.equal(schema.oneOf, undefined);
	const question = { question: "Choose one", options: [{ label: "First" }] };
	let prompts = 0;
	const ctx = { mode: "tui", ui: { select: async () => { prompts++; } } } as unknown as ExtensionContext;
	for (const params of [
		{},
		{ question: "Missing options" },
		{ options: question.options },
		{ ...question, questions: [question] },
		{ questions: [] },
		{ questions: [{ question: "Missing options" }] },
		{ questions: [{ ...question, extra: true }] },
		{ questions: [{ ...question, options: [] }] },
		{ questions: [{ ...question, options: Array.from({ length: 4 }, (_, i) => ({ label: String(i) })) }] },
		{ questions: [{ ...question, options: [{ label: "First", extra: true }] }] },
	]) {
		await assert.rejects(() => tool.execute("invalid", params as AskQuestionRequest, undefined, undefined, ctx), /Invalid ask_question arguments/);
	}
	assert.equal(prompts, 0);
});

test("asks a list in order, associates selected and custom answers, and keeps status active throughout", async () => {
	const events: unknown[] = [];
	const calls: string[] = [];
	const signal = new AbortController().signal;
	const result = await loadTool({ emit: (channel, payload) => { events.push({ channel, payload }); } }).execute("batch", {
		questions: [
			{ question: " Storage? ", options: [{ label: " SQLite " }, { label: "PostgreSQL" }] },
			{ question: "Region?", options: [{ label: "Local", description: "Near the team" }] },
		],
	}, signal, undefined, {
		mode: "tui",
		ui: {
			select: async (title: string, choices: string[], opts: { signal: AbortSignal }) => {
				assert.equal(events.length, 1);
				assert.equal(opts.signal, signal);
				calls.push(title);
				if (title === "Storage?") return choices[1];
				assert.deepEqual(choices, ["1. Local (Recommended) — Near the team", "2. Something else."]);
				return choices[1];
			},
			input: async (title: string, _placeholder: string, opts: { signal: AbortSignal }) => {
				assert.equal(events.length, 1);
				assert.equal(opts.signal, signal);
				calls.push(title);
				return "  Europe  ";
			},
		},
	} as unknown as ExtensionContext);

	assert.deepEqual(calls, ["Storage?", "Region?", "Something else."]);
	assert.deepEqual(result.details, {
		answers: [
			{ questionIndex: 1, question: "Storage?", options: ["SQLite", "PostgreSQL"], answer: "PostgreSQL", wasCustom: false, selectedIndex: 2 },
			{ questionIndex: 2, question: "Region?", options: ["Local"], answer: "Europe", wasCustom: true, selectedIndex: undefined },
		],
		cancelled: false,
	});
	assert.deepEqual(result.content, [{ type: "text", text: "Question 1: Storage?\nUser selected: 2. PostgreSQL\n\nQuestion 2: Region?\nUser wrote: Europe" }]);
	assert.deepEqual(events, [
		{ channel: "herdr:blocked", payload: { active: true, label: "Input required" } },
		{ channel: "herdr:blocked", payload: { active: false } },
	]);
});

test("validates later questions before opening any dialog", async () => {
	let prompts = 0;
	const ctx = { mode: "tui", ui: { select: async () => { prompts++; } } } as unknown as ExtensionContext;
	for (const [question, error] of [
		[{ question: "  ", options: [{ label: "First" }] }, "Question must not be blank"],
		[{ question: "Invalid", options: [{ label: "  " }] }, "Option labels must not be blank"],
		[{ question: "Invalid", options: [{ label: "First" }, { label: " first " }] }, "Option labels must be unique"],
		[{ question: "Invalid", options: [{ label: " something ELSE. " }] }, 'Option label "Something else." is reserved'],
	] as const) {
		const result = await loadTool().execute("invalid-later", {
			questions: [{ question: "Valid", options: [{ label: "First" }] }, { ...question, options: [...question.options] }],
		}, undefined, undefined, ctx);
		assert.deepEqual(result.details, { answers: [], cancelled: false, error: `Question 2: ${error}` });
		assert.equal(result.isError, true);
	}
	assert.equal(prompts, 0);
});

test("stops a list on selection cancellation or empty custom input and retains earlier answers", async () => {
	for (const custom of [false, true]) {
		const titles: string[] = [];
		const result = await loadTool().execute("cancel", {
			questions: ["First?", "Second?", "Third?"].map((question) => ({ question, options: [{ label: "Yes" }] })),
		}, undefined, undefined, {
			mode: "tui",
			ui: {
				select: async (title: string, choices: string[]) => {
					titles.push(title);
					return title === "First?" ? choices[0] : custom ? choices[1] : undefined;
				},
				input: async () => "  ",
			},
		} as unknown as ExtensionContext);
		assert.deepEqual(titles, ["First?", "Second?"]);
		assert.equal(result.isError, false);
		assert.deepEqual(result.details, {
			answers: [
				{ questionIndex: 1, question: "First?", options: ["Yes"], answer: "Yes", wasCustom: false, selectedIndex: 1 },
				{ questionIndex: 2, question: "Second?", options: ["Yes"], answer: null },
			],
			cancelled: true,
		});
	}
});

test("does not open dialogs for an already-aborted signal", async () => {
	const controller = new AbortController();
	controller.abort();
	let prompts = 0;
	const ctx = { mode: "tui", ui: { select: async () => { prompts++; } } } as unknown as ExtensionContext;
	const question = { question: "Choose one", options: [{ label: "First" }] };
	const single = await askQuestion(question, ctx, controller.signal);
	assert.deepEqual(single, { question: "Choose one", options: ["First"], answer: null });
	const batch = await loadTool().execute("aborted", { questions: [question] }, controller.signal, undefined, ctx);
	assert.deepEqual(batch.details, { answers: [], cancelled: true });
	assert.equal(batch.isError, false);
	assert.equal(prompts, 0);
});

test("passes abort to native dialogs and stops the list after abort during selection or custom input", async () => {
	for (const custom of [false, true]) {
		const controller = new AbortController();
		const titles: string[] = [];
		let inputs = 0;
		const events: unknown[] = [];
		const abortDialog = (opts: { signal: AbortSignal }) => new Promise<undefined>((resolve) => {
			assert.equal(opts.signal, controller.signal);
			opts.signal.addEventListener("abort", () => resolve(undefined), { once: true });
			controller.abort();
		});
		const result = await loadTool({ emit: (_channel, payload) => { events.push(payload); } }).execute("abort", {
			questions: ["First?", "Second?", "Third?"].map((question) => ({ question, options: [{ label: "Yes" }] })),
		}, controller.signal, undefined, {
			mode: "tui",
			ui: {
				select: async (title: string, choices: string[], opts: { signal: AbortSignal }) => {
					titles.push(title);
					return title === "First?" ? choices[0] : custom ? choices[1] : abortDialog(opts);
				},
				input: async (_title: string, _placeholder: string, opts: { signal: AbortSignal }) => {
					inputs++;
					return abortDialog(opts);
				},
			},
		} as unknown as ExtensionContext);
		assert.deepEqual(titles, ["First?", "Second?"]);
		assert.equal(inputs, custom ? 1 : 0);
		assert.equal(result.details?.cancelled, true);
		assert.equal(result.isError, false);
		assert.deepEqual(result.details?.answers.map(({ answer }) => answer), ["Yes", null]);
		assert.deepEqual(events, [{ active: true, label: "Input required" }, { active: false }]);
	}
});

test("retains earlier answers and clears status when a later dialog fails", async () => {
	const events: unknown[] = [];
	const result = await loadTool({ emit: (_channel, payload) => { events.push(payload); } }).execute("failure", {
		questions: ["First?", "Second?", "Third?"].map((question) => ({ question, options: [{ label: "Yes" }] })),
	}, undefined, undefined, {
		mode: "tui",
		ui: {
			select: async (title: string, choices: string[]) => {
				if (title === "First?") return choices[0];
				throw new Error("prompt failed");
			},
		},
	} as unknown as ExtensionContext);
	assert.equal(result.details?.cancelled, false);
	assert.equal(result.details?.error, "Question 2: prompt failed");
	assert.equal(result.isError, true);
	assert.deepEqual(result.details?.answers.map(({ questionIndex, answer }) => ({ questionIndex, answer })), [{ questionIndex: 1, answer: "Yes" }]);
	assert.deepEqual(events, [{ active: true, label: "Input required" }, { active: false }]);
});

test("single and batch calls in non-interactive mode do not prompt or emit blocked status", async () => {
	const events: unknown[] = [];
	const tool = loadTool({ emit: (_channel, payload) => { events.push(payload); } });
	const question = { question: "Choose one", options: [{ label: "First" }] };
	const ctx = { mode: "print", ui: {} } as ExtensionContext;
	const single = await tool.execute("non-interactive", question, undefined, undefined, ctx);
	assert.equal(single.details?.error, "UI not available (running in non-interactive mode)");
	const batch = await tool.execute("non-interactive", { questions: [question] }, undefined, undefined, ctx);
	assert.deepEqual(batch.details, { answers: [], cancelled: false, error: "Question 1: UI not available (running in non-interactive mode)" });
	assert.equal(batch.isError, true);
	assert.deepEqual(events, []);
});

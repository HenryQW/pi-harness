import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { extensionConfigDir, extensionConfigPath } from "@henryqw/pi-config-store";
import type {
	EphemeralSubagentExecutor,
	EphemeralSubagentResult,
	EphemeralSubagentRunInput,
} from "@henryqw/pi-subagent";
import promptCreatorExtension, { parseDraftOutput } from "../extensions/prompt-creator.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type PendingRun = {
	input: EphemeralSubagentRunInput;
	prepared: Awaited<ReturnType<EphemeralSubagentRunInput["prepare"]>>;
	resolve(result: EphemeralSubagentResult): void;
	reject(error: unknown): void;
};

const model = {
	provider: "test",
	id: "prompt-draft",
	input: ["text"],
	reasoning: false,
	contextWindow: 100_000,
	maxTokens: 8_192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function success(output: string): EphemeralSubagentResult {
	return { outcome: "success", exitCode: 0, output, stderr: "", stopReason: "stop" };
}

function controlledExecutor(): { executor: EphemeralSubagentExecutor; runs: PendingRun[] } {
	const runs: PendingRun[] = [];
	return {
		runs,
		executor: {
			async run(input) {
				const prepared = await input.prepare();
				return await new Promise<EphemeralSubagentResult>((resolve, reject) => {
					runs.push({ input, prepared, resolve, reject });
				});
			},
		},
	};
}

async function eventually(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.fail("condition was not reached");
}

async function writeTaskModelConfig(agentDir: string): Promise<void> {
	const directory = extensionConfigDir("pi-task-models", agentDir);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "config.json"), JSON.stringify({
		profiles: { fast: { primary: { model: "test/prompt-draft", thinkingLevel: "off" } } },
		tasks: {},
	}));
}

function harness(options: {
	agentDir: string;
	executor: EphemeralSubagentExecutor;
	branch?: any[];
	commands?: SlashCommandInfo[];
	selections?: string[];
	inputs?: Array<string | undefined>;
}) {
	const handlers = new Map<string, Handler>();
	const registeredCommands = new Map<string, Command>();
	const widgets: Array<{ key: string; content: unknown }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const selectCalls: Array<{ title: string; choices: string[] }> = [];
	const inputCalls: Array<{ title: string; placeholder?: string }> = [];
	const branch = options.branch ?? [];
	const selections = [...(options.selections ?? [])];
	const inputs = [...(options.inputs ?? [])];
	let nextEntryId = 1;
	const branchEntries = () => {
		for (const entry of branch) entry.id ??= `entry-${nextEntryId++}`;
		return branch;
	};
	let mode: ExtensionContext["mode"] = "tui";
	let idle = true;
	let reloads = 0;

	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		registerCommand(name: string, command: { handler: Command }) { registeredCommands.set(name, command.handler); },
		getCommands: () => options.commands ?? [],
		sendMessage(message: any, deliveryOptions: any) {
			sentMessages.push({ message, options: deliveryOptions });
			branch.push({
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				display: message.display,
			});
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		get mode() { return mode; },
		hasUI: true,
		cwd: process.cwd(),
		model,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [model] },
		sessionManager: {
			buildContextEntries: branchEntries,
			getBranch: branchEntries,
			getLeafId: () => branchEntries().at(-1)?.id ?? null,
		},
		isIdle: () => idle,
		isProjectTrusted: () => false,
		ui: {
			setWidget(key: string, content: unknown) { widgets.push({ key, content }); },
			notify(message: string, level?: string) { notifications.push({ message, level }); },
			async select(title: string, choices: string[]) {
				selectCalls.push({ title, choices: [...choices] });
				return selections.shift();
			},
			async input(title: string, placeholder?: string) {
				inputCalls.push({ title, placeholder });
				return inputs.shift();
			},
		},
		async reload() { reloads += 1; },
	} as unknown as ExtensionCommandContext;

	promptCreatorExtension(api, { agentDir: options.agentDir, executor: options.executor });
	return {
		api,
		branch,
		ctx,
		handlers,
		registeredCommands,
		widgets,
		notifications,
		sentMessages,
		selectCalls,
		inputCalls,
		setMode(value: ExtensionContext["mode"]) { mode = value; },
		setIdle(value: boolean) { idle = value; },
		get reloads() { return reloads; },
	};
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-prompt-creator-"));
	try {
		await writeTaskModelConfig(agentDir);
		await run(agentDir);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("automatic analysis honors the configured input threshold and discards a stale branch result", async () => {
	await withAgentDir(async (agentDir) => {
		await mkdir(extensionConfigDir("pi-prompt-creator", agentDir), { recursive: true });
		await writeFile(extensionConfigPath("pi-prompt-creator", agentDir), '{"automatic":true,"inputThreshold":4}\n');
		const child = controlledExecutor();
		const app = harness({
			agentDir,
			executor: child.executor,
			commands: [{ name: "existing-prompt", description: "Existing template", source: "prompt" } as SlashCommandInfo],
			branch: [
				{ type: "compaction", summary: "Earlier compacted work" },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "First request" }, { type: "image", data: "secret" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Visible answer" }, { type: "toolCall", name: "read" }], stopReason: "stop" } },
				{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool secret" }] } },
				{ type: "custom_message", customType: "other", content: "custom secret", display: true },
				{ type: "message", message: { role: "user", content: "Latest request" } },
			],
		});
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);

		app.handlers.get("input")!({ source: "extension", text: "injected" }, app.ctx);
		app.handlers.get("input")!({ source: "interactive", text: "   " }, app.ctx);
		app.handlers.get("input")!({ source: "interactive", text: "one" }, app.ctx);
		app.handlers.get("input")!({ source: "rpc", text: "two" }, app.ctx);
		await app.handlers.get("agent_settled")!({ type: "agent_settled" }, app.ctx);
		assert.equal(child.runs.length, 0);
		app.handlers.get("input")!({ source: "interactive", text: "three" }, app.ctx);
		await app.handlers.get("agent_settled")!({ type: "agent_settled" }, app.ctx);
		assert.equal(child.runs.length, 0, "analysis waits for the configured threshold");
		app.handlers.get("input")!({ source: "interactive", text: "four" }, app.ctx);

		app.setMode("rpc");
		await app.handlers.get("agent_settled")!({ type: "agent_settled" }, app.ctx);
		assert.equal(child.runs.length, 0, "automatic analysis is TUI-only");
		app.setMode("tui");
		app.setIdle(false);
		await app.handlers.get("agent_settled")!({ type: "agent_settled" }, app.ctx);
		assert.equal(child.runs.length, 0);
		app.setIdle(true);
		await app.handlers.get("agent_settled")!({ type: "agent_settled" }, app.ctx);
		await eventually(() => child.runs.length === 1);

		const run = child.runs[0]!;
		assert.equal(typeof app.widgets.at(-1)?.content, "function");
		assert.ok(run.prepared.launch.args.includes("--no-session"));
		assert.ok(run.prepared.launch.args.includes("--no-extensions"));
		assert.ok(run.prepared.launch.args.includes("--no-skills"));
		assert.ok(run.prepared.launch.args.includes("--no-context-files"));
		assert.ok(run.prepared.launch.args.includes("--no-prompt-templates"));
		assert.ok(run.prepared.launch.args.includes("--pi-subagent-role-tools"));
		assert.ok(run.prepared.launch.args.includes("--no-approve"));
		const payload = JSON.parse(run.prepared.task);
		assert.deepEqual(payload, {
			currentConversation: [
				{ role: "summary", text: "Earlier compacted work" },
				{ role: "user", text: "First request" },
				{ role: "assistant", text: "Visible answer" },
				{ role: "user", text: "Latest request" },
			],
			existingPrompts: [{ name: "existing-prompt", description: "Existing template" }],
		});
		assert.equal(run.prepared.cwd, tmpdir());
		assert.notEqual(run.prepared.cwd, app.ctx.cwd);

		app.handlers.get("input")!({ source: "interactive", text: "does not cancel" }, app.ctx);
		assert.equal(run.input.signal?.aborted, false);
		await app.handlers.get("session_tree")!({ type: "session_tree" }, app.ctx);
		assert.equal(run.input.signal?.aborted, false, "tree navigation must not abort the child");
		run.resolve(success('{"candidate":{"name":"stale-candidate","markdown":"# Stale"}}'));
		await eventually(() => app.widgets.at(-1)?.content === undefined);
		assert.equal(app.widgets.some(({ content }) => Array.isArray(content) && content[0] === "Prompt ready — /promptor"), false);

		for (const text of ["new one", "new two", "new three"]) {
			app.handlers.get("input")!({ source: "interactive", text }, app.ctx);
		}
		await app.handlers.get("agent_settled")!({ type: "agent_settled" }, app.ctx);
		assert.equal(child.runs.length, 1, "the runtime-wide automatic opportunity stays consumed");
	});
});

test("the child payload reserves its envelope and prioritizes the active summary", async () => {
	await withAgentDir(async (agentDir) => {
		const child = controlledExecutor();
		const activeSummary = "s".repeat(29_850);
		const app = harness({
			agentDir,
			executor: child.executor,
			selections: ["Analyze now"],
			branch: [
				{ type: "message", message: { role: "user", content: "Replaced by the active summary." } },
				{ type: "branch_summary", summary: activeSummary },
				{ type: "message", message: { role: "user", content: "n".repeat(100) } },
			],
			commands: [{ name: "large-prompt", description: "d".repeat(500), source: "prompt" } as SlashCommandInfo],
		});
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		await app.registeredCommands.get("promptor")!("", app.ctx);
		await eventually(() => child.runs.length === 1);
		const run = child.runs[0]!;
		assert.ok(run.prepared.task.length <= 30_000);
		assert.deepEqual(JSON.parse(run.prepared.task), {
			currentConversation: [{ role: "summary", text: activeSummary }],
			existingPrompts: [],
		});
	});
});

test("an oversized newest message does not hide smaller older messages", async () => {
	await withAgentDir(async (agentDir) => {
		const child = controlledExecutor();
		const app = harness({
			agentDir,
			executor: child.executor,
			selections: ["Analyze now"],
			branch: [
				{ type: "message", message: { role: "user", content: "Older usable request" } },
				{ type: "message", message: { role: "assistant", content: "Older usable reply", stopReason: "stop" } },
				{ type: "message", message: { role: "user", content: "x".repeat(30_000) } },
			],
		});
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		await app.registeredCommands.get("promptor")!("", app.ctx);
		await eventually(() => child.runs.length === 1);
		assert.deepEqual(JSON.parse(child.runs[0]!.prepared.task).currentConversation, [
			{ role: "user", text: "Older usable request" },
			{ role: "assistant", text: "Older usable reply" },
		]);
	});
});

test("analysis excludes incomplete assistant replies from the child payload", async () => {
	await withAgentDir(async (agentDir) => {
		const child = controlledExecutor();
		const app = harness({
			agentDir,
			executor: child.executor,
			selections: ["Analyze now"],
			branch: [
				{ type: "message", message: { role: "user", content: "Request before interruption" } },
				{ type: "message", message: { role: "assistant", content: "Interrupted reply", stopReason: "aborted" } },
				{ type: "message", message: { role: "user", content: "Request after interruption" } },
				{ type: "message", message: { role: "assistant", content: "Completed reply", stopReason: "stop" } },
			],
		});
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		await app.registeredCommands.get("promptor")!("", app.ctx);
		await eventually(() => child.runs.length === 1);
		assert.deepEqual(JSON.parse(child.runs[0]!.prepared.task).currentConversation, [
			{ role: "user", text: "Request before interruption" },
			{ role: "user", text: "Request after interruption" },
			{ role: "assistant", text: "Completed reply" },
		]);
	});
});

test("a candidate stays pending until shown, and invalid later output fails visibly", async () => {
	assert.equal(parseDraftOutput('{"candidate":null}'), null);
	assert.throws(
		() => parseDraftOutput('{"candidate":{"name":"valid-name","markdown":"bad\\u0000text"}}'),
		/Draft candidate is invalid/,
	);
	assert.throws(
		() => parseDraftOutput(JSON.stringify({ candidate: { name: "valid-name", markdown: "x".repeat(16 * 1024 + 1) } })),
		/Draft candidate is invalid/,
	);
	assert.throws(() => parseDraftOutput('{"candidate":null,"extra":true}'), /unexpected keys/);

	await withAgentDir(async (agentDir) => {
		const child = controlledExecutor();
		const app = harness({
			agentDir,
			executor: child.executor,
			selections: ["Analyze now", "Show candidate", "Analyze again"],
			branch: [
				{ type: "message", message: { role: "user", content: "Please make these reviews repeatable" } },
				{ type: "message", message: { role: "assistant", content: "I can help.", stopReason: "stop" } },
			],
		});
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		const promptor = app.registeredCommands.get("promptor")!;

		await promptor("", app.ctx);
		await eventually(() => child.runs.length === 1);
		child.runs[0]!.resolve(success(JSON.stringify({
			candidate: { name: "review-template", markdown: "# Review\n\nCheck the complete change." },
		})));
		await eventually(() => Array.isArray(app.widgets.at(-1)?.content));
		assert.deepEqual(app.widgets.at(-1)?.content, ["Prompt ready — /promptor"]);
		assert.equal(app.sentMessages.length, 0, "analysis never injects a candidate automatically");

		await promptor("", app.ctx);
		assert.equal(app.selectCalls[1]!.choices.some((choice) => choice.startsWith("Analyze")), false);
		assert.ok(app.selectCalls[1]!.choices.includes("Dismiss candidate"));
		assert.equal(app.sentMessages.length, 1);
		const shown = app.sentMessages[0]!;
		assert.equal(shown.message.customType, "pi-prompt-creator/candidate");
		assert.equal(shown.message.display, true);
		assert.deepEqual(shown.options, { triggerTurn: false });
		assert.match(shown.message.content, /Untrusted prompt candidate/i);
		assert.match(shown.message.content, /Suggested name: `review-template`/);
		assert.match(shown.message.content, /> # Review\n> \n> Check the complete change\./);
		assert.match(shown.message.content, /Main must emit only the complete Final Prompt Draft/);

		await promptor("", app.ctx);
		assert.ok(app.selectCalls[2]!.choices.includes("Analyze again"));
		await eventually(() => child.runs.length === 2);
		child.runs[1]!.resolve(success('{"candidate":{"name":"Bad Name","markdown":"draft"}}'));
		await eventually(() => {
			const content = app.widgets.at(-1)?.content;
			return Array.isArray(content) && content[0] === "Prompt analysis failed — /promptor";
		});

		app.handlers.get("input")!({ source: "extension", text: "internal" }, app.ctx);
		assert.deepEqual(app.widgets.at(-1)?.content, ["Prompt analysis failed — /promptor"]);
		app.handlers.get("input")!({ source: "interactive", text: "next request" }, app.ctx);
		assert.equal(app.widgets.at(-1)?.content, undefined);
	});
});

test("saving requires a shown candidate and later Main review, retries failures, and consumes the review", async () => {
	await withAgentDir(async (agentDir) => {
		const child = controlledExecutor();
		const app = harness({
			agentDir,
			executor: child.executor,
			commands: [{ name: "taken-command", source: "extension" } as SlashCommandInfo],
			selections: [
				"Analyze now", "Show candidate", "",
				...Array<string>(5).fill("Save latest Main draft"),
				"",
			],
			inputs: ["Bad Name", "taken-command", "existing-prompt", "write-failure", "saved-prompt"],
			branch: [
				{ type: "message", message: { role: "user", content: "Draft a reusable review prompt" } },
				{ type: "message", message: { role: "assistant", content: "Initial answer", stopReason: "stop" } },
			],
		});
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		const promptor = app.registeredCommands.get("promptor")!;

		await promptor("", app.ctx);
		assert.equal(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"), false, "ordinary replies cannot enable save");
		await eventually(() => child.runs.length === 1);
		child.runs[0]!.resolve(success(JSON.stringify({
			candidate: { name: "review-template", markdown: "Candidate text must not be saved." },
		})));
		await eventually(() => Array.isArray(app.widgets.at(-1)?.content));
		await promptor("", app.ctx);
		assert.equal(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"), false, "a pending candidate cannot enable save");

		await promptor("", app.ctx);
		assert.equal(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"), false, "showing a candidate alone cannot enable save");

		const finalDraft = "# Final prompt\n\nReview the whole change.\n";
		app.branch.push({ type: "message", message: { role: "assistant", content: finalDraft, stopReason: "stop" } });
		const promptsDir = join(agentDir, "prompts");
		await mkdir(promptsDir, { recursive: true });
		await writeFile(join(promptsDir, "existing-prompt.md"), "keep me");

		await promptor("", app.ctx);
		assert.ok(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"));
		assert.match(app.notifications.at(-1)!.message, /Use lowercase kebab-case/);
		await promptor("", app.ctx);
		assert.match(app.notifications.at(-1)!.message, /command named \/taken-command already exists/);
		await promptor("", app.ctx);
		assert.equal(await readFile(join(promptsDir, "existing-prompt.md"), "utf8"), "keep me");
		assert.match(app.notifications.at(-1)!.message, /Prompt \/existing-prompt already exists/);

		await chmod(promptsDir, 0o500);
		try {
			await promptor("", app.ctx);
			assert.match(app.notifications.at(-1)!.message, /Could not save \/write-failure/);
		} finally {
			await chmod(promptsDir, 0o700);
		}
		await promptor("", app.ctx);

		assert.equal(await readFile(join(promptsDir, "saved-prompt.md"), "utf8"), finalDraft);
		assert.equal(app.reloads, 1);
		assert.deepEqual(app.inputCalls.map(({ placeholder }) => placeholder), Array<string>(5).fill("review-template"));

		app.branch.push({ type: "message", message: { role: "assistant", content: "Ordinary later reply", stopReason: "stop" } });
		await promptor("", app.ctx);
		assert.equal(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"), false, "a successful save consumes the review");
	});
});

test("an incomplete latest Main reply cannot fall back to an older reviewed draft", async () => {
	await withAgentDir(async (agentDir) => {
		const child = controlledExecutor();
		const app = harness({
			agentDir,
			executor: child.executor,
			selections: ["Analyze now", "Show candidate", "Save latest Main draft"],
			inputs: ["must-not-save"],
			branch: [
				{ type: "message", message: { role: "user", content: "Create a reusable prompt" } },
				{ type: "message", message: { role: "assistant", content: "Ordinary answer", stopReason: "stop" } },
			],
		});
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		const promptor = app.registeredCommands.get("promptor")!;
		await promptor("", app.ctx);
		await eventually(() => child.runs.length === 1);
		child.runs[0]!.resolve(success('{"candidate":{"name":"review-draft","markdown":"# Candidate"}}'));
		await eventually(() => Array.isArray(app.widgets.at(-1)?.content));
		await promptor("", app.ctx);

		app.branch.push(
			{ type: "message", message: { role: "assistant", content: "# Older complete draft", stopReason: "stop" } },
			{ type: "message", message: { role: "user", content: "Revise that draft" } },
			{ type: "message", message: { role: "assistant", content: "# Interrupted revision", stopReason: "aborted" } },
		);
		await promptor("", app.ctx);

		assert.equal(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"), false);
		assert.equal(app.inputCalls.length, 0);
		await assert.rejects(readFile(join(agentDir, "prompts", "must-not-save.md")), /ENOENT/);
	});
});

test("active summaries bound reviewed drafts to post-summary replies", async () => {
	for (const boundary of ["compaction", "branch_summary"] as const) {
		await withAgentDir(async (agentDir) => {
			const child = controlledExecutor();
			const draftName = `${boundary.replace("_", "-")}-draft`;
			const postSummaryDraft = `# ${boundary} draft`;
			const finalDraft = `${postSummaryDraft}\n\nFinal review.`;
			const app = harness({
				agentDir,
				executor: child.executor,
				selections: ["Analyze now", "Show candidate", "", "", "", "", "Save latest Main draft"],
				inputs: [draftName],
				branch: [
					{ type: "message", message: { role: "user", content: "Write a draft" } },
					{ type: "message", message: { role: "assistant", content: "# Replaced draft", stopReason: "stop" } },
				],
			});
			await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
			const promptor = app.registeredCommands.get("promptor")!;
			await promptor("", app.ctx);
			await eventually(() => child.runs.length === 1);
			child.runs[0]!.resolve(success('{"candidate":{"name":"summary-draft","markdown":"# Candidate"}}'));
			await eventually(() => Array.isArray(app.widgets.at(-1)?.content));
			await promptor("", app.ctx);

			app.branch.push({ type: boundary, summary: "Active summary" });
			await promptor("", app.ctx);
			assert.equal(
				app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"),
				false,
				`${boundary} hides drafts from replaced history`,
			);

			app.branch.push(
				{ type: "message", message: { role: "user", content: "Write a new draft" } },
				{ type: "message", message: { role: "assistant", content: postSummaryDraft, stopReason: "stop" } },
			);
			await promptor("", app.ctx);
			assert.ok(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"));

			app.branch.push({ type: "message", message: { role: "assistant", content: "", stopReason: "stop" } });
			await promptor("", app.ctx);
			assert.equal(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"), false, "invalid drafts do not fall back");

			app.branch.push({ type: "message", message: { role: "assistant", content: "# Interrupted draft", stopReason: "aborted" } });
			await promptor("", app.ctx);
			assert.equal(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"), false, "incomplete drafts do not fall back");

			app.branch.push({ type: "message", message: { role: "assistant", content: finalDraft, stopReason: "stop" } });
			await promptor("", app.ctx);
			assert.equal(await readFile(join(agentDir, "prompts", `${draftName}.md`), "utf8"), finalDraft);
		});
	}
});

test("review eligibility resets on tree, session, and shutdown lifecycle changes", async () => {
	await withAgentDir(async (agentDir) => {
		const child = controlledExecutor();
		const app = harness({
			agentDir,
			executor: child.executor,
			selections: [
				"Analyze now", "Show candidate", "", "",
				"Analyze now", "Show candidate", "", "",
				"Analyze now", "Show candidate", "", "",
			],
			branch: [
				{ type: "message", message: { role: "user", content: "Create reusable review prompts" } },
				{ type: "message", message: { role: "assistant", content: "Initial answer", stopReason: "stop" } },
			],
		});
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		const promptor = app.registeredCommands.get("promptor")!;
		let runIndex = 0;
		const makeReviewEligible = async () => {
			await promptor("", app.ctx);
			await eventually(() => child.runs.length === runIndex + 1);
			child.runs[runIndex]!.resolve(success(JSON.stringify({
				candidate: { name: `reset-${runIndex}`, markdown: "# Candidate" },
			})));
			await eventually(() => Array.isArray(app.widgets.at(-1)?.content));
			await promptor("", app.ctx);
			app.branch.push({ type: "message", message: { role: "assistant", content: `# Review ${runIndex}`, stopReason: "stop" } });
			await promptor("", app.ctx);
			assert.ok(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"));
			runIndex += 1;
		};
		const assertReset = async () => {
			await promptor("", app.ctx);
			assert.equal(app.selectCalls.at(-1)!.choices.includes("Save latest Main draft"), false);
		};

		await makeReviewEligible();
		await app.handlers.get("session_tree")!({ type: "session_tree" }, app.ctx);
		await assertReset();

		await makeReviewEligible();
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		await assertReset();

		await makeReviewEligible();
		await app.handlers.get("session_shutdown")!({ type: "session_shutdown" }, app.ctx);
		await assertReset();
	});
});

test("malformed config is preserved and warns once until an explicit toggle replaces it", async () => {
	await withAgentDir(async (agentDir) => {
		const configPath = extensionConfigPath("pi-prompt-creator", agentDir);
		await mkdir(join(configPath, ".."), { recursive: true });
		const malformed = '{"automatic":true,"inputThreshold":0}\n';
		await writeFile(configPath, malformed);
		const child = controlledExecutor();
		const app = harness({ agentDir, executor: child.executor, selections: ["Automatic On"] });

		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		await app.handlers.get("session_start")!({ type: "session_start" }, app.ctx);
		assert.equal(app.notifications.filter(({ message }) => message.includes("config is invalid")).length, 1);
		assert.equal(await readFile(configPath, "utf8"), malformed);
		for (const text of ["one", "two", "three"]) app.handlers.get("input")!({ source: "interactive", text }, app.ctx);
		await app.handlers.get("agent_settled")!({ type: "agent_settled" }, app.ctx);
		assert.equal(child.runs.length, 0, "invalid config disables automatic analysis");

		await app.registeredCommands.get("promptor")!("", app.ctx);
		assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { automatic: true, inputThreshold: 3 });
		assert.equal(app.notifications.at(-1)?.message, "Automatic analysis enabled.");
	});
});

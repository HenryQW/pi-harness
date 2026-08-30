import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	capEphemeralSubagentOutput as capOutput,
	EphemeralSubagentError,
	ROLE_TOOL_POLICY_FLAG,
} from "@henryqw/pi-subagent";
import { MODEL_CLASS_GUIDANCE } from "../extensions/model-class-policy.ts";
import { WorkflowAbortedError, WorkflowFailureError } from "../extensions/result-transport.ts";
import subagentExtension, { MAX_WIDGET_ACTIVE_TOOLS } from "../extensions/subagent.ts";
import { parseWorkflow, WorkflowSchema } from "../extensions/workflow.ts";
import { loadRoles } from "../src/index.ts";

type Tool = {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
	prepareArguments?: (args: unknown) => any;
	renderShell?: "default" | "self";
	renderCall?: (...args: any[]) => { render: (width: number) => string[] };
	renderResult?: (...args: any[]) => { render: (width: number) => string[] };
	execute: (...args: any[]) => Promise<any>;
};

function singleEvidence(text: string, _details: any, kind: "assistant" | "failure"): string {
	const match = /^- \[0\] .+? (assistant|failure):\n/m.exec(text);
	assert.ok(match);
	assert.equal(match[1], kind);
	const contentStart = match.index + match[0].length;
	const continued = text.indexOf("\nContinued evidence:\n", contentStart);
	if (continued === -1) return text.slice(contentStart);
	const remainder = text.indexOf(match[0], continued);
	assert.notEqual(remainder, -1);
	return text.slice(contentStart, continued) + text.slice(remainder + match[0].length);
}

function singleOutput(result: any): string {
	return singleEvidence(result.content[0].text, result.details, "assistant");
}

function assertTruncated(actual: string, original: string): void {
	assert.ok(Buffer.byteLength(actual, "utf8") <= 50 * 1024);
	const marker = /\n\n\[Output truncated: (\d+) bytes omitted\]$/.exec(actual);
	assert.ok(marker);
	const prefix = actual.slice(0, -marker[0].length);
	assert.equal(Number(marker[1]), Buffer.byteLength(original, "utf8") - Buffer.byteLength(prefix, "utf8"));
}

async function environment(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousActivePi = process.env.PI_CODING_AGENT;
	const previousScript = process.argv[1];
	const previousTitle = process.title;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT = "true";
	process.title = "pi";
	try {
		await mkdir(join(agentDir, "config", "pi-task-models"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: {
				fast: { primary: { model: "test/text-model", thinkingLevel: "low" } },
				balanced: { primary: { model: "test/text-model", thinkingLevel: "low" } },
			},
		}));
		await run(agentDir);
	} finally {
		process.argv[1] = previousScript;
		process.title = previousTitle;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousActivePi === undefined) delete process.env.PI_CODING_AGENT;
		else process.env.PI_CODING_AGENT = previousActivePi;
		await rm(agentDir, { recursive: true, force: true });
	}
}

const model = {
	provider: "test",
	id: "text-model",
	name: "Text Model",
	api: "openai-responses",
	baseUrl: "https://example.test",
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 10_000,
	reasoning: true,
	thinkingLevelMap: { off: "none", low: "low", high: "high" },
} as const;

function harness(options: {
	ui?: boolean;
	skills?: Array<{ name: string; path: string }>;
	trusted?: boolean;
	availableModels?: any[];
	currentModel?: any;
	scopedModels?: any[];
	timeoutPolicy?: { idleMs: number; maxMs: number };
	cwd?: string;
	sendMessageError?: Error;
} = {}) {
	let tool: Tool | undefined;
	let widget: { render: (width: number) => string[] } | undefined;
	let renders = 0;
	const notifications: Array<{ message: string; type: string }> = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const tui = { requestRender: () => { renders++; } };
	const theme = { fg: (_color: string, value: string) => value };
	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		registerTool(candidate: Tool) { tool = candidate; },
		sendMessage(message: any, deliveryOptions: any) {
			if (options.sendMessageError) throw options.sendMessageError;
			sentMessages.push({ message, options: deliveryOptions });
		},
		registerCommand(name: string, candidate: { handler: (...args: any[]) => any }) { commands.set(name, candidate); },
		getCommands() {
			return (options.skills ?? []).map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.name,
				source: "skill" as const,
				sourceInfo: { path: skill.path, source: "test", scope: "user" as const, origin: "top-level" as const },
			}));
		},
	} as unknown as ExtensionAPI;
	subagentExtension(api, options.timeoutPolicy);
	const ctx = {
		cwd: options.cwd ?? "/tmp",
		model: options.currentModel ?? model,
		thinkingLevel: "low",
		hasUI: options.ui ?? false,
		isProjectTrusted: () => options.trusted ?? true,
		modelRegistry: { getAvailable: () => options.availableModels ?? [model] },
		scopedModels: options.scopedModels ?? [],
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			setWidget: (_key: string, content: any) => {
				widget = typeof content === "function" ? content(tui, theme) : undefined;
			},
		},
	} as unknown as ExtensionContext;
	return {
		get tool() { return tool!; },
		get widget() { return widget; },
		get renders() { return renders; },
		notifications,
		sentMessages,
		ctx,
		handlers,
		commands,
	};
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test state.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function workingWidgetHeaders(lines: string[]): string[] {
	return lines.filter((line) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(line));
}

async function writeWorkerRole(agentDir: string, isolation = false): Promise<void> {
	await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
${isolation ? "isolation: worktree\n" : ""}---
Do bounded work.
`);
}

const childName = (id: string): string => `subagent-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;

async function initializedRepository(t: import("node:test").TestContext): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), "pi-subagent-repo-"));
	t.after(async () => { await rm(repo, { recursive: true, force: true }); });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	await mkdir(join(repo, "extensions", "worker"), { recursive: true });
	await Promise.all([
		writeFile(join(repo, "README.md"), "test\n"),
		writeFile(join(repo, "extensions", "worker", "package.json"), "{}\n"),
	]);
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: repo });
	return repo;
}

async function blockedPiRunner(agentDir: string, activeTasks: string[] = []) {
	const started = join(agentDir, "children-started");
	const release = join(agentDir, "children-release");
	await Promise.all([mkdir(started), mkdir(release)]);
	const runner = join(agentDir, "fake-pi.mjs");
	await writeFile(runner, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const task = process.argv.at(-1)?.replace(/^Task: /, "");
if (!task) throw new Error("Missing delegated task.");
const event = (value) => console.log(JSON.stringify(value));
writeFileSync(join(${JSON.stringify(started)}, task), "");
const release = join(${JSON.stringify(release)}, task);
const active = ${JSON.stringify(activeTasks)}.includes(task);
if (active) event({ type: "message_start", message: { role: "assistant", content: [] } });
const activity = active ? setInterval(() => event({ type: "message_update", usage: { totalTokens: 1 } }), 25) : undefined;
const timer = setInterval(() => {
	if (!existsSync(release)) return;
	clearInterval(timer);
	if (activity) clearInterval(activity);
	event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } });
}, 10);
`);
	process.argv[1] = runner;
	return {
		started: () => readdirSync(started).sort(),
		release: (task: string) => writeFile(join(release, task), ""),
	};
}

test("delegate_task description exposes built-in roles with an empty user config", async () => {
	await environment(async () => {
		const app = harness();
		assert.match(app.tool.description, /implementer: Implements and validates one bounded change/);
		assert.match(app.tool.description, /reviewer: Reviews one bounded change for correctness without changing files/);
		assert.match(app.tool.description, /scout: Maps relevant code and evidence for one bounded task without changing files/);
	});
});

test("role config rejects repository-relative extension sources", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "unsafe.md"), `---
name: unsafe
description: Loads repository code
extensions: [./extensions/review.ts]
tools: []
skills: []
---
Review code.
`);
		assert.throws(() => loadRoles(agentDir), /extension.*absolute|extension.*source/i);
	});
});

test("role profile resolves skill names and selects exact extensions, tools, model, thinking, and trust", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "reviewer.md"), `---
name: reviewer
description: Reviews focused changes
tools: [read, grep]
extensions:
  - /user/extensions/review.ts
skills:
  - security
  - unavailable-skill
---
Review only requested change.
`);
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: { frontier: { primary: { model: "test/text-model", thinkingLevel: "high" } } },
		}));
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);
const prompt = args[args.indexOf("--append-system-prompt") + 1];
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ args, prompt, cwd: process.cwd() }) }], stopReason: "end" } }));
`);
		process.argv[1] = runner;

		assert.deepEqual(loadRoles(agentDir).map(({ name }) => name), ["implementer", "reviewer", "scout"]);
		const app = harness({
			skills: [{ name: "security", path: "/effective/skills/security/SKILL.md" }],
			trusted: false,
		});
		assert.match(app.tool.description, /reviewer: Reviews focused changes/);
		const updates: any[] = [];
		const result = await app.tool.execute(
			"call-1",
			{ role: "reviewer", name: "Test delegated task", task: "inspect auth", modelClass: "frontier" },
			undefined,
			(update: any) => updates.push(update),
			app.ctx,
		);
		const child = JSON.parse(singleOutput(result));
		assert.equal(child.cwd, await realpath("/tmp"));
		assert.equal(child.prompt, "You are a delegated Pi Subagent, not Main. Execute the assigned Role and task directly. Main-only delegation rules do not apply. Recursive delegation is unavailable; do not seek or invoke delegation tools.\n\nReview only requested change.");
		const extensionArgs = child.args.filter((value: string, index: number) => child.args[index - 1] === "--extension");
		const policyExtension = extensionArgs.at(-1)!;
		assert.match(policyExtension, /pi-subagent\/extensions\/role-tools\.ts$/);
		assert.deepEqual(child.args, [
			"--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills",
			"--exclude-tools", "delegate_task,delegate_flow,delegate_flow_continue,ask_question",
			"--extension", "/user/extensions/review.ts",
			"--extension", policyExtension,
			"--skill", "/effective/skills/security/SKILL.md",
			`--${ROLE_TOOL_POLICY_FLAG}`, JSON.stringify(["read", "grep"]),
			"--model", "test/text-model",
			"--thinking", "high",
			"--no-approve",
			"--append-system-prompt", "You are a delegated Pi Subagent, not Main. Execute the assigned Role and task directly. Main-only delegation rules do not apply. Recursive delegation is unavailable; do not seek or invoke delegation tools.\n\nReview only requested change.",
			"Task: inspect auth",
		]);
		assert.ok(updates.length >= 2);
		assert.ok(updates.every((update) => update.content[0].text.startsWith("Workflow update.\nMode: single")));
		assert.deepEqual(app.notifications, [{
			message: "Subagent role reviewer skipped unavailable Pi skills: unavailable-skill.",
			type: "warning",
		}]);
	});
});

test("worktree isolation preserves the delegated repository subdirectory", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd() }) }], stopReason: "end" } }));`);
		process.argv[1] = runner;

		const app = harness({ cwd: join(repo, "extensions", "worker") });
		const result = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx);
		const name = childName("call-1:single:0");
		const worktreeRoot = join(await realpath(repo), ".worktrees", name);
		assert.equal(JSON.parse(singleOutput(result)).cwd, join(worktreeRoot, "extensions", "worker"));
		assert.deepEqual(result.details.entries[0].worktree, {
			path: worktreeRoot,
			branch: `pi-subagent/${name}`,
			commits: 0,
			dirty: false,
			pruned: true,
		});
	});
});

test("failed worktree inspection rejects a successful child and preserves recovery", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { execFileSync } from "node:child_process";
execFileSync("git", ["checkout", "--detach"], { stdio: "ignore" });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "child succeeded" }], stopReason: "end" } }));
`);
		process.argv[1] = runner;

		const app = harness({ cwd: repo, ui: true });
		const error = await app.tool.execute("inspection", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx).then(
			() => assert.fail("expected finalization rejection"),
			(reason) => reason,
		);
		assert.ok(error instanceof WorkflowFailureError);
		const entry = error.details.entries[0];
		const worktree = entry.worktree;
		assert.equal(entry.status, "rejected");
		assert.ok(worktree);
		assert.equal(worktree.inspection_failed, true);
		assert.equal(worktree.pruned, false);
		assert.match(worktree.note!, /HEAD is detached/);
		assert.match(error.message, /HEAD is detached/);
		assert.ok(app.widget!.render(80)[0].startsWith("✗"));
		assert.ok(error.message.indexOf(worktree.path) < error.message.indexOf("Evidence:"));
		assert.equal(existsSync(worktree.path), true);
		assert.ok(Buffer.byteLength(error.message, "utf8") <= 50 * 1024);
	});
});

test("empty Role tools install a tool policy", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Uses only extension tools
extensions:
  - /user/extensions/company-tools.ts
tools: []
skills: []
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));
`);
		process.argv[1] = runner;
		const app = harness();
		const result = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx);
		const args = JSON.parse(singleOutput(result));
		assert.equal(args.includes("--tools"), false);
		assert.equal(args.includes("--no-tools"), false);
		assert.equal(args[args.indexOf(`--${ROLE_TOOL_POLICY_FLAG}`) + 1], "[]");
		assert.equal(args[args.indexOf("--extension") + 1], "/user/extensions/company-tools.ts");
		assert.equal(args.filter((value: string, index: number) => args[index - 1] === "--extension").some((path: string) => path.endsWith("/pi-subagent/extensions/role-tools.ts")), true);
	});
});

test("empty role tools leave only loaded extension tools", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "thinker.md"), `---
name: thinker
description: Reasons without tools
tools: []
extensions: []
skills: []
---
Return a plan.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));
`);
		process.argv[1] = runner;
		const app = harness();
		const result = await app.tool.execute("call-1", { role: "thinker", name: "Test delegated task", task: "plan" }, undefined, undefined, app.ctx);
		const args = JSON.parse(singleOutput(result));
		assert.equal(args.includes("--tools"), false);
		assert.equal(args.includes("--no-tools"), false);
		assert.equal(args[args.indexOf(`--${ROLE_TOOL_POLICY_FLAG}`) + 1], "[]");
		assert.equal(args[args.indexOf("--exclude-tools") + 1], "delegate_task,delegate_flow,delegate_flow_continue,ask_question");
	});
});

test("routes supply thinking for omitted, class, direct-model, and background delegation", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		const legacyConfig = JSON.stringify({ models: { frontier: { model: "legacy/model", thinkingLevel: "high" } } });
		await writeFile(join(agentDir, "config", "pi-subagent", "config.json"), legacyConfig);
		const availableModels = [
			{ provider: "provider", id: "fast-model", input: ["text"], reasoning: false },
			{ provider: "provider", id: "balanced-model", input: ["text"], reasoning: true, thinkingLevelMap: { medium: "medium" } },
			{ provider: "provider", id: "frontier-model", input: ["text"], reasoning: true, thinkingLevelMap: { max: "max" } },
			{ provider: "provider", id: "fav-model", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" } },
			{ provider: "provider", id: "direct-model", input: ["text"], reasoning: true, thinkingLevelMap: { medium: "medium", max: "max" } },
		];
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: {
				fast: { primary: { model: "provider/fast-model", thinkingLevel: "off" } },
				balanced: { primary: { model: "provider/balanced-model", thinkingLevel: "medium" } },
				frontier: { primary: { model: "provider/frontier-model", thinkingLevel: "max" } },
				fav: { primary: { model: "provider/fav-model", thinkingLevel: "high" } },
			},
			tasks: {},
		}));
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels });
		assert.equal(app.commands.has("subagent"), false);

		const explicit = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "inspect code", modelClass: "frontier" }, undefined, undefined, app.ctx);
		const explicitArgs = JSON.parse(singleOutput(explicit));
		assert.equal(explicitArgs[explicitArgs.indexOf("--model") + 1], "provider/frontier-model");
		assert.equal(explicitArgs[explicitArgs.indexOf("--thinking") + 1], "max");

		const favorite = await app.tool.execute("call-fav", { role: "worker", name: "Test delegated task", task: "inspect code", modelClass: "fav" }, undefined, undefined, app.ctx);
		const favoriteArgs = JSON.parse(singleOutput(favorite));
		assert.equal(favoriteArgs[favoriteArgs.indexOf("--model") + 1], "provider/fav-model");
		assert.equal(favoriteArgs[favoriteArgs.indexOf("--thinking") + 1], "high");

		const omitted = await app.tool.execute("call-2", { role: "worker", name: "Test delegated task", task: "inspect code" }, undefined, undefined, app.ctx);
		const omittedArgs = JSON.parse(singleOutput(omitted));
		assert.equal(omittedArgs[omittedArgs.indexOf("--model") + 1], "provider/fast-model");
		assert.equal(omittedArgs[omittedArgs.indexOf("--thinking") + 1], "off");

		const direct = await app.tool.execute("call-3", { role: "worker", name: "Test delegated task", task: "inspect code", model: "provider/direct-model", modelClass: "frontier" }, undefined, undefined, app.ctx);
		const directArgs = JSON.parse(singleOutput(direct));
		assert.equal(directArgs[directArgs.indexOf("--model") + 1], "provider/direct-model");
		assert.equal(directArgs[directArgs.indexOf("--thinking") + 1], "max");

		const background = await app.tool.execute("call-4", { role: "worker", name: "Test delegated task", task: "inspect code", modelClass: "fav", background: true }, undefined, undefined, app.ctx);
		assert.match(background.content[0]!.text, /accepted/);
		await waitFor(() => app.sentMessages.length === 1);
		const backgroundArgs = JSON.parse(singleEvidence(app.sentMessages[0]!.message.content, app.sentMessages[0]!.message.details, "assistant"));
		assert.equal(backgroundArgs[backgroundArgs.indexOf("--model") + 1], "provider/fav-model");
		assert.equal(backgroundArgs[backgroundArgs.indexOf("--thinking") + 1], "high");
		assert.equal(await readFile(join(agentDir, "config", "pi-subagent", "config.json"), "utf8"), legacyConfig);
	});
});

test("unknown designated model lists available models", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: { fast: { primary: { model: "provider/alpha", thinkingLevel: "medium" } } },
		}));
		const availableModels = [
			{ provider: "provider", id: "alpha", input: ["text"], reasoning: true, thinkingLevelMap: { medium: "medium" } },
			{ provider: "provider", id: "beta", input: ["text"], reasoning: false },
		];
		const app = harness({ availableModels });

		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "inspect code", model: "provider/gamma" }, undefined, undefined, app.ctx),
			/Available models: provider\/alpha, provider\/beta/,
		);
	});
});

test("canonical Codex route follows active account alias in isolated child", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: { frontier: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "high" } } },
		}));
		const canonical = { ...model, provider: "openai-codex", id: "gpt-test" };
		const alias = { ...canonical, provider: "openai-codex-2" };
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels: [canonical, alias], currentModel: alias });
		const result = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "inspect", modelClass: "frontier" }, undefined, undefined, app.ctx);
		const args = JSON.parse(singleOutput(result)) as string[];
		assert.equal(args[args.indexOf("--model") + 1], "openai-codex-2/gpt-test");
		const extensions = args.flatMap((value, index) => value === "--extension" ? [args[index + 1]] : []);
		assert.ok(extensions.some((path) => path.endsWith("/pi-multi-codex/extensions/multi-codex.ts")));
	});
});

test("direct models honor scoped route thinking before launch", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: { fast: { primary: { model: "p/route", thinkingLevel: "high" } } },
		}));
		const marker = join(agentDir, "child-started");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");`);
		process.argv[1] = runner;
		const route = { ...model, provider: "p", id: "route", reasoning: true, thinkingLevelMap: { high: "high" } };
		const pinned = { ...model, provider: "p", id: "pinned", reasoning: true, thinkingLevelMap: { low: "low", high: "high" } };
		const app = harness({ scopedModels: [
			{ model: route, thinkingLevel: "high" },
			{ model: pinned, thinkingLevel: "low" },
		] });

		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "inspect code", model: "p/pinned" }, undefined, undefined, app.ctx),
			/cannot use route thinking high/,
		);
		assert.equal(existsSync(marker), false);
	});
});

test("validates every Role and route before isolated worktree creation", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const marker = join(agentDir, "child-started");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");`);
		process.argv[1] = runner;
		const app = harness({ cwd: repo });
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "inspect code", modelClass: "frontier" }, undefined, undefined, app.ctx),
			/Run \/task-models/,
		);
		await assert.rejects(
			app.tool.execute("call-2", { tasks: [
				{ role: "worker", name: "Test delegated task", task: "must not start" },
				{ role: "missing", name: "Test delegated task", task: "invalid" },
			] }, undefined, undefined, app.ctx),
			/Unknown Subagent role: missing/,
		);
		assert.equal(existsSync(marker), false);
		assert.equal(existsSync(join(repo, ".worktrees")), false);
	});
});

test("uses a profile fallback when the primary thinking level is unavailable before launch", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: {
				balanced: {
					primary: { model: "provider/primary", thinkingLevel: "high" },
					fallback: { model: "provider/fallback", thinkingLevel: "low" },
				},
			},
			tasks: { "pi-subagent/delegateTask": "balanced" },
		}));
		const primary = { provider: "provider", id: "primary", input: ["text"], reasoning: false };
		const fallback = { provider: "provider", id: "fallback", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low" } };
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels: [primary, fallback] });
		const result = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "inspect" }, undefined, undefined, app.ctx);
		const args = JSON.parse(singleOutput(result));
		assert.equal(args[args.indexOf("--model") + 1], "provider/fallback");
		assert.equal(args[args.indexOf("--thinking") + 1], "low");
	});
});

test("does not retry a child after launch failure", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		const marker = join(agentDir, "child-launches");
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: {
				balanced: {
					primary: { model: "provider/primary", thinkingLevel: "off" },
					fallback: { model: "provider/fallback", thinkingLevel: "off" },
				},
			},
			tasks: { "pi-subagent/delegateTask": "balanced" },
		}));
		const primary = { provider: "provider", id: "primary", input: ["text"], reasoning: false };
		const fallback = { provider: "provider", id: "fallback", input: ["text"], reasoning: false };
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "1");\nprocess.exit(2);\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels: [primary, fallback] });
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "inspect" }, undefined, undefined, app.ctx),
			(error: unknown) => error instanceof WorkflowFailureError && /Subagent exited with code 2/.test(error.message),
		);
		assert.equal(await readFile(marker, "utf8"), "1");
	});
});

test("widget renders one truncated line, retains terminal entries, and clears them on user input", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		for (const [name, description] of [["scout", "Finds code"], ["worker", "Does work"]]) {
			await writeFile(join(agentDir, "config", "pi-subagent", `${name}.md`), `---
name: ${name}
description: ${description}
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		}
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `
const event = (value) => console.log(JSON.stringify(value));
event({ type: "message_update", usage: { totalTokens: 1_100 } });
setTimeout(() => event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { totalTokens: 100 }, stopReason: "end" } }), 120);
`);
		process.argv[1] = runner;
		const app = harness({ ui: true });
		const completed = app.tool.execute("call-1", { role: "scout", name: "Normalize worktree paths", task: "Normalize Windows registered-worktree paths now" }, undefined, undefined, app.ctx);
		await waitFor(() => app.widget?.render(160).join("\n").includes("1.1k tok") ?? false);
		const wide = app.widget!.render(160);
		assert.equal(wide.length, 1);
		assert.ok(wide.every((line) => visibleWidth(line) <= 160));
		assert.match(wide[0]!, /\[S\] Normalize worktree paths · thinking… · text-model·low · 1\.1k tok ·/);
		assert.doesNotMatch(wide[0]!, /working|registered-worktree/);
		assert.doesNotMatch(wide.join("\n"), /test\//);
		const narrow = app.widget!.render(24);
		assert.equal(narrow.length, 1);
		assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
		assert.match(narrow[0]!, /\[S\] Normalize/);
		const tiny = app.widget!.render(1);
		assert.equal(tiny.length, 1);
		assert.ok(tiny.every((line) => visibleWidth(line) <= 1));
		await completed;
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		const terminal = app.widget!.render(160);
		assert.equal(terminal.length, 1);
		assert.match(terminal[0]!, /\[S\] Normalize worktree paths · Done · 1 turn/);
		assert.doesNotMatch(terminal[0]!, /complete|registered-worktree/);

		await writeFile(runner, `setTimeout(() => console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } })), 300);`);
		const running = app.tool.execute("call-2", { role: "worker", name: "Keep worker active", task: "keep working" }, undefined, undefined, app.ctx);
		await waitFor(() => app.widget?.render(100).join("\n").includes("[W] Keep worker active") ?? false);
		const activeFirst = app.widget!.render(160);
		assert.match(activeFirst[0]!, /\[W\] Keep worker active/);
		assert.match(activeFirst[1]!, /\[S\] Normalize worktree paths · Done/);
		await app.handlers.get("input")?.({ source: "extension", text: "injected" }, app.ctx);
		assert.match(app.widget!.render(100).join("\n"), /\[S\] Normalize worktree paths · Done/);
		await app.handlers.get("input")?.({ source: "interactive", text: "next" }, app.ctx);
		const afterInput = app.widget!.render(100).join("\n");
		assert.doesNotMatch(afterInput, /\[S\] Normalize worktree paths · Done/);
		assert.match(afterInput, /\[W\] Keep worker active/);
		await running;
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
	});
});

test("widget renders deterministic live activity across overlapping tools", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const stages = join(agentDir, "widget-activity-stages");
		await mkdir(stages);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const stages = ${JSON.stringify(stages)};
const event = (value) => console.log(JSON.stringify(value));
const waitFor = (stage, next) => {
	const timer = setInterval(() => {
		if (!existsSync(join(stages, stage))) return;
		clearInterval(timer);
		next();
	}, 5);
};
writeFileSync(join(stages, "started"), "");
waitFor("read", () => {
	event({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/target.ts" } });
	waitFor("bash", () => {
		event({ type: "tool_execution_start", toolCallId: "bash-2", toolName: "bash", args: {} });
		waitFor("bash-end", () => {
			event({ type: "tool_execution_end", toolCallId: "bash-2", toolName: "bash" });
			waitFor("read-end", () => {
				event({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" });
				waitFor("done", () => event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }));
			});
		});
	});
});
`);
		process.argv[1] = runner;
		const app = harness({ ui: true });
		const stagesToRelease = ["read", "bash", "bash-end", "read-end", "done"];
		const release = async (stage: string) => { await writeFile(join(stages, stage), ""); };
		const renderRows = () => {
			for (const width of [100, 24, 1]) {
				const lines = app.widget!.render(width);
				assert.equal(lines.length, 1);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
			}
			return app.widget!.render(100).join("\n");
		};
		const running = app.tool.execute("activity", { role: "worker", name: "Test delegated task", task: "trace deterministic widget activity" }, undefined, undefined, app.ctx);
		try {
			await waitFor(() => existsSync(join(stages, "started")) && (app.widget?.render(100).join("\n").includes("thinking…") ?? false));
			let widget = renderRows();
			assert.match(widget, /\[W\] Test delegated task/);
			assert.doesNotMatch(widget, /trace deterministic widget activity/);
			assert.match(widget, /thinking…/);
			assert.doesNotMatch(widget, /\b(?:turn|tool)s?\b/);

			await release("read");
			await waitFor(() => app.widget?.render(100).join("\n").includes("read ·") ?? false);
			widget = renderRows();
			assert.match(widget, /read · \d+s · target\.ts · 1 tool/);

			await release("bash");
			await waitFor(() => app.widget?.render(100).join("\n").includes("bash ·") ?? false);
			widget = renderRows();
			assert.match(widget, /bash · \d+s · 2 tools/);
			assert.doesNotMatch(widget, /target\.ts/);

			await release("bash-end");
			await waitFor(() => {
				const text = app.widget?.render(100).join("\n") ?? "";
				return text.includes("read ·") && !text.includes("bash ·");
			});
			widget = renderRows();
			assert.match(widget, /read · \d+s · target\.ts · 2 tools/);

			await release("read-end");
			await waitFor(() => app.widget?.render(100).join("\n").includes("thinking… · 2 tools") ?? false);
			widget = renderRows();
			assert.match(widget, /thinking… · 2 tools/);

			await release("done");
			assert.equal(singleOutput(await running), "done");
			widget = renderRows();
			assert.match(widget, /Done · 1 turn · 2 tools/);
		} finally {
			await Promise.all(stagesToRelease.map(release));
			await Promise.allSettled([running]);
			await app.handlers.get("session_shutdown")?.({}, app.ctx);
		}
	});
});

test("widget bounds retained activity without losing counts or overlap fallback", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const stages = join(agentDir, "widget-activity-cap-stages");
		await mkdir(stages);
		const toolIds = Array.from({ length: MAX_WIDGET_ACTIVE_TOOLS + 1 }, (_, index) => `tool-${index + 1}`);
		const retainedIds = toolIds.slice(1);
		const oversized = "x".repeat(64 * 1024);
		const actions = [
			{ stage: "oversized", event: { type: "tool_execution_start", toolCallId: "oversized", toolName: oversized, args: {} } },
			...toolIds.map((toolCallId) => ({ stage: `start-${toolCallId}`, event: { type: "tool_execution_start", toolCallId, toolName: toolCallId, args: {} } })),
			{ stage: "duplicate", event: { type: "tool_execution_start", toolCallId: toolIds.at(-1)!, toolName: toolIds.at(-1)!, args: {} } },
			{ stage: "end-evicted", event: { type: "tool_execution_end", toolCallId: toolIds[0]!, toolName: toolIds[0]! } },
			{ stage: "end-latest", event: { type: "tool_execution_end", toolCallId: toolIds.at(-1)!, toolName: toolIds.at(-1)! } },
			...retainedIds.slice(0, -1).reverse().map((toolCallId) => ({ stage: `end-${toolCallId}`, event: { type: "tool_execution_end", toolCallId, toolName: toolCallId } })),
			{ stage: "done", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } } },
		];
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const stages = ${JSON.stringify(stages)};
const actions = ${JSON.stringify(actions)};
const event = (value) => console.log(JSON.stringify(value));
writeFileSync(join(stages, "started"), "");
const next = () => {
	const action = actions.shift();
	if (!action) return;
	const timer = setInterval(() => {
		if (!existsSync(join(stages, action.stage))) return;
		clearInterval(timer);
		event(action.event);
		next();
	}, 5);
};
next();
`);
		process.argv[1] = runner;
		const app = harness({ ui: true });
		const release = async (stage: string) => { await writeFile(join(stages, stage), ""); };
		const rendered = () => app.widget!.render(100).join("\n");
		const running = app.tool.execute("activity-cap", { role: "worker", name: "Test delegated task", task: "bound retained widget activity" }, undefined, undefined, app.ctx);
		try {
			await waitFor(() => existsSync(join(stages, "started")) && (app.widget?.render(100).join("\n").includes("thinking…") ?? false));
			await release("oversized");
			for (const toolCallId of toolIds) {
				await release(`start-${toolCallId}`);
				await waitFor(() => rendered().includes(`${toolCallId} ·`));
			}
			let widget = rendered();
			assert.match(widget, new RegExp(`${toolIds.at(-1)!} · \\d+s · ${toolIds.length} tools`));
			assert.doesNotMatch(widget, /x{100}/);

			await release("duplicate");
			await release("end-evicted");
			await release("end-latest");
			const fallback = retainedIds.at(-1)!;
			await waitFor(() => rendered().includes(`${fallback} ·`) && rendered().includes(`${toolIds.length} tools`));
			widget = rendered();
			assert.match(widget, new RegExp(`${fallback} · \\d+s · ${toolIds.length} tools`));

			const endingIds = retainedIds.slice(0, -1).reverse();
			for (const [index, toolCallId] of endingIds.entries()) {
				await release(`end-${toolCallId}`);
				const next = endingIds[index + 1];
				await waitFor(() => next === undefined ? rendered().includes("thinking…") : rendered().includes(`${next} ·`));
			}
			widget = rendered();
			assert.match(widget, new RegExp(`thinking… · ${toolIds.length} tools`));

			await release("done");
			assert.equal(singleOutput(await running), "done");
			widget = rendered();
			assert.match(widget, new RegExp(`Done · 1 turn · ${toolIds.length} tools`));
			assert.doesNotMatch(widget, /tool-\d+ ·/);
		} finally {
			await Promise.all(actions.map(({ stage }) => release(stage)));
			await Promise.allSettled([running]);
			await app.handlers.get("session_shutdown")?.({}, app.ctx);
		}
	});
});

test("widget evicts the oldest terminal row so new active work remains visible at capacity", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = await blockedPiRunner(agentDir, ["active ninth"]);
		const app = harness({ ui: true });
		for (let index = 1; index <= 8; index++) {
			const task = `completed ${index}`;
			const completed = app.tool.execute(`call-${index}`, { role: "worker", name: task, task }, undefined, undefined, app.ctx);
			await waitFor(() => runner.started().includes(task));
			runner.release(task);
			await completed;
		}

		const active = app.tool.execute("call-9", { role: "worker", name: "Active ninth", task: "active ninth" }, undefined, undefined, app.ctx);
		await waitFor(() => runner.started().includes("active ninth"));
		try {
			const widget = app.widget!.render(160);
			assert.equal(widget.length, 6);
			assert.match(widget[0]!, /\[W\] Active ninth/);
			assert.doesNotMatch(widget.join("\n"), /completed 1/);
			for (let index = 2; index <= 5; index++) assert.match(widget[index - 1]!, new RegExp(`completed ${index}`));
			assert.equal(widget[5], "… 3 more · 3 complete");
		} finally {
			runner.release("active ninth");
			await active;
		}
	});
});

test("widget summarizes overflow while evicting terminal rows for new active work", async () => {
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "9";
		const tasks = Array.from({ length: 9 }, (_, index) => `blocked-${String(index + 1).padStart(2, "0")}`);
		const tenth = "blocked-10";
		const calls: Promise<unknown>[] = [];
		let releaseAll: () => Promise<unknown> = () => Promise.resolve();
		try {
			await writeWorkerRole(agentDir);
			const fake = await blockedPiRunner(agentDir, tasks);
			releaseAll = () => Promise.all([...tasks, tenth].map((task) => fake.release(task)));
			const app = harness({ ui: true });
			calls.push(...tasks.map((task, index) => app.tool.execute(`call-${index + 1}`, { role: "worker", name: task, task }, undefined, undefined, app.ctx)));
			await waitFor(() => fake.started().length === 9);
			for (const width of [160, 24, 1]) {
				const rows = app.widget!.render(width);
				assert.equal(rows.length, 6);
				assert.ok(rows.every((line) => visibleWidth(line) <= width));
			}
			let widget = app.widget!.render(160);
			assert.equal(widget.length, 6);
			assert.equal(workingWidgetHeaders(widget).length, 5);
			assert.equal(widget[5], "… 4 more · 4 working");

			for (const task of tasks.slice(0, 2)) fake.release(task);
			await Promise.all(calls.slice(0, 2));
			widget = app.widget!.render(160);
			assert.equal(widget.length, 6);
			assert.equal(widget[5], "… 4 more · 2 working · 2 complete");
			const tenthCall = app.tool.execute("call-10", { role: "worker", name: tenth, task: tenth }, undefined, undefined, app.ctx);
			calls.push(tenthCall);
			await waitFor(() => fake.started().includes(tenth));

			widget = app.widget!.render(160);
			assert.doesNotMatch(widget.join("\n"), /blocked-01|blocked-02/);
			for (const task of tasks.slice(2, 7)) assert.match(widget.join("\n"), new RegExp(task));
			assert.equal(workingWidgetHeaders(widget).length, 5);
			assert.equal(widget[5], "… 3 more · 3 working");
		} finally {
			await releaseAll();
			await Promise.allSettled(calls);
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	});
});

test("delegate_task leaves rendering to Pi", async () => {
	await environment(async () => {
		const app = harness();
		assert.equal(app.tool.renderShell, undefined);
		assert.equal(app.tool.renderCall, undefined);
		assert.equal(app.tool.renderResult, undefined);
	});
});

test("streams assistant text deltas before final message", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "scout.md"), `---
name: scout
description: Finds relevant code
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const event = (value) => console.log(JSON.stringify(value));
event({ type: "message_update", usage: { totalTokens: 1 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial 🙂" } });
setTimeout(() => event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial 🙂 done" }], stopReason: "end" } }), 100);
`);
		process.argv[1] = runner;
		const app = harness();
		const updates: any[] = [];
		const running = app.tool.execute("call-1", { role: "scout", name: "Test delegated task", task: "find auth" }, undefined, (update: any) => updates.push(update), app.ctx);
		await waitFor(() => updates.some((update) => update.content[0].text.includes("partial 🙂")));
		assert.ok(updates.every((update) => Buffer.byteLength(update.content[0].text, "utf8") <= 50 * 1024));
		const result = await running;
		assert.equal(singleOutput(result), "partial 🙂 done");
		assert.ok(updates.length > 0);
	});
});

test("decodes JSON output across UTF-8 chunk boundaries", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "scout.md"), `---
name: scout
description: Finds relevant code
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const line = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok 🙂" }], stopReason: "end" } }) + "\\n");
const split = line.indexOf(Buffer.from("🙂")) + 2;
process.stdout.write(line.subarray(0, split));
setTimeout(() => process.stdout.write(line.subarray(split)), 20);
`);
		process.argv[1] = runner;
		const app = harness();
		const result = await app.tool.execute("call-1", { role: "scout", name: "Test delegated task", task: "find auth" }, undefined, undefined, app.ctx);
		assert.equal(singleOutput(result), "ok 🙂");
	});
});

test("large child output bounds final result and streaming update", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "scout.md"), `---
name: scout
description: Finds relevant code
tools: [read]
extensions: []
skills: []
---
Return conclusions first, then file and line references.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const text = "a".repeat(60 * 1024);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }));
`);
		process.argv[1] = runner;
		const app = harness();
		const updates: any[] = [];
		const task = "🙂".repeat(10_000);
		const result = await app.tool.execute("call-1", { role: "scout", name: "Test delegated task", task }, undefined, (update: any) => updates.push(update), app.ctx);
		const original = "a".repeat(60 * 1024);
		assertTruncated(singleOutput(result), capOutput(original));
		assert.equal(result.details.entries[0].summary.length, 160);
		assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 50 * 1024);
		assert.ok(updates.length >= 2);
		assert.ok(updates.every((update) => Buffer.byteLength(update.content[0].text, "utf8") <= 50 * 1024));
		assertTruncated(singleOutput(updates.at(-1)), capOutput(original));
	});
});

test("ignores oversized lifecycle events after final message", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "scout.md"), `---
name: scout
description: Finds relevant code
tools: [read]
extensions: []
skills: []
---
Return concise findings.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const event = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } });
event({ type: "agent_end", messages: [{ role: "toolResult", content: "x".repeat(2 * 1024 * 1024) }] });
`);
		process.argv[1] = runner;
		const app = harness();
		const result = await app.tool.execute("call-1", { role: "scout", name: "Test delegated task", task: "find auth" }, undefined, undefined, app.ctx);
		assert.equal(singleOutput(result), "done");
	});
});

test("output cap preserves complete UTF-8 characters", () => {
	const original = "🙂".repeat(20_000);
	const result = capOutput(original);
	assertTruncated(result, original);
	assert.equal(result.includes("�"), false);
});

test("invalid role config blocks delegation without blocking extension load", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "broken.md"), `---
name: broken
description: Has malformed tool list
tools: [read, 1]
extensions: []
skills: []
---
Do work.
`);
		const app = harness();
		assert.equal(app.tool.parameters, WorkflowSchema);
		assert.match(app.tool.description, /single, parallel, or chain/);
		assert.ok(app.tool.promptGuidelines?.every((guideline) => guideline.includes("delegate_task")));
		assert.ok(app.tool.promptGuidelines?.some((guideline) => guideline.includes(MODEL_CLASS_GUIDANCE)
			&& guideline.includes("direct model replaces only the selected route's model")
			&& guideline.includes("thinking level stays unchanged")));
		assert.match(app.tool.description, /configuration error/);
		await assert.rejects(
			app.tool.execute("invalid", { role: "broken", name: "Test delegated task", task: "work", tasks: [] }, undefined, undefined, app.ctx),
			/exactly one mode/,
		);
		await assert.rejects(
			app.tool.execute("call-1", { role: "broken", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx),
			/tools/,
		);
	});
});

test("tool argument preparation normalizes valid modes and bounds parse failures before schema validation", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const marker = join(agentDir, "preflight-child-started");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");`);
		process.argv[1] = runner;
		const app = harness();
		const valid = [
			{ role: " worker ", name: "Test delegated task", task: " work " },
			{ tasks: [{ role: " worker ", name: "Test delegated task", task: " parallel " }], background: true },
			{ chain: [{ role: " worker ", name: "Test delegated task", task: " chain " }] },
		];
		for (const params of valid) {
			const normalized = app.tool.prepareArguments!(params);
			assert.deepEqual(parseWorkflow(normalized), parseWorkflow(params));
			assert.equal((normalized as { background: boolean }).background, Boolean(params.background));
		}

		const huge = "x".repeat(60 * 1024);
		for (const run of [
			() => app.tool.prepareArguments!({ role: "worker", name: "Test delegated task", task: "work", [huge]: true }),
			() => app.tool.execute("role", { role: huge, name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx),
		]) {
			const error = await Promise.resolve().then(run).then(
				() => assert.fail("expected preflight rejection"),
				(reason) => reason,
			);
			assert.ok(error instanceof Error);
			assert.ok(Buffer.byteLength(error.message, "utf8") <= 50 * 1024);
		}
		assert.equal(existsSync(marker), false);
	});
});

test("pre-aborted foreground and background calls use fixed typed errors before acceptance or launch", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const marker = join(agentDir, "pre-aborted-child-started");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");`);
		process.argv[1] = runner;
		const app = harness();
		for (const background of [false, true]) {
			const controller = new AbortController();
			const reason = new Error("x".repeat(60 * 1024));
			controller.abort(reason);
			await assert.rejects(
				app.tool.execute(`pre-${background}`, { role: "worker", name: "Test delegated task", task: "work", background }, controller.signal, undefined, app.ctx),
				(error) => {
					assert.ok(error instanceof EphemeralSubagentError);
					assert.equal(error.code, "aborted");
					assert.equal(error.message, "Subagent was aborted.");
					assert.equal(error.cause, reason);
					return true;
				},
			);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(existsSync(marker), false);
		assert.deepEqual(app.sentMessages, []);
	});
});

test("parallel workflow starts together, settles in input order, and resolves per-entry Roles and routes", async () => {
	await environment(async (agentDir) => {
		const roleDir = join(agentDir, "config", "pi-subagent");
		await mkdir(roleDir, { recursive: true });
		await Promise.all([
			writeFile(join(roleDir, "scout.md"), `---
name: scout
description: Finds code
tools: [read]
extensions: [/user/scout.ts]
skills: [skill-a]
---
Find code.
`),
			writeFile(join(roleDir, "reviewer.md"), `---
name: reviewer
description: Reviews code
tools: [grep]
extensions: [/user/reviewer.ts]
skills: [skill-b]
---
Review code.
`),
			writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
				profiles: {
					fast: { primary: { model: "provider/fast", thinkingLevel: "off" } },
					frontier: { primary: { model: "provider/deep", thinkingLevel: "high" } },
				},
			})),
		]);
		const started = join(agentDir, "parallel-started");
		const release = join(agentDir, "parallel-release");
		await Promise.all([mkdir(started), mkdir(release)]);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const task = process.argv.at(-1).replace(/^Task: /, "");
writeFileSync(join(${JSON.stringify(started)}, task), JSON.stringify(process.argv.slice(2)));
const factor = task === "alpha" ? 1 : 2;
const timer = setInterval(() => {
	if (!existsSync(join(${JSON.stringify(release)}, task))) return;
	clearInterval(timer);
	const usage = { input: factor, output: factor, cacheRead: factor, cacheWrite: factor, totalTokens: factor * 4, cost: { input: factor, output: factor, cacheRead: factor, cacheWrite: factor, total: factor * 4 } };
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: task + "-done" }], usage, stopReason: "end" } }));
}, 5);
`);
		process.argv[1] = runner;
		const fast = { provider: "provider", id: "fast", input: ["text"], reasoning: false };
		const deep = { provider: "provider", id: "deep", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" } };
		const app = harness({
			availableModels: [fast, deep],
			skills: [
				{ name: "skill-a", path: "/skills/a/SKILL.md" },
				{ name: "skill-b", path: "/skills/b/SKILL.md" },
			],
		});
		const updates: any[] = [];
		const running = app.tool.execute("workflow-1", { tasks: [
			{ role: "scout", name: "Test delegated task", task: "alpha", model: "provider/fast" },
			{ role: "reviewer", name: "Test delegated task", task: "beta", modelClass: "frontier" },
		] }, undefined, (update: any) => updates.push(update), app.ctx);
		await waitFor(() => readdirSync(started).length === 2);
		await writeFile(join(release, "beta"), "");
		await writeFile(join(release, "alpha"), "");
		const result = await running;

		assert.deepEqual(result.details.entries.map(({ id, index, role, status, model, thinkingLevel }: any) => ({ id, index, role, status, model, thinkingLevel })), [
			{ id: "workflow-1:parallel:0", index: 0, role: "scout", status: "succeeded", model: "provider/fast", thinkingLevel: "off" },
			{ id: "workflow-1:parallel:1", index: 1, role: "reviewer", status: "succeeded", model: "provider/deep", thinkingLevel: "high" },
		]);
		assert.ok(result.content[0].text.indexOf("alpha-done") < result.content[0].text.indexOf("beta-done"));
		assert.deepEqual(result.usage, {
			input: 3, output: 3, cacheRead: 3, cacheWrite: 3, totalTokens: 12,
			cost: { input: 3, output: 3, cacheRead: 3, cacheWrite: 3, total: 12 },
		});
		const alphaArgs = JSON.parse(await readFile(join(started, "alpha"), "utf8")) as string[];
		const betaArgs = JSON.parse(await readFile(join(started, "beta"), "utf8")) as string[];
		assert.equal(alphaArgs[alphaArgs.indexOf("--model") + 1], "provider/fast");
		assert.equal(alphaArgs[alphaArgs.indexOf("--extension") + 1], "/user/scout.ts");
		assert.equal(alphaArgs[alphaArgs.indexOf("--skill") + 1], "/skills/a/SKILL.md");
		assert.equal(alphaArgs[alphaArgs.indexOf(`--${ROLE_TOOL_POLICY_FLAG}`) + 1], JSON.stringify(["read"]));
		assert.equal(betaArgs[betaArgs.indexOf("--model") + 1], "provider/deep");
		assert.equal(betaArgs[betaArgs.indexOf("--extension") + 1], "/user/reviewer.ts");
		assert.equal(betaArgs[betaArgs.indexOf("--skill") + 1], "/skills/b/SKILL.md");
		assert.equal(betaArgs[betaArgs.indexOf(`--${ROLE_TOOL_POLICY_FLAG}`) + 1], JSON.stringify(["grep"]));
	});
});

test("background parallel acknowledges before launch and sends one ordered partial-failure aggregate", async () => {
	await environment(async (agentDir) => {
		const roleDir = join(agentDir, "config", "pi-subagent");
		await mkdir(roleDir, { recursive: true });
		await Promise.all([
			writeFile(join(roleDir, "scout.md"), `---
name: scout
description: Finds code
tools: [read]
extensions: []
skills: []
---
Find code.
`),
			writeFile(join(roleDir, "reviewer.md"), `---
name: reviewer
description: Reviews code
tools: [grep]
extensions: []
skills: []
---
Review code.
`),
		]);
		const started = join(agentDir, "background-parallel-started");
		const release = join(agentDir, "background-parallel-release");
		await Promise.all([mkdir(started), mkdir(release)]);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const task = process.argv.at(-1).replace(/^Task: /, "");
writeFileSync(join(${JSON.stringify(started)}, task), "");
const factor = task === "alpha" ? 1 : 2;
const timer = setInterval(() => {
	if (!existsSync(join(${JSON.stringify(release)}, task))) return;
	clearInterval(timer);
	const usage = { input: factor, output: factor, cacheRead: factor, cacheWrite: factor, totalTokens: factor * 4, cost: { input: factor, output: factor, cacheRead: factor, cacheWrite: factor, total: factor * 4 } };
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: task === "alpha" ? "successful sibling evidence" : "failed child output" }], usage, stopReason: task === "alpha" ? "end" : "error", ...(task === "beta" ? { errorMessage: "beta failed" } : {}) } }));
}, 5);
`);
		process.argv[1] = runner;
		const app = harness();
		const updates: any[] = [];
		const acknowledgement = await app.tool.execute("background-parallel", { tasks: [
			{ role: "scout", name: "Test delegated task", task: "alpha" },
			{ role: "reviewer", name: "Test delegated task", task: "beta" },
		], background: true }, undefined, (update: any) => updates.push(update), app.ctx);

		assert.equal(readdirSync(started).length, 0);
		assert.ok(Buffer.byteLength(acknowledgement.content[0].text, "utf8") <= 50 * 1024);
		assert.match(acknowledgement.details.taskId, /^bg-\d+-[a-z0-9]+$/);
		assert.equal(acknowledgement.details.mode, "parallel");
		assert.deepEqual(acknowledgement.details.entries, [
			{ id: "background-parallel:parallel:0", index: 0, role: "scout" },
			{ id: "background-parallel:parallel:1", index: 1, role: "reviewer" },
		]);
		await waitFor(() => readdirSync(started).length === 2);
		await writeFile(join(release, "beta"), "");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(app.sentMessages.length, 0);
		await writeFile(join(release, "alpha"), "");
		await waitFor(() => app.sentMessages.length === 1);

		assert.deepEqual(updates, []);
		const { message, options } = app.sentMessages[0]!;
		assert.equal(message.customType, "subagent-background-result");
		assert.equal(message.details.taskId, acknowledgement.details.taskId);
		assert.equal(message.details.outcome, "failed");
		assert.deepEqual(message.details.entries.map(({ role, status }: any) => ({ role, status })), [
			{ role: "scout", status: "succeeded" },
			{ role: "reviewer", status: "failed" },
		]);
		assert.deepEqual(message.details.usage, {
			input: 3, output: 3, cacheRead: 3, cacheWrite: 3, totalTokens: 12,
			cost: { input: 3, output: 3, cacheRead: 3, cacheWrite: 3, total: 12 },
		});
		assert.match(message.content, /^Background workflow failed\.\nMode: parallel/);
		assert.match(message.content, /successful sibling evidence/);
		assert.match(message.content, /beta failed/);
		assert.ok(message.content.indexOf("successful sibling evidence") < message.content.indexOf("beta failed"));
		assert.ok(Buffer.byteLength(message.content, "utf8") <= 50 * 1024);
		assert.deepEqual(options, { triggerTurn: false });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(app.sentMessages.length, 1);
	});
});

test("chain passes only immediate assistant output, stops on failure, and isolates each started entry", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const log = join(agentDir, "chain-tasks.jsonl");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { appendFileSync, writeFileSync } from "node:fs";
const rawTask = process.argv.at(-1).replace(/^Task: /, "");
const task = rawTask.split("\\n\\n[WORKTREE ISOLATION]", 1)[0];
appendFileSync(${JSON.stringify(log)}, JSON.stringify(task) + "\\n");
const event = (value) => console.log(JSON.stringify(value));
if (task === "first") {
	writeFileSync("retained.txt", "recover me");
	event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FIRST {previous}" }], stopReason: "end" } });
} else if (task === "second sees [FIRST {previous}]") {
	event({ type: "message_end", message: { role: "assistant", content: [], stopReason: "end" } });
} else if (task === "third sees []") {
	event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "must not continue" }], stopReason: "error", errorMessage: "chain broke" } });
} else {
	throw new Error("unexpected chain task: " + task);
}
`);
		process.argv[1] = runner;
		const app = harness({ cwd: repo });
		const error = await app.tool.execute("chain-call", { chain: [
			{ role: "worker", name: "Test delegated task", task: "first" },
			{ role: "worker", name: "Test delegated task", task: "second sees [{previous}]" },
			{ role: "worker", name: "Test delegated task", task: "third sees [{previous}]" },
			{ role: "worker", name: "Test delegated task", task: "never" },
		] }, undefined, undefined, app.ctx).then(
			() => assert.fail("expected workflow failure"),
			(reason) => reason,
		);
		assert.ok(error instanceof WorkflowFailureError);
		assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
			"first",
			"second sees [FIRST {previous}]",
			"third sees []",
		]);
		assert.deepEqual(error.details.entries.map(({ status }: any) => status), ["succeeded", "succeeded", "failed", "skipped"]);
		const [firstName, secondName, thirdName] = [0, 1, 2].map((index) => childName(`chain-call:chain:${index}`));
		const root = await realpath(repo);
		const [firstPath, secondPath, thirdPath] = [firstName, secondName, thirdName]
			.map((name) => join(root, ".worktrees", name));
		const [firstWorktree, secondWorktree, thirdWorktree] = error.details.entries.map(({ worktree }: any) => worktree);
		assert.ok(firstWorktree);
		assert.ok(secondWorktree);
		assert.ok(thirdWorktree);
		assert.equal(firstWorktree.path, firstPath);
		assert.equal(firstWorktree.pruned, false);
		assert.equal(secondWorktree.path, secondPath);
		assert.equal(secondWorktree.pruned, true);
		assert.equal(thirdWorktree.path, thirdPath);
		assert.equal(thirdWorktree.pruned, true);
		assert.equal(new Set([firstPath, secondPath, thirdPath]).size, 3);
		assert.equal(existsSync(firstPath), true);
		assert.equal(existsSync(secondPath), false);
		assert.equal(existsSync(thirdPath), false);
		assert.match(error.message, /FIRST \{previous\}/);
		assert.match(error.message, /chain broke/);
		assert.match(error.message, new RegExp(firstName));
	});
});

test("background chain substitutes immediate output and fails fast", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const log = join(agentDir, "background-chain.jsonl");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { appendFileSync } from "node:fs";
const task = process.argv.at(-1).replace(/^Task: /, "");
appendFileSync(${JSON.stringify(log)}, JSON.stringify(task) + "\\n");
if (task === "first") {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FIRST {previous}" }], stopReason: "end" } }));
} else if (task === "second sees [FIRST {previous}]") {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "unused failure output" }], stopReason: "error", errorMessage: "chain stopped" } }));
} else {
	throw new Error("unexpected chained task: " + task);
}
`);
		process.argv[1] = runner;
		const app = harness();
		const acknowledgement = await app.tool.execute("background-chain", { chain: [
			{ role: "worker", name: "Test delegated task", task: "first" },
			{ role: "worker", name: "Test delegated task", task: "second sees [{previous}]" },
			{ role: "worker", name: "Test delegated task", task: "must not start" },
		], background: true }, undefined, undefined, app.ctx);
		assert.equal(acknowledgement.details.mode, "chain");
		assert.deepEqual(acknowledgement.details.entries.map(({ id }: any) => id), [
			"background-chain:chain:0",
			"background-chain:chain:1",
			"background-chain:chain:2",
		]);
		await waitFor(() => app.sentMessages.length === 1);

		assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
			"first",
			"second sees [FIRST {previous}]",
		]);
		const message = app.sentMessages[0]!.message;
		assert.equal(message.details.outcome, "failed");
		assert.deepEqual(message.details.entries.map(({ status }: any) => status), ["succeeded", "failed", "skipped"]);
		assert.match(message.content, /FIRST \{previous\}/);
		assert.match(message.content, /chain stopped/);
		assert.doesNotMatch(message.content, /must not start/);
	});
});

test("parallel partial failure throws with successful sibling and retained recovery evidence", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs";
const task = process.argv.at(-1).replace(/^Task: /, "").split("\\n\\n[WORKTREE ISOLATION]", 1)[0];
if (task === "bad") writeFileSync("recover.txt", "recover me");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: task === "good" ? "successful sibling evidence" : "failed child output" }], stopReason: task === "good" ? "end" : "error", ...(task === "bad" ? { errorMessage: "bad child failed" } : {}) } }));
`);
		process.argv[1] = runner;
		const app = harness({ cwd: repo });
		const error = await app.tool.execute("partial", { tasks: [
			{ role: "worker", name: "Test delegated task", task: "good" },
			{ role: "worker", name: "Test delegated task", task: "bad" },
		] }, undefined, undefined, app.ctx).then(
			() => assert.fail("expected workflow failure"),
			(reason) => reason,
		);
		assert.ok(error instanceof WorkflowFailureError);
		assert.deepEqual(error.details.entries.map(({ status }: any) => status), ["succeeded", "failed"]);
		const retained = join(await realpath(repo), ".worktrees", childName("partial:parallel:1"));
		const worktree = error.details.entries[1]!.worktree;
		assert.ok(worktree);
		assert.equal(worktree.path, retained);
		assert.equal(worktree.pruned, false);
		assert.match(error.message, /successful sibling evidence/);
		assert.match(error.message, /bad child failed/);
		assert.match(error.message, new RegExp(childName("partial:parallel:1")));
		assert.equal(existsSync(retained), true);
	});
});

test("tool_result restores bounded foreground failure details and aggregate Usage exactly once", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "failed output" }], usage, stopReason: "error", errorMessage: "child failed" } }));
`);
		process.argv[1] = runner;
		const app = harness();
		const error = await app.tool.execute("patched", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx).then(
			() => assert.fail("expected workflow failure"),
			(reason) => reason,
		);
		assert.ok(error instanceof WorkflowFailureError);
		const event = {
			type: "tool_result",
			toolName: "delegate_task",
			toolCallId: "patched",
			input: { role: "worker", name: "Test delegated task", task: "work" },
			content: [{ type: "text", text: error.message }],
			details: undefined,
			isError: true,
		};
		const handler = app.handlers.get("tool_result")!;
		assert.deepEqual(await handler(event, app.ctx), {
			content: [{ type: "text", text: error.message }],
			details: error.details,
			isError: true,
			usage: error.usage,
		});
		assert.equal(await handler(event, app.ctx), undefined);

		await assert.rejects(app.tool.execute("leftover", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx));
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
		assert.equal(await handler({ ...event, toolCallId: "leftover" }, app.ctx), undefined);
	});
});

test("background parallel keeps distinct Role, widget, child, and worktree identities", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		const roleDir = join(agentDir, "config", "pi-subagent");
		await mkdir(roleDir, { recursive: true });
		await Promise.all([
			writeFile(join(roleDir, "scout.md"), `---
name: scout
description: Finds code
tools: [read]
extensions: [/user/scout.ts]
isolation: worktree
skills: []
---
Find code.
`),
			writeFile(join(roleDir, "reviewer.md"), `---
name: reviewer
description: Reviews code
tools: [grep]
extensions: [/user/reviewer.ts]
isolation: worktree
skills: []
---
Review code.
`),
		]);
		const started = join(agentDir, "identity-started");
		const release = join(agentDir, "identity-release");
		await Promise.all([mkdir(started), mkdir(release)]);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const task = process.argv.at(-1).replace(/^Task: /, "").split("\\n\\n[WORKTREE ISOLATION]", 1)[0];
writeFileSync(join(${JSON.stringify(started)}, task), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
const timer = setInterval(() => {
	if (!existsSync(join(${JSON.stringify(release)}, task))) return;
	clearInterval(timer);
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: task + " done" }], stopReason: "end" } }));
}, 5);
`);
		process.argv[1] = runner;
		const app = harness({ cwd: repo, ui: true });
		const acknowledgement = await app.tool.execute("identity", { tasks: [
			{ role: "scout", name: "Inspect auth files", task: "alpha" },
			{ role: "reviewer", name: "Review auth findings", task: "beta" },
		], background: true }, undefined, undefined, app.ctx);
		await waitFor(() => readdirSync(started).length === 2);

		const root = await realpath(repo);
		const names = [0, 1].map((index) => childName(`identity:parallel:${index}`));
		const paths = names.map((name) => join(root, ".worktrees", name));
		const launches = await Promise.all(["alpha", "beta"].map(async (task) =>
			JSON.parse(await readFile(join(started, task), "utf8")) as { args: string[]; cwd: string }));
		assert.deepEqual(launches.map(({ cwd }) => cwd), paths);
		assert.equal(launches[0]!.args[launches[0]!.args.indexOf("--extension") + 1], "/user/scout.ts");
		assert.equal(launches[1]!.args[launches[1]!.args.indexOf("--extension") + 1], "/user/reviewer.ts");
		assert.equal(launches[0]!.args[launches[0]!.args.indexOf(`--${ROLE_TOOL_POLICY_FLAG}`) + 1], JSON.stringify(["read"]));
		assert.equal(launches[1]!.args[launches[1]!.args.indexOf(`--${ROLE_TOOL_POLICY_FLAG}`) + 1], JSON.stringify(["grep"]));
		const widget = workingWidgetHeaders(app.widget!.render(120));
		assert.equal(widget.length, 2);
		assert.match(widget.join("\n"), /\[S\] Inspect auth files/);
		assert.match(widget.join("\n"), /\[R\] Review auth findings/);
		await Promise.all([writeFile(join(release, "alpha"), ""), writeFile(join(release, "beta"), "")]);
		await waitFor(() => app.sentMessages.length === 1);

		const entries = app.sentMessages[0]!.message.details.entries;
		assert.equal(app.sentMessages[0]!.message.details.taskId, acknowledgement.details.taskId);
		assert.deepEqual(entries.map(({ role }: any) => role), ["scout", "reviewer"]);
		assert.deepEqual(entries.map(({ worktree }: any) => worktree), names.map((name, index) => ({
			path: paths[index],
			branch: `pi-subagent/${name}`,
			commits: 0,
			dirty: false,
			pruned: true,
		})));
		assert.equal(new Set(paths).size, 2);
	});
});

test("oversized parallel foreground and background aggregates stay within 50 KiB", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const task = process.argv.at(-1).replace(/^Task: /, "");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: task + ":" + "x".repeat(60 * 1024) }], stopReason: "end" } }));
`);
		process.argv[1] = runner;
		const app = harness();
		const tasks = Array.from({ length: 8 }, (_, index) => ({ role: "worker", name: "Test delegated task", task: `task-${index}` }));
		const updates: any[] = [];
		const result = await app.tool.execute("large", { tasks }, undefined, (update: any) => updates.push(update), app.ctx);
		assert.equal(result.details.entries.length, 8);
		assert.ok(updates.length >= 8);
		for (const transport of [...updates, result]) {
			assert.ok(Buffer.byteLength(transport.content[0].text, "utf8") <= 50 * 1024);
		}
		assert.match(result.content[0].text, /\[Output truncated: \d+ bytes omitted\]$/);

		const backgroundUpdates: any[] = [];
		const acknowledgement = await app.tool.execute(
			"large-background", { tasks, background: true }, undefined,
			(update: any) => backgroundUpdates.push(update), app.ctx,
		);
		assert.ok(Buffer.byteLength(acknowledgement.content[0].text, "utf8") <= 50 * 1024);
		await waitFor(() => app.sentMessages.length === 1);
		const message = app.sentMessages[0]!.message;
		assert.deepEqual(backgroundUpdates, []);
		assert.equal(message.details.entries.length, 8);
		assert.ok(message.details.entries.every(({ status }: any) => status === "succeeded"));
		assert.ok(Buffer.byteLength(message.content, "utf8") <= 50 * 1024);
		assert.match(message.content, /\[Output truncated: \d+ bytes omitted\]$/);
	});
});

test("real parent abort finalizes every started child and reports dirty recovery paths", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const started = join(agentDir, "abort-started");
		await mkdir(started);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const task = process.argv.at(-1).replace(/^Task: /, "").split("\\n\\n[WORKTREE ISOLATION]", 1)[0];
writeFileSync(task + ".txt", "recover me");
writeFileSync(join(${JSON.stringify(started)}, task), "");
console.log(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
setInterval(() => console.log(JSON.stringify({ type: "message_update", usage: { totalTokens: 1 } })), 25);
`);
		process.argv[1] = runner;
		const app = harness({ cwd: repo, timeoutPolicy: { idleMs: 60_000, maxMs: 120_000 } });
		const controller = new AbortController();
		const running = app.tool.execute("abort-flow", { tasks: [
			{ role: "worker", name: "Test delegated task", task: "one" }, { role: "worker", name: "Test delegated task", task: "two" },
		] }, controller.signal, undefined, app.ctx);
		const paths = [0, 1].map((index) => join(repo, ".worktrees", childName(`abort-flow:parallel:${index}`)));
		await waitFor(() => readdirSync(started).length === 2 && paths.every(existsSync));
		const reason = new Error("parent stopped");
		reason.name = "AbortError";
		controller.abort(reason);
		const error = await running.then(
			() => assert.fail("expected workflow abort"),
			(reason) => reason,
		);
		assert.ok(error instanceof WorkflowAbortedError);
		assert.equal(error.cause, reason);
		assert.deepEqual(error.details.entries.map(({ status, worktree }: any) => ({
			status,
			dirty: worktree.dirty,
			pruned: worktree.pruned,
		})), [
			{ status: "rejected", dirty: true, pruned: false },
			{ status: "rejected", dirty: true, pruned: false },
		]);
		assert.ok(Buffer.byteLength(error.message, "utf8") <= 50 * 1024);
		for (const path of paths) {
			assert.equal(existsSync(path), true);
			assert.ok(error.message.indexOf(path) >= 0 && error.message.indexOf(path) < error.message.indexOf("Evidence:"));
		}
	});
});

test("runs four child delegations and starts queued children FIFO", async () => {
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "4";
		try {
			await runsQueuedChildrenFifo(agentDir);
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	});
});

async function runsQueuedChildrenFifo(agentDir: string): Promise<void> {
	await writeWorkerRole(agentDir);
		const tasks = Array.from({ length: 6 }, (_, index) => `task-${index + 1}`);
		const runner = await blockedPiRunner(agentDir);
		const app = harness({ ui: true });
		const calls = tasks.map((task, index) => app.tool.execute(
			`call-${index + 1}`,
			{ role: "worker", name: "Test delegated task", task },
			undefined,
			undefined,
			app.ctx,
		));
		try {
			await waitFor(() => workingWidgetHeaders(app.widget?.render(80) ?? []).length >= 4);
			assert.equal(workingWidgetHeaders(app.widget!.render(80)).length, 4);
			await waitFor(() => runner.started().length === 4);
			assert.deepEqual(runner.started(), tasks.slice(0, 4));
			await runner.release(tasks[0]!);
			await waitFor(() => runner.started().includes(tasks[4]!));
			assert.deepEqual(runner.started(), [...tasks.slice(0, 4), tasks[4]!]);
			for (const task of tasks.slice(1)) await runner.release(task);
			assert.equal((await Promise.all(calls)).length, tasks.length);
		} finally {
			await Promise.all(tasks.map((task) => runner.release(task)));
			await Promise.allSettled(calls);
			await app.handlers.get("session_shutdown")?.({}, app.ctx);
		}
}

test("queued foreground delegation resolves its route after the permit", async () => {
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "1";
		try {
			await writeWorkerRole(agentDir);
			const started = join(agentDir, "late-route-started");
			const release = join(agentDir, "late-route-release");
			await Promise.all([mkdir(started), mkdir(release)]);
			const runner = join(agentDir, "fake-pi.mjs");
			await writeFile(runner, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const task = process.argv.at(-1).replace(/^Task: /, "");
writeFileSync(join(${JSON.stringify(started)}, task), "");
const timer = setInterval(() => {
	if (!existsSync(join(${JSON.stringify(release)}, task))) return;
	clearInterval(timer);
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], stopReason: "stop" } }));
}, 5);
`);
			process.argv[1] = runner;
			const lateModel = { ...model, provider: "provider", id: "late-model" };
			const app = harness({ availableModels: [model, lateModel] });
			const first = app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "task-1" }, undefined, undefined, app.ctx);
			await waitFor(() => existsSync(join(started, "task-1")));
			const second = app.tool.execute("call-2", { role: "worker", name: "Test delegated task", task: "task-2" }, undefined, undefined, app.ctx);
			await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
				profiles: { balanced: { primary: { model: "provider/late-model", thinkingLevel: "low" } } },
				tasks: { "pi-subagent/delegateTask": "balanced" },
			}));
			await writeFile(join(release, "task-1"), "");
			await first;
			await waitFor(() => existsSync(join(started, "task-2")));
			await writeFile(join(release, "task-2"), "");
			const args = JSON.parse(singleOutput(await second)) as string[];
			assert.equal(args[args.indexOf("--model") + 1], "provider/late-model");
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	});
});

test("PI_SUBAGENT_MAX_SUBAGENTS overrides the default child cap", async () => {
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "1";
		try {
			await writeWorkerRole(agentDir);
			const tasks = ["task-1", "task-2"];
			const runner = await blockedPiRunner(agentDir);
			const app = harness({ ui: true });
			const calls = tasks.map((task, index) => app.tool.execute(
				`call-${index + 1}`, { role: "worker", name: "Test delegated task", task }, undefined, undefined, app.ctx,
			));
			try {
				await waitFor(() => runner.started().length === 1);
				assert.deepEqual(runner.started(), ["task-1"]);
				assert.equal(workingWidgetHeaders(app.widget!.render(80)).length, 1);
				await runner.release("task-1");
				await waitFor(() => runner.started().includes("task-2"));
				for (const task of tasks) await runner.release(task);
				assert.equal((await Promise.all(calls)).length, tasks.length);
			} finally {
				await Promise.all(tasks.map((task) => runner.release(task)));
				await Promise.allSettled(calls);
				await app.handlers.get("session_shutdown")?.({}, app.ctx);
			}
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	});
});

test("session shutdown aborts queued background subagents without unhandled rejections", async () => {
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "1";
		try {
			const unhandled: unknown[] = [];
			const onUnhandled = (error: unknown) => unhandled.push(error);
			process.on("unhandledRejection", onUnhandled);
			try {
				await writeWorkerRole(agentDir);
				const runner = join(agentDir, "fake-pi.mjs");
				await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }));`);
				process.argv[1] = runner;

				const app = harness();
				const first = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "task-1", background: true }, undefined, undefined, app.ctx);
				assert.match(first.content[0]!.text, /accepted/);
				const second = await app.tool.execute("call-2", { role: "worker", name: "Test delegated task", task: "task-2", background: true }, undefined, undefined, app.ctx);
				assert.match(second.content[0]!.text, /accepted/);
				// Second task is queued; shutdown must abort it without an unhandled
				// rejection from the discarded IIFE promise.
				await app.handlers.get("session_shutdown")?.({}, { hasUI: false });
				await new Promise((resolve) => setTimeout(resolve, 50));
				assert.deepEqual(unhandled, []);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	});
});

test("background outcomes are not delivered after session shutdown", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "end" } }));`);
		process.argv[1] = runner;

		const app = harness();
		await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work", background: true }, undefined, undefined, app.ctx);
		await app.handlers.get("session_shutdown")?.({}, { hasUI: false });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(app.sentMessages.length, 0);
	});
});

test("invalid PI_SUBAGENT_MAX_SUBAGENTS fails extension load", () => {
	for (const invalid of ["zero", "2workers", "1.5", "1e3", "0", "-1"]) {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = invalid;
		try {
			assert.throws(() => harness(), /PI_SUBAGENT_MAX_SUBAGENTS/);
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	}
});

test("config file maxSubagents applies and malformed config warns without failing load", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const configDir = join(agentDir, "config", "pi-subagent");
		await mkdir(configDir, { recursive: true });
		await writeFile(join(configDir, "config.json"), JSON.stringify({ maxSubagents: 1 }));

		const configured = harness({ ui: true });
		configured.handlers.get("session_start")?.({}, configured.ctx);
		assert.deepEqual(configured.notifications, []);

		const tasks = ["task-1", "task-2"];
		const runner = await blockedPiRunner(agentDir);
		const app = harness({ ui: true });
		const calls = tasks.map((task, index) => app.tool.execute(
			`call-${index + 1}`, { role: "worker", name: "Test delegated task", task }, undefined, undefined, app.ctx,
		));
		try {
			await waitFor(() => runner.started().length === 1);
			await runner.release("task-1");
			await waitFor(() => runner.started().includes("task-2"));
		} finally {
			await Promise.all(tasks.map((task) => runner.release(task)));
			await Promise.allSettled(calls);
			await app.handlers.get("session_shutdown")?.({}, app.ctx);
		}

		// Malformed file: session still loads; warning surfaces at session_start.
		await writeFile(join(configDir, "config.json"), "{ broken");
		const warned = harness({ ui: true });
		warned.handlers.get("session_start")?.({}, warned.ctx);
		assert.equal(warned.notifications.length, 1);
		assert.match(warned.notifications[0]!.message, /not valid JSON/);
	});
});

test("missing local config uses defaults quietly while missing shared config warns once", async () => {
	await environment(async (agentDir) => {
		const localConfig = join(agentDir, "config", "pi-subagent", "config.json");
		const sharedConfig = join(agentDir, "config", "pi-task-models", "config.json");
		await rm(sharedConfig);

		const app = harness({ ui: true });
		app.handlers.get("session_start")?.({}, app.ctx);
		assert.deepEqual(app.notifications, [
			{ message: "Task model config is missing; run /task-models to configure it.", type: "warning" },
		]);
		assert.equal(existsSync(localConfig), false);
		assert.equal(existsSync(sharedConfig), false);
	});
});

test("drops an aborted queued delegation and transfers its permit", async () => {
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "4";
		try {
			await writeWorkerRole(agentDir);
		const tasks = Array.from({ length: 6 }, (_, index) => `task-${index + 1}`);
		const runner = await blockedPiRunner(agentDir);
		const app = harness({ ui: true });
		const active = tasks.slice(0, 4).map((task, index) => app.tool.execute(
			`call-${index + 1}`,
			{ role: "worker", name: "Test delegated task", task },
			undefined,
			undefined,
			app.ctx,
		));
		const calls = [...active];
		try {
			await waitFor(() => runner.started().length === 4);
			assert.deepEqual(runner.started(), tasks.slice(0, 4));
			const abort = new AbortController();
			const fifth = app.tool.execute("call-5", { role: "worker", name: "Test delegated task", task: tasks[4]! }, abort.signal, undefined, app.ctx);
			const fifthAborted = assert.rejects(fifth, (error: unknown) => error instanceof Error && error.name === "AbortError");
			const sixth = app.tool.execute("call-6", { role: "worker", name: "Test delegated task", task: tasks[5]! }, undefined, undefined, app.ctx);
			calls.push(fifth, sixth);
			abort.abort();
			await fifthAborted;
			assert.equal(workingWidgetHeaders(app.widget!.render(80)).length, 4);
			await runner.release(tasks[0]!);
			await waitFor(() => runner.started().includes(tasks[5]!));
			assert.deepEqual(runner.started(), [...tasks.slice(0, 4), tasks[5]!]);
			for (const task of tasks.slice(1)) await runner.release(task);
			await Promise.all([...active, sixth]);
		} finally {
			await Promise.all(tasks.map((task) => runner.release(task)));
			await Promise.allSettled(calls);
			await app.handlers.get("session_shutdown")?.({}, app.ctx);
		}
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	});
});

test("queued abort never creates an isolated worktree", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "1";
		try {
			await writeWorkerRole(agentDir, true);
			const started = join(agentDir, "isolated-child-started");
			const release = join(agentDir, "isolated-child-release");
			const runner = join(agentDir, "fake-pi.mjs");
			await writeFile(runner, `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "");
const timer = setInterval(() => {
	if (!existsSync(${JSON.stringify(release)})) return;
	clearInterval(timer);
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));
}, 5);
`);
			process.argv[1] = runner;
			const app = harness({ cwd: repo });
			const first = app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "first" }, undefined, undefined, app.ctx);
			await waitFor(() => existsSync(started));
			const controller = new AbortController();
			const queued = app.tool.execute("call-2", { role: "worker", name: "Test delegated task", task: "queued" }, controller.signal, undefined, app.ctx);
			controller.abort();
			await assert.rejects(queued, (error: unknown) => error instanceof Error && error.name === "AbortError");
			assert.equal(existsSync(join(repo, ".worktrees", childName("call-2"))), false);
			await writeFile(release, "");
			await first;
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	});
});

test("queued delegation does not consume its inactive-child timeout", async () => {
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "4";
		try {
			await writeWorkerRole(agentDir);
		const tasks = Array.from({ length: 5 }, (_, index) => `task-${index + 1}`);
		const timeoutPolicy = { idleMs: 250, maxMs: 1_250 };
		const runner = await blockedPiRunner(agentDir, tasks.slice(0, 4));
		const app = harness({ timeoutPolicy });
		const active = tasks.slice(0, 4).map((task, index) => app.tool.execute(
			`call-${index + 1}`,
			{ role: "worker", name: "Test delegated task", task },
			undefined,
			undefined,
			app.ctx,
		));
		const calls = [...active];
		try {
			await waitFor(() => runner.started().length === 4);
			assert.deepEqual(runner.started(), tasks.slice(0, 4));
			const queuedAt = Date.now();
			const fifth = app.tool.execute("call-5", { role: "worker", name: "Test delegated task", task: tasks[4]! }, undefined, undefined, app.ctx);
			calls.push(fifth);
			let fifthSettled = false;
			void fifth.then(() => { fifthSettled = true; }, () => { fifthSettled = true; });
			await waitFor(() => Date.now() >= queuedAt + timeoutPolicy.idleMs + 100);
			assert.deepEqual(runner.started(), tasks.slice(0, 4));
			assert.equal(fifthSettled, false);
			await runner.release(tasks[0]!);
			await waitFor(() => runner.started().includes(tasks[4]!));
			await assert.rejects(fifth, /Subagent timed out.*without a recognized Pi event/);
			for (const task of tasks.slice(1, 4)) await runner.release(task);
			await Promise.all(active);
		} finally {
			await Promise.all(tasks.map((task) => runner.release(task)));
			await Promise.allSettled(calls);
			await app.handlers.get("session_shutdown")?.({}, app.ctx);
		}
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	});
});

test("malformed JSON, unknown events, and stderr do not renew the idle deadline", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `process.on("SIGTERM", () => {});
setInterval(() => {
	process.stdout.write('{"type":"message_update"\\n');
	console.log(JSON.stringify({ type: "heartbeat" }));
	process.stderr.write("still here\\n");
}, 25);`);
		process.argv[1] = runner;
		const app = harness({ timeoutPolicy: { idleMs: 120, maxMs: 270 } });
		const startedAt = Date.now();
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx),
			/Subagent timed out.*without a recognized Pi event/,
		);
		assert.ok(Date.now() - startedAt < 600, "idle timeout escalation exceeded the maximum runtime");
	});
});

test("config file timeout applies when no explicit policy is passed", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const configDir = join(agentDir, "config", "pi-subagent");
		await writeFile(join(configDir, "config.json"), JSON.stringify({
			timeout: { idleMinutes: 0.002, maxMinutes: 0.004 },
		}));
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_start", message: { role: "user", content: [] } }));
setInterval(() => {}, 1_000);
`);
		process.argv[1] = runner;

		const app = harness();
		assert.equal(app.notifications.length, 0);
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx),
			/Subagent timed out.*without a recognized Pi event/,
		);
	});
});

test("recognized Pi events extend the idle deadline", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const event = (value) => console.log(JSON.stringify(value));
setTimeout(() => event({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} }), 200);
setTimeout(() => event({ type: "message_update", usage: { totalTokens: 1 } }), 600);
setTimeout(() => {
	event({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: {}, isError: false });
	event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } });
}, 1_000);
`);
		process.argv[1] = runner;
		const timeoutPolicy = { idleMs: 800, maxMs: 1_500 };
		const app = harness({ timeoutPolicy });
		const startedAt = Date.now();
		const result = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx);
		assert.equal(singleOutput(result), "done");
		assert.ok(Date.now() - startedAt > timeoutPolicy.idleMs, "completion did not outlast the original idle deadline");
	});
});

test("workflow transport retains executor rejection Usage when no child result exists", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const observedUsage = {
			input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_update", usage: ${JSON.stringify(observedUsage)} })); setInterval(() => {}, 1_000);`);
		process.argv[1] = runner;
		const app = harness({ timeoutPolicy: { idleMs: 500, maxMs: 800 } });
		const error = await app.tool.execute("usage-rejection", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx).then(
			() => assert.fail("expected workflow failure"),
			(reason) => reason,
		);
		assert.ok(error instanceof WorkflowFailureError);
		assert.deepEqual(error.usage, observedUsage);
		assert.equal(error.details.entries[0].status, "rejected");
	});
});

test("ordinary delegation turn-limit failure includes retained assistant output", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await writeFile(join(agentDir, "config", "pi-subagent", "config.json"), JSON.stringify({ maxTurns: 1 }));
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const event = (value) => console.log(JSON.stringify(value));
event({ type: "turn_start", turnIndex: 0 });
event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "retained failure evidence" }], stopReason: "toolUse" } });
event({ type: "turn_start", turnIndex: 1 });
setInterval(() => {}, 1_000);
`);
		process.argv[1] = runner;
		const app = harness();
		const error = await app.tool.execute("turn-limit", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx).then(
			() => assert.fail("expected workflow failure"),
			(reason) => reason,
		);
		assert.ok(error instanceof WorkflowFailureError);
		assert.match(error.message, /Subagent reached its maximum turn limit of 1\.[\s\S]*retained failure evidence/);
	});
});

test("maximum runtime stops a child that keeps emitting Pi events", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `process.on("SIGTERM", () => {});
console.log(JSON.stringify({ type: "message_update", usage: { totalTokens: 1 } }));
setInterval(() => console.log(JSON.stringify({ type: "message_update", usage: { totalTokens: 1 } })), 25);`);
		process.argv[1] = runner;
		const app = harness({ timeoutPolicy: { idleMs: 1_000, maxMs: 2_000 } });
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx),
			/Subagent reached its maximum runtime/,
		);
	});
});

test("parent abort remains an abort while timeout cleanup is underway", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Do bounded work.
`);
		const cleanupStarted = join(agentDir, "timeout-cleanup-started");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
	writeFileSync(${JSON.stringify(cleanupStarted)}, "");
	setTimeout(() => process.exit(0), 80);
});
setInterval(() => {}, 1_000);
`);
		process.argv[1] = runner;
		const app = harness({ ui: true, timeoutPolicy: { idleMs: 1_000, maxMs: 2_000 } });
		const abort = new AbortController();
		const running = app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, abort.signal, undefined, app.ctx);
		await waitFor(() => existsSync(cleanupStarted));
		abort.abort();
		await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === "AbortError");
		assert.ok(app.widget!.render(80)[0].startsWith("✗"));
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
	});
});

test("abort stops child process tree", async (t) => {
	if (process.platform === "win32") return t.skip("Unix process groups only");
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Do bounded work.
`);
		const marker = join(agentDir, "descendant-survived");
		const started = join(agentDir, "descendant-started");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(started)}, "started"); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 300); setInterval(() => {}, 1000)`)}], { stdio: "ignore" });
setInterval(() => {}, 1_000);
`);
		process.argv[1] = runner;
		const app = harness({ ui: true });
		const abort = new AbortController();
		const running = app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, abort.signal, undefined, app.ctx);
		await waitFor(() => existsSync(started));
		abort.abort();
		await assert.rejects(
			running,
			(error: unknown) => error instanceof Error && error.name === "AbortError" && !(error instanceof WorkflowFailureError),
		);
		assert.ok(app.widget!.render(80)[0].startsWith("■"));
		await new Promise((resolve) => setTimeout(resolve, 400));
		await assert.rejects(readFile(marker), /ENOENT/);
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
	});
});

test("normal completion stops surviving child process descendants with inherited output", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const marker = join(agentDir, "normal-descendant-survived");
		const started = join(agentDir, "normal-descendant-started");
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(started)}, "started"); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 300); setInterval(() => {}, 1000)`)}], { stdio: "inherit" });
descendant.unref();
const ready = setInterval(() => {
	if (!existsSync(${JSON.stringify(started)})) return;
	clearInterval(ready);
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }));
}, 5);
`);
		process.argv[1] = runner;
		const app = harness({ timeoutPolicy: { idleMs: 1_000, maxMs: 2_000 } });
		const result = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx);
		assert.equal(singleOutput(result), "done");
		await new Promise((resolve) => setTimeout(resolve, 400));
		await assert.rejects(readFile(marker), /ENOENT/);
	});
});

test("oversized unterminated stdout protocol line fails bounded", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1_000);\n`);
		process.argv[1] = runner;
		const app = harness();
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx),
			/Subagent JSON event exceeds/,
		);
	});
});

test("oversized stderr returns bounded tool error", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `process.stderr.write("e".repeat(60 * 1024)); process.exit(2);\n`);
		process.argv[1] = runner;
		const app = harness({ ui: true });
		const error = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work" }, undefined, undefined, app.ctx).then(
			() => assert.fail("expected workflow failure"),
			(reason) => reason,
		);
		assert.ok(error instanceof WorkflowFailureError);
		assertTruncated(singleEvidence(error.message, error.details, "failure"), capOutput("e".repeat(60 * 1024)));
		assert.ok(Buffer.byteLength(error.message, "utf8") <= 50 * 1024);
		assert.ok(app.widget!.render(80)[0].startsWith("✗"));
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
	});
});

test("background delegation returns one bounded workflow acknowledgement and result message", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }));`);
		process.argv[1] = runner;

		const app = harness();
		const result = await app.tool.execute(
			"call-1", { role: "worker", name: "Test delegated task", task: "work", background: true }, undefined, undefined, app.ctx,
		);
		assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 50 * 1024);
		assert.match(result.content[0].text, /Background workflow bg-\d+-[a-z0-9]+ accepted/);
		assert.deepEqual(result.details.entries, [{ id: "call-1:single:0", index: 0, role: "worker" }]);
		await waitFor(() => app.sentMessages.length === 1);
		const { message, options } = app.sentMessages[0]!;
		assert.equal(message.customType, "subagent-background-result");
		assert.equal(message.details.taskId, result.details.taskId);
		assert.equal(message.details.outcome, "completed");
		assert.match(message.content, /Background workflow succeeded/);
		assert.match(message.content, /done/);
		assert.equal(options.triggerTurn, false);
	});
});

test("active background delivery failure issues one bounded UI error", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }));`);
		process.argv[1] = runner;
		const app = harness({ ui: true, sendMessageError: new Error("delivery ".repeat(10_000)) });
		app.handlers.get("session_start")?.({}, app.ctx);
		const acknowledgement = await app.tool.execute(
			"delivery-failure", { role: "worker", name: "Test delegated task", task: "work", background: true }, undefined, undefined, app.ctx,
		);
		await waitFor(() => app.notifications.some(({ type }) => type === "error"));
		const errors = app.notifications.filter(({ type }) => type === "error");
		assert.equal(errors.length, 1);
		assert.match(errors[0]!.message, new RegExp(acknowledgement.details.taskId));
		assert.ok(Buffer.byteLength(errors[0]!.message, "utf8") <= 50 * 1024);
		assert.match(errors[0]!.message, /\[Output truncated: \d+ bytes omitted\]$/);
		assert.deepEqual(app.sentMessages, []);
	});
});

test("background worktree report survives capped child output", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(60 * 1024) }], stopReason: "end" } }));`);
		process.argv[1] = runner;

		const app = harness({ cwd: repo });
		await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work", background: true }, undefined, undefined, app.ctx);
		await waitFor(() => app.sentMessages.length === 1);
		const message = app.sentMessages[0]!.message;
		assert.match(message.content, /\[Output truncated: \d+ bytes omitted\]$/);
		const name = childName("call-1:single:0");
		assert.deepEqual(message.details.entries[0].worktree, {
			path: join(await realpath(repo), ".worktrees", name),
			branch: `pi-subagent/${name}`,
			commits: 0,
			dirty: false,
			pruned: true,
		});
	});
});

test("session shutdown promptly reports preserved isolated setup failures", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const hook = join(repo, ".git", "hooks", "post-checkout");
		const hookStarted = join(agentDir, "post-checkout-started");
		await writeFile(hook, `#!/bin/sh\n: > ${JSON.stringify(hookStarted)}\nsleep 5\nexit 1\n`);
		await chmod(hook, 0o755);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, "throw new Error('runner must not start');\n");
		process.argv[1] = runner;

		const app = harness({ cwd: repo });
		const started = await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "work", background: true }, undefined, undefined, app.ctx);
		const name = childName("call-1:single:0");
		const path = join(await realpath(repo), ".worktrees", name);
		const branch = `pi-subagent/${name}`;
		await waitFor(() => existsSync(hookStarted), 10_000);
		const shutdownAt = Date.now();
		await app.handlers.get("session_shutdown")?.({ reason: "reload" }, { hasUI: false });

		assert.ok(Date.now() - shutdownAt < 2_000);
		assert.equal(app.sentMessages.length, 1);
		const { message, options } = app.sentMessages[0]!;
		assert.equal(message.details.taskId, started.details.taskId);
		assert.equal(message.details.recovery, true);
		assert.equal(options.triggerTurn, false);
		assert.match(message.content, /left recoverable isolated work/);
		assert.ok(message.content.indexOf("Recovery locations:") < message.content.indexOf("Evidence:"));
		assert.equal(message.content.includes(path), true);
		assert.equal(message.content.includes(branch), true);
		assert.notEqual(execFileSync("git", ["branch", "--list", branch], { cwd: repo, encoding: "utf8" }).trim(), "");
	});
});

test("multi-child shutdown sends at most one recovery-only background message", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs";
const task = process.argv.at(-1).replace(/^Task: /, "").split("\\n\\n[WORKTREE ISOLATION]", 1)[0];
const event = (value) => console.log(JSON.stringify(value));
writeFileSync(task + ".txt", "recover me");
event({ type: "message_start", message: { role: "assistant", content: [] } });
event({ type: "message_update", usage: { totalTokens: 1 }, assistantMessageEvent: { type: "text_delta", delta: "DO NOT REPLAY " + task } });
setInterval(() => {}, 1_000);
`);
		process.argv[1] = runner;

		const app = harness({ cwd: repo, timeoutPolicy: { idleMs: 60_000, maxMs: 120_000 } });
		const tasks = ["one", "two", "three"];
		const started = await app.tool.execute("shutdown", {
			tasks: tasks.map((task) => ({ role: "worker", name: "Test delegated task", task })),
			background: true,
		}, undefined, undefined, app.ctx);
		const root = await realpath(repo);
		const names = tasks.map((_, index) => childName(`shutdown:parallel:${index}`));
		const paths = names.map((name) => join(root, ".worktrees", name));
		await waitFor(() => paths.every((path, index) => existsSync(join(path, `${tasks[index]}.txt`))));

		await app.handlers.get("session_shutdown")?.({ reason: "reload" }, { hasUI: false });
		await new Promise((resolve) => setTimeout(resolve, 100));

		assert.equal(app.sentMessages.length, 1);
		const { message, options } = app.sentMessages[0]!;
		assert.equal(message.customType, "subagent-background-result");
		assert.equal(message.details.taskId, started.details.taskId);
		assert.equal(message.details.outcome, "aborted");
		assert.equal(message.details.recovery, true);
		assert.deepEqual(message.details.entries.map(({ status }: any) => status), tasks.map(() => "rejected"));
		assert.equal(options.triggerTurn, false);
		assert.ok(Buffer.byteLength(message.content, "utf8") <= 50 * 1024);
		assert.ok(message.content.indexOf("Recovery locations:") < message.content.indexOf("Evidence:"));
		for (const [index, path] of paths.entries()) {
			assert.match(message.content, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.equal(message.details.entries[index].worktree.path, path);
			assert.equal(message.details.entries[index].worktree.pruned, false);
		}
		assert.doesNotMatch(message.content, /DO NOT REPLAY|Subagent was aborted/);
	});
});

test("session shutdown aborts a running background subagent and suppresses delivery", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const event = (value) => console.log(JSON.stringify(value));
event({ type: "message_start", message: { role: "assistant", content: [] } });
setInterval(() => event({ type: "message_update", usage: { totalTokens: 1 } }), 25);
`);
		process.argv[1] = runner;

		const app = harness({ timeoutPolicy: { idleMs: 60_000, maxMs: 120_000 } });
		const result = await app.tool.execute(
			"call-1", { role: "worker", name: "Test delegated task", task: "long work", background: true }, undefined, undefined, app.ctx,
		);
		assert.match(result.content[0]!.text, /accepted/);
		await app.handlers.get("session_shutdown")?.({}, { hasUI: false });
		// The aborted child settles after shutdown; its outcome must not leak into
		// a subsequent session.
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(app.sentMessages.length, 0);
	});
});

test("background tasks deliver again after a new session starts", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }));`);
		process.argv[1] = runner;

		const app = harness();
		// First session: launch, shut down (task aborts, epoch advances).
		await app.tool.execute("call-1", { role: "worker", name: "Test delegated task", task: "old", background: true }, undefined, undefined, app.ctx);
		await app.handlers.get("session_shutdown")?.({}, { hasUI: false });
		app.handlers.get("session_start")?.({}, app.ctx);
		// Second session: a fresh task must deliver normally.
		const result = await app.tool.execute("call-2", { role: "worker", name: "Test delegated task", task: "new", background: true }, undefined, undefined, app.ctx);
		assert.match(result.content[0]!.text, /accepted/);
		await waitFor(() => app.sentMessages.length === 1);
		assert.match(app.sentMessages[0]!.message.content, /succeeded/);
	});
});

test("oversized PI_SUBAGENT_MAX_SUBAGENTS failures are bounded", () => {
	for (const value of ["x".repeat(60 * 1024), "9".repeat(309)]) {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = value;
		try {
			assert.throws(() => harness(), (error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(Buffer.byteLength(error.message, "utf8") <= 50 * 1024);
				return /positive integer|exceeds the supported range/.test(error.message);
			});
		} finally {
			delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
		}
	}
});

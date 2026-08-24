import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ROLE_TOOL_POLICY_FLAG } from "../extensions/role-tools.ts";
import subagentExtension, { capOutput } from "../extensions/subagent.ts";
import { loadRoles } from "../src/index.ts";

type Tool = { description: string; execute: (...args: any[]) => Promise<any> };

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
	const previousScript = process.argv[1];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
		profiles: {
			balanced: { primary: { model: "test/text-model", thinkingLevel: "low" } },
		},
	}));
	try {
		await run(agentDir);
	} finally {
		process.argv[1] = previousScript;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		registerTool(candidate: Tool) { tool = candidate; },
		sendMessage(message: any, options: any) { sentMessages.push({ message, options }); },
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

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test state.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function writeWorkerRole(agentDir: string, isolation = false): Promise<void> {
	await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
${isolation ? "isolation: worktree\n" : ""}---
Do bounded work.
`);
}

const childName = (id: string): string => `subagent-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;

async function initializedRepository(t: import("node:test").TestContext): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), "pi-subagent-repo-"));
	t.after(async () => { await rm(repo, { recursive: true, force: true }); });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	await mkdir(join(repo, "packages", "worker"), { recursive: true });
	await Promise.all([
		writeFile(join(repo, "README.md"), "test\n"),
		writeFile(join(repo, "packages", "worker", "package.json"), "{}\n"),
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

test("role config rejects repository-relative extension sources", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "unsafe.md"), `---
name: unsafe
description: Loads repository code
extensions: [./extensions/review.ts]
tools: []
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
tools: read, grep
extensions:
  - /user/extensions/review.ts
skills:
  - security
  - unavailable-skill
---
Review only requested change.
`);
		await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
			profiles: { frontier: { primary: { model: "test/text-model", thinkingLevel: "high" } } },
		}));
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);
const prompt = args[args.indexOf("--append-system-prompt") + 1];
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ args, prompt, cwd: process.cwd() }) }], stopReason: "end" } }));
`);
		process.argv[1] = runner;

		assert.deepEqual(loadRoles(agentDir).map(({ name }) => name), ["reviewer"]);
		const app = harness({
			skills: [{ name: "security", path: "/effective/skills/security/SKILL.md" }],
			trusted: false,
		});
		assert.match(app.tool.description, /reviewer: Reviews focused changes/);
		const updates: any[] = [];
		const result = await app.tool.execute(
			"call-1",
			{ role: "reviewer", task: "inspect auth", modelClass: "frontier" },
			undefined,
			(update: any) => updates.push(update),
			app.ctx,
		);
		const child = JSON.parse(result.content[0].text);
		assert.equal(child.cwd, await realpath("/tmp"));
		assert.equal(child.prompt, "Review only requested change.");
		const extensionArgs = child.args.filter((value: string, index: number) => child.args[index - 1] === "--extension");
		const policyExtension = extensionArgs.at(-1)!;
		assert.match(policyExtension, /pi-subagent\/extensions\/role-tools\.ts$/);
		assert.deepEqual(child.args, [
			"--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills",
			"--exclude-tools", "delegate_task,ask_question,auto_dag_execute",
			"--extension", "/user/extensions/review.ts",
			"--extension", policyExtension,
			"--skill", "/effective/skills/security/SKILL.md",
			`--${ROLE_TOOL_POLICY_FLAG}`, JSON.stringify(["read", "grep"]),
			"--model", "test/text-model",
			"--thinking", "high",
			"--no-approve",
			"--append-system-prompt", "Review only requested change.",
			"Task: inspect auth",
		]);
		assert.equal(updates.length, 1);
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

		const app = harness({ cwd: join(repo, "packages", "worker") });
		const result = await app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx);
		const [childLine, payloadLine] = result.content[0].text.split("\n");
		const name = childName("call-1");
		const worktreeRoot = join(await realpath(repo), ".worktrees", name);
		assert.equal(JSON.parse(childLine!).cwd, join(worktreeRoot, "packages", "worker"));
		assert.deepEqual(JSON.parse(payloadLine!), {
			path: worktreeRoot,
			branch: `pi-subagent/${name}`,
			commits: 0,
			dirty: false,
			pruned: true,
		});
	});
});

test("role without tools leaves Pi tool policy unoverridden", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Uses Pi default tools
extensions:
  - /user/extensions/company-tools.ts
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));
`);
		process.argv[1] = runner;
		const app = harness();
		const result = await app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx);
		const args = JSON.parse(result.content[0].text);
		assert.equal(args.includes("--tools"), false);
		assert.equal(args.includes("--no-tools"), false);
		assert.equal(args.includes(`--${ROLE_TOOL_POLICY_FLAG}`), false);
		assert.equal(args[args.indexOf("--extension") + 1], "/user/extensions/company-tools.ts");
		assert.equal(args.filter((value: string, index: number) => args[index - 1] === "--extension").some((path: string) => path.endsWith("/pi-subagent/extensions/role-tools.ts")), false);
	});
});

test("empty role tools leave only loaded extension tools", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "thinker.md"), `---
name: thinker
description: Reasons without tools
tools: []
---
Return a plan.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));
`);
		process.argv[1] = runner;
		const app = harness();
		const result = await app.tool.execute("call-1", { role: "thinker", task: "plan" }, undefined, undefined, app.ctx);
		const args = JSON.parse(result.content[0].text);
		assert.equal(args.includes("--tools"), false);
		assert.equal(args.includes("--no-tools"), false);
		assert.equal(args[args.indexOf(`--${ROLE_TOOL_POLICY_FLAG}`) + 1], "[]");
		assert.equal(args[args.indexOf("--exclude-tools") + 1], "delegate_task,ask_question,auto_dag_execute");
	});
});

test("shared profiles route explicit and omitted model classes without a subagent command", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
---
Return concise findings.
`);
		const legacyConfig = JSON.stringify({ models: { frontier: { model: "legacy/model", thinkingLevel: "high" } } });
		await writeFile(join(agentDir, "config", "pi-subagent", "pi-subagent.json"), legacyConfig);
		const availableModels = [
			{ provider: "provider", id: "fast-model", input: ["text"], reasoning: false },
			{ provider: "provider", id: "balanced-model", input: ["text"], reasoning: true, thinkingLevelMap: { medium: "medium" } },
			{ provider: "provider", id: "frontier-model", input: ["text"], reasoning: true, thinkingLevelMap: { max: "max" } },
			{ provider: "provider", id: "fav-model", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" } },
		];
		await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
			profiles: {
				fast: { primary: { model: "provider/fast-model", thinkingLevel: "off" } },
				balanced: { primary: { model: "provider/balanced-model", thinkingLevel: "medium" } },
				frontier: { primary: { model: "provider/frontier-model", thinkingLevel: "max" } },
				fav: { primary: { model: "provider/fav-model", thinkingLevel: "high" } },
			},
			tasks: { "pi-subagent/delegateTask": "fast" },
		}));
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels });
		assert.equal(app.commands.has("subagent"), false);

		const explicit = await app.tool.execute("call-1", { role: "worker", task: "inspect code", modelClass: "frontier" }, undefined, undefined, app.ctx);
		const explicitArgs = JSON.parse(explicit.content[0].text);
		assert.equal(explicitArgs[explicitArgs.indexOf("--model") + 1], "provider/frontier-model");
		assert.equal(explicitArgs[explicitArgs.indexOf("--thinking") + 1], "max");

		const favorite = await app.tool.execute("call-fav", { role: "worker", task: "inspect code", modelClass: "fav" }, undefined, undefined, app.ctx);
		const favoriteArgs = JSON.parse(favorite.content[0].text);
		assert.equal(favoriteArgs[favoriteArgs.indexOf("--model") + 1], "provider/fav-model");
		assert.equal(favoriteArgs[favoriteArgs.indexOf("--thinking") + 1], "high");

		const omitted = await app.tool.execute("call-2", { role: "worker", task: "inspect code" }, undefined, undefined, app.ctx);
		const omittedArgs = JSON.parse(omitted.content[0].text);
		assert.equal(omittedArgs[omittedArgs.indexOf("--model") + 1], "provider/fast-model");
		assert.equal(omittedArgs[omittedArgs.indexOf("--thinking") + 1], "off");
		assert.equal(await readFile(join(agentDir, "config", "pi-subagent", "pi-subagent.json"), "utf8"), legacyConfig);
	});
});

test("designated model overrides class routing and unknown reference lists available models", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
---
Return concise findings.
`);
		const availableModels = [
			{ provider: "provider", id: "alpha", input: ["text"], reasoning: true, thinkingLevelMap: { medium: "medium" } },
			{ provider: "provider", id: "beta", input: ["text"], reasoning: false },
		];
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels });

		const result = await app.tool.execute("call-1", { role: "worker", task: "inspect code", model: "provider/beta" }, undefined, undefined, app.ctx);
		const args = JSON.parse(result.content[0].text) as string[];
		assert.equal(args[args.indexOf("--model") + 1], "provider/beta");
		assert.equal(args[args.indexOf("--thinking") + 1], "off");

		await assert.rejects(
			app.tool.execute("call-2", { role: "worker", task: "inspect code", model: "provider/gamma" }, undefined, undefined, app.ctx),
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
---
Return concise findings.
`);
		await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
			profiles: { frontier: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "high" } } },
		}));
		const canonical = { ...model, provider: "openai-codex", id: "gpt-test" };
		const alias = { ...canonical, provider: "openai-codex-2" };
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels: [canonical, alias], currentModel: alias });
		const result = await app.tool.execute("call-1", { role: "worker", task: "inspect", modelClass: "frontier" }, undefined, undefined, app.ctx);
		const args = JSON.parse(result.content[0].text) as string[];
		assert.equal(args[args.indexOf("--model") + 1], "openai-codex-2/gpt-test");
		const extensions = args.flatMap((value, index) => value === "--extension" ? [args[index + 1]] : []);
		assert.ok(extensions.some((path) => path.endsWith("/pi-multi-codex/extensions/multi-codex.ts")));
	});
});

test("thinking override participates in route resolution across all paths", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
			profiles: { balanced: {
				primary: { model: "provider/a-model", thinkingLevel: "off" },
				fallback: { model: "provider/b-model", thinkingLevel: "high" },
			} },
			tasks: { "pi-subagent/delegateTask": "balanced" },
		}));
		const availableModels = [
			{ provider: "provider", id: "a-model", input: ["text"], reasoning: false },
			{ provider: "provider", id: "b-model", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" } },
		];
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels });

		// Omitted thinking keeps the primary route.
		const primary = await app.tool.execute("call-1", { role: "worker", task: "inspect code" }, undefined, undefined, app.ctx);
		const primaryArgs = JSON.parse(primary.content[0].text) as string[];
		assert.equal(primaryArgs[primaryArgs.indexOf("--model") + 1], "provider/a-model");
		assert.equal(primaryArgs[primaryArgs.indexOf("--thinking") + 1], "off");

		// Explicit override skips the incompatible primary and uses the fallback.
		const override = await app.tool.execute("call-2", { role: "worker", task: "inspect code", thinking: "high" }, undefined, undefined, app.ctx);
		const overrideArgs = JSON.parse(override.content[0].text) as string[];
		assert.equal(overrideArgs[overrideArgs.indexOf("--model") + 1], "provider/b-model");
		assert.equal(overrideArgs[overrideArgs.indexOf("--thinking") + 1], "high");

		// No route supports the requested level.
		await assert.rejects(
			app.tool.execute("call-3", { role: "worker", task: "inspect code", thinking: "max" }, undefined, undefined, app.ctx),
			/supporting thinking max/,
		);

		// Explicit class path honors the override too.
		const byClass = await app.tool.execute("call-5", { role: "worker", task: "work", modelClass: "balanced", thinking: "high" }, undefined, undefined, app.ctx);
		const byClassArgs = JSON.parse(byClass.content[0].text) as string[];
		assert.equal(byClassArgs[byClassArgs.indexOf("--model") + 1], "provider/b-model");
		assert.equal(byClassArgs[byClassArgs.indexOf("--thinking") + 1], "high");

		// Designated model path honors the override.
		const designated = await app.tool.execute("call-6", { role: "worker", task: "work", model: "provider/b-model", thinking: "high" }, undefined, undefined, app.ctx);
		const designatedArgs = JSON.parse(designated.content[0].text) as string[];
		assert.equal(designatedArgs[designatedArgs.indexOf("--thinking") + 1], "high");

		// Background delegation propagates the override to the child args.
		const background = await app.tool.execute(
			"call-4", { role: "worker", task: "work", thinking: "high", background: true }, undefined, undefined, app.ctx,
		);
		assert.match(background.content[0]!.text, /started \(worker/);
		await waitFor(() => app.sentMessages.length === 1);
		const backgroundArgs = JSON.parse(app.sentMessages[0]!.message.content.split("\n").at(-1)) as string[];
		assert.equal(backgroundArgs[backgroundArgs.indexOf("--thinking") + 1], "high");
	});
});

test("designated model with unusable scoped thinking pin rejects before launch", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const pinned = { ...model, provider: "p", id: "pinned", reasoning: true, thinkingLevelMap: { high: "high" } };
		const app = harness({ availableModels: [pinned], scopedModels: [{ model: pinned, thinkingLevel: "xhigh" }] });

		// The scoped pin allows no supported level; launching without --thinking must not bypass it.
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", task: "inspect code", model: "p/pinned" }, undefined, undefined, app.ctx),
			/no usable thinking level/,
		);

		await assert.rejects(
			app.tool.execute("call-2", { role: "worker", task: "inspect code", model: "p/pinned", thinking: "low" }, undefined, undefined, app.ctx),
			/not usable for p\/pinned in this session/,
		);
	});
});

test("explicit unconfigured model class rejects with task-models guidance before child start", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
---
Return concise findings.
`);
		const app = harness();
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", task: "inspect code", modelClass: "frontier" }, undefined, undefined, app.ctx),
			/Run \/task-models/,
		);
	});
});

test("uses a profile fallback when the primary thinking level is unavailable before launch", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
---
Return concise findings.
`);
		await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
			profiles: {
				balanced: {
					primary: { model: "provider/primary", thinkingLevel: "high" },
					fallback: { model: "provider/fallback", thinkingLevel: "low" },
				},
			},
		}));
		const primary = { provider: "provider", id: "primary", input: ["text"], reasoning: false };
		const fallback = { provider: "provider", id: "fallback", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low" } };
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const args = process.argv.slice(2);\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(args) }], stopReason: "end" } }));\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels: [primary, fallback] });
		const result = await app.tool.execute("call-1", { role: "worker", task: "inspect" }, undefined, undefined, app.ctx);
		const args = JSON.parse(result.content[0].text);
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
---
Return concise findings.
`);
		const marker = join(agentDir, "child-launches");
		await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
			profiles: {
				balanced: {
					primary: { model: "provider/primary", thinkingLevel: "off" },
					fallback: { model: "provider/fallback", thinkingLevel: "off" },
				},
			},
		}));
		const primary = { provider: "provider", id: "primary", input: ["text"], reasoning: false };
		const fallback = { provider: "provider", id: "fallback", input: ["text"], reasoning: false };
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "1");\nprocess.exit(2);\n`);
		process.argv[1] = runner;
		const app = harness({ availableModels: [primary, fallback] });
		const result = await app.tool.execute("call-1", { role: "worker", task: "inspect" }, undefined, undefined, app.ctx);
		assert.equal(result.isError, true);
		assert.equal(await readFile(marker, "utf8"), "1");
	});
});

test("widget aligns live rows, sums tokens, shows success, and auto-removes", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		for (const [name, description] of [["scout", "Finds code"], ["reviewer", "Reviews code"]]) {
			await writeFile(join(agentDir, "config", "pi-subagent", `${name}.md`), `---
name: ${name}
description: ${description}
tools: [read]
---
Return concise findings.
`);
		}
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `
const event = (value) => console.log(JSON.stringify(value));
event({ type: "message_update", usage: { totalTokens: 400 } });
event({ type: "message_end", message: { role: "assistant", content: [], usage: { totalTokens: 500 }, stopReason: "toolUse" } });
event({ type: "message_update", usage: { totalTokens: 600 } });
setTimeout(() => event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { totalTokens: 700 }, stopReason: "end" } }), 120);
`);
		process.argv[1] = runner;
		const app = harness({ ui: true });
		const tasks = [
			app.tool.execute("call-1", { role: "scout", task: "find auth flow" }, undefined, undefined, app.ctx),
			app.tool.execute("call-2", { role: "reviewer", task: "inspect authentication changes" }, undefined, undefined, app.ctx),
		];
		await waitFor(() => (app.widget?.render(100).filter((line) => line.includes("1.1k")).length ?? 0) === 2);
		const working = app.widget!.render(100);
		assert.equal(working.length, 2);
		assert.ok(working.every((line) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)));
		assert.ok(working.every((line) => visibleWidth(line) === 100));
		assert.equal(working[0].indexOf("1.1k"), working[1].indexOf("1.1k"));
		const narrow = app.widget!.render(25);
		assert.ok(narrow.every((line) => visibleWidth(line) === 25 && line.includes("1.1k")));
		assert.ok(app.renders > 0);

		await Promise.all(tasks);
		const finished = app.widget!.render(100);
		assert.ok(finished.every((line) => line.startsWith("✓")));
		assert.ok(finished.every((line) => line.includes("1.2k")));
		await waitFor(() => app.widget!.render(100).length === 0);
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
	});
});

test("streams assistant text deltas before final message", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "scout.md"), `---
name: scout
description: Finds relevant code
tools: [read]
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
		const running = app.tool.execute("call-1", { role: "scout", task: "find auth" }, undefined, (update: any) => updates.push(update), app.ctx);
		await waitFor(() => updates.length === 1);
		assert.equal(updates[0].content[0].text, "partial 🙂");
		const result = await running;
		assert.equal(result.content[0].text, "partial 🙂 done");
		assert.equal(updates.at(-1).content[0].text, "partial 🙂 done");
	});
});

test("decodes JSON output across UTF-8 chunk boundaries", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "scout.md"), `---
name: scout
description: Finds relevant code
tools: [read]
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
		const result = await app.tool.execute("call-1", { role: "scout", task: "find auth" }, undefined, undefined, app.ctx);
		assert.equal(result.content[0].text, "ok 🙂");
	});
});

test("large child output bounds final result and streaming update", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "scout.md"), `---
name: scout
description: Finds relevant code
tools: [read]
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
		const result = await app.tool.execute("call-1", { role: "scout", task: "find auth" }, undefined, (update: any) => updates.push(update), app.ctx);
		const original = "a".repeat(60 * 1024);
		assertTruncated(result.content[0].text, original);
		assert.equal(updates.length, 1);
		assert.equal(updates[0].content[0].text, result.content[0].text);
	});
});

test("ignores oversized lifecycle events after final message", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "scout.md"), `---
name: scout
description: Finds relevant code
tools: [read]
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
		const result = await app.tool.execute("call-1", { role: "scout", task: "find auth" }, undefined, undefined, app.ctx);
		assert.equal(result.content[0].text, "done");
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
---
Do work.
`);
		const app = harness();
		assert.match(app.tool.description, /configuration error/);
		await assert.rejects(
			app.tool.execute("call-1", { role: "broken", task: "work" }, undefined, undefined, app.ctx),
			/tools/,
		);
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
			{ role: "worker", task },
			undefined,
			undefined,
			app.ctx,
		));
		try {
			await waitFor(() => (app.widget?.render(80).length ?? 0) >= 4);
			assert.equal(app.widget!.render(80).length, 4);
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

test("PI_SUBAGENT_MAX_SUBAGENTS overrides the default child cap", async () => {
	await environment(async (agentDir) => {
		process.env.PI_SUBAGENT_MAX_SUBAGENTS = "1";
		try {
			await writeWorkerRole(agentDir);
			const tasks = ["task-1", "task-2"];
			const runner = await blockedPiRunner(agentDir);
			const app = harness({ ui: true });
			const calls = tasks.map((task, index) => app.tool.execute(
				`call-${index + 1}`, { role: "worker", task }, undefined, undefined, app.ctx,
			));
			try {
				await waitFor(() => runner.started().length === 1);
				assert.deepEqual(runner.started(), ["task-1"]);
				assert.equal(app.widget!.render(80).length, 1);
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
				const first = await app.tool.execute("call-1", { role: "worker", task: "task-1", background: true }, undefined, undefined, app.ctx);
				assert.match(first.content[0]!.text, /started/);
				const second = await app.tool.execute("call-2", { role: "worker", task: "task-2", background: true }, undefined, undefined, app.ctx);
				assert.match(second.content[0]!.text, /started/);
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
		await app.tool.execute("call-1", { role: "worker", task: "work", background: true }, undefined, undefined, app.ctx);
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
		await writeFile(join(configDir, "pi-subagent.json"), JSON.stringify({ maxSubagents: 1 }));

		const configured = harness({ ui: true });
		configured.handlers.get("session_start")?.({}, configured.ctx);
		assert.deepEqual(configured.notifications, []);

		const tasks = ["task-1", "task-2"];
		const runner = await blockedPiRunner(agentDir);
		const app = harness({ ui: true });
		const calls = tasks.map((task, index) => app.tool.execute(
			`call-${index + 1}`, { role: "worker", task }, undefined, undefined, app.ctx,
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
		await writeFile(join(configDir, "pi-subagent.json"), "{ broken");
		const warned = harness({ ui: true });
		warned.handlers.get("session_start")?.({}, warned.ctx);
		assert.equal(warned.notifications.length, 1);
		assert.match(warned.notifications[0]!.message, /not valid JSON/);
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
			{ role: "worker", task },
			undefined,
			undefined,
			app.ctx,
		));
		const calls = [...active];
		try {
			await waitFor(() => runner.started().length === 4);
			assert.deepEqual(runner.started(), tasks.slice(0, 4));
			const abort = new AbortController();
			const fifth = app.tool.execute("call-5", { role: "worker", task: tasks[4]! }, abort.signal, undefined, app.ctx);
			const fifthAborted = assert.rejects(fifth, /Subagent was aborted/);
			const sixth = app.tool.execute("call-6", { role: "worker", task: tasks[5]! }, undefined, undefined, app.ctx);
			calls.push(fifth, sixth);
			abort.abort();
			await fifthAborted;
			assert.equal(app.widget!.render(80).length, 4);
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
			{ role: "worker", task },
			undefined,
			undefined,
			app.ctx,
		));
		const calls = [...active];
		try {
			await waitFor(() => runner.started().length === 4);
			assert.deepEqual(runner.started(), tasks.slice(0, 4));
			const queuedAt = Date.now();
			const fifth = app.tool.execute("call-5", { role: "worker", task: tasks[4]! }, undefined, undefined, app.ctx);
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
			app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx),
			/Subagent timed out.*without a recognized Pi event/,
		);
		assert.ok(Date.now() - startedAt < 600, "idle timeout escalation exceeded the maximum runtime");
	});
});

test("config file timeout applies when no explicit policy is passed", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const configDir = join(agentDir, "config", "pi-subagent");
		await writeFile(join(configDir, "pi-subagent.json"), JSON.stringify({
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
			app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx),
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
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `const event = (value) => console.log(JSON.stringify(value));
setTimeout(() => event({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} }), 80);
setTimeout(() => {
	event({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: {}, isError: false });
	event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } });
}, 180);
`);
		process.argv[1] = runner;
		const app = harness({ timeoutPolicy: { idleMs: 120, maxMs: 270 } });
		const result = await app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx);
		assert.equal(result.content[0].text, "done");
	});
});

test("maximum runtime stops a child that keeps emitting Pi events", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `process.on("SIGTERM", () => {});
setInterval(() => console.log(JSON.stringify({ type: "message_update", usage: { totalTokens: 1 } })), 25);`);
		process.argv[1] = runner;
		const app = harness({ timeoutPolicy: { idleMs: 80, maxMs: 180 } });
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx),
			/Subagent reached its maximum runtime/,
		);
	});
});

test("timeout remains failure when user abort follows deadline", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 80));
setInterval(() => {}, 1_000);
`);
		process.argv[1] = runner;
		const app = harness({ ui: true, timeoutPolicy: { idleMs: 120, maxMs: 270 } });
		const abort = new AbortController();
		const running = app.tool.execute("call-1", { role: "worker", task: "work" }, abort.signal, undefined, app.ctx);
		setTimeout(() => abort.abort(), 150);
		await assert.rejects(running, /Subagent timed out/);
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
		const running = app.tool.execute("call-1", { role: "worker", task: "work" }, abort.signal, undefined, app.ctx);
		await waitFor(() => existsSync(started));
		abort.abort();
		await assert.rejects(
			running,
			/Subagent was aborted/,
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
		const app = harness({ timeoutPolicy: { idleMs: 120, maxMs: 270 } });
		const result = await app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx);
		assert.equal(result.content[0].text, "done");
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
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1_000);\n`);
		process.argv[1] = runner;
		const app = harness();
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx),
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
---
Do bounded work.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `process.stderr.write("e".repeat(60 * 1024)); process.exit(2);\n`);
		process.argv[1] = runner;
		const app = harness({ ui: true });
		const result = await app.tool.execute("call-1", { role: "worker", task: "work" }, undefined, undefined, app.ctx);
		assert.equal(result.isError, true);
		assertTruncated(result.content[0].text, "e".repeat(60 * 1024));
		assert.ok(app.widget!.render(80)[0].startsWith("✗"));
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
	});
});

test("background delegation returns immediately and reports the outcome as a message", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }));`);
		process.argv[1] = runner;

		const app = harness();
		const result = await app.tool.execute(
			"call-1", { role: "worker", task: "work", background: true }, undefined, undefined, app.ctx,
		);
		assert.match(result.content[0]!.text, /bg-\d+-[a-z0-9]+ started \(worker/);
		await waitFor(() => app.sentMessages.length === 1);
		const { message, options } = app.sentMessages[0]!;
		assert.equal(message.customType, "subagent-background-result");
		assert.match(message.content, /completed/);
		assert.match(message.content, /done/);
		assert.equal(options.triggerTurn, false);
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
		await app.tool.execute("call-1", { role: "worker", task: "work", background: true }, undefined, undefined, app.ctx);
		await waitFor(() => app.sentMessages.length === 1);
		const content = app.sentMessages[0]!.message.content as string;
		assert.match(content, /\[Output truncated: \d+ bytes omitted\]/);
		const name = childName("call-1");
		assert.deepEqual(JSON.parse(content.trim().split("\n").at(-1)!), {
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
		await writeFile(hook, "#!/bin/sh\nsleep 5\nexit 1\n");
		await chmod(hook, 0o755);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, "throw new Error('runner must not start');\n");
		process.argv[1] = runner;

		const app = harness({ cwd: repo });
		const started = await app.tool.execute("call-1", { role: "worker", task: "work", background: true }, undefined, undefined, app.ctx);
		const name = childName("call-1");
		const path = join(await realpath(repo), ".worktrees", name);
		const branch = `pi-subagent/${name}`;
		await waitFor(() => existsSync(path));
		const shutdownAt = Date.now();
		await app.handlers.get("session_shutdown")?.({ reason: "reload" }, { hasUI: false });

		assert.ok(Date.now() - shutdownAt < 2_000);
		assert.equal(app.sentMessages.length, 1);
		const { message, options } = app.sentMessages[0]!;
		assert.equal(message.details.taskId, started.details.taskId);
		assert.equal(message.details.recovery, true);
		assert.equal(options.triggerTurn, false);
		assert.match(message.content, /left recoverable isolated setup state/);
		assert.equal(message.content.includes(path), true);
		assert.equal(message.content.includes(branch), true);
		assert.equal(existsSync(path), true);
	});
});

test("session shutdown reports dirty isolated work without stale child output", async (t) => {
	const repo = await initializedRepository(t);
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir, true);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { writeFileSync } from "node:fs";
const event = (value) => console.log(JSON.stringify(value));
writeFileSync("dirty.txt", "recover me");
event({ type: "message_start", message: { role: "assistant", content: [] } });
event({ type: "message_update", usage: { totalTokens: 1 }, assistantMessageEvent: { type: "text_delta", delta: "DO NOT REPLAY" } });
setInterval(() => {}, 1_000);
`);
		process.argv[1] = runner;

		const app = harness({ cwd: repo, timeoutPolicy: { idleMs: 60_000, maxMs: 120_000 } });
		const started = await app.tool.execute("call-1", { role: "worker", task: "work", background: true }, undefined, undefined, app.ctx);
		const name = childName("call-1");
		const root = join(await realpath(repo), ".worktrees", name);
		await waitFor(() => existsSync(join(root, "dirty.txt")));

		await app.handlers.get("session_shutdown")?.({ reason: "reload" }, { hasUI: false });

		assert.equal(app.sentMessages.length, 1);
		const { message, options } = app.sentMessages[0]!;
		assert.equal(message.customType, "subagent-background-result");
		assert.equal(message.details.taskId, started.details.taskId);
		assert.equal(message.details.recovery, true);
		assert.equal(options.triggerTurn, false);
		assert.doesNotMatch(message.content, /DO NOT REPLAY|Subagent was aborted/);
		assert.deepEqual(JSON.parse(message.content.trim().split("\n").at(-1)), {
			path: root,
			branch: `pi-subagent/${name}`,
			commits: 0,
			dirty: true,
			pruned: false,
		});
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
			"call-1", { role: "worker", task: "long work", background: true }, undefined, undefined, app.ctx,
		);
		assert.match(result.content[0]!.text, /started/);
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
		await app.tool.execute("call-1", { role: "worker", task: "old", background: true }, undefined, undefined, app.ctx);
		await app.handlers.get("session_shutdown")?.({}, { hasUI: false });
		app.handlers.get("session_start")?.({}, app.ctx);
		// Second session: a fresh task must deliver normally.
		const result = await app.tool.execute("call-2", { role: "worker", task: "new", background: true }, undefined, undefined, app.ctx);
		assert.match(result.content[0]!.text, /started/);
		await waitFor(() => app.sentMessages.length === 1);
		assert.match(app.sentMessages[0]!.message.content, /completed/);
	});
});

test("oversized PI_SUBAGENT_MAX_SUBAGENTS digit strings fail extension load", () => {
	process.env.PI_SUBAGENT_MAX_SUBAGENTS = "9".repeat(309);
	try {
		assert.throws(() => harness(), /exceeds the supported range/);
	} finally {
		delete process.env.PI_SUBAGENT_MAX_SUBAGENTS;
	}
});

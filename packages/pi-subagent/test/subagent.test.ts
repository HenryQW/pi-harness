import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import subagentExtension, { capOutput, loadRoles } from "../extensions/subagent.ts";

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

function harness(options: { ui?: boolean; skills?: Array<{ name: string; path: string }> } = {}) {
	let tool: Tool | undefined;
	let widget: { render: (width: number) => string[] } | undefined;
	let renders = 0;
	const notifications: Array<{ message: string; type: string }> = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const tui = { requestRender: () => { renders++; } };
	const theme = { fg: (_color: string, value: string) => value };
	const api = {
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		registerTool(candidate: Tool) { tool = candidate; },
		getCommands() {
			return (options.skills ?? []).map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.name,
				source: "skill" as const,
				sourceInfo: { path: skill.path, source: "test", scope: "user" as const, origin: "top-level" as const },
			}));
		},
	} as unknown as ExtensionAPI;
	subagentExtension(api);
	const ctx = {
		cwd: "/tmp",
		model,
		thinkingLevel: "low",
		hasUI: options.ui ?? false,
		modelRegistry: { getAvailable: () => [model] },
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
		ctx,
		handlers,
	};
}

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test state.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("role profile resolves skill names and selects exact extensions, tools, model, and thinking", async () => {
	await environment(async (agentDir) => {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-subagent", "reviewer.md"), `---
name: reviewer
description: Reviews focused changes
tools: read, grep
extensions:
  - ./extensions/review.ts
skills:
  - security
  - unavailable-skill
---
Review only requested change.
`);
		const runner = join(agentDir, "fake-pi.mjs");
		await writeFile(runner, `import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ args, prompt, cwd: process.cwd() }) }], stopReason: "end" } }));
`);
		process.argv[1] = runner;

		assert.deepEqual(loadRoles(agentDir).map(({ name }) => name), ["reviewer"]);
		const app = harness({ skills: [{ name: "security", path: "/effective/skills/security/SKILL.md" }] });
		assert.match(app.tool.description, /reviewer: Reviews focused changes/);
		const updates: any[] = [];
		const result = await app.tool.execute(
			"call-1",
			{ role: "reviewer", task: "inspect auth", model: "test/text-model", thinkingLevel: "high" },
			undefined,
			(update: any) => updates.push(update),
			app.ctx,
		);
		const child = JSON.parse(result.content[0].text);
		assert.equal(child.cwd, await realpath("/tmp"));
		assert.equal(child.prompt, "Review only requested change.");
		assert.deepEqual(child.args, [
			"--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills",
			"--extension", "./extensions/review.ts",
			"--skill", "/effective/skills/security/SKILL.md",
			"--tools", "read,grep",
			"--model", "test/text-model",
			"--thinking", "high",
			"--append-system-prompt", child.args.at(-2),
			"Task: inspect auth",
		]);
		assert.equal(updates.length, 1);
		assert.deepEqual(app.notifications, [{
			message: "Subagent role reviewer skipped unavailable Pi skills: unavailable-skill.",
			type: "warning",
		}]);
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
description: Missing bounded tool list
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

test("abort stops child process", async () => {
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
		await writeFile(runner, `setInterval(() => {}, 1_000);\n`);
		process.argv[1] = runner;
		const app = harness({ ui: true });
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 20);
		await assert.rejects(
			app.tool.execute("call-1", { role: "worker", task: "work" }, abort.signal, undefined, app.ctx),
			/Subagent was aborted/,
		);
		assert.ok(app.widget!.render(80)[0].startsWith("■"));
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
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

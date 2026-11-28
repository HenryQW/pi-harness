import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, initTheme, ToolExecutionComponent, type ToolRendererResolver, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi, Text } from "@earendil-works/pi-tui";
import toolRowsExtension from "../extensions/tool-rows.ts";

initTheme("dark");

// A plain base renderer: a call line and a three-line result.
const base: ToolRenderers = {
	renderCall: (args) => new Text(`run ${(args as { cmd: string }).cmd}`, 0, 0),
	renderResult: (result) => new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 0, 0),
};

type Handler = (event: unknown, ctx: unknown) => Promise<void>;
function setup(t: { after(fn: () => void): void }, config?: unknown) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-tool-rows-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});
	const configDir = join(agentDir, "config", "pi-tool-rows");
	const configFile = join(configDir, "config.json");
	if (config !== undefined) {
		mkdirSync(configDir, { recursive: true });
		writeFileSync(configFile, JSON.stringify(config));
	}

	const handlers = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	let resolver: ToolRendererResolver | undefined;
	const activate = () => toolRowsExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command.handler),
		registerToolRenderer: (next: ToolRendererResolver) => (resolver = next),
	} as unknown as ExtensionAPI);
	activate();

	const thinkingLabels: (string | undefined)[] = [];
	let branch: unknown[] = [];
	const entries = new Map<string, { type: string; parentId: string | null }>();
	let leaf: string | null = null;
	let idle = true;
	let reloads = 0;
	let renders = 0;
	const start = () => handlers.get("session_start")!({}, ctx);
	const ctx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => idle,
		reload: async () => {
			reloads++;
			activate();
			await start();
		},
		sessionManager: {
			buildContextEntries: () => branch,
			getLeafId: () => leaf,
			getEntry: (id: string) => entries.get(id),
		},
		ui: {
			setHiddenThinkingLabel: (label?: string) => thinkingLabels.push(label),
			notify: () => {},
		},
	};
	const resolve = (toolName = "bash", next = () => base as ToolRenderers | undefined) => resolver!(toolName, next);
	const row = (id: string, renderersFor: ToolRenderers, cmd: string, done = true, name = "bash", args: object = { cmd }) => {
		const component = new ToolExecutionComponent(name, id, args, undefined, renderersFor, { requestRender() { renders++; } } as never, agentDir);
		if (done) component.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree" }], isError: false } as never);
		return component;
	};
	return {
		configFile, handlers, commands, ctx, resolve, row, thinkingLabels, start,
		setBranch: (context: unknown[]) => { branch = context; },
		appendEntry: (id: string, type: string) => {
			entries.set(id, { type, parentId: leaf });
			leaf = id;
		},
		setIdle: (value: boolean) => { idle = value; },
		getReloads: () => reloads,
		getRenders: () => renders,
	};
}

test("off mode preserves Pi's renderer and native fallback", async (t) => {
	const { start, resolve } = setup(t, { mode: "off" });
	await start();
	assert.equal(resolve(), base);
	assert.equal(resolve("bash", () => undefined), undefined);
});

test("with no config file, tools between agent replies fold into one line", async (t) => {
	const { start, resolve, row, handlers, ctx, thinkingLabels } = setup(t);
	await start();
	assert.equal(thinkingLabels.at(-1), "");

	const begin = (id: string, name = "bash", args: object = {}) => handlers.get("tool_execution_start")!({ toolCallId: id, toolName: name, args }, ctx);
	const end = (id: string, isError = false) => handlers.get("tool_execution_end")!({ toolCallId: id, isError }, ctx);
	const renderers = resolve()!;
	await begin("a");
	const first = row("a", renderers, "ls");
	await end("a");
	await begin("b");
	const second = row("b", renderers, "pwd");
	await end("b", true);
	const skillArgs = { path: "/home/u/.agents/skills/git-pr/SKILL.md" };
	await begin("s", "read", skillArgs);
	const skill = row("s", resolve("read")!, "", true, "read", skillArgs);
	await end("s");
	assert.equal(second.render(60).length, 0);
	assert.equal(skill.render(60).length, 0);
	const toolCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: {} });
	await handlers.get("message_end")!({ message: { role: "assistant", content: [toolCall("a")], usage: { input: 1200, output: 40 } } }, ctx);
	await handlers.get("message_end")!({ message: { role: "assistant", content: [toolCall("b"), { ...toolCall("s"), name: "read" }], usage: { input: 300, output: 300 } } }, ctx);
	// Pi keeps its blank spacer above the summary line.
	const lines = first.render(85).map(stripAnsi).filter((line) => line.trim());
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /▸ 3 tools: bash ×2, read · skills: git-pr · ↑ 1\.5k ↓ 340 · 1 failed/);

	// Agent text ends the stretch, so the next tool starts its own summary line.
	await handlers.get("message_update")!({ assistantMessageEvent: { type: "text_end", content: "Done." } }, ctx);
	// An export can render a call outside the current branch before the next live call.
	assert.match(stripAnsi(row("outside-branch", resolve()!, "archived").render(60).join("\n")), /run archived/);
	const partial = { content: [toolCall("c")] };
	await handlers.get("message_update")!({ assistantMessageEvent: { type: "toolcall_start", partial, contentIndex: 0 } }, ctx);
	assert.match(stripAnsi(row("c", renderers, "id").render(80).join("\n")), /▸ running bash · 1 tool: bash/);

	// Expansion shows every row in full.
	second.setExpanded(true);
	assert.ok(second.render(60).map(stripAnsi).some((line) => line.includes("three")));
});

test("the collapsed group refreshes the running tool's elapsed time and stops when tools finish", async (t) => {
	const { start, handlers, ctx, row, resolve, getRenders } = setup(t, { mode: "group" });
	let now = 0;
	t.mock.method(performance, "now", () => now);
	t.mock.timers.enable({ apis: ["setInterval"] });
	const tick = () => {
		now += 1_000;
		t.mock.timers.tick(1_000);
	};
	await start();
	const begin = (id: string, toolName: string) => handlers.get("tool_execution_start")!({ toolCallId: id, toolName, args: {} }, ctx);
	const end = (id: string, isError = false) => handlers.get("tool_execution_end")!({ toolCallId: id, isError }, ctx);

	await begin("a", "bash");
	const first = row("a", resolve()!, "sleep", false);
	const summary = (width = 80) => stripAnsi(first.render(width).join("\n"));
	assert.match(summary(24), /running bash 0s/);
	const initialRenders = getRenders();
	tick();
	assert.equal(getRenders(), initialRenders + 1);
	assert.match(summary(), /running bash 1s/);

	await begin("b", "read");
	assert.match(summary(), /running read 0s/);
	await end("b", true);
	first.setExpanded(true);
	const expandedRenders = getRenders();
	tick();
	assert.equal(getRenders(), expandedRenders);
	first.setExpanded(false);
	assert.match(summary(), /running bash 2s/);

	await end("a");
	const finishedRenders = getRenders();
	tick();
	assert.equal(getRenders(), finishedRenders);
	assert.doesNotMatch(summary(), /running/);
	assert.match(summary(), /1 failed/);

	await begin("c", "bash");
	assert.match(summary(), /running bash 0s/);
	await handlers.get("session_shutdown")!({}, ctx);
	const shutdownRenders = getRenders();
	tick();
	assert.equal(getRenders(), shutdownRenders);
});

test("restores every tool call from an assistant message and counts usage once", async (t) => {
	const { start, setBranch, appendEntry, handlers, ctx, row, resolve } = setup(t, { mode: "group" });
	const savedCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { cmd: id } });
	const savedMessage = (...content: object[]) => ({
		type: "message",
		message: { role: "assistant", content, usage: { input: 100, output: 20 } },
	});
	appendEntry("initial", "message");
	setBranch([savedMessage(savedCall("a"), savedCall("b"), { type: "text", text: "Next." }, savedCall("c"))]);
	// Pi can construct restored rows before the new runtime receives session_start.
	const first = row("a", resolve()!, "a");
	const second = row("b", resolve()!, "b");
	await start();
	assert.match(stripAnsi(first.render(80).join("\n")), /2 tools: bash ×2 · ↑ 100 ↓ 20/);
	assert.deepEqual(second.render(80), []);

	const summary = (id: string) => stripAnsi(row(id, resolve()!, id).render(80).join("\n"));
	assert.match(summary("c"), /1 tool: bash · .*to expand/);

	// A boundary compaction redraws retained calls without a session_compact event.
	appendEntry("compaction", "compaction");
	appendEntry("after-compaction", "custom");
	setBranch([savedMessage(savedCall("b"), savedCall("c"))]);
	assert.match(summary("b"), /2 tools: bash ×2 · ↑ 100 ↓ 20/);
	assert.equal(summary("c"), "");

	setBranch([savedMessage(savedCall("c"))]);
	await handlers.get("session_tree")!({}, ctx);
	assert.match(summary("c"), /1 tool: bash · ↑ 100 ↓ 20/);
});

test("line mode keeps one line per finished tool", async (t) => {
	const { start, resolve, row } = setup(t, { mode: "line" });
	await start();
	const rendered: boolean[] = [];
	const renderers = resolve("bash", () => ({
		...base,
		renderResult(result, options, theme, context) {
			rendered.push(options.isPartial);
			return base.renderResult!(result, options, theme, context);
		},
	}))!;
	const call = row("a", renderers, "ls", false);
	const result = { content: [{ type: "text" as const, text: "one\ntwo\nthree" }], isError: false };
	call.updateResult(result, true);
	assert.match(stripAnsi(call.render(60).join("\n")), /three/);
	call.updateResult(result);
	assert.deepEqual(rendered, [true, false]);
	const lines = call.render(60).map(stripAnsi).filter((line) => line.trim());
	assert.deepEqual(lines.map((line) => line.trim()), ["run ls"]);
});

test("/tool-rows saves a mode change only while idle and reloads", async (t) => {
	const { start, commands, ctx, configFile, setIdle, getReloads, resolve } = setup(t, { mode: "off" });
	await start();
	const toolRows = commands.get("tool-rows")!;
	setIdle(false);
	await assert.rejects(toolRows("group", ctx), /Wait for Pi to finish/);
	assert.equal(JSON.parse(readFileSync(configFile, "utf8")).mode, "off");
	setIdle(true);
	await toolRows("group", ctx);
	assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { mode: "group" });
	assert.equal(getReloads(), 1);
	assert.notEqual(resolve(), base);
	await assert.rejects(toolRows("fold", ctx), /Usage: \/tool-rows group\|line\|off/);
	assert.equal(JSON.parse(readFileSync(configFile, "utf8")).mode, "group");
});

test("an invalid mode in the file keeps Pi's own rows", async (t) => {
	const { start, resolve } = setup(t, { mode: "fold" });
	await start();
	assert.equal(resolve(), base);
});

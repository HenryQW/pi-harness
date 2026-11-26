import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, initTheme, ToolExecutionComponent, type ToolRendererResolver, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import toolRowsExtension from "../extensions/tool-rows.ts";

initTheme("dark");
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

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
	const configFile = join(agentDir, "config", "pi-tool-rows", "config.json");
	if (config !== undefined) {
		mkdirSync(join(agentDir, "config", "pi-tool-rows"), { recursive: true });
		writeFileSync(configFile, JSON.stringify(config));
	}

	const handlers = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	let resolver: ToolRendererResolver | undefined;
	toolRowsExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command.handler),
		registerToolRenderer: (next: ToolRendererResolver) => (resolver = next),
	} as unknown as ExtensionAPI);

	const thinkingLabels: (string | undefined)[] = [];
	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			setHiddenThinkingLabel: (label?: string) => thinkingLabels.push(label),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			notify: () => {},
		},
	};
	const renderers = resolver!("bash", () => base)!;
	const readRenderers = resolver!("read", () => base)!;
	const row = (id: string, renderersFor: ToolRenderers, cmd: string, done = true, name = "bash", args: object = { cmd }) => {
		const component = new ToolExecutionComponent(name, id, args, undefined, renderersFor, { requestRender() {} } as never, agentDir);
		if (done) component.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree" }], isError: false } as never);
		return component;
	};
	return { configFile, handlers, commands, ctx, renderers, readRenderers, row, thinkingLabels, start: () => handlers.get("session_start")!({}, ctx) };
}

test("off mode draws the same rows as Pi", async (t) => {
	const { start, renderers, row } = setup(t);
	await start();
	for (const done of [true, false]) {
		for (const expanded of [false, true]) {
			const own = row("a", base, "ls", done);
			const wrapped = row("b", renderers, "ls", done);
			own.setExpanded(expanded);
			wrapped.setExpanded(expanded);
			assert.deepEqual(wrapped.render(60), own.render(60), `done=${done} expanded=${expanded}`);
		}
	}
});

test("group mode folds the tools between agent replies into one line", async (t) => {
	const { start, renderers, readRenderers, row, handlers, thinkingLabels } = setup(t, { mode: "group" });
	await start();
	assert.equal(thinkingLabels.at(-1), "");

	const first = row("a", renderers, "ls");
	const second = row("b", renderers, "pwd");
	const skill = row("s", readRenderers, "", true, "read", { path: "/home/u/.agents/skills/git-pr/SKILL.md" });
	assert.equal(second.render(60).length, 0);
	assert.equal(skill.render(60).length, 0);
	const toolCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: {} });
	await handlers.get("message_end")!({ message: { role: "assistant", content: [toolCall("a")], usage: { input: 1200, output: 40 } } }, {});
	await handlers.get("message_end")!({ message: { role: "assistant", content: [toolCall("b"), toolCall("s")], usage: { input: 300, output: 300 } } }, {});
	await Promise.resolve();
	// Pi keeps its blank spacer above the summary line.
	const lines = first.render(60).map(stripAnsi).filter((line) => line.trim());
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /▸ 3 tools: bash ×2, read · skills: git-pr · ↑ 1\.5k ↓ 340/);

	// Agent text ends the stretch, so the next tool starts its own summary line.
	await handlers.get("message_update")!({ assistantMessageEvent: { type: "text_end", content: "Done." } }, {});
	assert.match(stripAnsi(row("c", renderers, "id").render(60).join("\n")), /▸ 1 tool: bash(?! ×)/);

	// Expansion shows every row in full.
	second.setExpanded(true);
	assert.ok(second.render(60).map(stripAnsi).some((line) => line.includes("three")));
});

test("line mode keeps one line per finished tool", async (t) => {
	const { start, renderers, row } = setup(t, { mode: "line" });
	await start();
	const lines = row("a", renderers, "ls").render(60).map(stripAnsi).filter((line) => line.trim());
	assert.deepEqual(lines.map((line) => line.trim()), ["run ls"]);
});

test("/tool-rows saves the mode; a bad mode writes nothing", async (t) => {
	const { start, commands, ctx, configFile } = setup(t);
	await start();
	const toolRows = commands.get("tool-rows")!;
	await toolRows("group", ctx);
	assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { mode: "group" });
	await assert.rejects(toolRows("fold", ctx), /Usage: \/tool-rows group\|line\|off/);
	assert.equal(JSON.parse(readFileSync(configFile, "utf8")).mode, "group");
});

test("an invalid mode in the file keeps Pi's own rows", async (t) => {
	const { start, renderers, row } = setup(t, { mode: "fold" });
	await start();
	assert.deepEqual(row("b", renderers, "ls").render(60), row("a", base, "ls").render(60));
});

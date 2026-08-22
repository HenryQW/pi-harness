import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import footerExtension from "../extensions/footer.ts";

const usage = (input: number, output: number, cacheRead: number, cost: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const plain = (text: string) => text
	.replace(/\x1b\]8;;.*?\x1b\\/g, "")
	.replace(/\x1b\[[0-9;]*m/g, "");

test("renders readable usage, model thinking, and subscription status", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-footer-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	let sessionStart: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
	let footerFactory: ((tui: { requestRender(): void }, theme: { fg(_color: string, text: string): string }, data: {
		getGitBranch(): string;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		onBranchChange(callback: () => void): () => void;
	}) => { render(width: number): string[]; dispose(): void }) | undefined;
	let disposed = false;
	let thinkingLevel = "high";
	let entries = [
		{ type: "message", message: { role: "assistant", usage: usage(800, 200, 200, 0.1) } },
		{ type: "message", message: { role: "toolResult", usage: usage(100, 50, 0, 0.02) } },
		{ type: "compaction", usage: usage(1_500, 100, 0, 0.03) },
		{ type: "message", message: { role: "assistant", usage: usage(500, 100, 500, 0.2) } },
	];

	footerExtension({

		on(event: string, handler: typeof sessionStart) {
			if (event === "session_start") sessionStart = handler;
		},
		exec: async () => ({ stdout: "/Users/me/Git/repo/.git\n", stderr: "", code: 0, killed: false }),
	} as unknown as ExtensionAPI);

	const ctx = {
		mode: "tui",
		cwd: "/Users/me/.herdr/worktrees/repo/worktree-clear-field-f8d2",
		model: { id: "gpt-5.6-luna" },
		get thinkingLevel() { return thinkingLevel; },
		sessionManager: { getEntries: () => entries },
		getContextUsage: () => ({ tokens: 84_680, contextWindow: 200_000, percent: 42.34 }),
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
	} as unknown as ExtensionContext;

	await sessionStart?.({}, ctx);
	assert.ok(footerFactory);
	const colors: [string, string][] = [];
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (color, text) => { colors.push([color, text]); return text; } },
		{
			getGitBranch: () => "worktree/clear-field-f8d2",
			getExtensionStatuses: () => new Map([["pi-multi-codex", "Codex #1 · 50% · 7d 1d 1h 22m"]]),
			onBranchChange: () => () => { disposed = true; },
		},
	);

	const rendered = footer.render(100);
	assert.match(rendered[0]!, /\x1b\]8;;vscode:\/\/file\/Users\/me\/\.herdr\/worktrees\/repo\/worktree-clear-field-f8d2\x1b\\/);
	assert.ok(colors.some(([color, text]) => color === "accent" && text === "clear-field-f8d2"));
	const usageText = "↑ 2.9k · ↓ 450 · ↺ 50.0% · $ 0.350 · ◔ 42.3%";
	const modelText = "gpt-5.6-luna • high";
	assert.deepEqual(rendered.map(plain), [
		"repo · clear-field-f8d2",
		usageText + " ".repeat(100 - usageText.length - modelText.length) + modelText,
		"Codex #1 · 50% · 1d 1h 22m",
	]);

	thinkingLevel = "off";
	footer.render(100);
	assert.ok(colors.some(([color, text]) => color === "dim" && text === "off"));
	for (const [level, color] of [
		["minimal", 46],
		["low", 82],
		["medium", 118],
		["high", 220],
		["xhigh", 208],
		["max", 196],
	] as const) {
		thinkingLevel = level;
		assert.match(footer.render(100)[1], new RegExp(`\\x1b\\[38;5;${color}m${level}\\x1b\\[39m$`));
	}

	thinkingLevel = "ultra";
	assert.match(footer.render(100)[1], /\x1b\[38;5;196mu\x1b\[39m\x1b\[38;5;220ml\x1b\[39m\x1b\[38;5;46mt\x1b\[39m\x1b\[38;5;39mr\x1b\[39m\x1b\[38;5;201ma\x1b\[39m$/);

	entries = [];
	assert.match(footer.render(100)[1], /↺ —(?: ·|$)/);
	assert.doesNotMatch(footer.render(100)[1], /\?%/);
	footer.dispose();
	assert.equal(disposed, true);
});

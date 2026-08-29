import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, stripTerminalSequences } from "@earendil-works/pi-tui";
import footerExtension from "../extensions/footer.ts";

const usage = (input: number, output: number, cacheRead: number, cost: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
type Handler = (event: unknown, ctx?: ExtensionContext) => unknown;
type FooterFactory = (tui: { requestRender(): void }, theme: { fg(_color: string, text: string): string }, data: {
	getGitBranch(): string | undefined;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
}) => { render(width: number): string[]; dispose(): void };

function setupFooter(
	{
		appendEntry = () => {},
		exec = async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	}: {
		appendEntry?: (customType: string, data: unknown) => void;
		exec?: () => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
	} = {},
) {
	const handlers = new Map<string, Handler>();
	footerExtension({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		appendEntry,
		exec,
	} as unknown as ExtensionAPI);

	return {
		handlers,
		async start(ctx: object): Promise<FooterFactory> {
			let footerFactory: FooterFactory | undefined;
			const context = Object.assign(ctx, {
				ui: {
					setFooter(factory: FooterFactory) {
						footerFactory = factory;
					},
				},
			}) as unknown as ExtensionContext;
			const sessionStart = handlers.get("session_start");
			assert.ok(sessionStart);
			await sessionStart({}, context);
			assert.ok(footerFactory);
			return footerFactory;
		},
	};
}

test("renders family status on the first line and external statuses beside runtime", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-footer-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousCapabilities = getCapabilities();
	process.env.PI_CODING_AGENT_DIR = agentDir;
	setCapabilities({ ...previousCapabilities, hyperlinks: true });
	t.after(async () => {
		setCapabilities(previousCapabilities);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	let disposed = false;
	let thinkingLevel = "high";
	let gitOutput = "/Users/me/.herdr/worktrees/repo/worktree-clear-field-f8d2\n/Users/me/Git/repo/.git\n";
	let entries = [
		{ type: "message", message: { role: "assistant", usage: usage(800, 200, 200, 0.1) } },
		{ type: "message", message: { role: "toolResult", usage: usage(100, 50, 0, 0.02) } },
		{ type: "compaction", usage: usage(1_500, 100, 0, 0.03) },
		{ type: "message", message: { role: "assistant", usage: usage(500, 100, 500, 0.2) } },
	];
	const { start } = setupFooter({
		exec: async () => ({ stdout: gitOutput, stderr: "", code: 0, killed: false }),
	});

	const ctx = {
		mode: "tui",
		cwd: "/Users/me/.herdr/worktrees/repo/worktree-clear-field-f8d2",
		model: { id: "gpt-5.6-luna" },
		get thinkingLevel() { return thinkingLevel; },
		sessionManager: { getEntries: () => entries },
		getContextUsage: () => ({ tokens: 84_680, contextWindow: 200_000, percent: 42.34 }),
	};

	const footerFactory = await start(ctx);
	const colors: [string, string][] = [];
	let extensionStatuses = new Map([
		["ponytail", "●  🐴\tponytail: ⚡ FULL\r\nready"],
		["pi-pr", "\x1b[32mPR #123 · approved\x1b[39m"],
		["pi-multi-codex", "Codex #1 · 50% · 7d 1d 1h 22m"],
		["pi-rewind", "↩ rewind"],
		["hidden", ""],
	]);
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (color, text) => { colors.push([color, text]); return text; } },
		{
			getGitBranch: () => "worktree/clear-field-f8d2",
			getExtensionStatuses: () => extensionStatuses,
			onBranchChange: () => () => { disposed = true; },
		},
	);

	const rendered = footer.render(100);
	assert.match(rendered[0]!, /\x1b\]8;;vscode:\/\/file\/Users\/me\/\.herdr\/worktrees\/repo\/worktree-clear-field-f8d2\x1b\\/);
	assert.ok(colors.some(([color, text]) => color === "accent" && text === "clear-field-f8d2"));
	const usageText = "↑ 2.9k · ↓ 450 · ↺ 50.0% · ⚡ — · $ 0.350 · ◔ 42.3%";
	const modelText = "gpt-5.6-luna • high";
	assert.match(stripTerminalSequences(rendered[0]!), /^repo · clear-field-f8d2 · PR #123 · approved +Codex #1 · 50% · 7d 1d 1h 22m$/);
	assert.match(stripTerminalSequences(rendered[1]!), new RegExp(`^${usageText.replace("$", "\\$")} +${modelText}$`));
	assert.match(stripTerminalSequences(rendered[2]!), /^↩ rewind ●  🐴\tponytail: ⚡ FULL ready +◷ 0s$/);
	assert.match(rendered[0]!, /\x1b\[32mPR #123 · approved\x1b\[39m/);
	assert.doesNotMatch(rendered[2]!, /PR #123|Codex/);

	// Narrow width: external status truncates first so the runtime stays visible.
	const narrow = stripTerminalSequences(footer.render(30)[2]!);
	assert.match(narrow, /◷ 0s$/);

	extensionStatuses = new Map([["pi-rewind", "↩ rewind"]]);
	assert.match(stripTerminalSequences(footer.render(100)[2]!).trim(), /^↩ rewind +◷ 0s$/);

	await mkdir(join(agentDir, "config"));
	await writeFile(join(agentDir, "config", "pi-open-in.json"), '{"command":"codex"}');
	assert.doesNotMatch(footer.render(100)[0]!, /vscode:\/\//);
	await writeFile(join(agentDir, "config", "pi-open-in.json"), '{"command":"code"}');
	assert.match(footer.render(100)[0]!, /vscode:\/\//);
	setCapabilities({ ...previousCapabilities, hyperlinks: false });
	assert.doesNotMatch(footer.render(100)[0]!, /\x1b\]8;;/);

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

	gitOutput = "/parent/child\n/parent/.git/modules/child\n";
	const submoduleFooterFactory = await start({ ...ctx, cwd: "/parent/child" });
	const submoduleFooter = submoduleFooterFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => {},
		},
	);
	assert.equal(stripTerminalSequences(submoduleFooter.render(100)[0]!), "child · main");
	submoduleFooter.dispose();
});

test("shows TPS and active session time", async () => {
	const { handlers, start } = setupFooter();
	const footerFactory = await start({
		mode: "tui",
		cwd: "/repo",
		sessionManager: { getEntries: () => [] },
		getContextUsage: () => undefined,
	});
	const footer = footerFactory({ requestRender() {} }, { fg: (_c: string, text: string) => text }, { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });

	assert.match(footer.render(100)[1]!, /⚡ — /);
	assert.equal(footer.render(100)[2]!.trim(), "◷ 0s");
	let now = 0;
	const realPerformance = globalThis.performance;
	globalThis.performance = { now: () => now } as unknown as typeof performance;
	try {
		const assistantMessage = { role: "assistant", usage: { output: 100 } };
		await handlers.get("message_start")!({ message: assistantMessage });
		now = 2_000;
		await handlers.get("message_end")!({ message: assistantMessage });
		assert.match(footer.render(100)[1]!, /⚡ 50\.0 t\/s/);

		await handlers.get("agent_start")!({ message: { role: "assistant" } }, { isIdle: () => false } as unknown as ExtensionContext);
		now = 3_725_000;
		assert.equal(footer.render(100)[2]!.trim(), "◷ 1h 2m 3s");
		const idleCtx = { isIdle: () => true } as unknown as ExtensionContext;
		await handlers.get("agent_settled")!({ message: { role: "assistant" } }, idleCtx);
		now = 4_000_000;
		assert.equal(footer.render(100)[2]!.trim(), "◷ 1h 2m 3s");

		const zeroOutput = { role: "assistant", usage: { output: 0 } };
		await handlers.get("message_start")!({ message: zeroOutput });
		now = 4_002_000;
		await handlers.get("message_end")!({ message: zeroOutput });
		assert.match(footer.render(100)[1]!, /⚡ 0\.0 t\/s/);
	} finally {
		await handlers.get("agent_settled")?.({ message: { role: "assistant" } }, { isIdle: () => true } as unknown as ExtensionContext);
		globalThis.performance = realPerformance;
	}
});

test("counts one agent run across duplicate starts and stale settled", async () => {
	const { handlers, start } = setupFooter();
	const footerFactory = await start({
		mode: "tui",
		cwd: "/repo",
		sessionManager: { getEntries: () => [] },
		getContextUsage: () => undefined,
	});
	const footer = footerFactory({ requestRender() {} }, { fg: (_c: string, text: string) => text }, { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
	const runtime = () => footer.render(100)[2]!.trim();

	let now = 0;
	let idle = true;
	const ctx = { isIdle: () => idle } as unknown as ExtensionContext;
	const realPerformance = globalThis.performance;
	globalThis.performance = { now: () => now } as unknown as typeof performance;
	try {
		// Duplicate start ignored; a non-idle settled must not finalize the newer run.
		await handlers.get("agent_start")!(undefined, ctx);
		now = 1_000;
		await handlers.get("agent_start")!(undefined, ctx);
		idle = false;
		await handlers.get("agent_settled")!(undefined, ctx);
		assert.equal(runtime(), "◷ 1s");
		now = 2_500;
		idle = true;
		await handlers.get("agent_settled")!(undefined, ctx);
		assert.equal(runtime(), "◷ 2s");
	} finally {
		// Clear the active interval before restoring globals so assertion failures cannot hang.
		await handlers.get("session_shutdown")?.(undefined);
		globalThis.performance = realPerformance;
	}
});

test("excludes prompt waits and persists a paused run", async () => {
	const appended: Array<[string, unknown]> = [];
	const { handlers, start } = setupFooter({
		appendEntry(customType, data) {
			appended.push([customType, data]);
		},
	});
	const footerFactory = await start({
		mode: "tui",
		cwd: "/repo",
		sessionManager: { getEntries: () => [] },
		getContextUsage: () => undefined,
	});
	const footer = footerFactory({ requestRender() {} }, { fg: (_c: string, text: string) => text }, { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
	const runtime = () => footer.render(100)[2]!.trim();

	let now = 0;
	const idleCtx = { isIdle: () => true } as unknown as ExtensionContext;
	const realPerformance = globalThis.performance;
	globalThis.performance = { now: () => now } as unknown as typeof performance;
	try {
		// Prompt events outside a run are no-ops.
		await handlers.get("ui_prompt_start")!(undefined);
		await handlers.get("ui_prompt_end")!(undefined);

		await handlers.get("agent_start")!(undefined);
		now = 1_000;
		await handlers.get("ui_prompt_start")!(undefined);
		now = 5_000;
		await handlers.get("agent_start")!(undefined); // Duplicate start while paused is ignored.
		now = 8_000;
		assert.equal(runtime(), "◷ 1s");

		await handlers.get("ui_prompt_end")!(undefined);
		now = 10_000;
		assert.equal(runtime(), "◷ 3s");

		await handlers.get("ui_prompt_start")!(undefined);
		now = 15_000;
		await handlers.get("agent_settled")!(undefined, idleCtx);
		assert.equal(runtime(), "◷ 3s");
		assert.deepEqual(appended, [["pi-footer:agent-work", 3_000]]);
		await handlers.get("ui_prompt_end")!(undefined);
		now = 20_000;
		assert.equal(runtime(), "◷ 3s");
	} finally {
		await handlers.get("session_shutdown")?.(undefined);
		globalThis.performance = realPerformance;
	}
});

test("restores cumulative agent time on resume and appends updated totals", async () => {
	const appended: Array<[string, unknown]> = [];
	const { handlers, start } = setupFooter({
		appendEntry(customType, data) {
			appended.push([customType, data]);
		},
	});
	const entries = [
		{ type: "custom", customType: "pi-footer:agent-work", data: 1_000 },
		{ type: "custom", customType: "pi-footer:agent-work", data: -5 },
		{ type: "custom", customType: "other", data: 999_999 },
		{ type: "custom", customType: "pi-footer:agent-work", data: 65_000 },
	];
	const footerFactory = await start({
		mode: "tui",
		cwd: "/repo",
		sessionManager: { getEntries: () => entries },
		getContextUsage: () => undefined,
	});
	const footer = footerFactory({ requestRender() {} }, { fg: (_c: string, text: string) => text }, { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
	assert.equal(footer.render(100)[2]!.trim(), "◷ 1m 5s");

	let now = 0;
	const realPerformance = globalThis.performance;
	globalThis.performance = { now: () => now } as unknown as typeof performance;
	try {
		const ctx = { isIdle: () => true } as unknown as ExtensionContext;
		await handlers.get("agent_start")!(undefined, ctx);
		now = 2_500;
		await handlers.get("agent_settled")!(undefined, ctx);
		assert.deepEqual(appended, [["pi-footer:agent-work", 67_500]]);
		assert.equal(footer.render(100)[2]!.trim(), "◷ 1m 7s");

		// Non-TUI sessions restore their own total before global agent handlers append.
		now = 10_000;
		await handlers.get("session_start")!({}, {
			mode: "rpc",
			sessionManager: { getEntries: () => entries },
		} as unknown as ExtensionContext);
		await handlers.get("agent_start")!(undefined, ctx);
		now = 11_500;
		await handlers.get("agent_settled")!(undefined, ctx);
		assert.deepEqual(appended, [
			["pi-footer:agent-work", 67_500],
			["pi-footer:agent-work", 66_500],
		]);
	} finally {
		await handlers.get("session_shutdown")?.(undefined, undefined as never);
		globalThis.performance = realPerformance;
	}
});

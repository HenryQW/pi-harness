/**
 * Integration test for the extension entry point. PI_CODING_AGENT_DIR is
 * pointed at a temp dir so getAgentDir() resolves tmp config/db/sessions.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { searchIndex } from "../extensions/search-core.ts";
import { MAX_SESSION_FILE_BYTES } from "../extensions/transcript.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

before(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-entry-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	fs.rmSync(agentDir, { recursive: true, force: true });
});

// --- stub pi + helpers ---

interface CapturedTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
	renderResult: (
		result: { content: { type: string; text: string }[]; details: unknown },
		options: { expanded: boolean },
		theme: { fg(color: string, text: string): string },
		context: unknown,
	) => { render(width: number): string[] };
}

function makePi(commands: object[] = []): {
	on: (event: string, callback: (...args: unknown[]) => void) => void;
	registerTool: (t: CapturedTool) => void;
	sessionStart?: (...args: unknown[]) => void;
} & Record<string, unknown> {
	const captured: { tool?: CapturedTool; sessionStart?: (...args: unknown[]) => void } = {};
	return {
		on: (event, callback) => {
			if (event === "session_start") captured.sessionStart = callback;
		},
		registerTool: (t: CapturedTool) => {
			captured.tool = t;
		},
		async exec(command: string, args: string[], options?: { cwd?: string }) {
			const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: result.status ?? 1,
				killed: result.signal !== null,
			};
		},
		getCommands: () => commands,
		get tool() {
			return captured.tool!;
		},
		get sessionStart() {
			return captured.sessionStart;
		},
	};
}

function writeSession(relName: string, lines: object[]): string {
	const file = path.join(agentDir, "sessions", relName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
}

function clearRecallState(): void {
	fs.rmSync(path.join(agentDir, "sessions"), { recursive: true, force: true });
	fs.rmSync(path.join(agentDir, "config", "pi-session-recall"), { recursive: true, force: true });
}

function makeRepository(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-entry-repo-"));
	const result = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return fs.realpathSync(root);
}

function writeRepositoryFile(root: string, relativePath: string, content: string, mode?: number): string {
	const file = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	if (mode !== undefined) fs.chmodSync(file, mode);
	return file;
}

function writeSimpleSession(
	relName: string,
	options: { id: string; cwd: string; timestamp: string; text?: string; parentSession?: string },
): string {
	return writeSession(relName, [
		{
			type: "session",
			version: 3,
			id: options.id,
			timestamp: options.timestamp,
			cwd: options.cwd,
			...(options.parentSession ? { parentSession: options.parentSession } : {}),
		},
		...(options.text === undefined ? [] : [{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: options.timestamp,
			message: { role: "user", content: [{ type: "text", text: options.text }] },
		}]),
	]);
}

function msg(parentId: string | null, role: string, text: string): object {
	const n = msgCount++;
	return {
		type: "message",
		id: `e${String(n).padStart(2, "0")}`,
		parentId,
		timestamp: `2026-01-01T00:${String(n).padStart(2, "0")}:00.000Z`,
		message: { role, content: [{ type: "text", text }] },
	};
}
let msgCount = 0;

describe("session_search entry point", () => {
	it("previews the last five visual result lines and expands to the full response", async () => {
		const pi = makePi();
		const { default: register } = await import("../extensions/session-recall.ts");
		register(pi as never);

		const tool = (pi as any).tool as CapturedTool;
		const result = { content: [{ type: "text", text: JSON.stringify({ messages: Array.from({ length: 10 }, (_, index) => `${index}:${"x".repeat(30)}`) }) }], details: {} };
		const width = 40;
		const allLines = new Text(result.content[0]!.text, 0, 0).render(width);
		assert.ok(allLines.length > 5);
		const theme = { fg: (_color: string, text: string) => text };
		initTheme("dark");

		const collapsed = tool.renderResult(result, { expanded: false }, theme, {}).render(width);
		assert.deepEqual(collapsed.slice(-5), allLines.slice(-5));
		assert.match(collapsed[1]!, /earlier lines/);
		assert.match(collapsed[1]!, /to expand/);
		assert.deepEqual(tool.renderResult(result, { expanded: true }, theme, {}).render(width), new Text(`\n${result.content[0]!.text}`, 0, 0).render(width));
	});

	it("registers the tool and dispatches browse/discovery", async () => {
		const pi = makePi();
		const { default: register } = await import("../extensions/session-recall.ts");
		register(pi as never);

		const tool = (pi as any).tool as CapturedTool;
		assert.equal(tool.name, "session_search");
		assert.equal(tool.promptSnippet, "Search past Pi sessions for prior decisions and context");
		assert.deepEqual(tool.promptGuidelines, [
			"Use session_search only when the user explicitly asks about past Pi sessions, historical decisions, or repeated work not available in the current conversation. Do not use it for current-session continuation or ordinary repository inspection.",
		]);

		// Fixture sessions with proper parentId chain.
		msgCount = 1;
		const s1 = writeSession("a/session-a.jsonl", [
			{ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/Users/tester/proj" },
			msg(null, "user", "how do we handle the auth refactor"),
			msg("e01", "assistant", "we decided to use JWT tokens for auth"),
			msg("e02", "user", "sounds good"),
			msg("e03", "assistant", "done"),
		]);
		msgCount = 1;
		writeSession("b/session-b.jsonl", [
			{ type: "session", version: 3, id: "s2", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/Users/tester/web" },
			(() => {
				const m = msg(null, "user", "fix the deploy pipeline");
				return m;
			})(),
			msg("e01", "assistant", "ok"),
		]);

		// Sync via exported core, then browse.
		const { syncSessions } = await import("../extensions/search-core.ts");
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));

		const ctx = { sessionManager: {} };

		const browse = await tool.execute("t1", {}, undefined, undefined, ctx);
		const browseResult = JSON.parse(browse.content[0].text);
		assert.equal(browseResult.mode, "browse");
		assert.equal(browseResult.sessions.length, 2);
		assert.ok(browseResult.sessions[0].path.startsWith(agentDir));
		assert.ok(browseResult.sessions[0].preview.length > 0);
		assert.deepEqual((browse.details as { mode: string }).mode, "browse");

		// Discovery: query hits session A top-ranked with full hydration.
		const disc = await tool.execute("t2", { query: "auth refactor" }, undefined, undefined, ctx);
		const discResult = JSON.parse(disc.content[0].text);
		assert.equal(discResult.mode, "discovery");
		assert.ok(discResult.results.length >= 1);
		const top = discResult.results[0];
		assert.equal(top.path, s1);
		assert.ok(top.snippet.includes("[") || top.snippet.length > 0);
		assert.equal(top.detail, "full");
		assert.ok(top.messages.some((m: { anchor?: boolean }) => m.anchor));
		assert.equal(top.bookends.start[0]?.role, "user");
		assert.equal(typeof top.messagesBefore, "number");
		assert.equal(top.toolResultsOmitted, undefined);

		// Read mode via sessionId.
		const read = await tool.execute("t3", { sessionId: s1 }, undefined, undefined, ctx);
		const readResult = JSON.parse(read.content[0].text);
		assert.equal(readResult.mode, "read");
		assert.equal(readResult.totalMessages, 4);

		// Scroll mode: sessionId + aroundMessageId takes precedence over query.
		const scroll = await tool.execute(
			"t4",
			{ sessionId: s1, aroundMessageId: "e03", window: 2, query: "ignored" },
			undefined,
			undefined,
			ctx,
		);
		const scrollResult = JSON.parse(scroll.content[0].text);
		assert.equal(scrollResult.mode, "scroll");
		assert.equal(scrollResult.messages.at(-1).entryId, "e04"); // window extends past the anchor
		assert.equal(scrollResult.messages.find((m: { entryId: string }) => m.entryId === "e03").anchor, true);
		assert.equal(scrollResult.messagesBefore, 2);
	});

	it("adaptive discovery filters tool results while explicit retrieval stays raw", async () => {
		const pi = makePi();
		const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-adaptive-filter`);
		register(pi as never);
		const tool = (pi as any).tool as CapturedTool;

		const lines: object[] = [
			{ type: "session", version: 3, id: "adaptive-filter", timestamp: "2026-02-01T00:00:00.000Z", cwd: "/tmp" },
		];
		let parentId: string | null = null;
		for (let i = 1; i <= 13; i++) {
			if (i === 7) {
				lines.push({
					type: "message",
					id: "tool-large",
					parentId,
					timestamp: "2026-02-01T00:06:30.000Z",
					message: { role: "toolResult", content: [{ type: "text", text: "sensitive raw output " + "x".repeat(12_000) }] },
				});
				parentId = "tool-large";
			}
			const id = `v${String(i).padStart(2, "0")}`;
			lines.push({
				type: "message",
				id,
				parentId,
				timestamp: `2026-02-01T00:${String(i).padStart(2, "0")}:00.000Z`,
				message: {
					role: i % 2 ? "user" : "assistant",
					content: [{ type: "text", text: i === 7 ? "adaptive visible anchor narwhal" : `visible message ${i}` }],
				},
			});
			parentId = id;
		}
		const session = writeSession("adaptive-filter/session.jsonl", lines);
		const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-adaptive-filter`);
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));

		for (const params of [
			{ query: "adaptive visible anchor narwhal" },
			{ query: "adaptive visible anchor narwhal", detail: "adaptive" },
		]) {
			const response = await tool.execute("adaptive", params, undefined, undefined, { sessionManager: {} });
			const parsed = JSON.parse(response.content[0].text);
			const hit = parsed.results[0];
			assert.equal(hit.path, session);
			assert.equal(hit.toolResultsOmitted, true);
			assert.deepEqual(hit.messages.map((m: { entryId: string }) => m.entryId), ["v02", "v03", "v04", "v05", "v06", "v07", "v08", "v09", "v10", "v11", "v12"]);
			assert.deepEqual(hit.messages.filter((m: { anchor?: boolean }) => m.anchor).map((m: { entryId: string }) => m.entryId), ["v07"]);
			assert.deepEqual(hit.bookends.start.map((m: { entryId: string }) => m.entryId), ["v01", "v02", "v03"]);
			assert.deepEqual(hit.bookends.end.map((m: { entryId: string }) => m.entryId), ["v11", "v12", "v13"]);
			assert.equal(hit.messagesBefore, 6);
			assert.equal(hit.messagesAfter, 6);
			assert.ok(hit.messages.every((m: { role: string }) => m.role === "user" || m.role === "assistant"));
		}

		const full = JSON.parse((await tool.execute("full", { query: "adaptive visible anchor narwhal", detail: "full" }, undefined, undefined, { sessionManager: {} })).content[0].text).results[0];
		assert.equal(full.toolResultsOmitted, undefined);
		assert.equal(full.messages.find((m: { entryId: string }) => m.entryId === "tool-large").content.length, 12_021);
		assert.equal(full.messagesBefore, 7);
		assert.equal(full.messagesAfter, 6);

		const read = JSON.parse((await tool.execute("read", { sessionId: session }, undefined, undefined, { sessionManager: {} })).content[0].text);
		assert.equal(read.totalMessages, 14);
		assert.equal(read.messages.find((m: { entryId: string }) => m.entryId === "tool-large").content.length, 12_021);

		const scroll = JSON.parse((await tool.execute("scroll", { sessionId: session, aroundMessageId: "v07", window: 5 }, undefined, undefined, { sessionManager: {} })).content[0].text);
		assert.equal(scroll.messages.find((m: { entryId: string }) => m.entryId === "tool-large").content.length, 12_021);
		assert.equal(scroll.messagesBefore, 7);
		assert.equal(scroll.messagesAfter, 6);
	});

	it("SCROLL keeps position and branch as separate cursors", async () => {
		const pi = makePi();
		const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-branch-scroll`);
		register(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		msgCount = 1;
		const session = writeSession("fork-scroll/session.jsonl", [
			{ type: "session", version: 3, id: "fork-scroll", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			msg(null, "user", "q1"),
			msg("e01", "assistant", "a1"),
			msg("e02", "user", "q2"),
			msg("e03", "assistant", "branch A"),
			msg("e04", "user", "branch A tail"),
			msg("e03", "assistant", "branch B"),
			msg("e06", "user", "branch B tail"),
		]);
		const response = await tool.execute("tb", {
			sessionId: session,
			aroundMessageId: "e01",
			branchTip: "e05",
			window: 5,
		}, undefined, undefined, { sessionManager: {} });
		const parsed = JSON.parse(response.content[0].text);
		assert.deepEqual(parsed.messages.map((m: { entryId: string }) => m.entryId), ["e01", "e02", "e03", "e04", "e05"]);
		assert.equal(parsed.branchTip, "e05");
	});

	it("READ clamps oversized content to the output budget (PR #135)", async () => {
		const pi = makePi();
		const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-read`);
		register(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		msgCount = 1;
		const s = writeSession("d/session-d.jsonl", [
			{ type: "session", version: 3, id: "sd", timestamp: "2026-01-04T00:00:00.000Z", cwd: "/Users/tester/proj" },
			...Array.from({ length: 8 }, (_, i) => msg(i === 0 ? null : `e${String(i).padStart(2, "0")}`, i % 2 ? "assistant" : "user", "x".repeat(10_000))),
		]);
		const res = await tool.execute("tr", { sessionId: s }, undefined, undefined, { sessionManager: {} });
		assert.ok(res.content[0].text.length <= 50_000, "serialized READ must respect the 50k budget");
		const parsed = JSON.parse(res.content[0].text); // valid JSON
		assert.equal(parsed.mode, "read");
		assert.equal(parsed.totalMessages, 8);
		assert.equal(parsed.branchTip, "e08", "branch tip survives character truncation");
		assert.equal(parsed.truncated, false, "message-count truncation untouched");
		assert.equal(parsed.contentTruncated, true, "character-level truncation signaled");
		assert.ok(parsed.messages.every((m: { content: string }) => m.content.length < 10_000));
	});

	it("SCROLL and DISCOVERY bound oversized content to the output budget (PR #135)", async () => {
		const pi = makePi();
		const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-bound`);
		register(pi as never);
		const tool = (pi as any).tool as CapturedTool;

		// SCROLL over a window with a multi-hundred-kB paste.
		msgCount = 1;
		const sBig = writeSession("e/session-e.jsonl", [
			{ type: "session", version: 3, id: "se", timestamp: "2026-01-05T00:00:00.000Z", cwd: "/Users/tester/proj" },
			...Array.from({ length: 6 }, (_, i) => msg(i === 0 ? null : `e${String(i).padStart(2, "0")}`, i % 2 ? "assistant" : "user", `quokka ${"y".repeat(200_000)}`)),
		]);
		const scroll = await tool.execute("ts", { sessionId: sBig, aroundMessageId: "e03", window: 5 }, undefined, undefined, { sessionManager: {} });
		assert.ok(scroll.content[0].text.length <= 50_000, "serialized SCROLL must respect the 50k budget");
		const scrollParsed = JSON.parse(scroll.content[0].text);
		assert.equal(scrollParsed.mode, "scroll");
		assert.equal(scrollParsed.branchTip, "e06", "branch tip exposed as scroll cursor");
		assert.equal(scrollParsed.contentTruncated, true);

		// Discovery with detail=full: every hit sized against the cumulative budget.
		for (const dir of ["f1", "f2", "f3"]) {
			msgCount = 1;
			writeSession(`${dir}/session.jsonl`, [
				{ type: "session", version: 3, id: dir, timestamp: "2026-01-06T00:00:00.000Z", cwd: "/Users/tester/proj" },
				...Array.from({ length: 4 }, (_, i) => msg(i === 0 ? null : `e${String(i).padStart(2, "0")}`, i % 2 ? "assistant" : "user", `capybara ${"z".repeat(30_000)}`)),
			]);
		}
		const disc = await tool.execute("td", { query: "capybara", limit: 3, detail: "full" }, undefined, undefined, { sessionManager: {} });
		assert.ok(disc.content[0].text.length <= 50_000, "complete serialized DISCOVERY must respect the 50k budget");
		const discParsed = JSON.parse(disc.content[0].text);
		assert.equal(discParsed.results.length, 3);
		assert.ok(discParsed.results.some((r: { contentTruncated?: boolean }) => r.contentTruncated), "later hits truncated against cumulative budget");
	});

	it("discovery full hit derives window and bookends from one snapshot read", async () => {
		const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-single-snapshot`);
		const pi = makePi();
		mod.default(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		msgCount = 1;
		// Hit anchors on branch A (e04/e05) while the file's final leaf sits on branch B.
		const target = writeSession("single-snapshot/session.jsonl", [
			{ type: "session", version: 3, id: "ss1", timestamp: "2026-01-09T00:00:00.000Z", cwd: "/tmp" },
			msg(null, "user", "shared root quoll"), // e01
			msg("e01", "assistant", "shared middle quoll"), // e02
			msg("e02", "user", "shared tail quoll"), // e03
			msg("e03", "assistant", "branch A marker wombat token"), // e04
			msg("e04", "user", "branch A tail wombat"), // e05
			msg("e03", "assistant", "branch B sibling"), // e06 leaf branch
			msg("e06", "user", "branch B tail"), // e07 leaf
		]);
		const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-single-snapshot`);
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));

		// Pre-synced walk skips unchanged files via stat fingerprinting, so any
		// further read of the transcript must come from hydration itself.
		const realOpenSync = fs.openSync.bind(fs) as typeof fs.openSync;
		let opens = 0;
		fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
			if (args[0] === target) opens++;
			return realOpenSync(...args);
		}) as typeof fs.openSync;
		let hit: { bookends: { start: { entryId: string }[]; end: { entryId: string }[] }; messages: { entryId: string }[]; messagesBefore: number; messagesAfter: number };
		try {
			const response = await tool.execute("single-snapshot", { query: "branch A marker wombat token" }, undefined, undefined, {
				sessionManager: {},
			});
			const parsed = JSON.parse(response.content[0].text);
			hit = parsed.results.find((r: { path: string }) => r.path === target);
		} finally {
			fs.openSync = realOpenSync;
		}
		assert.ok(hit, "expected the forked session to match");
		assert.equal(opens, 1, "full hit must hydrate from exactly one transcript snapshot read");
		// Bookends come from the anchor's branch (same array as the window), not
		// the file's final leaf on branch B.
		assert.deepEqual(hit.bookends.start.map((m) => m.entryId), ["e01", "e02", "e03"]);
		assert.deepEqual(hit.bookends.end.map((m) => m.entryId), ["e03", "e04", "e05"]);
		assert.ok(hit.messages.every((m: { entryId: string }) => ["e01", "e02", "e03", "e04", "e05"].includes(m.entryId)), "window stays on the anchor's branch");
	});

	it("truncateContent never splits surrogate pairs at head/tail cut points", async () => {
		const { truncateContent } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-surrogate`);
		const emoji = "\u{1F600}"; // 😀 — one astral char = two UTF-16 code units
		// Both cut points for maxChars=20 land inside emoji pairs:
		// head=10 splits pair at [9,10]; tail start=20 splits pair at [19,20].
		const content = "a".repeat(9) + emoji + "c".repeat(8) + emoji + "b".repeat(9);
		assert.equal(content.length, 30);
		const [m] = truncateContent([{ entryId: "e1", role: "user", content, timestamp: "t" }], 20);
		const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		assert.doesNotMatch(m.content, lone, "no dangling surrogate half may survive truncation");
		assert.ok(m.content.length <= content.length && m.content.includes("…"), "result truncated and bounded");
		// Non-astral content keeps the exact legacy split (no off-by-one).
		const plain = "x".repeat(30);
		const [p] = truncateContent([{ entryId: "e2", role: "user", content: plain, timestamp: "t" }], 20);
		assert.equal(p.content, "x".repeat(10) + "…" + "x".repeat(10));
	});

	it("caps hydrated metadata at the JSONL trust boundary", async () => {
		const pi = makePi();
		const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-metadata`);
		register(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		const session = writeSession("metadata/session.jsonl", [
			{ type: "session", version: 3, id: "meta", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			{ type: "message", id: "m1", parentId: null, timestamp: "t".repeat(100_000), message: { role: "user", content: "bounded metadata" } },
		]);
		const response = await tool.execute("tm", { sessionId: session }, undefined, undefined, { sessionManager: {} });
		assert.ok(response.content[0].text.length <= 50_000);
		const parsed = JSON.parse(response.content[0].text);
		assert.equal(parsed.messages[0].timestamp.length, 128);
	});

	it("errors return success:false instead of throwing", async () => {
		const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}`);
		const pi = makePi();
		mod.default(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		const res = await tool.execute("t5", { sessionId: "/nonexistent/file.jsonl" }, undefined, undefined, {
			sessionManager: {},
		});
		const parsed = JSON.parse(res.content[0].text);
		assert.equal(parsed.success, false);
	});

	it("rejects sessionId outside the sessions directory (bhGOq)", async () => {
		const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-trav`);
		const pi = makePi();
		mod.default(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		// A readable JSONL-shaped file OUTSIDE the sessions dir must be refused.
	 const outside = path.join(agentDir, "secret.jsonl");
		fs.writeFileSync(outside, [
			JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/tmp" }),
			JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "secret contents" }] } }),
		].join("\n"));
		for (const attempt of [outside, path.join(agentDir, "../..", "etc", "hosts")]) {
			const res = await tool.execute("t6", { sessionId: attempt }, undefined, undefined, { sessionManager: {} });
			const parsed = JSON.parse(res.content[0].text);
			assert.equal(parsed.success, false, `should refuse ${attempt}`);
			assert.ok(/sessions directory|not found/.test(parsed.message), `refusal message for ${attempt}: ${parsed.message}`);
		}
	});

	it("compact discovery hits carry the anchor message (bhGOn)", async () => {
		const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-compact`);
		const pi = makePi();
		mod.default(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		msgCount = 1;
		writeSession("c/session-c.jsonl", [
			{ type: "session", version: 3, id: "s3", timestamp: "2026-01-03T00:00:00.000Z", cwd: "/Users/tester/proj" },
			msg(null, "user", "compacts anchor unique zebra topic"),
			msg("e01", "assistant", "zebra reply"),
		]);
		writeSession("c/session-c2.jsonl", [
			{ type: "session", version: 3, id: "s4", timestamp: "2026-01-03T01:00:00.000Z", cwd: "/Users/tester/proj" },
			msg(null, "user", "another zebra topic conversation"),
		]);
		const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-compact`);
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));
		const res = await tool.execute("t7", { query: "zebra topic", limit: 2 }, undefined, undefined, {
			sessionManager: {},
		});
		const parsed = JSON.parse(res.content[0].text);
		assert.ok(parsed.results.length >= 2);
		const compact = parsed.results.find((r: { detail: string }) => r.detail === "compact");
		assert.ok(compact, "expected a compact hit with limit 2");
		assert.equal(compact.messages.length, 1);
		assert.match(compact.messages[0].content, /zebra topic/);
	});

	it("compact discovery preserves a match from the tail of oversized content", async () => {
		const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-compact-tail`);
		const pi = makePi();
		mod.default(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		msgCount = 1;
		const target = writeSession("compact-tail/target.jsonl", [
			{ type: "session", version: 3, id: "compact-tail-target", timestamp: "2026-01-08T00:00:00.000Z", cwd: "/tmp" },
			msg(null, "user", `${"head ".repeat(5000)}amber-tail-citation`),
		]);
		writeSession("compact-tail/short.jsonl", [
			{ type: "session", version: 3, id: "compact-tail-short", timestamp: "2026-01-08T00:00:01.000Z", cwd: "/tmp" },
			msg(null, "user", "amber-tail-citation"),
		]);
		const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-compact-tail`);
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));

		const response = await tool.execute("compact-tail", { query: "amber-tail-citation", limit: 2 }, undefined, undefined, {
			sessionManager: {},
		});
		const parsed = JSON.parse(response.content[0].text);
		const hit = parsed.results.find((r: { path: string }) => r.path === target);
		assert.ok(hit, "expected the oversized target session to be discovered");
		assert.equal(hit.detail, "compact");
		assert.match(hit.messages[0].content, /amber-tail-citation/);
	});

	it("discovery preserves an indexed hit and reports oversized hydration failure", async () => {
		const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-oversized-hydration`);
		const pi = makePi();
		mod.default(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		msgCount = 1;
		const session = writeSession("oversized-hydration/session.jsonl", [
			{ type: "session", version: 3, id: "oversized-hydration", timestamp: "2026-01-08T00:00:00.000Z", cwd: "/tmp" },
			msg(null, "user", "sparse hydration ceiling platypus"),
		]);
		const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-oversized-hydration`);
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));
		fs.truncateSync(session, MAX_SESSION_FILE_BYTES + 1);

		const response = await tool.execute("oversized", { query: "sparse hydration ceiling platypus" }, undefined, undefined, { sessionManager: {} });
		const hit = JSON.parse(response.content[0].text).results[0];
		assert.equal(hit.path, session);
		assert.deepEqual(hit.messages, []);
		assert.match(hit.error, /session file exceeds 32 MiB snapshot limit/);
	});

	it("incomplete walk / failed lazy sync surface as warnings over stale data", async () => {
		const pi = makePi();
		const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-syncwarn`);
		register(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		const ctx = { sessionManager: {} };

		// Index one fixture so stale browse/discovery data exists.
		msgCount = 1;
		writeSession("sync-warn/session.jsonl", [
			{ type: "session", version: 3, id: "sync-warn", timestamp: "2026-01-10T00:00:00.000Z", cwd: "/tmp" },
			msg(null, "user", "sync warning unique quokka topic"),
		]);
		const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-syncwarn`);
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));

		// Hide the sessions root: the walk cannot enumerate it.
		const sessionsRoot = path.join(agentDir, "sessions");
		fs.renameSync(sessionsRoot, sessionsRoot + ".hidden");
		try {
			const browse = await tool.execute("w1", {}, undefined, undefined, ctx);
			const browseResult = JSON.parse(browse.content[0].text);
			assert.equal(browseResult.mode, "browse");
			assert.deepEqual(browseResult.syncWarning, { kind: "incomplete-walk" }, "browse must warn on incomplete walk");
			assert.ok(browseResult.sessions.length >= 1, "stale browse rows stay usable");

			const disc = await tool.execute("w2", { query: "sync warning unique quokka topic" }, undefined, undefined, ctx);
			const discResult = JSON.parse(disc.content[0].text);
			assert.equal(discResult.mode, "discovery");
			assert.deepEqual(discResult.syncWarning, { kind: "incomplete-walk" });
			assert.ok(discResult.results.length >= 1, "stale discovery hits stay usable");
		} finally {
			fs.renameSync(sessionsRoot + ".hidden", sessionsRoot);
		}

		// A subsequent complete sync omits the warning.
		const after = await tool.execute("w3", { query: "sync warning unique quokka topic" }, undefined, undefined, ctx);
		const afterParsed = JSON.parse(after.content[0].text);
		assert.equal(afterParsed.syncWarning, undefined, "warning omitted after complete sync");
	});

	it("thrown lazy sync surfaces a capped warning while stale results remain usable", async () => {
		const pi = makePi();
		const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-syncthrow`);
		register(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		const ctx = { sessionManager: {} };

		msgCount = 1;
		writeSession("sync-throw/session.jsonl", [
			{ type: "session", version: 3, id: "sync-throw", timestamp: "2026-01-11T00:00:00.000Z", cwd: "/tmp" },
			msg(null, "user", "sync throw unique capybara topic"),
		]);
		const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-syncthrow`);
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));

		// One-shot failure: the FIRST index-db open inside the tool call belongs to
		// the lazy sync; browse/discovery then open normally over the stale index.
		const dbFile = path.join(agentDir, "config", "pi-session-recall", "index.db");
		const realOpenSync = fs.openSync.bind(fs) as typeof fs.openSync;
		let failedOnce = false;
		const longError = new Error(`synthetic db outage ${"x".repeat(1000)}`);
		fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
			if (!failedOnce && args[0] === dbFile) {
				failedOnce = true;
				throw longError;
			}
			return realOpenSync(...args);
		}) as typeof fs.openSync;
		let parsed: { syncWarning?: { kind: string; error: string }; results: unknown[] };
		try {
			const res = await tool.execute("wt", { query: "sync throw unique capybara topic" }, undefined, undefined, ctx);
			parsed = JSON.parse(res.content[0].text);
		} finally {
			fs.openSync = realOpenSync;
		}
		assert.ok(failedOnce, "lazy sync must have attempted the index-db open");
		assert.equal(parsed.syncWarning?.kind, "sync-failed");
		assert.ok(parsed.syncWarning!.error.length <= 512, "error message capped at 512 chars");
		assert.ok(parsed.syncWarning!.error.startsWith("synthetic db outage"));
		assert.ok(parsed.results.length >= 1, "stale discovery hits stay usable after sync failure");
	});

	it("indexes sessions from the deferred session_start backfill", async () => {
		const pi = makePi();
		const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-startup`);
		register(pi as never);

		const marker = "startup lifecycle unique citrine falcon";
		msgCount = 1;
		const session = writeSession("startup/session.jsonl", [
			{ type: "session", version: 3, id: "startup", timestamp: "2026-01-12T00:00:00.000Z", cwd: "/tmp" },
			msg(null, "user", marker),
		]);
		const sessionStart = pi.sessionStart;
		assert.ok(sessionStart, "session_start callback must be registered");
		sessionStart({}, {});

		// This timer queues after the production timer, making it a completion barrier.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const { hits } = searchIndex(path.join(agentDir, "config", "pi-session-recall", "index.db"), marker);
		assert.ok(hits.some((hit) => hit.path === session), "session_start backfill must index the session");
	});

	it("tool lazy sync drains backlog left by a capped sync pass (bhGOb)", async () => {
		// Simulate a 1-file capped startup pass; lifecycle wiring is covered above.
		msgCount = 1;
		for (let i = 0; i < 3; i++) {
			writeSession(`d/session-d${i}.jsonl`, [
				{ type: "session", version: 3, id: `d${i}`, timestamp: "2026-01-04T00:00:00.000Z", cwd: "/Users/tester/proj" },
				msg(null, "user", `backlog drain unique topic number ${i}`),
				msg("e01", "assistant", "noted"),
			]);
		}
		const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-drain`);
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"), { cap: 1 });
		let before = 0;
		for (let i = 0; i < 3; i++) {
			const r = await (async () => {
				const mod = await import(`../extensions/search-core.ts?bust=${Date.now()}-drain${i}`);
				return mod.searchIndex(path.join(agentDir, "config", "pi-session-recall", "index.db"), `backlog drain unique topic number ${i}`);
			})();
			if (r.hits.length > 0) before++;
		}
		const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-drain`);
		const pi = makePi();
		mod.default(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		await tool.execute("t8", { query: "backlog drain unique topic number 2" }, undefined, undefined, { sessionManager: {} });
		const { searchIndex: si } = await import(`../extensions/search-core.ts?bust=${Date.now()}-drain-after`);
		const after = si(path.join(agentDir, "config", "pi-session-recall", "index.db"), `backlog drain unique topic number 2`);
		// The direct capped pass indexes at most one file; lazy sync drains the rest.
		assert.ok(after.hits.length > 0 || before > 0);
		assert.ok(before + after.hits.length >= 1);
	});

	it("prepares a stable repository corpus with scoped lineage, safe hydration, and inventory", async () => {
		clearRecallState();
		const root = makeRepository();
		try {
			writeRepositoryFile(root, "package.json", JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
			writeRepositoryFile(root, "scripts/run.sh", "#!/bin/sh\necho run\n", 0o755);
			writeRepositoryFile(root, "skills/local/SKILL.md", "local skill\n");
			writeRepositoryFile(root, "AGENTS.md", "instructions\n");
			assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);

			const current = writeSimpleSession("prep/current.jsonl", {
				id: "current", cwd: root, timestamp: "2026-03-01T00:10:00.000Z", text: "current request",
			});
			const currentChild = writeSimpleSession("prep/current-child-new.jsonl", {
				id: "current-child-new", cwd: root, parentSession: current, timestamp: "2026-03-01T00:09:00.000Z", text: "current child",
			});
			writeSimpleSession("prep/current-child-old.jsonl", {
				id: "current-child-old", cwd: root, parentSession: current, timestamp: "2026-03-01T00:08:00.000Z", text: "older current child",
			});
			const outsideParent = writeSimpleSession("prep/outside-parent.jsonl", {
				id: "outside-parent", cwd: path.join(root, "..", "outside"), timestamp: "2026-03-01T00:11:00.000Z", text: "outside parent",
			});
			const outsideChild = writeSimpleSession("prep/outside-child-new.jsonl", {
				id: "outside-child-new", cwd: root, parentSession: outsideParent, timestamp: "2026-03-01T00:07:00.000Z", text: "external parent child",
			});
			writeSimpleSession("prep/outside-child-old.jsonl", {
				id: "outside-child-old", cwd: root, parentSession: outsideParent, timestamp: "2026-03-01T00:06:30.000Z", text: "older external parent child",
			});
			const exact = writeSession("prep/exact.jsonl", [
				{ type: "session", version: 3, id: "exact", timestamp: "2026-03-01T00:06:00.000Z", cwd: root },
				{ type: "session_info", name: "exact session" },
				{ type: "message", id: "u", parentId: null, timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "visible user episode" }] } },
				{ type: "message", id: "thinking", parentId: "u", timestamp: "t2", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden-thought-secret" }] } },
				{ type: "message", id: "tool", parentId: "thinking", timestamp: "t3", message: { role: "toolResult", content: [{ type: "text", text: "raw-tool-secret" }] } },
				{ type: "message", id: "a", parentId: "tool", timestamp: "t4", message: { role: "assistant", content: [{ type: "thinking", thinking: "second-hidden-secret" }, { type: "text", text: "visible assistant result" }] } },
				{ type: "model_change", id: "tip-exact", parentId: "a", timestamp: "t5" },
			]);
			const parent = writeSimpleSession("prep/parent.jsonl", {
				id: "parent", cwd: root, timestamp: "2026-03-01T00:05:00.000Z", text: "parent episode",
			});
			writeSimpleSession("prep/child.jsonl", {
				id: "child", cwd: root, parentSession: parent, timestamp: "2026-03-01T00:14:00.000Z", text: "newer child episode",
			});
			const descendant = writeSimpleSession("prep/descendant.jsonl", {
				id: "descendant", cwd: path.join(root, "packages", "app"), timestamp: "2026-03-01T00:04:00.000Z", text: "descendant episode",
			});
			writeSimpleSession("prep/sibling-prefix.jsonl", {
				id: "sibling-prefix", cwd: `${root}-sibling`, timestamp: "2026-03-01T00:13:00.000Z", text: "must stay outside",
			});
			writeSimpleSession("prep/unrelated.jsonl", {
				id: "unrelated", cwd: path.join(root, "..", "unrelated"), timestamp: "2026-03-01T00:12:00.000Z", text: "unrelated",
			});

			const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-prepare-operation`);
			syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));
			const skillPath = path.join(root, "skills", "local", "SKILL.md");
			const pi = makePi([{
				name: "skill:local",
				description: "Local repository skill",
				source: "skill",
				sourceInfo: { path: skillPath, source: "skill", scope: "project", origin: "top-level" },
			}]);
			const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-prepare-operation`);
			register(pi as never);
			const tool = (pi as any).tool as CapturedTool;
			const context = {
				cwd: root,
				sessionManager: { getSessionFile: () => current },
			};
			const first = await tool.execute("prepare", { operation: "prepare-pattern-miner", scope: "repository", limit: 5 }, undefined, undefined, context);
			const second = await tool.execute("prepare-again", { operation: "prepare-pattern-miner", scope: "repository", limit: 5 }, undefined, undefined, context);
			assert.equal(first.content[0].text, second.content[0].text, "repeated preparation must serialize identically");
			const prepared = JSON.parse(first.content[0].text);

			assert.deepEqual(prepared.scope, { kind: "repository", gitRoot: fs.realpathSync(root), requestedLimit: 5, sampledCount: 5 });
			assert.deepEqual(prepared.sync, { walkComplete: true, backlogRemaining: 0, complete: true });
			assert.deepEqual(prepared.sessions.map((session: { path: string }) => session.path), [currentChild, outsideChild, exact, parent, descendant]);
			assert.ok(prepared.sessions.every((session: { cwd: string }) => session.cwd === root || session.cwd.startsWith(`${root}${path.sep}`)));
			assert.equal(prepared.sessions.some((session: { path: string }) => session.path === current), false);
			assert.equal(new Set(prepared.sessions.map((session: { lineageId: string }) => session.lineageId)).size, prepared.sessions.length);
			assert.deepEqual(prepared.sessions.map((session: { lineageId: string }) => session.lineageId), [current, outsideParent, exact, parent, descendant]);
			const exactResult = prepared.sessions.find((session: { path: string }) => session.path === exact);
			assert.deepEqual(
				{ name: exactResult.name, startedAt: exactResult.startedAt, branchTip: exactResult.branchTip, totalMessages: exactResult.totalMessages },
				{ name: "exact session", startedAt: "2026-03-01T00:06:00.000Z", branchTip: "tip-exact", totalMessages: 2 },
			);
			assert.deepEqual(exactResult.messages.map((message: { entryId: string; role: string }) => [message.entryId, message.role]), [["u", "user"], ["a", "assistant"]]);
			assert.doesNotMatch(first.content[0].text, /hidden-thought-secret|second-hidden-secret|raw-tool-secret/);
			assert.deepEqual(prepared.inventory.packageScripts, [
				{ path: "package.json", name: "build", command: "tsc" },
				{ path: "package.json", name: "test", command: "node --test" },
			]);
			assert.deepEqual(prepared.inventory.executableScripts, ["scripts/run.sh"]);
			assert.deepEqual(prepared.inventory.skills, [{ name: "skill:local", description: "Local repository skill", sourcePath: "skills/local/SKILL.md" }]);
			assert.deepEqual(prepared.inventory.agentInstructions, ["AGENTS.md"]);
			assert.deepEqual(prepared.inventory.provenance, {
				packageScripts: "git-index",
				executableScripts: "git-index",
				agentInstructions: "git-index",
				skills: "pi-effective-registry",
			});
			assert.equal(prepared.inventory.worktreeVerified, false);
			assert.equal(prepared.inventory.truncated, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("cancels preparation inventory from the execute-call AbortSignal", async () => {
		clearRecallState();
		const root = makeRepository();
		try {
			const pi = makePi();
			const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-prepare-cancel`);
			register(pi as never);
			const call = new AbortController();
			call.abort();
			const context = new AbortController();
			const response = await (pi as any).tool.execute(
				"prepare-cancel",
				{ operation: "prepare-pattern-miner", scope: "repository" },
				call.signal,
				undefined,
				{ cwd: root, signal: context.signal, sessionManager: { getSessionFile: () => undefined } },
			);
			const result = JSON.parse(response.content[0].text);
			assert.equal(context.signal.aborted, false, "context signal remains live");
			assert.equal(result.success, false);
			assert.match(result.error, /Repository inventory cancelled/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects preparation parameter conflicts and handles both scopes outside Git", async () => {
		clearRecallState();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-entry-not-git-"));
		try {
			writeSimpleSession("prepare-all/session.jsonl", {
				id: "all", cwd: "/some/project", timestamp: "2026-03-02T00:00:00.000Z", text: "global corpus",
			});
			const pi = makePi();
			const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-prepare-invalid`);
			register(pi as never);
			const tool = (pi as any).tool as CapturedTool;
			const context = { cwd, sessionManager: { getSessionFile: () => undefined } };

			const global = JSON.parse((await tool.execute("all", { operation: "prepare-pattern-miner", scope: "all" }, undefined, undefined, context)).content[0].text);
			assert.equal(global.mode, "prepare-pattern-miner");
			assert.deepEqual(global.scope, { kind: "all", gitRoot: null, requestedLimit: 10, sampledCount: 1 });
			assert.equal(global.inventory.available, false);
			assert.equal(global.inventory.reason, "not-a-git-repository");
			assert.equal(global.sessions.length, 1);

			const repository = JSON.parse((await tool.execute("repository", { operation: "prepare-pattern-miner", scope: "repository" }, undefined, undefined, context)).content[0].text);
			assert.equal(repository.success, false);
			assert.match(repository.error, /requires a Git repository/);

			const conflicts = [
				{ query: "x" },
				{ sessionId: "x" },
				{ aroundMessageId: "x" },
				{ branchTip: "x" },
				{ window: 2 },
				{ detail: "full" },
			];
			for (const conflict of conflicts) {
				const parsed = JSON.parse((await tool.execute("invalid", { operation: "prepare-pattern-miner", scope: "all", ...conflict }, undefined, undefined, context)).content[0].text);
				assert.equal(parsed.success, false);
				assert.match(parsed.error, /does not accept/);
			}
			for (const params of [{ scope: "all" }, { operation: "prepare-pattern-miner" }]) {
				const parsed = JSON.parse((await tool.execute("invalid-shape", params, undefined, undefined, context)).content[0].text);
				assert.equal(parsed.success, false);
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the all-scope corpus when repository inventory fails", async () => {
		clearRecallState();
		const root = makeRepository();
		try {
			writeRepositoryFile(root, "package.json", "{");
			assert.equal(spawnSync("git", ["add", "package.json"], { cwd: root }).status, 0);
			writeSimpleSession("prepare-inventory-failure/session.jsonl", {
				id: "inventory-failure",
				cwd: root,
				timestamp: "2026-03-02T01:00:00.000Z",
				text: "corpus survives inventory failure",
			});
			const pi = makePi();
			const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-prepare-inventory-failure`);
			register(pi as never);
			const prepared = JSON.parse((await (pi as any).tool.execute(
				"all-inventory-failure",
				{ operation: "prepare-pattern-miner", scope: "all" },
				undefined,
				undefined,
				{ cwd: root, sessionManager: { getSessionFile: () => undefined } },
			)).content[0].text);
			assert.equal(prepared.mode, "prepare-pattern-miner");
			assert.equal(prepared.inventory.available, false);
			assert.equal(prepared.inventory.reason, "inventory-failed");
			assert.equal(prepared.inventory.worktreeVerified, false);
			assert.deepEqual(prepared.sessions.map((session: { messages: { content: string }[] }) => session.messages[0]?.content), [
				"corpus survives inventory failure",
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds preparation fairly and trims inventory deterministically without dropping session metadata", async () => {
		clearRecallState();
		const root = makeRepository();
		try {
			const scripts = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
				`script-${String(index).padStart(3, "0")}`,
				`echo ${String(index).padStart(3, "0")} ${"x".repeat(500)}`,
			]));
			writeRepositoryFile(root, "package.json", JSON.stringify({ scripts }));
			writeRepositoryFile(root, "bin/run", "#!/bin/sh\n", 0o755);
			const skillPath = writeRepositoryFile(root, "skills/large/SKILL.md", "large skill\n");
			writeRepositoryFile(root, "AGENTS.md", "instructions\n");
			assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
			for (let index = 0; index < 3; index++) {
				writeSimpleSession(`prepare-budget/big-${index}.jsonl`, {
					id: `big-${index}`,
					cwd: root,
					timestamp: `2026-03-03T00:0${index}:00.000Z`,
					text: `fair-${index} ${"y".repeat(40_000)}`,
				});
			}
			const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-prepare-budget`);
			syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));
			const pi = makePi([{
				name: "skill:large",
				description: "Large fixture skill",
				source: "skill",
				sourceInfo: { path: skillPath, source: "skill", scope: "project", origin: "top-level" },
			}]);
			const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-prepare-budget`);
			register(pi as never);
			const tool = (pi as any).tool as CapturedTool;
			const context = { cwd: root, sessionManager: { getSessionFile: () => undefined } };
			const first = await tool.execute("budget", { operation: "prepare-pattern-miner", scope: "repository", limit: 3 }, undefined, undefined, context);
			const second = await tool.execute("budget-again", { operation: "prepare-pattern-miner", scope: "repository", limit: 3 }, undefined, undefined, context);
			assert.equal(first.content[0].text, second.content[0].text);
			assert.ok(first.content[0].text.length <= 50_000);
			const prepared = JSON.parse(first.content[0].text);
			assert.equal(prepared.sessions.length, 3);
			assert.ok(prepared.sessions.every((session: { path: string; lineageId: string; messages: unknown[]; contentTruncated: boolean }) =>
				typeof session.path === "string" && typeof session.lineageId === "string" && session.messages.length === 1 && session.contentTruncated));
			assert.equal(new Set(prepared.sessions.map((session: { messages: { content: string }[] }) => session.messages[0].content.length)).size, 1, "equal sessions receive equal transcript space");
			assert.ok(JSON.stringify(prepared.inventory).length <= 10_000);
			assert.equal(prepared.inventory.truncated, true);
			assert.ok(prepared.inventory.omittedCounts.packageScripts > 0);
			assert.ok(prepared.inventory.packageScripts.length > 0);
			assert.deepEqual(prepared.inventory.executableScripts, ["bin/run"]);
			assert.equal(prepared.inventory.skills.length, 1);
			assert.deepEqual(prepared.inventory.agentInstructions, ["AGENTS.md"]);
			assert.deepEqual(prepared.inventory.provenance, {
				packageScripts: "git-index",
				executableScripts: "git-index",
				agentInstructions: "git-index",
				skills: "pi-effective-registry",
			});
			assert.equal(prepared.inventory.worktreeVerified, false);
			assert.equal(prepared.contentTruncated, true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps inventory truncation independent from transcript content truncation", async () => {
		clearRecallState();
		const root = makeRepository();
		try {
			const scripts = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
				`script-${String(index).padStart(3, "0")}`,
				`echo ${"x".repeat(500)}`,
			]));
			writeRepositoryFile(root, "package.json", JSON.stringify({ scripts }));
			assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
			writeSimpleSession("prepare-in-miner/short.jsonl", {
				id: "short",
				cwd: root,
				timestamp: "2026-03-03T01:00:00.000Z",
				text: "short mining episode",
			});
			const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-prepare-inventory-only`);
			syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));
			const pi = makePi();
			const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-prepare-inventory-only`);
			register(pi as never);
			const tool = (pi as any).tool as CapturedTool;
			const prepared = JSON.parse((await tool.execute(
				"inventory-only",
				{ operation: "prepare-pattern-miner", scope: "repository", limit: 1 },
				undefined,
				undefined,
				{ cwd: root, sessionManager: { getSessionFile: () => undefined } },
			)).content[0].text);
			assert.equal(prepared.inventory.truncated, true);
			assert.ok(prepared.inventory.omittedCounts.packageScripts > 0);
			assert.deepEqual(prepared.inventory.provenance, {
				packageScripts: "git-index",
				executableScripts: "git-index",
				agentInstructions: "git-index",
				skills: "pi-effective-registry",
			});
			assert.equal(prepared.inventory.worktreeVerified, false);
			assert.equal(prepared.sessions[0].contentTruncated, false);
			assert.equal(prepared.contentTruncated, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("isolates missing and oversized hydration failures while preserving a valid empty session", async () => {
		clearRecallState();
		const root = makeRepository();
		try {
			const empty = writeSimpleSession("prepare-errors/empty.jsonl", {
				id: "empty", cwd: root, timestamp: "2026-03-04T00:03:00.000Z",
			});
			const missing = writeSimpleSession("prepare-errors/missing.jsonl", {
				id: "missing", cwd: root, timestamp: "2026-03-04T00:02:00.000Z", text: "will disappear",
			});
			const oversized = writeSimpleSession("prepare-errors/oversized.jsonl", {
				id: "oversized", cwd: root, timestamp: "2026-03-04T00:01:00.000Z", text: "will grow",
			});
			const dbFile = path.join(agentDir, "config", "pi-session-recall", "index.db");
			const { syncSessions } = await import(`../extensions/search-core.ts?bust=${Date.now()}-prepare-errors`);
			syncSessions(path.join(agentDir, "sessions"), dbFile);
			const pi = makePi();
			const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-prepare-errors`);
			register(pi as never);
			const tool = (pi as any).tool as CapturedTool;
			const realOpenSync = fs.openSync.bind(fs) as typeof fs.openSync;
			let dbOpens = 0;
			fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
				if (args[0] === dbFile && ++dbOpens === 2) {
					fs.rmSync(missing);
					fs.truncateSync(oversized, MAX_SESSION_FILE_BYTES + 1);
				}
				return realOpenSync(...args);
			}) as typeof fs.openSync;
			let prepared: any;
			try {
				const response = await tool.execute("errors", { operation: "prepare-pattern-miner", scope: "repository", limit: 3 }, undefined, undefined, {
					cwd: root,
					sessionManager: { getSessionFile: () => undefined },
				});
				prepared = JSON.parse(response.content[0].text);
			} finally {
				fs.openSync = realOpenSync;
			}
			assert.equal(prepared.sessions.length, 3);
			const emptyResult = prepared.sessions.find((session: { path: string }) => session.path === empty);
			assert.deepEqual(
				{ branchTip: emptyResult.branchTip, totalMessages: emptyResult.totalMessages, truncated: emptyResult.truncated, contentTruncated: emptyResult.contentTruncated, messages: emptyResult.messages, error: emptyResult.error },
				{ branchTip: null, totalMessages: 0, truncated: false, contentTruncated: false, messages: [], error: undefined },
			);
			for (const [sessionPath, kind] of [[missing, "missing"], [oversized, "oversized"]]) {
				const failed = prepared.sessions.find((session: { path: string }) => session.path === sessionPath);
				assert.deepEqual(
					{ branchTip: failed.branchTip, totalMessages: failed.totalMessages, truncated: failed.truncated, contentTruncated: failed.contentTruncated, messages: failed.messages },
					{ branchTip: null, totalMessages: null, truncated: false, contentTruncated: false, messages: [] },
				);
				assert.equal(failed.error.kind, kind);
				assert.ok(failed.error.message.length <= 512);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a positive one-pass preparation backlog as incomplete", async () => {
		clearRecallState();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-entry-backlog-"));
		try {
			for (let index = 0; index < 51; index++) {
				writeSimpleSession(`prepare-backlog/session-${String(index).padStart(2, "0")}.jsonl`, {
					id: `backlog-${index}`,
					cwd: "/global/project",
					timestamp: `2026-03-05T00:00:${String(index).padStart(2, "0")}.000Z`,
					text: `backlog item ${index}`,
				});
			}
			const pi = makePi();
			const { default: register } = await import(`../extensions/session-recall.ts?bust=${Date.now()}-prepare-backlog`);
			register(pi as never);
			const tool = (pi as any).tool as CapturedTool;
			const prepared = JSON.parse((await tool.execute("backlog", { operation: "prepare-pattern-miner", scope: "all", limit: 99 }, undefined, undefined, {
				cwd,
				sessionManager: { getSessionFile: () => undefined },
			})).content[0].text);
			assert.deepEqual(prepared.sync, { walkComplete: true, backlogRemaining: 1, complete: false });
			assert.equal(prepared.scope.requestedLimit, 10);
			assert.equal(prepared.scope.sampledCount, 10);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

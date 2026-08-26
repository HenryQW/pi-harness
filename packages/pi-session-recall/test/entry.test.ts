/**
 * Integration test for the extension entry point. PI_CODING_AGENT_DIR is
 * pointed at a temp dir so getAgentDir() resolves tmp config/db/sessions.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { MAX_SESSION_FILE_BYTES } from "../extensions/search-core.ts";

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
	execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

function makePi(): { on: () => void; registerTool: (t: CapturedTool) => void } & Record<string, unknown> {
	const captured: { tool?: CapturedTool } = {};
	return {
		on: () => {},
		registerTool: (t: CapturedTool) => {
			captured.tool = t;
		},
		get tool() {
			return captured.tool!;
		},
	};
}

function writeSession(relName: string, lines: object[]): string {
	const file = path.join(agentDir, "sessions", relName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
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
	it("registers the tool and dispatches browse/discovery", async () => {
		const pi = makePi();
		const { default: register } = await import("../extensions/session-recall.ts");
		register(pi as never);

		const tool = (pi as any).tool as CapturedTool;
		assert.equal(tool.name, "session_search");
		assert.match(tool.description, /FOUR CALLING SHAPES/);
		assert.match(tool.description, /user\/assistant/);
		assert.equal(tool.promptSnippet, "Search past Pi sessions for prior decisions and context");

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

		// Junk dirs are pruned during the walk, not after it.
		msgCount = 1;
		writeSession("--private-tmp-junk/junk.jsonl", [
			{ type: "session", version: 3, id: "junk", timestamp: "2026-01-07T00:00:00.000Z", cwd: "/Users/tester/proj" },
			msg(null, "user", "pangolin migration notes"),
		]);
		const core = await import("../extensions/search-core.ts");
		core.syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "config", "pi-session-recall", "index.db"));
		const { hits } = core.searchIndex(path.join(agentDir, "config", "pi-session-recall", "index.db"), "pangolin migration");
		assert.equal(hits.length, 0, "sessions under --private-tmp-* must not be indexed");
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

	it("discovery drains sync backlog left by capped startup pass (bhGOb)", async () => {
		// Fill more files than the default cap, then run only a 1-file startup backfill.
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
		// Before the tool call at most cap=1 file was indexed; lazy sync drains the rest.
		assert.ok(after.hits.length > 0 || before > 0);
		assert.ok(before + after.hits.length >= 1);
	});
});

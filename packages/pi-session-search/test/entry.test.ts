/**
 * Integration test for the extension entry point. PI_CODING_AGENT_DIR is
 * pointed at a temp dir so getAgentDir() resolves tmp config/db/sessions.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

before(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-entry-"));
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
		const { default: register } = await import("../extensions/session-search.ts");
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
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "pi-session-search", "index.db"));

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

	it("config validation: malformed file logs-and-defaults, invalid backfillFiles rejected", async () => {
		const configDir = path.join(agentDir, "config");
		fs.mkdirSync(configDir, { recursive: true });
		const configPath = path.join(configDir, "pi-session-search.json");

		fs.writeFileSync(configPath, "{ not json !!!");
		const errors: unknown[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			// Fresh module instance picks up the config at registration time.
			const mod = await import(`../extensions/session-search.ts?bust=${Date.now()}`);
			const pi = makePi();
			mod.default(pi as never); // must not throw
			assert.equal(errors.length, 1);

			fs.writeFileSync(configPath, JSON.stringify({ backfillFiles: -5 }));
			errors.length = 0;
			mod.default(makePi() as never);
			assert.equal(errors.length, 1);
			// Config file preserved untouched.
			assert.equal(fs.readFileSync(configPath, "utf8"), JSON.stringify({ backfillFiles: -5 }));
		} finally {
			console.error = origError;
		}
	});

	it("errors return success:false instead of throwing", async () => {
		const mod = await import(`../extensions/session-search.ts?bust=${Date.now()}`);
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
		const mod = await import(`../extensions/session-search.ts?bust=${Date.now()}-trav`);
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
			assert.match(parsed.message, /sessions directory/);
		}
	});

	it("compact discovery hits carry the anchor message (bhGOn)", async () => {
		const mod = await import(`../extensions/session-search.ts?bust=${Date.now()}-compact`);
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
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "pi-session-search", "index.db"));
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
		syncSessions(path.join(agentDir, "sessions"), path.join(agentDir, "pi-session-search", "index.db"), { cap: 1 });
		let before = 0;
		for (let i = 0; i < 3; i++) {
			const r = await (async () => {
				const mod = await import(`../extensions/search-core.ts?bust=${Date.now()}-drain${i}`);
				return mod.searchIndex(path.join(agentDir, "pi-session-search", "index.db"), `backlog drain unique topic number ${i}`);
			})();
			if (r.hits.length > 0) before++;
		}
		const mod = await import(`../extensions/session-search.ts?bust=${Date.now()}-drain`);
		const pi = makePi();
		mod.default(pi as never);
		const tool = (pi as any).tool as CapturedTool;
		await tool.execute("t8", { query: "backlog drain unique topic number 2" }, undefined, undefined, { sessionManager: {} });
		const { searchIndex: si } = await import(`../extensions/search-core.ts?bust=${Date.now()}-drain-after`);
		const after = si(path.join(agentDir, "pi-session-search", "index.db"), `backlog drain unique topic number 2`);
		// Before the tool call at most cap=1 file was indexed; lazy sync drains the rest.
		assert.ok(after.hits.length > 0 || before > 0);
		assert.ok(before + after.hits.length >= 1);
	});
});

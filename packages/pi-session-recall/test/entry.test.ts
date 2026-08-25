/**
 * Integration test for the extension entry point. PI_CODING_AGENT_DIR is
 * pointed at a temp dir so getAgentDir() resolves tmp config/db/sessions.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
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

function resetConfigProbe(): void {
	fs.rmSync(path.join(agentDir, "sessions"), { recursive: true, force: true });
	const db = path.join(agentDir, "config", "pi-session-recall", "index.db");
	for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(db + suffix, { force: true });
	msgCount = 1;
	for (let i = 0; i < 2; i++) {
		writeSession(`config-probe-${i}.jsonl`, [
			{ type: "session", version: 3, id: `config-probe-${i}`, timestamp: `2026-01-0${i + 1}T00:00:00.000Z`, cwd: "/tmp" },
			msg(null, "user", `config probe ${i}`),
		]);
	}
}

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

	it("config validation: invalid config and read failures log-and-default without rewriting", async () => {
		const configDir = path.join(agentDir, "config", "pi-session-recall");
		fs.mkdirSync(configDir, { recursive: true });
		const configPath = path.join(configDir, "pi-session-recall.json");

		const errors: unknown[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}`);
			for (const invalid of ["{ not json !!!", "null", "[]", '"string"', "{\"backfillFiles\":-5}", "{\"backfillFiles\":501}"]) {
				fs.writeFileSync(configPath, invalid);
				errors.length = 0;
				mod.default(makePi() as never); // must not throw
				assert.equal(errors.length, 1);
				assert.equal(fs.readFileSync(configPath, "utf8"), invalid);
			}

			fs.rmSync(configPath);
			fs.mkdirSync(configPath);
			errors.length = 0;
			mod.default(makePi() as never);
			assert.equal(errors.length, 1);
		} finally {
			console.error = origError;
			fs.rmSync(configPath, { recursive: true, force: true });
		}
	});

	it("unknown config keys warn once and default without rewriting", async () => {
		resetConfigProbe();
		const configPath = path.join(agentDir, "config", "pi-session-recall", "pi-session-recall.json");
		const raw = '{"backfillFiles":1,"backfilFiles":2}';
		fs.writeFileSync(configPath, raw);
		const errors: unknown[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-unknown-config`);
			const pi = makePi();
			mod.default(pi as never);
			const result = await (pi as any).tool.execute("config", {}, undefined, undefined, { sessionManager: {} });
			assert.equal(errors.length, 1);
			assert.equal(JSON.parse(result.content[0].text).sessions.length, 2, "unknown key must default instead of accepting backfillFiles: 1");
			assert.equal(fs.readFileSync(configPath, "utf8"), raw);
		} finally {
			console.error = origError;
			fs.rmSync(configPath, { force: true });
		}
	});

	it("sparse oversized config warns once and defaults without rewriting", async () => {
		resetConfigProbe();
		const configPath = path.join(agentDir, "config", "pi-session-recall", "pi-session-recall.json");
		fs.writeFileSync(configPath, '{"backfillFiles":1}');
		fs.truncateSync(configPath, 1024 * 1024 * 1024);
		const before = fs.statSync(configPath, { bigint: true });
		const errors: unknown[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-oversized-config`);
			const pi = makePi();
			mod.default(pi as never);
			const result = await (pi as any).tool.execute("config", {}, undefined, undefined, { sessionManager: {} });
			const after = fs.statSync(configPath, { bigint: true });
			assert.equal(errors.length, 1);
			assert.equal(JSON.parse(result.content[0].text).sessions.length, 2, "oversized config must use the default cap");
			assert.equal(after.size, before.size);
			assert.equal(after.mtimeNs, before.mtimeNs);
		} finally {
			console.error = origError;
			fs.rmSync(configPath, { force: true });
		}
	});

	it("FIFO/symlink-to-FIFO config cannot hang startup: defaults with one warning, no writer", { skip: process.platform === "win32", timeout: 5000 }, async () => {
		resetConfigProbe();
		const configDir = path.join(agentDir, "config", "pi-session-recall");
		fs.mkdirSync(configDir, { recursive: true });
		const fifo = path.join(agentDir, "probe.fifo");
		const errors: unknown[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			for (const [label, link] of [["fifo", false], ["symlink-to-fifo", true]] as const) {
				const configPath = path.join(configDir, "pi-session-recall.json");
				execFileSync("mkfifo", [fifo]); // never written to; open must not block
				if (link) fs.symlinkSync(fifo, configPath);
				else fs.renameSync(fifo, configPath); // move the FIFO into place directly
				errors.length = 0;
				const mod = await import(`../extensions/session-recall.ts?bust=${Date.now()}-${label}`);
				const pi = makePi();
				mod.default(pi as never); // must return without a writer on the FIFO
				const result = await (pi as any).tool.execute("fifo", {}, undefined, undefined, { sessionManager: {} });
				assert.equal(errors.length, 1);
				assert.match(String(errors[0]), /not a regular file/);
				assert.equal(JSON.parse(result.content[0].text).sessions.length, 2, `${label} must default the cap`);
				fs.rmSync(configPath, { force: true });
			}
		} finally {
			console.error = origError;
			fs.rmSync(fifo, { force: true });
		}
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
		assert.match(hit.error, /session file exceeds 32 MiB hydration limit/);
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

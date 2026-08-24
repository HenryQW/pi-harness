/**
 * Tests for the index engine. No network, no pi runtime imports — fixture
 * JSONL files are written to a temp dir per run.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildFtsQueryPlan, DEFAULT_SYNC_CAP, getSessionRows, MAX_QUERY_CHARS, searchIndex, syncSessions } from "../extensions/search-core.ts";

let tmp: string;
let sessionsDir: string;
let dbPath: string;

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-test-"));
	sessionsDir = path.join(tmp, "sessions");
	dbPath = path.join(tmp, "index.db");
});

after(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

// --- fixture helpers ---

function sessionHeader(opts: { cwd?: string; parentSession?: string } = {}) {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: crypto.randomUUID(),
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: opts.cwd ?? "/Users/tester/proj",
		...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
	});
}

function msg(id: string, role: "user" | "assistant", text: string) {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:01:00.000Z",
		message: { role, content: [{ type: "text", text }] },
	});
}

/** Write a fixture session file; returns its path. mtimeMs is staggered by index order. */
function writeFixture(dirName: string, fileName: string, lines: string[], mtimeOffsetMs = 0): string {
	const dir = path.join(sessionsDir, dirName);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, fileName);
	fs.writeFileSync(file, lines.join("\n") + "\n");
	const t = new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + mtimeOffsetMs);
	fs.utimesSync(file, t, t);
	return file;
}

describe("sync + BM25 search", () => {
	it("indexes user/assistant text and finds hits with snippet", () => {
		writeFixture("--users-tester-proj--", "a.jsonl", [
			sessionHeader(),
			msg("u1", "user", "How do I configure the deploy pipeline for staging?"),
			msg("a1", "assistant", "The deploy pipeline config lives in deploy.yml under the staging key."),
			JSON.stringify({ type: "message", id: "t1", message: { role: "toolResult", content: [{ type: "text", text: "deploy pipeline tool output noise" }] } }),
			JSON.stringify({ type: "message", id: "th1", message: { role: "assistant", content: [{ type: "thinking", thinking: "thinking about deploy pipeline" }, { type: "text", text: "visible answer" }] } }),
			JSON.stringify({ type: "compaction", id: "c1", summaryText: "compaction mentions deploy pipeline" }),
			JSON.stringify({ type: "session_info", id: "si1", name: "Deploy pipeline chat" }),
		]);

		const res = syncSessions(sessionsDir, dbPath);
		assert.equal(res.filesProcessed, 1);
		assert.equal(res.backlogRemaining, 0);

		const { hits } = searchIndex(dbPath, "deploy pipeline");
		assert.ok(hits.length > 0, "expected at least one hit");
		assert.equal(hits[0].path, path.join(sessionsDir, "--users-tester-proj--", "a.jsonl"));
		assert.ok(["u1", "a1"].includes(hits[0].entryId), `unexpected entry ${hits[0].entryId}`);
		assert.ok(hits[0].snippet.length > 0 && /[[]/.test(hits[0].snippet), "snippet should contain markers");

		// thinking / toolResult / compaction absent
		const all = searchIndex(dbPath, "noise");
		assert.equal(all.hits.length, 0);
		const think = searchIndex(dbPath, '"thinking about deploy"');
		assert.equal(think.hits.length, 0);
	});

	it("re-sync of unchanged file is a no-op; append reindexes; delete purges", () => {
		const file = path.join(sessionsDir, "--users-tester-proj--", "a.jsonl");
		const before = searchIndex(dbPath, "staging");
		assert.ok(before.hits.length > 0);

		const resNoop = syncSessions(sessionsDir, dbPath);
		assert.equal(resNoop.filesProcessed, 0);
		assert.equal(resNoop.messagesIndexed, 0);

		fs.appendFileSync(file, msg("u2", "user", "unique-zebra-query about kubernetes ingress\n") );
		const t = new Date();
		fs.utimesSync(file, t, t);
		const res2 = syncSessions(sessionsDir, dbPath);
		assert.equal(res2.filesProcessed, 1);
		assert.equal(searchIndex(dbPath, "unique-zebra-query").hits.length, 1);

		fs.rmSync(file);
		syncSessions(sessionsDir, dbPath);
		assert.equal(searchIndex(dbPath, "unique-zebra-query").hits.length, 0);
		assert.equal(getSessionRows(dbPath, 100).length, 0);

		// restore for later suites
		writeFixture("--users-tester-proj--", "a.jsonl", [
			sessionHeader(),
			msg("u1", "user", "How do I configure the deploy pipeline for staging?"),
			msg("a1", "assistant", "The deploy pipeline config lives in deploy.yml under the staging key."),
			JSON.stringify({ type: "session_info", id: "si1", name: "Deploy pipeline chat" }),
		]);
	});

	it("caps per call, newest-first, reports backlog and catches up", () => {
		for (let i = 0; i < 5; i++) {
			writeFixture(`--cap-proj-${i}--`, `${i}.jsonl`, [sessionHeader(), msg("m1", "user", `capfile${i} marker number`)], i * 1000);
		}
		const r1 = syncSessions(sessionsDir, dbPath, { cap: 2 });
		// 6 changed: 5 capfiles + a.jsonl restored by the previous suite
		assert.equal(r1.filesProcessed, 2);
		assert.equal(r1.backlogRemaining, 4);
		// newest first: files 4 and 3 indexed (highest mtime offsets)
		assert.ok(searchIndex(dbPath, `"capfile4"`).hits.length === 1);
		assert.ok(searchIndex(dbPath, `"capfile3"`).hits.length === 1);
		assert.ok(searchIndex(dbPath, `"capfile0"`).hits.length === 0);

		const r2 = syncSessions(sessionsDir, dbPath, { cap: 2 });
		assert.equal(r2.filesProcessed, 2);
		assert.equal(r2.backlogRemaining, 2);
		const r3 = syncSessions(sessionsDir, dbPath, { cap: DEFAULT_SYNC_CAP });
		assert.equal(r3.filesProcessed, 2);
		assert.equal(r3.backlogRemaining, 0);
		assert.ok(searchIndex(dbPath, `"capfile0"`).hits.length === 1);
	});
});

describe("sanitize ladder", () => {
	it("natural language query is quoted term-by-term (implicit AND)", () => {
		const plan = buildFtsQueryPlan('  what about "quoted phrases" and stuff?  ');
		assert.deepEqual(plan.ftsCandidates[0], `"what" "about" "quoted phrases" "and" "stuff"`);
		assert.equal(plan.forceLike, false);
	});

	it("explicit operator queries pass raw with quoted recovery then OR", () => {
		const plan = buildFtsQueryPlan("error AND NOT (unterminated");
		assert.deepEqual(plan.ftsCandidates, [`error AND NOT (unterminated`, `"error" "AND" "NOT" "(unterminated"`, `"error" OR "AND" OR "NOT" OR "(unterminated"`]);
	});

	it("explicit operators with short terms route to boolean LIKE (bhZel)", () => {
		const plan = buildFtsQueryPlan("Go OR Rust");
		assert.equal(plan.forceLike, true);
		assert.equal(plan.ftsCandidates.length, 0);
	});

	it("trailing wildcard keeps FTS5 prefix syntax (bnRnk)", () => {
		const plan = buildFtsQueryPlan("deploy*");
		assert.deepEqual(plan.ftsCandidates[0], `"deploy"*`);
		const { hits } = searchIndex(dbPath, "deploy*");
		assert.ok(hits.length >= 1, "prefix query must match indexed deploy text");
	});

	it("technical sigils survive boundary normalization (bhZeo)", () => {
		const plan = buildFtsQueryPlan("C++ templates");
		assert.match(plan.ftsCandidates[0], /"C\+\+"/);
	});

	it("parse-error recovery falls back through ladder to deploy hits (bhZf0)", () => {
		// raw form is an FTS5 syntax error; recovery candidates and the LIKE
		// fallback must still surface existing deploy hits
		const { hits } = searchIndex(dbPath, 'deploy AND NOT ("unterminated');
		assert.ok(hits.length >= 1, "malformed query must recover an existing deploy hit");
	});

	it("queries with every term <3 chars use LIKE fallback", () => {
		const plan = buildFtsQueryPlan("ab cd");
		assert.equal(plan.forceLike, true);
		assert.equal(plan.ftsCandidates.length, 0);
		// e2e: LIKE matches substring that trigram cannot
		// "yml" is a substring of deploy.yml; trigram handles it
		assert.ok(searchIndex(dbPath, "yml").hits.length >= 1);
		// ".y" is below the trigram floor → only the LIKE path can find it
		assert.equal(buildFtsQueryPlan(".y").forceLike, true);
		const like = searchIndex(dbPath, ".y");
		assert.ok(like.hits.length >= 1, "LIKE fallback must match short substrings");
		assert.equal(searchIndex(dbPath, "*").hits.length, 0, "empty wildcard must not match every session");
	});

	it("512 char cap truncates query", () => {
		const long = "x".repeat(600); // single term past the cap
		const plan = buildFtsQueryPlan(long);
		// quoted form adds one quote per side only
		assert.ok(plan.ftsCandidates[0].length <= MAX_QUERY_CHARS + 2);
	});

	it("CJK terms match via trigram", () => {
		writeFixture("--cjk-proj--", "cjk.jsonl", [sessionHeader(), msg("u1", "user", "今天我们要讨论部署流水线的配置问题")]);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		const { hits } = searchIndex(dbPath, "部署流水线");
		assert.equal(hits.length, 1);
		assert.ok(hits[0].snippet.includes("部署流水线") || hits[0].snippet.length > 0);
	});
});

describe("lineage + guards", () => {
	it("collapses child into parent when parent has hits; not when parent file absent", () => {
		const parentFile = writeFixture("--parent-proj--", "parent.jsonl", [
			sessionHeader(),
			msg("p1", "user", "lineage-marker shared topic in the root session"),
		], 10000);
		const childFile = writeFixture("--child-proj--", "child.jsonl", [
			sessionHeader({ parentSession: parentFile }),
			msg("c1", "assistant", "lineage-marker shared topic answered in the fork"),
		], 20000);

		syncSessions(sessionsDir, dbPath, { cap: 10 });
		let { hits } = searchIndex(dbPath, "lineage-marker shared topic");
		assert.equal(hits.length, 1);
		assert.equal(hits[0].path, parentFile, "parent-rooted hit must win");

		// remove parent → child no longer suppressed
		fs.rmSync(parentFile);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		({ hits } = searchIndex(dbPath, "lineage-marker shared topic"));
		assert.equal(hits.length, 1);
		assert.equal(hits[0].path, childFile);
	});

	it("current-session guard skips live entries only in the current file", () => {
		const cur = path.join(sessionsDir, "--users-tester-proj--", "a.jsonl");
		const { hits } = searchIndex(dbPath, "deploy pipeline", {
			currentSessionPath: cur,
			currentLiveEntryIds: new Set(["u1"]),
		});
		for (const h of hits) {
			assert.ok(!(h.path === cur && h.entryId === "u1"));
		}
	});

	it("suppressed live hit on parent does not suppress a matching child (bhGOs)", () => {
		const parentFile = writeFixture("--lg-parent--", "parent.jsonl", [
			sessionHeader(),
			msg("p1", "user", "guardlineage shared topic in the root session"),
		], 30000);
		writeFixture("--lg-child--", "child.jsonl", [
			sessionHeader({ parentSession: parentFile }),
			msg("c1", "assistant", "guardlineage shared topic answered in the fork"),
		], 31000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		// Parent's only match is on its live branch → suppressed; child must survive.
		const { hits } = searchIndex(dbPath, "guardlineage shared topic", {
			currentSessionPath: parentFile,
			currentLiveEntryIds: new Set(["p1"]),
		});
		assert.equal(hits.length, 1);
		assert.equal(hits[0].path.endsWith("child.jsonl"), true);
	});

	it("failing newest file does not monopolize the sync cap (bmSMo)", () => {
		// Newest file permanently fails the transaction (duplicate entry id).
		const dup = JSON.stringify({ type: "message", id: "dup", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "dup id one" }] } });
		writeFixture("--cap-fail--", "bad.jsonl", [
			sessionHeader(),
			dup,
			dup.replace("one", "two"),
		], 90000);
		writeFixture("--cap-ok1--", "ok1.jsonl", [
			sessionHeader(),
			msg("g1", "user", "capfail unique marker one"),
		], 80000);
		writeFixture("--cap-ok2--", "ok2.jsonl", [
			sessionHeader(),
			msg("g2", "user", "capfail unique marker two"),
		], 70000);
		const res = syncSessions(sessionsDir, dbPath, { cap: 1 });
		// Failed newest file doesn't consume the cap: one good file still indexes.
		assert.equal(res.filesProcessed, 1);
		assert.ok(res.backlogRemaining >= 1, "failed file must stay in the backlog");
		assert.equal(searchIndex(dbPath, "capfail unique marker one").hits.length, 1);
	});

	it("entries without valid ids are skipped without aborting the pass (bhGOu)", () => {
		writeFixture("--bad-ids--", "bad.jsonl", [
			sessionHeader(),
			JSON.stringify({ type: "message", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "idless alpha message" }] } }),
			msg("ok1", "assistant", "idless beta reply with good id"),
		], 40000);
		const res = syncSessions(sessionsDir, dbPath, { cap: 10 });
		assert.ok(res.filesProcessed >= 1);
		const { hits } = searchIndex(dbPath, "idless beta");
		assert.equal(hits.length, 1);
	});
});

describe("sanitize ladder regression", () => {
	it("mixed short-term query routes through LIKE and still matches (bhGOl)", () => {
		writeFixture("--short-mix--", "mix.jsonl", [
			sessionHeader(),
			msg("m1", "user", "we chose the Go deployment strategy for the edge service"),
		], 50000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		const plan = buildFtsQueryPlan("Go deployment");
		assert.equal(plan.forceLike, true);
		const { hits } = searchIndex(dbPath, "Go deployment");
		assert.equal(hits.length, 1);
	});

	it("boolean LIKE fallback surfaces both sides of OR with short operands (bhZey)", () => {
		writeFixture("--rust-proj--", "rust.jsonl", [
			sessionHeader(),
			msg("r1", "user", "we picked Rust for the CLI renderer rewrite"),
		], 55000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		const { hits } = searchIndex(dbPath, "Go OR Rust", { limit: 5 });
		const paths = hits.map((h) => h.path);
		assert.ok(paths.some((p) => p.includes("--short-mix--")), "Go-only session must surface for `Go OR Rust`");
		assert.ok(paths.some((p) => p.includes("--rust-proj--")), "Rust-only session must surface for `Go OR Rust`");

		const filtered = searchIndex(dbPath, "Go OR (Rust NOT renderer)", { limit: 5 }).hits;
		assert.ok(filtered.some((h) => h.path.includes("--short-mix--")), "parenthesized OR must keep the Go side");
		assert.ok(!filtered.some((h) => h.path.includes("--rust-proj--")), "NOT must exclude the Rust renderer session");
	});

	it("LIKE fallback treats trailing FTS wildcard as prefix, not literal (bhZf1)", () => {
		const { hits } = searchIndex(dbPath, "Go deploy*");
		assert.equal(hits.length, 1, "`Go deploy*` must match 'Go deployment strategy'");
	});

	it("LIKE fallback results carry a snippet (bhGOt)", () => {
		const { hits } = searchIndex(dbPath, "Go deployment");
		assert.ok(hits[0].snippet.length > 0 && /Go deployment|deployment/i.test(hits[0].snippet));
	});

	it("boundary punctuation is stripped from NL terms end-to-end (bhGOw)", () => {
		const { hits } = searchIndex(dbPath, "Go deployment strategy?");
		assert.equal(hits.length, 1);
	});

	it("hits carry joined session metadata (bhGO0)", () => {
		const { hits } = searchIndex(dbPath, "Go deployment");
		assert.ok(hits[0].cwd && hits[0].startedAt);
	});

	it("verbose session cannot exhaust the scan ceiling (bhGOz)", () => {
		const lines = [sessionHeader()];
		for (let i = 0; i < 60; i++) lines.push(msg(`v${i}`, "assistant", `verbose-flood repeated marker text block number ${i}`));
		writeFixture("--flood--", "flood.jsonl", lines, 60000);
		writeFixture("--quiet--", "quiet.jsonl", [
			sessionHeader(),
			msg("q1", "user", "verbose-flood mentioned once here in a quiet session"),
		], 61000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		const { hits } = searchIndex(dbPath, "verbose-flood", { limit: 5 });
		const paths = new Set(hits.map((h) => h.path));
		assert.equal(paths.size, 2, "both sessions must surface despite flood volume");
	});
});

describe("browse", () => {
	it("returns recent sessions newest-first", () => {
		const rows = getSessionRows(dbPath, 100);
		assert.ok(rows.length >= 2);
		const times = rows.filter((r) => r.startedAt).map((r) => r.startedAt!);
		const sorted = [...times].sort().reverse();
		assert.deepEqual(times, sorted);
		const cjkRow = rows.find((r) => r.path.endsWith("cjk.jsonl"));
		assert.equal(cjkRow?.preview?.slice(0, 4), "今天我们");
		assert.equal(cjkRow?.cwd, "/Users/tester/proj");
	});
});

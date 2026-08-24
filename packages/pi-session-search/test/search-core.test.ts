/**
 * Tests for the index engine. No network, no pi runtime imports — fixture
 * JSONL files are written to a temp dir per run.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
		assert.deepEqual(plan.ftsCandidates, [`error AND NOT (unterminated`, `"error" "AND" "NOT" "unterminated"`, `"error" OR "AND" OR "NOT" OR "unterminated"`]);
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

	it("collapses lineage before the scan limit", () => {
		const parent = writeFixture("--lineage-cap-parent--", "parent.jsonl", [
			sessionHeader(),
			msg("lcp", "user", "lineagecap marker"),
		], 21000);
		for (let i = 0; i < 300; i++) {
			writeFixture(`--lineage-cap-child-${i}--`, "child.jsonl", [
				sessionHeader({ parentSession: parent }),
				msg(`lcc${i}`, "assistant", "lineagecap marker"),
			], 22000 + i);
		}
		for (let i = 0; i < 10; i++) {
			writeFixture(`--lineage-cap-other-${i}--`, "other.jsonl", [
				sessionHeader(),
				msg(`lco${i}`, "user", `lineagecap marker unrelated ${i}`),
			], 23000 + i);
		}
		syncSessions(sessionsDir, dbPath, { cap: 500 });
		const { hits } = searchIndex(dbPath, "lineagecap marker", { limit: 10 });
		assert.equal(hits.length, 10, "collapsed children must not consume the scan limit");
		assert.ok(hits.every((h) => !h.path.includes("lineage-cap-child")));
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

	it("duplicate ids are first-wins across entry types", () => {
		writeFixture("--cap-fail--", "bad.jsonl", [
			sessionHeader(),
			JSON.stringify({ type: "custom", id: "dup", parentId: null, timestamp: "t" }),
			msg("dup", "user", "duplicate searchable text must not index"),
			msg("unique", "assistant", "unique searchable text indexes"),
		], 90000);
		writeFixture("--cap-ok1--", "ok1.jsonl", [
			sessionHeader(),
			msg("g1", "user", "capfail unique marker one"),
		], 80000);
		const res = syncSessions(sessionsDir, dbPath, { cap: 10 });
		assert.equal(res.filesProcessed, 2, "duplicate ids must not fail the transaction");
		assert.equal(searchIndex(dbPath, "duplicate searchable text").hits.length, 0);
		assert.equal(searchIndex(dbPath, "unique searchable text").hits.length, 1);
		assert.equal(searchIndex(dbPath, "capfail unique marker one").hits.length, 1);
	});

	it("transient read failure is retried on the next pass without file changes (regression)", () => {
		const target = writeFixture("--transient--", "t.jsonl", [
			sessionHeader(),
			msg("tr1", "user", "transient retry unique marker text"),
		], 95000);
		const origRead = fs.readFileSync;
		let failed = false;
		try {
			fs.readFileSync = ((p: any, ...rest: any[]) => {
				if (p === target && !failed) {
					failed = true; // stat succeeded, first read fails once
					throw new Error("EIO simulated");
				}
				return (origRead as any).call(fs, p, ...rest);
			}) as typeof fs.readFileSync;
			const first = syncSessions(sessionsDir, dbPath);
			assert.equal(first.filesProcessed, 0, "simulated transient read must fail the pass");
		} finally {
			fs.readFileSync = origRead;
		}
		// File is unchanged — no fingerprint cache may block the retry.
		const second = syncSessions(sessionsDir, dbPath);
		assert.equal(second.filesProcessed, 1, "unchanged file must be retried and indexed");
		assert.equal(searchIndex(dbPath, "transient retry unique marker").hits.length, 1);
	});

	it("persistent failures retry without starving older healthy files", () => {
		const failing = writeFixture("--retry-order--", "fail.jsonl", [
			sessionHeader(),
			msg("rf", "user", "retry order eventually indexed"),
		], 99500);
		writeFixture("--retry-order--", "ok1.jsonl", [sessionHeader(), msg("ro1", "user", "retry order healthy one")], 99400);
		writeFixture("--retry-order--", "ok2.jsonl", [sessionHeader(), msg("ro2", "user", "retry order healthy two")], 99300);
		const origRead = fs.readFileSync;
		let fail = true;
		try {
			fs.readFileSync = ((p: any, ...rest: any[]) => {
				if (p === failing && fail) throw new Error("persistent EIO simulated");
				return (origRead as any).call(fs, p, ...rest);
			}) as typeof fs.readFileSync;
			const first = syncSessions(sessionsDir, dbPath, { cap: 1 });
			assert.equal(first.filesProcessed, 0);
			assert.equal(first.backlogRemaining, 3, "attempted failure remains backlog");
			assert.equal(syncSessions(sessionsDir, dbPath, { cap: 1 }).filesProcessed, 1);
			const third = syncSessions(sessionsDir, dbPath, { cap: 1 });
			assert.equal(third.filesProcessed, 1, "second healthy file must not starve");
			assert.equal(third.backlogRemaining, 1);
			fail = false;
			assert.equal(syncSessions(sessionsDir, dbPath, { cap: 1 }).backlogRemaining, 0);
		} finally {
			fs.readFileSync = origRead;
		}
		assert.equal(searchIndex(dbPath, "retry order healthy one", { limit: 5 }).hits.length, 1);
		assert.equal(searchIndex(dbPath, "retry order healthy two", { limit: 5 }).hits.length, 1);
	});

	it("persistent failures rotate under a small cap instead of retrying only the newest (regression)", () => {
		const oldFail = writeFixture("--rotation--", "old-fail.jsonl", [sessionHeader(), msg("of", "user", "rotation marker old")], 80000);
		const newFail = writeFixture("--rotation--", "new-fail.jsonl", [sessionHeader(), msg("nf", "user", "rotation marker new")], 90000);
		const origRead = fs.readFileSync;
		const reads = new Set<string>();
		try {
			fs.readFileSync = ((p: any, ...rest: any[]) => {
				if (p === oldFail || p === newFail) {
					reads.add(p as string);
					throw new Error("persistent EIO simulated");
				}
				return (origRead as any).call(fs, p, ...rest);
			}) as typeof fs.readFileSync;
			// Seed BOTH failure rows in one pass (cap >= 2) so neither file is
			// "fresh" afterward — only retry rotation can reach the older one.
			syncSessions(sessionsDir, dbPath, { cap: 2 });
			reads.clear();
			for (let i = 0; i < 3; i++) syncSessions(sessionsDir, dbPath, { cap: 1 });
		} finally {
			fs.readFileSync = origRead;
		}
		assert.ok(reads.has(oldFail), "older persistent failure must eventually be attempted, not starve behind the newest");
	});

	it("grouping parens outside quotes are stripped from terms before planning (regression)", () => {
		const plan = buildFtsQueryPlan("(deploy pipeline)");
		assert.deepEqual(plan.ftsCandidates[0], `"deploy" "pipeline"`);
		assert.equal(plan.forceLike, false);
		const { hits } = searchIndex(dbPath, "(deploy pipeline)");
		assert.ok(hits.length >= 1, "parenthesized natural query must match deploy pipeline hits");
	});

	it("NEAR with short operands falls back to LIKE over operand terms, not literal NEAR (regression)", () => {
		writeFixture("--near-proj--", "near.jsonl", [
			sessionHeader(),
			msg("n1", "user", "we wrote the CLI in Go AND kept the parser in Rust here"),
		], 96000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		assert.equal(buildFtsQueryPlan("NEAR(Go Rust)").forceLike, true);
		const { hits } = searchIndex(dbPath, "NEAR(Go Rust)");
		assert.equal(hits.length, 1, "NEAR operands must be searched via LIKE fallback");
		assert.ok(!hits[0].snippet.includes("NEAR"), "snippet terms must not anchor on the operator");
		assert.equal(searchIndex(dbPath, "NEAR(Go Rust, 5)").hits.length, 1, "NEAR distance is syntax, not an operand");
		assert.equal(searchIndex(dbPath, "NEAR(Go \"AND\")").hits.length, 1, "quoted operator word remains an operand");
	});

	it("short-term floor counts Unicode code points, not UTF-16 units (two-emoji term)", () => {
		writeFixture("--emoji-proj--", "emoji.jsonl", [
			sessionHeader(),
			msg("em1", "user", "ship it \u{1F680}\u{1F680} today please"),
		], 97000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		// Two emoji = 4 UTF-16 units but 2 code points → below trigram floor → LIKE.
		const plan = buildFtsQueryPlan("\u{1F680}\u{1F680}");
		assert.equal(plan.forceLike, true);
		const { hits } = searchIndex(dbPath, "\u{1F680}\u{1F680}");
		assert.equal(hits.length, 1, "two-emoji term must match via LIKE fallback");
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

describe("legacy schema migration", () => {
	it("discards and rebuilds an incompatible 0.1.2-era index.db (regression)", () => {
		const legacyDir = path.join(tmp, "legacy-sessions");
		const legacyDb = path.join(tmp, "legacy-index.db");
		fs.mkdirSync(legacyDir, { recursive: true });
		const file = path.join(legacyDir, "l.jsonl");
		fs.writeFileSync(file, [sessionHeader(), msg("lg1", "user", "legacy schema migration unique marker")].join("\n") + "\n");
		// Build a database with the OLD (0.1.2) schema: no attempts column.
		const db = new DatabaseSync(legacyDb);
		db.exec(`
			CREATE TABLE session_files (
				path TEXT PRIMARY KEY,
				size INTEGER NOT NULL,
				mtime_ms INTEGER NOT NULL
			);
			CREATE TABLE session_failures (
				path TEXT PRIMARY KEY,
				size INTEGER NOT NULL,
				mtime_ms INTEGER NOT NULL
			);
		`);
		const stat = fs.statSync(file);
		db.prepare("INSERT INTO session_failures(path, size, mtime_ms) VALUES (?, ?, ?)").run(file, stat.size, Math.floor(stat.mtimeMs));
		db.close();

		const res = syncSessions(legacyDir, legacyDb);
		assert.equal(res.filesProcessed, 1);
		assert.equal(searchIndex(legacyDb, "legacy schema migration unique marker").hits.length, 1);
	});

	describe("sanitize ladder regressions from review", () => {
		it("unmatched quote is malformed syntax, not searchable text", () => {
			writeFixture("--quote-fix--", "q.jsonl", [
				sessionHeader(),
				msg("uq1", "user", "we finished the zqxlaunch on Friday morning"),
			], 120000);
			syncSessions(sessionsDir, dbPath, { cap: 10 });
			const plan = buildFtsQueryPlan('"zqxlaunch');
			assert.ok(!plan.ftsCandidates.some((candidate) => candidate.includes('""')), "unmatched quote must not become literal quote text");
			assert.equal(searchIndex(dbPath, '"zqxlaunch').hits.length, 1, 'query with unmatched opening quote must match ordinary text');
		});

		it("NEAR distance attached to the operand comma is recognized as syntax", () => {
			writeFixture("--near-comma--", "n.jsonl", [
				sessionHeader(),
				msg("nc1", "user", "first Go ZqRust then zqxwrap"),
			], 121000);
			syncSessions(sessionsDir, dbPath, { cap: 10 });
			assert.equal(searchIndex(dbPath, "NEAR(Go ZqRust,10)").hits.length, 1, "attached NEAR distance must not be searched as literal text");
		});
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

	it("quoted LIKE operands keep parentheses during balance recovery", () => {
		const abi = writeFixture("--abi--", "abi.jsonl", [
			sessionHeader(),
			msg("ab1", "user", "we call the runtime via C(ABI) from Zig here"),
		], 58000);
		const literal = writeFixture("--func-open--", "literal.jsonl", [sessionHeader(), msg("fo1", "user", "literal func( token")], 58100);
		const falsePositive = writeFixture("--func-word--", "word.jsonl", [sessionHeader(), msg("fw1", "user", "plain func token")], 58200);
		const attached = writeFixture("--attached-paren--", "attached.jsonl", [sessionHeader(), msg("ap1", "user", "foo bar operands")], 58300);
		syncSessions(sessionsDir, dbPath, { cap: 10 });

		const { hits } = searchIndex(dbPath, 'Go OR "C(ABI)"', { limit: 5 });
		assert.ok(hits.some((h) => h.path === abi), "quoted `C(ABI)` must match literal parens text under LIKE");
		assert.ok(hits.every((h) => !h.snippet.includes(" ( ")), "snippet must not anchor on operator words or mangled phrases");
		const openParenHits = searchIndex(dbPath, 'Go OR "func("', { limit: 20 }).hits;
		assert.ok(openParenHits.some((h) => h.path === literal));
		assert.ok(!openParenHits.some((h) => h.path === falsePositive), "quoted `func(` must not broaden to `func`");
		assert.ok(searchIndex(dbPath, "Qx OR foo(bar", { limit: 20 }).hits.some((h) => h.path === attached), "removed grouping parens must not merge operands");
	});

	it("LIKE fallback ranks sessions by matching messages, not insertion order", () => {
		const frequent = writeFixture("--like-frequent--", "frequent.jsonl", [
			sessionHeader(),
			msg("lf1", "user", "Qx first match"),
			msg("lf2", "assistant", "Qx second match"),
			msg("lf3", "user", "Qx third match"),
		], 57000);
		writeFixture("--like-recent--", "recent.jsonl", [sessionHeader(), msg("lr1", "user", "Qx only match")], 56000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		const { hits } = searchIndex(dbPath, "Qx", { limit: 5 });
		assert.equal(hits[0].path, frequent);
	});

	it("untrusted header metadata is capped at parse time (qIqk)", () => {
		writeFixture("--huge-meta--", "meta.jsonl", [
			JSON.stringify({ type: "session", version: 3, id: "hm", timestamp: "2".repeat(100_000), cwd: "/".repeat(100_000) }),
			JSON.stringify({ type: "session_info", name: "n".repeat(100_000) }),
			msg("hm1", "user", "metadata cap fixture text"),
		], 59000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		const rows = getSessionRows(dbPath, 10);
		const row = rows.find((r) => r.cwd && r.cwd.length > 2)!;
		assert.ok(row.cwd.length <= 500, "cwd must be capped");
		const named = rows.find((r) => r.name);
		if (named) assert.ok(named.name!.length <= 500, "name must be capped");
		const huge = rows.find((r) => r.path.endsWith("meta.jsonl"));
		assert.ok((huge?.startedAt?.length ?? 0) <= 128, "session timestamp must be capped");
	});

	it("truncated indexed text contains no synthetic searchable text", () => {
		const seamText = `${"x".repeat(9_984)}abc${"m".repeat(100)}def${"y".repeat(9_997)}`;
		writeFixture("--raw-truncate--", "raw.jsonl", [
			sessionHeader(),
			msg("rt1", "user", `actualneedle ${seamText}`),
		], 59100);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		assert.equal(searchIndex(dbPath, "actualneedle").hits.length, 1);
		assert.equal(searchIndex(dbPath, "truncated").hits.filter((h) => h.path.endsWith("raw.jsonl")).length, 0);
		assert.equal(searchIndex(dbPath, "abcdef").hits.filter((h) => h.path.endsWith("raw.jsonl")).length, 0, "truncation seam must not create a searchable token");
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

	it("3000+ row verbose session cannot starve a quiet matching session (bhGOz)", () => {
		const lines = [sessionHeader()];
		// Shorter rows rank above the quiet file and used to fill the 3000-row
		// pre-partition limit before that second session could enter the window.
		for (let i = 0; i < 3100; i++) lines.push(msg(`v${i}`, "assistant", "verbose-flood"));
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

describe("SQL prefilter + parse semantics + walk safety", () => {
	it("live-entry prefilter lets lower-ranked historical entry on same file surface", () => {
		const file = writeFixture("--live-guard--", "lg.jsonl", [
			sessionHeader(),
			...Array.from({ length: 8 }, (_, i) => msg(`lg${i}`, "assistant", `Go livesearch unique marker instance ${i}`)),
		], 70000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		// Seven matches are live; the historical one must survive the per-file
		// cap because suppression runs before ranking in both FTS and LIKE paths.
		const opts = {
			currentSessionPath: file,
			currentLiveEntryIds: new Set(["lg0", "lg1", "lg2", "lg3", "lg4", "lg5", "lg6"]),
		};
		const ftsHits = searchIndex(dbPath, "livesearch unique marker", opts).hits;
		assert.equal(ftsHits.length, 1);
		assert.equal(ftsHits[0].entryId, "lg7");
		const likeHits = searchIndex(dbPath, "Go livesearch", opts).hits;
		assert.equal(likeHits.length, 1);
		assert.equal(likeHits[0].entryId, "lg7");
	});

	it("parsed query with zero rows stays empty; malformed recovers via LIKE", () => {
		const none = searchIndex(dbPath, "nonexistent AND deploy");
		assert.equal(none.hits.length, 0, "zero-row parsed candidate must not broaden to OR/LIKE");
		const recovered = searchIndex(dbPath, 'deploy AND NOT ("unterminated');
		assert.ok(recovered.hits.length >= 1, "malformed query must still recover deploy hits");
	});

	it("readdir failure in an indexed subdir preserves indexed data and indexes other dirs", () => {
		const target = path.join(sessionsDir, "--flood--");
		const origReaddir = fs.readdirSync;
		writeFixture("--walk-ok--", "ok.jsonl", [sessionHeader(), msg("w1", "user", "walksafety unique survivor marker")], 72000);
		try {
			fs.readdirSync = ((dir: any, opts?: any) => {
				if (dir === target) throw new Error("EACCES simulated");
				return origReaddir.call(fs, dir, opts);
			}) as typeof fs.readdirSync;
			syncSessions(sessionsDir, dbPath, { cap: 50 });
			// Deterministic: only --flood-- fails; every other directory is fully read.
			assert.ok(searchIndex(dbPath, "walksafety unique survivor").hits.length === 1,
				"new file discovered around the failure must still be processed");
		} finally {
			fs.readdirSync = origReaddir;
		}
		// Data preservation: incomplete walk must not purge --flood--'s rows.
		const { hits } = searchIndex(dbPath, "verbose-flood");
		assert.ok(hits.some((hit) => hit.path.startsWith(target)), "indexed rows from the unreadable directory must survive");
	});
});

describe("transaction atomicity", () => {
	it("failure after in-transaction delete rolls back; prior rows stay searchable and retry succeeds", () => {
		const file = writeFixture("--rollback--", "r.jsonl", [
			sessionHeader(),
			msg("rb1", "user", "rollback survivor marker one"),
			msg("rb2", "assistant", "rollback survivor marker two"),
		]);
		syncSessions(sessionsDir, dbPath);
		assert.equal(searchIndex(dbPath, "rollback survivor marker").hits.length, 1);

		// Change the file so it re-syncs, then sabotage message inserts so the
		// transaction fails AFTER the existing rows were deleted inside it.
		fs.appendFileSync(file, msg("rb3", "user", "rollback newcomer never indexed\n"));
		const t = new Date();
		fs.utimesSync(file, t, t);
		const origPrepare = DatabaseSync.prototype.prepare;
		try {
			(DatabaseSync.prototype as any).prepare = function (sql: string) {
				if (sql.startsWith("INSERT INTO messages")) {
					return { run: () => { throw new Error("simulated mid-transaction insert failure"); } };
				}
				return origPrepare.call(this, sql);
			};
			const res = syncSessions(sessionsDir, dbPath);
			assert.equal(res.filesProcessed, 0, "sabotaged insert must fail the pass");
		} finally {
			DatabaseSync.prototype.prepare = origPrepare;
		}

		// Rollback preserved the previously indexed rows.
		assert.equal(searchIndex(dbPath, "rollback survivor marker").hits.length, 1);
		assert.equal(searchIndex(dbPath, "rollback newcomer").hits.length, 0);

		// Fault removed: retry re-indexes the file.
		const second = syncSessions(sessionsDir, dbPath);
		assert.equal(second.filesProcessed, 1);
		assert.equal(searchIndex(dbPath, "rollback newcomer").hits.length, 1);
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

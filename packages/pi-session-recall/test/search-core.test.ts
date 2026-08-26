/**
 * Tests for the index engine. No network, no pi runtime imports — fixture
 * JSONL files are written to a temp dir per run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { buildFtsQueryPlan, DEFAULT_SYNC_CAP, getSessionRows, MAX_QUERY_CHARS, readBoundedSnapshot, searchIndex, syncSessions } from "../extensions/search-core.ts";
import { getWindow } from "../extensions/hydrate.ts";

let tmp: string;
let sessionsDir: string;
let dbPath: string;

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-test-"));
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
		assert.deepEqual(plan.ftsCandidates, [`error AND NOT (unterminated`, `"error" "unterminated"`, `"error" OR "unterminated"`]);
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

	it("quoted trailing wildcard stays literal (regression)", () => {
		const literal = writeFixture("--literal-star--", "literal.jsonl", [sessionHeader(), msg("ls1", "user", "Qj run deploy* exactly as written")], 150000);
		const expanded = writeFixture("--expanded-star--", "expanded.jsonl", [sessionHeader(), msg("es1", "user", "Qj ordinary deployment text")], 150100);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		assert.deepEqual(buildFtsQueryPlan('"deploy*"').ftsCandidates[0], '"deploy*"');
		const { hits } = searchIndex(dbPath, '"deploy*"', { limit: 10 });
		assert.ok(hits.some((hit) => hit.path === literal), "quoted star must match a literal deploy*");
		assert.ok(!hits.some((hit) => hit.path === expanded), "quoted star must not expand to deployment");
		const likeHits = searchIndex(dbPath, 'Qj "deploy*"', { limit: 10 }).hits;
		assert.ok(likeHits.some((hit) => hit.path === literal), "quoted star stays literal in the short-term LIKE path");
		assert.ok(!likeHits.some((hit) => hit.path === expanded), "LIKE must not expand a quoted star");
		fs.rmSync(literal);
		fs.rmSync(expanded);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
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

	it("does not self-suppress malformed self-parent sessions in FTS or LIKE", () => {
		const selfFile = path.join(sessionsDir, "--self-parent--", "self.jsonl");
		writeFixture("--self-parent--", "self.jsonl", [
			sessionHeader({ parentSession: selfFile }),
			msg("self", "user", "selfparentftsmarker q7"),
		], 25000);
		writeFixture("--self-parent-child--", "child.jsonl", [
			sessionHeader({ parentSession: selfFile }),
			msg("child", "assistant", "selfparentftsmarker q7"),
		], 26000);

		syncSessions(sessionsDir, dbPath, { cap: 10 });
		assert.equal(buildFtsQueryPlan("q7").forceLike, true);
		for (const [query, pathLabel] of [["selfparentftsmarker", "FTS"], ["q7", "LIKE"]] as const) {
			const hits = searchIndex(dbPath, query, { limit: 10 }).hits;
			assert.deepEqual(hits.map((hit) => hit.path), [selfFile], `${pathLabel} should keep self-parent and suppress its child`);
		}
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

	it("current-session guard suppresses oversized messages by their real entry id", () => {
		const big = "x".repeat(20000);
		const fragFile = writeFixture("--lg-frag--", "frag.jsonl", [
			sessionHeader(),
			msg("f1", "user", `fragmentguard unique marker ${big}`),
		], 40000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		const { hits } = searchIndex(dbPath, "fragmentguard unique marker", {
			currentSessionPath: fragFile,
			currentLiveEntryIds: new Set(["f1"]),
		});
		assert.ok(!hits.some((h) => h.path === fragFile), "live oversized-message hits must be suppressed");
	});

	it("real entry ids ending in #h/#t survive search and hydration untouched", () => {
		writeFixture("--suffix-ids--", "sid.jsonl", [
			sessionHeader(),
			msg("u1#t", "user", "suffixid unique marker alpha"),
			msg("u2#h", "assistant", "suffixid reply beta"),
		], 140000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		const hit = searchIndex(dbPath, "suffixid beta").hits[0];
		assert.ok(hit, "message with #h-suffixed real id is found");
		assert.equal(hit.entryId, "u2#h", "hit carries the exact source id");
		// The exact hit id anchors a window (the discovery→scroll flow).
		const w = getWindow(path.join(sessionsDir, "--suffix-ids--", "sid.jsonl"), hit.entryId, 5);
		assert.ok(w.messages.some((m) => m.entryId === "u2#h" && m.anchor === true));
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
		const origOpen = fs.openSync;
		let failed = false;
		try {
			fs.openSync = ((p: any, ...rest: any[]) => {
				if (p === target && !failed) {
					failed = true; // stat succeeded, first open/read fails once
					throw new Error("EIO simulated");
				}
				return (origOpen as any).call(fs, p, ...rest);
			}) as typeof fs.openSync;
			const first = syncSessions(sessionsDir, dbPath);
			assert.equal(first.filesProcessed, 0, "simulated transient read must fail the pass");
		} finally {
			fs.openSync = origOpen;
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
		const origOpen = fs.openSync;
		let fail = true;
		try {
			fs.openSync = ((p: any, ...rest: any[]) => {
				if (p === failing && fail) throw new Error("persistent EIO simulated");
				return (origOpen as any).call(fs, p, ...rest);
			}) as typeof fs.openSync;
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
			fs.openSync = origOpen;
		}
		assert.equal(searchIndex(dbPath, "retry order healthy one", { limit: 5 }).hits.length, 1);
		assert.equal(searchIndex(dbPath, "retry order healthy two", { limit: 5 }).hits.length, 1);
	});

	it("persistent failures rotate under a small cap instead of retrying only the newest (regression)", () => {
		const oldFail = writeFixture("--rotation--", "old-fail.jsonl", [sessionHeader(), msg("of", "user", "rotation marker old")], 80000);
		const newFail = writeFixture("--rotation--", "new-fail.jsonl", [sessionHeader(), msg("nf", "user", "rotation marker new")], 90000);
		const origOpen = fs.openSync;
		const reads = new Set<string>();
		try {
			fs.openSync = ((p: any, ...rest: any[]) => {
				if (p === oldFail || p === newFail) {
					reads.add(p as string);
					throw new Error("persistent EIO simulated");
				}
				return (origOpen as any).call(fs, p, ...rest);
			}) as typeof fs.openSync;
			// Seed BOTH failure rows in one pass (cap >= 2) so neither file is
			// "fresh" afterward — only retry rotation can reach the older one.
			syncSessions(sessionsDir, dbPath, { cap: 2 });
			reads.clear();
			for (let i = 0; i < 3; i++) syncSessions(sessionsDir, dbPath, { cap: 1 });
		} finally {
			fs.openSync = origOpen;
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

	it("NEAR is a bounded operand in composed boolean LIKE expressions", () => {
		const nearby = writeFixture("--near-proj--", "near.jsonl", [sessionHeader(), msg("n1", "user", "Go Rust AND stay nearby")], 96000);
		const far = writeFixture("--near-far--", "far.jsonl", [sessionHeader(), msg("nf1", "user", `Go ${"arbitrarily distant ".repeat(20)}Rust`)], 96100);
		const blocked = writeFixture("--near-blocked--", "blocked.jsonl", [sessionHeader(), msg("nb1", "user", "Go Rust ZqBlocked")], 96200);
		const alternative = writeFixture("--near-alt--", "alt.jsonl", [sessionHeader(), msg("na1", "user", "ZqAlt only")], 96300);
		syncSessions(sessionsDir, dbPath, { cap: 10 });

		assert.equal(buildFtsQueryPlan("NEAR(Go Rust)").forceLike, true);
		const hits = searchIndex(dbPath, "((NEAR(Go Rust) AND NOT ZqBlocked) OR ZqAlt)", { limit: 10 }).hits;
		assert.deepEqual(new Set(hits.map((hit) => hit.path)), new Set([nearby, alternative]), "NEAR composes with grouping, AND, OR, and NOT without admitting distant or blocked matches");
		assert.ok(!hits.find((hit) => hit.path === nearby)!.snippet.includes("NEAR"), "snippet terms must not anchor on the operator");
		assert.equal(searchIndex(dbPath, "NEAR(Go, Rust)").hits.length, 0, "a comma between operands is malformed and must fail closed");
		assert.equal(searchIndex(dbPath, "NEAR(Go \"AND\")").hits.length, 1, "quoted operator word remains an operand");
		for (const file of [nearby, far, blocked, alternative]) fs.rmSync(file);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
	});

	it("NEAR keeps prior semantics on overlapping intervals (NEAR(a aaa,0) inside aaa)", () => {
		// Short operands route through the LIKE fallback's unear UDF. The prior
		// sliding-window sweep matches at distance 0 because the nested a@(1,2)
		// sits fully inside aaa@(0,3): max(start) - min(end) + 2 = 0.
		writeFixture("--near-overlap--", "overlap.jsonl", [
			sessionHeader(),
			msg("ov-u1", "user", "aaa"),
		]);
		syncSessions(sessionsDir, dbPath);
		const { hits } = searchIndex(dbPath, "NEAR(a aaa,0)");
		assert.equal(hits.length, 1);
		assert.equal(hits[0].entryId, "ov-u1");
	});

	it("NEAR with hundreds of repeated common operands still matches after deduplication", () => {
		// 100 duplicate operands fit well under the 512-char query cap; before
		// operand deduplication each repeat materialized every occurrence of "rs"
		// independently per candidate row. Dedup must leave the result unchanged.
		const query = `NEAR(${Array<string>(100).fill("rs").join(" ")} kubernetes,10)`;
		assert.ok(query.length <= MAX_QUERY_CHARS);
		writeFixture("--near-dedupe--", "dedupe.jsonl", [
			sessionHeader(),
			msg("dd-u1", "user", "deploy rs with kubernetes nearby"),
		]);
		syncSessions(sessionsDir, dbPath);
		const { hits } = searchIndex(dbPath, query);
		assert.equal(hits.length, 1);
		assert.equal(hits[0].entryId, "dd-u1");
		// A missing distinct operand still gates the whole NEAR expression.
		const gated = searchIndex(dbPath, `NEAR(${Array<string>(100).fill("rs").join(" ")} zebraqqq,10)`);
		assert.equal(gated.hits.length, 0);
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

describe("incompatible index schema", () => {
	it("an old-schema index fails visibly without deletion or rebuild; tightening may still occur", { skip: process.platform === "win32" }, () => {
		const prev = process.umask(0o022);
		try {
			const staleDir = path.join(tmp, "stale-schema");
			fs.mkdirSync(staleDir, { recursive: true });
			fs.chmodSync(staleDir, 0o755);
			const staleDb = path.join(staleDir, "index.db");
			// OLD (0.1.2-era) schema: session_failures has no attempts column and
			// messages has id/text instead of entry_id/head/tail.
			const db = new DatabaseSync(staleDb);
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
				CREATE TABLE messages (
					id TEXT PRIMARY KEY,
					session_path TEXT NOT NULL,
					role TEXT NOT NULL,
					text TEXT NOT NULL
				);
			`);
			db.prepare("INSERT INTO messages(id, session_path, role, text) VALUES (?, ?, ?, ?)").run("ghost1", "/x", "user", "stale old-schema ghost marker");
			db.close();
			fs.chmodSync(staleDb, 0o644);

			// Operations against an incompatible index must throw, not silently
			// delete/rebuild it (WAL header bytes may change; sentinel data must not).
			assert.throws(() => syncSessions(sessionsDir, staleDb), /attempts|no such column|no such table/i);
			assert.throws(() => searchIndex(staleDb, ".g"), /head|tail|entry_id|no such column|no such table/i);

			// The file survives with its sentinel schema/data intact; only
			// owner-only permission tightening may have occurred.
			assert.equal(fs.statSync(staleDb).mode & 0o777, 0o600, "permissive db may still be tightened");
			assert.equal(fs.statSync(staleDir).mode & 0o777, 0o700, "permissive dir may still be tightened");
			const check = new DatabaseSync(staleDb, { readOnly: true });
			try {
				const columns = check.prepare("PRAGMA table_info(messages)").all().map((c: any) => c.name);
				assert.deepEqual(columns, ["id", "session_path", "role", "text"], "old schema layout must be preserved untouched");
				assert.equal(check.prepare("SELECT text FROM messages WHERE id = 'ghost1'").get()?.text, "stale old-schema ghost marker", "sentinel row must survive");
			} finally {
				check.close();
			}
		} finally {
			process.umask(prev);
		}
	});

	describe("sanitize ladder regressions from review", () => {
		it("unmatched quote is stripped in the boolean LIKE path too", () => {
			writeFixture("--quote-like--", "ql.jsonl", [
				sessionHeader(),
				msg("ql1", "user", "ordinary Zqxlang vocabulary notes"),
			], 130000);
			syncSessions(sessionsDir, dbPath, { cap: 10 });
			assert.equal(searchIndex(dbPath, '"Zqxlang').hits.length, 1, 'short malformed query with unmatched quote must still match');
		});

		it("recovery operands exclude syntax operator words", () => {
			writeFixture("--op-recovery--", "or.jsonl", [
				sessionHeader(),
				msg("or1", "user", "a quiet line with and but no marker word"),
			], 131000);
			syncSessions(sessionsDir, dbPath, { cap: 10 });
			const hits = searchIndex(dbPath, "ZqMarker AND (").hits;
			assert.equal(hits.length, 0, "malformed query must not match on the operator word itself");
		});

		it("oversized message indexes head/tail columns; AND crosses regions, phrase/NEAR cannot", () => {
			const filler = "filler ".repeat(200);
			const big = "ZqHeadStart k7" + filler + " " + "x".repeat(21000) + " m9 ZqTailEnd";
			writeFixture("--regions--", "r.jsonl", [
				sessionHeader(),
				msg("rg1", "user", big),
			], 132000);
			syncSessions(sessionsDir, dbPath, { cap: 10 });
			// Phrase/NEAR must not match across the elided middle.
			assert.equal(searchIndex(dbPath, '"ZqHeadStart ZqTailEnd"').hits.length, 0, "phrase cannot span the elided middle");
			assert.equal(searchIndex(dbPath, "NEAR(ZqHeadStart ZqTailEnd)").hits.length, 0, "NEAR cannot span the elided middle");
			// Each region stays searchable on its own.
			assert.equal(searchIndex(dbPath, "ZqTailEnd").hits.length, 1, "tail column stays searchable");
			// Ordinary Boolean AND matches terms across both retained regions of one row.
			const hit = searchIndex(dbPath, "ZqHeadStart ZqTailEnd").hits[0];
			assert.ok(hit, "AND matches across head and tail columns");
			assert.equal(hit.entryId, "rg1", "source entry id preserved exactly");
			// Forced-LIKE path (every term <3 code points) must also AND across regions.
			const likeHit = searchIndex(dbPath, "k7 AND m9").hits[0];
			assert.ok(likeHit, "boolean LIKE fallback matches across head and tail columns");
			assert.equal(likeHit.entryId, "rg1", "LIKE fallback preserves source entry id exactly");
		});

		it("files over the byte cap are skipped without reading, recorded as failures", async () => {
			const { MAX_SESSION_FILE_BYTES } = await import("../extensions/search-core.ts");
			const file = writeFixture("--toobig--", "big.jsonl", [
				sessionHeader(),
				msg("tb1", "user", "oversized file unique content"),
			], 133000);
			fs.appendFileSync(file, "x".repeat(64));
			const res = syncSessions(sessionsDir, dbPath, { cap: 10, maxFileBytes: 32 });
			assert.equal(res.filesProcessed, 0, "oversized file must not be read or indexed");
			assert.equal(searchIndex(dbPath, "oversized file unique content").hits.length, 0);
			void MAX_SESSION_FILE_BYTES;
			void file;
		});

		it("growth between walk stat and parse open is rejected at the descriptor, not read past the cap", () => {
			const file = writeFixture("--grow-race--", "g.jsonl", [
				sessionHeader(),
				msg("gr1", "user", "growth race must not be indexed content"),
			], 134000);
			writeFixture("--grow-race--", "ok.jsonl", [
				sessionHeader(),
				msg("gr2", "user", "healthy sibling survives growth race"),
			], 134500);
			// Simulates a concurrent append AFTER the walk's stat: the file on disk is
			// now far over the cap, but statSync still reports the stale small size.
			fs.appendFileSync(file, "z".repeat(1024));
			const realStatSync = fs.statSync.bind(fs);
			const liveTargetFds = new Set<number>(); // fds currently open on the target file
			let targetBytesRead = 0; // durable counter: survives fd reuse
			(fs as any).statSync = (p: any, ...rest: any[]) => {
				const s = realStatSync(p, ...rest);
				if (p === file) {
					const stale = Object.create(s);
					stale.size = 10; // walk-time fingerprint: small
					return stale;
				}
				return s;
			};
			const realOpenSync = fs.openSync.bind(fs);
			(fs as any).openSync = (p: any, ...rest: any[]) => {
				const fd = (realOpenSync as any)(p, ...rest);
				if (p === file) liveTargetFds.add(fd);
				return fd;
			};
			const realReadSync = fs.readSync.bind(fs);
			(fs as any).readSync = (fd: number, buf: any, off: number, len: number, pos: number) => {
				if (liveTargetFds.has(fd)) targetBytesRead += len;
				return realReadSync(fd, buf, off, len, pos);
			};
			const realCloseSync = fs.closeSync.bind(fs);
			(fs as any).closeSync = (fd: number) => {
				liveTargetFds.delete(fd); // stop counting: the number may be reused
				return realCloseSync(fd);
			};
			try {
				syncSessions(sessionsDir, dbPath, { cap: 50, maxFileBytes: 512 });
				assert.equal(targetBytesRead, 0, "rejected file must not be read at all, let alone past the cap");
				assert.equal(searchIndex(dbPath, "growth race must not be indexed content").hits.length, 0);
				assert.ok(searchIndex(dbPath, "healthy sibling survives growth race").hits.length >= 1, "other files continue to index");
				// Rejection recorded as retryable failure under the STALE walk fingerprint.
				const db2 = new DatabaseSync(dbPath);
				const failure = db2.prepare("SELECT size, mtime_ms, attempts FROM session_failures WHERE path = ?").get(file) as any;
				assert.ok(failure, "rejection must be recorded as retryable failure");
				assert.equal(failure.attempts, 1);
				assert.ok(failure.size < 512, "failure fingerprint carries the walk-time size, so the next pass re-attempts");
			} finally {
				(fs as any).statSync = realStatSync;
				(fs as any).openSync = realOpenSync;
				(fs as any).readSync = realReadSync;
				(fs as any).closeSync = realCloseSync;
			}
		});

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

		it("NEAR accepts comma spacing at the distance boundary and rejects unsafe integers", () => {
			const boundary = writeFixture("--near-comma--", "boundary.jsonl", [sessionHeader(), msg("nc1", "user", "Go123ZqRust")], 121000);
			const outside = writeFixture("--near-comma--", "outside.jsonl", [sessionHeader(), msg("nc2", "user", "Go1234ZqRust")], 121100);
			syncSessions(sessionsDir, dbPath, { cap: 10 });
			assert.deepEqual(searchIndex(dbPath, "NEAR(Go ZqRust ,5)", { limit: 10 }).hits.map((hit) => hit.path), [boundary]);
			assert.equal(searchIndex(dbPath, "NEAR(Go ZqRust, 9007199254740992)").hits.length, 0, "an unsafe distance must fail closed");
			fs.rmSync(boundary);
			fs.rmSync(outside);
			syncSessions(sessionsDir, dbPath, { cap: 10 });
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

	it("short lowercase non-ASCII query matches uppercase text via Unicode-aware LIKE", () => {
		writeFixture("--unicode-case--", "uni.jsonl", [
			sessionHeader(),
			msg("uc1", "user", "ÉX report ΣΟΦΙΑ notes ПРИВЕТ log"),
		], 60000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		assert.equal(buildFtsQueryPlan("éx").forceLike, true, "two-code-point term must take the LIKE path");
		for (const q of ["éx", "σοφ", "прив"]) {
			const { hits } = searchIndex(dbPath, q);
			assert.equal(hits.length, 1, `\`${q}\` must match its uppercase form (SQLite LIKE folds ASCII only)`);
		}
	});

	it("LIKE folds Greek final sigma: ΟΣ text matches οσ query", () => {
		// Word-final Σ lowercases to ς, so plain toLowerCase breaks ΟΣ ↔ οσ.
		const file = writeFixture("--greek-sigma--", "gs.jsonl", [
			sessionHeader(),
			msg("gs1", "user", "the oracle answered ΟΣ plainly"),
		], 61000);
		syncSessions(sessionsDir, dbPath, { cap: 10 });
		for (const q of ["οσ", "ος"]) {
			const { hits } = searchIndex(dbPath, q);
			assert.ok(hits.some((h) => h.path === file), `\`${q}\` must match word-final Σ via LIKE`);
		}
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

	it("prunes /tmp and /private/tmp encoded directories without matching embedded tmp names", () => {
		writeFixture("--tmp-project--", "tmp.jsonl", [sessionHeader(), msg("tmp", "user", "tempwalk exclusion marker")]);
		writeFixture("--private-tmp-project--", "private.jsonl", [sessionHeader(), msg("private", "user", "tempwalk exclusion marker")]);
		const kept = writeFixture("--users-tmp-project--", "kept.jsonl", [sessionHeader(), msg("kept", "user", "tempwalk exclusion marker")]);

		const result = syncSessions(sessionsDir, dbPath, { cap: 10 });
		assert.equal(result.filesProcessed, 1);
		assert.deepEqual(searchIndex(dbPath, "tempwalk exclusion marker").hits.map((hit) => hit.path), [kept]);
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

	it("canonicalizes valid timestamps and ranks invalid timestamps last", () => {
		const isolatedSessions = path.join(tmp, "timestamp-sessions");
		const isolatedDb = path.join(tmp, "timestamp-index.db");
		const fixtures = [
			["z.jsonl", "2026-01-01T00:30:00Z"],
			["offset.jsonl", "2026-01-01T02:00:00+01:00"],
			["malformed.jsonl", "zzzz"],
			["impossible.jsonl", "2026-02-30T12:00:00Z"],
			["hour-24.jsonl", "2026-01-01T24:00:00Z"],
		] as const;
		fs.mkdirSync(isolatedSessions);
		for (const [name, timestamp] of fixtures) {
			fs.writeFileSync(path.join(isolatedSessions, name), `${JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp, cwd: "/tmp" })}\n`);
		}

		assert.equal(syncSessions(isolatedSessions, isolatedDb).filesProcessed, fixtures.length);
		const rows = getSessionRows(isolatedDb, fixtures.length);
		assert.deepEqual(rows.slice(0, 2).map((row) => [path.basename(row.path), row.startedAt]), [
			["offset.jsonl", "2026-01-01T01:00:00.000Z"],
			["z.jsonl", "2026-01-01T00:30:00.000Z"],
		]);
		assert.deepEqual(new Set(rows.slice(2).map((row) => path.basename(row.path))), new Set(["malformed.jsonl", "impossible.jsonl", "hour-24.jsonl"]));
		assert.ok(rows.slice(2).every((row) => row.startedAt === undefined));
	});
});

describe("index permissions (POSIX)", { skip: process.platform === "win32" }, () => {
	/** Run fn with a forced 022 umask; restores the previous mask after. */
	function withUmask022<T>(fn: () => T): T {
		const prev = process.umask(0o022);
		try {
			return fn();
		} finally {
			process.umask(prev);
		}
	}

	function modeOf(p: string): number {
		return fs.statSync(p).mode & 0o777;
	}

	const fileMode = (p: string) => modeOf(p);

	it("fresh index under umask 022: directory 0700, db 0600, WAL sidecars inherit 0600", () => {
		withUmask022(() => {
			const dir = path.join(tmp, "perm-fresh");
			const sessions = path.join(dir, "sessions");
			const freshDb = path.join(dir, "index.db");
			fs.mkdirSync(sessions, { recursive: true });
			fs.writeFileSync(path.join(sessions, "a.jsonl"), [sessionHeader(), msg("pm1", "user", "permission regression unique marker")].join("\n") + "\n");

			// Hold a second connection open so WAL/SHM sidecars survive sync's close.
			syncSessions(sessions, freshDb, { cap: 5 });
			const holder = new DatabaseSync(freshDb);
			try {
				holder.exec("SELECT count(*) FROM sessions");
				assert.equal(syncSessions(sessions, freshDb, { cap: 5 }).filesProcessed, 0);
				assert.equal(modeOf(dir), 0o700, "parent directory must be owner-only");
				assert.equal(fileMode(freshDb), 0o600, "database must be owner-only");
				assert.equal(fileMode(freshDb + "-wal"), 0o600, "WAL sidecar inherits the main db mode");
				assert.equal(fileMode(freshDb + "-shm"), 0o600, "SHM sidecar inherits the main db mode");
			} finally {
				holder.close();
			}
			assert.ok(searchIndex(freshDb, "permission regression unique marker").hits.length === 1, "secure modes must not break indexing");
		});
	});

	it("existing permissive directory and database are tightened in place, data preserved", () => {
		withUmask022(() => {
			const dir = path.join(tmp, "perm-existing");
			fs.mkdirSync(dir, { recursive: true });
			fs.chmodSync(dir, 0o755);
			const permissiveDb = path.join(dir, "index.db");
			fs.writeFileSync(permissiveDb, Buffer.alloc(0));
			fs.chmodSync(permissiveDb, 0o644);
			const sessions = path.join(tmp, "perm-existing-sessions");
			fs.mkdirSync(sessions, { recursive: true });
			fs.writeFileSync(path.join(sessions, "b.jsonl"), [sessionHeader(), msg("pm2", "user", "tightening keeps indexing functional marker")].join("\n") + "\n");

			assert.equal(syncSessions(sessions, permissiveDb, { cap: 5 }).filesProcessed, 1);
			assert.equal(modeOf(dir), 0o700, "permissive parent directory must be tightened");
			assert.equal(fileMode(permissiveDb), 0o600, "permissive database must be tightened");
			assert.ok(searchIndex(permissiveDb, "tightening keeps indexing functional marker").hits.length === 1);
		});
	});

	it("legacy permissive sidecars left by older builds are tightened", () => {
		withUmask022(() => {
			const dir = path.join(tmp, "perm-sidecars");
			fs.mkdirSync(dir, { recursive: true });
			const legacyDb = path.join(dir, "index.db");
			for (const suffix of ["-wal", "-shm"]) {
				fs.writeFileSync(legacyDb + suffix, Buffer.alloc(0));
				fs.chmodSync(legacyDb + suffix, 0o644);
			}
			const sessions = path.join(tmp, "perm-sidecars-sessions");
			fs.mkdirSync(sessions, { recursive: true });
			fs.writeFileSync(path.join(sessions, "c.jsonl"), [sessionHeader(), msg("pm3", "user", "sidecar tightening marker text")].join("\n") + "\n");

			syncSessions(sessions, legacyDb, { cap: 5 });
			// Hold a second connection so the sidecars survive sync's clean close.
			const holder = new DatabaseSync(legacyDb);
			try {
				holder.exec("SELECT count(*) FROM sessions");
				syncSessions(sessions, legacyDb, { cap: 5 });
				assert.equal(fileMode(legacyDb + "-wal"), 0o600);
				assert.equal(fileMode(legacyDb + "-shm"), 0o600);
			} finally {
				holder.close();
			}
		});
	});

	it("symlinked and non-regular database nodes are rejected, not followed", () => {
		withUmask022(() => {
			const dir = path.join(tmp, "perm-reject");
			fs.mkdirSync(dir, { recursive: true });

			// Symlink at the db path: O_NOFOLLOW must reject it instead of
			// writing transcript content to the link target outside the private dir.
			const outsideDb = path.join(tmp, "outside-index.db");
			fs.writeFileSync(outsideDb, Buffer.alloc(0));
			const linkedDb = path.join(dir, "linked.db");
			fs.symlinkSync(outsideDb, linkedDb);
			const sessions = path.join(tmp, "perm-reject-sessions");
			fs.mkdirSync(sessions, { recursive: true });
			fs.writeFileSync(path.join(sessions, "d.jsonl"), [sessionHeader(), msg("pm4", "user", "rejection path marker")].join("\n") + "\n");
			assert.throws(() => syncSessions(sessions, linkedDb), (err: NodeJS.ErrnoException) => err.code === "ELOOP" || /not a regular file|symbolic link/i.test(String(err.message)));
			assert.equal(fs.statSync(outsideDb).size, 0, "link target must stay untouched");

			// Directory at the db path: open(O_RDWR) fails instead of following.
			const dirAsDb = path.join(dir, "dir.db");
			fs.mkdirSync(dirAsDb);
			assert.throws(() => syncSessions(sessions, dirAsDb), (err: NodeJS.ErrnoException) => Boolean(err.code));
		});
	});
});

// The FIFO TOCTOU regression runs in a subprocess: pre-fix code blocks forever
// on the writerless FIFO open, and a timeout there kills only this child instead
// of wedging the test runner.
describe("FIFO TOCTOU in indexing", () => {
	it("a regular .jsonl swapped for a writerless FIFO fails promptly without hanging sync", { skip: process.platform === "win32" }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-fifo-"));
		try {
			const sessions = path.join(dir, "sessions");
			const victimDir = path.join(sessions, "--fifo-victim--", "victim.jsonl");
			fs.mkdirSync(path.dirname(victimDir), { recursive: true });
			const goodDir = path.join(sessions, "--good--");
			fs.mkdirSync(goodDir, { recursive: true });
			// Healthy neighbor proves the pass continues past the failed file.
			fs.writeFileSync(path.join(goodDir, "good.jsonl"),
				[sessionHeader(), msg("g1", "user", "healthy fifo neighbor marker")].join("\n") + "\n");
			assert.equal(spawnSync("mkfifo", [victimDir]).status, 0);

			// Simulate the race outcome inside the child: the walk's directory
			// listing was captured while victim.jsonl was still a regular file;
			// by open time it is a writerless FIFO.
			const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const origReaddirSync = fs.readdirSync;
fs.readdirSync = (p, opts) => {
	const entries = origReaddirSync(p, opts);
	if (!opts?.withFileTypes) return entries;
	return entries.map((e) => e.name === "victim.jsonl"
		? { name: e.name, isFile: () => true, isDirectory: () => false }
		: e);
};
const { syncSessions } = await import(pathToFileURL(process.env.SEARCH_CORE_PATH));
const res = syncSessions(process.env.FIFO_SESSIONS_DIR, process.env.FIFO_DB_PATH);
assert.equal(res.filesProcessed, 1, "healthy neighbor must still index");
assert.equal(res.backlogRemaining, 1, "FIFO must stay a retryable failure");
process.exit(0);
`;
			const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
				timeout: 5000,
				env: {
					...process.env,
					SEARCH_CORE_PATH: path.resolve(import.meta.dirname, "../extensions/search-core.ts"),
					FIFO_SESSIONS_DIR: sessions,
					FIFO_DB_PATH: path.join(dir, "index.db"),
				},
			});
			assert.equal(result.error, undefined, `sync hung on the writerless FIFO (timed out): ${result.error}`);
			assert.equal(result.status, 0, result.stderr.toString());
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("symlink TOCTOU in shared reader", () => {
	it("a symlink swapped in after the walk is rejected, not followed", { skip: process.platform === "win32" }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-symlink-"));
		try {
			// Simulate the race outcome: the walk validated victim.jsonl as a regular
			// file; by open time it is a symlink to a regular JSONL outside the tree.
			const outside = path.join(dir, "outside.jsonl");
			fs.writeFileSync(outside, [sessionHeader(), msg("s1", "user", "external secret marker")].join("\n") + "\n");
			const linked = path.join(dir, "victim.jsonl");
			fs.symlinkSync(outside, linked);

			assert.throws(() => readBoundedSnapshot(linked, 1024 * 1024), (err: NodeJS.ErrnoException) => err.code === "ELOOP");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

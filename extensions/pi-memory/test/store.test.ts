import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ENTRY_DELIMITER, MemoryStore, type Target } from "../src/store.ts";

const LIMIT = 1000;

async function makeStore(backupPath?: (target: Target) => string) {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
	return {
		dir,
		store: new MemoryStore({ directory: dir, memoryCharLimit: LIMIT, userCharLimit: LIMIT, backupPath }),
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

const memoryPath = (dir: string) => join(dir, "MEMORY.md");

test("parse/serialize round-trip including multiline entries", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await store.add("memory", "first entry");
		await store.add("memory", "line one\nline two\nline three");
		const loaded = await store.load("memory");
		assert.deepEqual(loaded.entries, ["first entry", "line one\nline two\nline three"]);
	} finally {
		await cleanup();
	}
});

test("add overflow rejection includes usage info", async () => {
	const { store, cleanup } = await makeStore();
	try {
		const big = "x".repeat(LIMIT + 1);
		const result = await store.add("memory", big);
		assert.equal(result.success, false);
		assert.match(result.error!, /exceed the limit/);
		assert.ok(result.usage!.includes(LIMIT.toLocaleString()));
		assert.deepEqual(result.currentEntries!, []);
	} finally {
		await cleanup();
	}
});

test("batch removes stale and adds new in one call when lone add would overflow", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await store.add("memory", `${"a".repeat(600)}`);
		const loneAdd = await store.add("memory", "b".repeat(500));
		assert.equal(loneAdd.success, false);

		const batch = await store.applyBatch("memory", [
			{ action: "remove", old_text: "aaa" },
			{ action: "add", content: "b".repeat(500) },
		]);
		assert.equal(batch.success, true, batch.error ?? "");
		const loaded = await store.load("memory");
		assert.deepEqual(loaded.entries, ["b".repeat(500)]);
	} finally {
		await cleanup();
	}
});

test("batch is all-or-nothing on a bad op", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await store.add("memory", "keep me");
		const result = await store.applyBatch("memory", [
			{ action: "remove", old_text: "keep" },
			{ action: "replace", old_text: "nonexistent" , content: "x"},
		]);
		assert.equal(result.success, false);
		assert.match(result.error!, /all-or-nothing/);
		assert.deepEqual(result.currentEntries!, ["keep me"]);
		const loaded = await store.load("memory");
		assert.deepEqual(loaded.entries, ["keep me"]);
	} finally {
		await cleanup();
	}
});

test("exact-duplicate add is idempotent", async () => {
	const { store, cleanup } = await makeStore();
	try {
		assert.equal((await store.add("memory", "dup")).success, true);
		const again = await store.add("memory", "dup");
		assert.equal(again.success, true);
		assert.match(again.message!, /already exists/);
		assert.equal((await store.load("memory")).entries.length, 1);
	} finally {
		await cleanup();
	}
});

test("multi-match ambiguity error with previews", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await store.add("memory", "note about project alpha");
		await store.add("memory", "note about project beta");
		const result = await store.remove("memory", "note about project");
		assert.equal(result.success, false);
		assert.match(result.error!, /Multiple entries matched/);
		assert.equal(result.matches!.length, 2);
	} finally {
		await cleanup();
	}
});

test("missing old_text returns recoverable error with current entries", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await store.add("memory", "an entry");
		const replaceResult = await store.replace("memory", "", "new");
		assert.equal(replaceResult.success, false);
		assert.match(replaceResult.error!, /needs old_text/);
		assert.deepEqual(replaceResult.currentEntries!, ["an entry"]);
		assert.match(replaceResult.error!, /Reissue/);

		const removeResult = await store.remove("memory", "");
		assert.equal(removeResult.success, false);
		assert.deepEqual(removeResult.currentEntries!, ["an entry"]);
	} finally {
		await cleanup();
	}
});

test("unreadable existing file aborts mutation and leaves file unchanged", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		const original = ["precious", "entries"].join(ENTRY_DELIMITER);
		await writeFile(memoryPath(dir), Buffer.from([0xff, 0xfe, 0x00, 0x81]), "binary"); // invalid UTF-8
		for (const attempt of [
			store.add("memory", "new"),
			store.replace("memory", "precious", "x"),
			store.remove("memory", "precious"),
			store.applyBatch("memory", [{ action: "add", content: "new" }]),
		]) {
			const result = await attempt;
			assert.equal(result.success, false, JSON.stringify(result));
			assert.match(result.error!, /could not be read/);
		}
		const bytes = await readFile(memoryPath(dir));
		assert.equal(bytes.length, 4); // untouched
		const loaded = await store.load("memory");
		assert.equal(loaded.status, "unreadable");
		assert.ok(loaded.conflictWarning);
	} finally {
		await cleanup();
	}
});

test("CRLF-delimiter bypass rejected after normalization", async () => {
	const { store, cleanup } = await makeStore();
	try {
		const result = await store.add("memory", "a\r\n§\r\nb");
		assert.equal(result.success, false);
		assert.match(result.error!, /delimiter/);
	} finally {
		await cleanup();
	}
});

test("BOM is stripped and first entry stays matchable", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(memoryPath(dir), "\uFEFFfirst entry" + ENTRY_DELIMITER + "second", "utf-8");
		const loaded = await store.load("memory");
		assert.deepEqual(loaded.entries, ["first entry", "second"]);
		const result = await store.remove("memory", "first entry");
		assert.equal(result.success, true, result.error ?? "");
		assert.deepEqual((await store.load("memory")).entries, ["second"]);
	} finally {
		await cleanup();
	}
});

test("dedupe preserves order and first occurrence", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await writeFile(
			memoryPath(dir),
			["b", "a", "b", "c", "a"].join(ENTRY_DELIMITER),
			"utf-8",
		);
		const loaded = await store.load("memory");
		assert.deepEqual(loaded.entries, ["b", "a", "c"]);
	} finally {
		await cleanup();
	}
});

test("consolidation cap: third consecutive failure terminal, reset on success", () => {
	let terminalSeen = false;
	const store = new MemoryStore({ directory: "/tmp/pi-memory-unused", memoryCharLimit: LIMIT, userCharLimit: LIMIT });
	assert.deepEqual(store.incrementFailure(), { done: false });
	assert.deepEqual(store.incrementFailure(), { done: false });
	const third = store.incrementFailure();
	assert.deepEqual(third, { done: true });
	terminalSeen = third.done;
	assert.ok(terminalSeen);
	store.resetOnSuccess();
	assert.deepEqual(store.incrementFailure(), { done: false });
});

test("delimiter-containing content rejected", async () => {
	const { store, cleanup } = await makeStore();
	try {
		const result = await store.add("memory", `before${ENTRY_DELIMITER}after`);
		assert.equal(result.success, false);
		assert.match(result.error!, /delimiter/);
	} finally {
		await cleanup();
	}
});

test("backup created before successful rewrite", async () => {
	let backedUp: string | undefined;
	const backupFor = (target: Target) => join(tmpdir(), `pi-mem-bak-${target}`);
	const { store, dir, cleanup } = await makeStore(backupFor);
	try {
		await store.add("memory", "v1"); // no existing file -> no backup needed
		backedUp = backupFor("memory");
		const result = await store.add("memory", "v2");
		assert.equal(result.success, true, result.error ?? "");
		const backupContent = await readFile(backedUp, "utf-8");
		assert.equal(backupContent, "v1");
		assert.deepEqual((await store.load("memory")).entries, ["v1", "v2"]);
		void dir;
	} finally {
		await cleanup();
		await rm(backedUp!, { force: true });
	}
});

test("two sequential adds both present", async () => {
	const { store, cleanup } = await makeStore();
	try {
		assert.equal((await store.add("memory", "one")).success, true);
		assert.equal((await store.add("memory", "two")).success, true);
		assert.deepEqual((await store.load("memory")).entries, ["one", "two"]);
	} finally {
		await cleanup();
	}
});

// ---- Fix-A additions ----

test("oversized load refuses injection and aborts mutations, file untouched", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(memoryPath(dir), "x".repeat(1_000_001), "utf-8");
		const loaded = await store.load("memory");
		assert.equal(loaded.status, "oversized");
		assert.ok(loaded.conflictWarning);
		for (const attempt of [
			store.add("memory", "new"),
			store.replace("memory", "x", "y"),
			store.remove("memory", "x"),
			store.applyBatch("memory", [{ action: "add", content: "new" }]),
		]) {
			const result = await attempt;
			assert.equal(result.success, false);
			assert.match(result.error!, /1,000,000|could not be read/);
		}
		assert.equal((await readFile(memoryPath(dir))).length, 1_000_001); // untouched
	} finally {
		await cleanup();
	}
});

test("reserved framing tokens rejected", async () => {
	const { store, cleanup } = await makeStore();
	try {
		for (const bad of [
			"entry\n═══\ntail",
			"═════",
			"MEMORY (your personal notes go here)",
			"USER PROFILE (who the user is) stuff",
			"fine line\n\tPROJECT MEMORY (current project) stuff",
			"fine line\nMEMORY (your personal notes",
		]) {
			const result = await store.add("memory", bad);
			assert.equal(result.success, false, JSON.stringify(bad));
		}
		assert.deepEqual((await store.load("memory")).entries, []);
		// Batch path validates too.
		const batch = await store.applyBatch("memory", [{ action: "add", content: "ok\n═══" }]);
		assert.equal(batch.success, false);
	} finally {
		await cleanup();
	}
});

test("batch replace normalizes CRLF content and old_text", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(memoryPath(dir), "old entry with CRLF\r\nsecond line", "utf-8");
		const batch = await store.applyBatch("memory", [
			{ action: "replace", old_text: "CRLF\r\nsecond", new_text: "new\r\nmultiline\r\ncontent" },
		]);
		assert.equal(batch.success, true, batch.error ?? "");
		assert.deepEqual((await store.load("memory")).entries, ["new\nmultiline\ncontent"]);
		const raw = await readFile(memoryPath(dir), "utf-8");
		assert.ok(!raw.includes("\r"));
	} finally {
		await cleanup();
	}
});

test("replace creating a duplicate dedupes (single and batch)", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await store.add("memory", "alpha");
		await store.add("memory", "beta");
		const single = await store.replace("memory", "alpha", "beta");
		assert.equal(single.success, true, single.error ?? "");
		assert.equal(single.entryCount, 1);
		assert.deepEqual((await store.load("memory")).entries, ["beta"]);

		await store.add("memory", "gamma"); // entries: beta, gamma
		const batch = await store.applyBatch("memory", [{ action: "replace", old_text: "gamma", content: "beta" }]);
		assert.equal(batch.success, true, batch.error ?? "");
		assert.equal(batch.entryCount, 1);
		assert.deepEqual((await store.load("memory")).entries, ["beta"]);
	} finally {
		await cleanup();
	}
});

test("tmp file removed when rename fails after write", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
	try {
		await writeFile(memoryPath(dir), "seed", "utf-8");
		const store = new MemoryStore({
			directory: dir,
			memoryCharLimit: LIMIT,
			userCharLimit: LIMIT,
			// Fail AFTER the tmp file is written so cleanup is actually exercised.
			renameFn: async () => { throw new Error("simulated rename failure"); },
		});
		await assert.rejects(store.add("memory", "boom"), /simulated rename failure/);
		// Original file untouched, no tmp leftovers.
		assert.equal(await readFile(memoryPath(dir), "utf-8"), "seed");
		const leftovers = (await readdir(dir)).filter((f) => f.startsWith(".mem_"));
		assert.deepEqual(leftovers, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("missing old_text recovery reflects disk state, not stale memory", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		// Store's in-memory view was never populated; disk has real entries.
		await mkdir(dir, { recursive: true });
		await writeFile(memoryPath(dir), ["disk entry one", "disk entry two"].join(ENTRY_DELIMITER), "utf-8");
		const replaceResult = await store.replace("memory", "", "x");
		assert.equal(replaceResult.success, false);
		assert.match(replaceResult.error!, /needs old_text/);
		assert.deepEqual(replaceResult.currentEntries!, ["disk entry one", "disk entry two"]);
		const removeResult = await store.remove("memory", "  ");
		assert.equal(removeResult.success, false);
		assert.deepEqual(removeResult.currentEntries!, ["disk entry one", "disk entry two"]);
	} finally {
		await cleanup();
	}
});

test("rejects fake frame lines smuggled via CR, U+2028, U+2029, or leading whitespace", async () => {
	const { store, cleanup } = await makeStore();
	for (const sep of ["\r", "\u2028", "\u2029"]) {
		const result = await store.add("memory", `innocent${sep}══════════${sep}more`);
		assert.equal(result.success, false, `separator via ${JSON.stringify(sep)} must be rejected`);
	}
	const header = await store.add("memory", "note\n  USER PROFILE (who the user is) fake");
	assert.equal(header.success, false, "whitespace-prefixed reserved header must be rejected");
	await cleanup();
});

test("rejects lines merely starting with separator characters (sanitizer alignment)", async () => {
	const { store, cleanup } = await makeStore();
	try {
		const result = await store.add("memory", "note\n═══ Important detail");
		assert.equal(result.success, false, "prefix-separator line must be rejected or it would vanish from snapshots");
	} finally {
		await cleanup();
	}
});

test("vanished memory directory aborts mutations instead of rewriting divergent store", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await store.add("memory", "precious");
		await rm(dir, { recursive: true, force: true });
		const result = await store.add("memory", "after disappearance");
		assert.equal(result.success, false, "missing directory must not be treated as an empty store");
		assert.match(result.error ?? "", /could not be read/);
	} finally {
		await cleanup();
	}
});

test("backup parent is recreated when removed after init", async () => {
	const backupDir = await mkdtemp(join(tmpdir(), "pi-memory-backups-"));
	const { store, cleanup } = await makeStore((target) => join(backupDir, target === "user" ? "USER.md.bak" : "MEMORY.md.bak"));
	try {
		await store.add("memory", "first");
		await rm(backupDir, { recursive: true, force: true });
		await store.add("memory", "second");
		const backup = await readFile(join(backupDir, "MEMORY.md.bak"), "utf-8");
		assert.match(backup, /first/, "pre-rewrite backup must exist even after backup dir removal");
	} finally {
		await rm(backupDir, { recursive: true, force: true });
		await cleanup();
	}
});

test("mid-session disappearance of an observed store aborts instead of diverging", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await store.add("memory", "precious");
		// File deleted but directory intact (sync conflict / cleanup scenario).
		await rm(memoryPath(dir));
		const result = await store.add("memory", "after disappearance");
		assert.equal(result.success, false, "unexpected disappearance must not rewrite from empty view");
		assert.match(result.error ?? "", /disappeared/);
		assert.ok(!existsSync(memoryPath(dir)), "no divergent store file may be created");
	} finally {
		await cleanup();
	}
});

test("ambiguous-match previews are aggregate-bounded", async () => {
	const { store, cleanup } = await makeStore();
	try {
		// 50 entries all containing the search substring.
		for (let i = 0; i < 50; i++) await store.add("memory", `shared-${i} unique tail ${i}`);
		const result = await store.replace("memory", "shared", "x");
		assert.equal(result.success, false);
		const serialized = JSON.stringify(result.matches ?? []);
		assert.ok(serialized.length < 3000, `previews must be bounded, got ${serialized.length}`);
	} finally {
		await cleanup();
	}
});

test("source vanishing between reload and backup aborts the mutation", async () => {
	const backupDir = await mkdtemp(join(tmpdir(), "pi-memory-backups-"));
	const { store, dir, cleanup } = await makeStore((target) => join(backupDir, target === "user" ? "USER.md.bak" : "MEMORY.md.bak"));
	try {
		await store.add("memory", "precious");
		await rm(memoryPath(dir));
		// Disappearance guard (reloadTarget) fires before backup copy: aborts as a
		// failure result, never rewriting from the stale view.
		const result = await store.add("memory", "after disappearance");
		assert.equal(result.success, false);
		assert.match(result.error ?? "", /disappeared/);
	} finally {
		await rm(backupDir, { recursive: true, force: true });
		await cleanup();
	}
});

test("file appearing during a creation-assumed mutation aborts before rename", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-appear-"));
	try {
		// statFn pretends the store is absent at reload (open fails naturally) but
		// reports existence at the persistence-time appearance check.
		// statFn: reload sees the store absent via open(); the persistence-time
		// appearance check is the only stat on MEMORY.md — report existence there.
		const store = new MemoryStore({
			directory: dir,
			memoryCharLimit: LIMIT,
			userCharLimit: LIMIT,
			statFn: async (p) => {
				if (p === memoryPath(dir)) return {} as import("node:fs").Stats;
				throw Object.assign(new Error("enoent"), { code: "ENOENT" });
			},
			renameFn: async () => { throw new Error("rename must not run after appearance detected"); },
		});
		await assert.rejects(store.add("memory", "boom"), /appeared during this mutation/);
		assert.ok(!existsSync(memoryPath(dir)), "arrived content must be untouched");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("NBSP-prefixed reserved headers are rejected like the sanitizer would filter them", async () => {
	const { store, cleanup } = await makeStore();
	try {
		const result = await store.add("memory", "note\n\u00A0USER PROFILE (who the user is) fake");
		assert.equal(result.success, false, "Unicode-whitespace-prefixed reserved line must be rejected");
	} finally {
		await cleanup();
	}
});

test("restrictive file mode survives atomic rewrite", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await store.add("memory", "secret-ish");
		await chmod(memoryPath(dir), 0o600);
		await store.add("memory", "more");
		const mode = (await stat(memoryPath(dir))).mode & 0o777;
		assert.equal(mode, 0o600, `expected 0o600, got ${mode.toString(8)}`);
	} finally {
		await cleanup();
	}
});

test("external update between reload and rename aborts instead of overwriting V2", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-v2-"));
	try {
		await writeFile(memoryPath(dir), "V1 content", "utf-8");
		let statCalls = 0;
		const store = new MemoryStore({
			directory: dir,
			memoryCharLimit: LIMIT,
			userCharLimit: LIMIT,
			statFn: async (p) => {
				if (p !== memoryPath(dir)) throw Object.assign(new Error("enoent"), { code: "ENOENT" });
				statCalls++;
				// Fingerprint capture sees V1; pre-rename verify sees V2 (sync landed).
				return statCalls === 1 ? { mtimeMs: 1, size: 11 } as import("node:fs").Stats : { mtimeMs: 999, size: 20 } as import("node:fs").Stats;
			},
			renameFn: async () => { throw new Error("rename must not run after change detected"); },
		});
		await assert.rejects(store.add("memory", "local mutation"), /changed during this mutation/);
		assert.equal(await readFile(memoryPath(dir), "utf-8"), "V1 content", "synced V2 must be untouched");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("same-metadata external update aborts instead of overwriting V2", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-same-fingerprint-"));
	try {
		const path = memoryPath(dir);
		await writeFile(path, "V1 content", "utf-8");
		let statCalls = 0;
		const fingerprint = { mtimeMs: 1, size: 10 } as import("node:fs").Stats;
		const store = new MemoryStore({
			directory: dir,
			memoryCharLimit: LIMIT,
			userCharLimit: LIMIT,
			statFn: async () => {
				statCalls++;
				if (statCalls === 2) await writeFile(path, "V2 content", "utf-8");
				return fingerprint;
			},
			renameFn: async () => { throw new Error("rename must not run after content changed"); },
		});
		await assert.rejects(store.add("memory", "local mutation"), /changed during this mutation/);
		assert.equal(await readFile(path, "utf-8"), "V2 content");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("symlinked store file is rejected with a clear reason", async () => {
	const { dir, cleanup } = await makeStore();
	try {
		await writeFile(join(dir, "real.md"), "elsewhere");
		await symlink(join(dir, "real.md"), memoryPath(dir));
		const store = new MemoryStore({ directory: dir, memoryCharLimit: LIMIT, userCharLimit: LIMIT });
		const result = await store.add("memory", "boom");
		assert.equal(result.success, false);
		assert.match(result.error ?? "", /symlink/);
	} finally {
		await cleanup();
	}
});

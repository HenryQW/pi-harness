import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ENTRY_DELIMITER, MAX_FILE_BYTES, MemoryStore } from "../src/store.ts";

const LIMIT = 1000;

async function makeStore(backupPath?: string) {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
	return {
		dir,
		store: new MemoryStore({ directory: dir, target: "memory", limit: LIMIT, backupPath }),
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

const memoryPath = (dir: string) => join(dir, "MEMORY.md");
const add = (store: MemoryStore, content: string) => store.apply({ action: "add", content });
const replace = (store: MemoryStore, old_text: string, content: string) => store.apply({ action: "replace", old_text, content });
const remove = (store: MemoryStore, old_text: string) => store.apply({ action: "remove", old_text });

test("parse/serialize round-trip including multiline entries", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await add(store, "first entry");
		await add(store, "line one\nline two\nline three");
		const loaded = await store.load();
		assert.deepEqual(loaded.entries, ["first entry", "line one\nline two\nline three"]);
	} finally {
		await cleanup();
	}
});

test("add overflow rejection includes usage info", async () => {
	const { store, cleanup } = await makeStore();
	try {
		const big = "x".repeat(LIMIT + 1);
		const result = await add(store, big);
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
		await add(store, `${"a".repeat(600)}`);
		const loneAdd = await add(store, "b".repeat(500));
		assert.equal(loneAdd.success, false);

		const batch = await store.applyBatch([
			{ action: "remove", old_text: "aaa" },
			{ action: "add", content: "b".repeat(500) },
		]);
		assert.equal(batch.success, true, batch.error ?? "");
		const loaded = await store.load();
		assert.deepEqual(loaded.entries, ["b".repeat(500)]);
	} finally {
		await cleanup();
	}
});

test("batch is all-or-nothing on a bad op", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await add(store, "keep me");
		const result = await store.applyBatch([
			{ action: "remove", old_text: "keep" },
			{ action: "replace", old_text: "nonexistent" , content: "x"},
		]);
		assert.equal(result.success, false);
		assert.match(result.error!, /all-or-nothing/);
		assert.deepEqual(result.currentEntries!, ["keep me"]);
		const loaded = await store.load();
		assert.deepEqual(loaded.entries, ["keep me"]);
	} finally {
		await cleanup();
	}
});

test("exact-duplicate add is idempotent", async () => {
	const { store, cleanup } = await makeStore();
	try {
		assert.equal((await add(store, "dup")).success, true);
		const again = await add(store, "dup");
		assert.equal(again.success, true);
		assert.match(again.message!, /already exists/);
		assert.equal((await store.load()).entries.length, 1);
	} finally {
		await cleanup();
	}
});

test("multi-match ambiguity error with previews", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await add(store, "note about project alpha");
		await add(store, "note about project beta");
		const result = await remove(store, "note about project");
		assert.equal(result.success, false);
		assert.match(result.error!, /Multiple entries matched/);
		assert.equal(result.matches!.length, 2);
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
			add(store, "new"),
			replace(store, "precious", "x"),
			remove(store, "precious"),
			store.applyBatch([{ action: "add", content: "new" }]),
		]) {
			const result = await attempt;
			assert.equal(result.success, false, JSON.stringify(result));
			assert.match(result.error!, /could not be read/);
		}
		const bytes = await readFile(memoryPath(dir));
		assert.equal(bytes.length, 4); // untouched
		const loaded = await store.load();
		assert.equal(loaded.state, "unreadable");
		assert.ok(loaded.conflictWarning);
	} finally {
		await cleanup();
	}
});

test("BOM is stripped and first entry stays matchable", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(memoryPath(dir), "\uFEFFfirst entry" + ENTRY_DELIMITER + "second", "utf-8");
		const loaded = await store.load();
		assert.deepEqual(loaded.entries, ["first entry", "second"]);
		const result = await remove(store, "first entry");
		assert.equal(result.success, true, result.error ?? "");
		assert.deepEqual((await store.load()).entries, ["second"]);
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
		const loaded = await store.load();
		assert.deepEqual(loaded.entries, ["b", "a", "c"]);
	} finally {
		await cleanup();
	}
});

test("consolidation cap: third consecutive failure terminal, reset on success", () => {
	let terminalSeen = false;
	const store = new MemoryStore({ directory: "/tmp/pi-memory-unused", target: "memory", limit: LIMIT });
	assert.deepEqual(store.incrementFailure(), { done: false });
	assert.deepEqual(store.incrementFailure(), { done: false });
	const third = store.incrementFailure();
	assert.deepEqual(third, { done: true });
	terminalSeen = third.done;
	assert.ok(terminalSeen);
	store.resetOnSuccess();
	assert.deepEqual(store.incrementFailure(), { done: false });
});

test("backup created before successful rewrite", async () => {
	let backedUp: string | undefined;
	const backupFor = () => join(tmpdir(), "pi-mem-bak-memory");
	const { store, dir, cleanup } = await makeStore(backupFor());
	try {
		await add(store, "v1"); // no existing file -> no backup needed
		backedUp = backupFor();
		const result = await add(store, "v2");
		assert.equal(result.success, true, result.error ?? "");
		const backupContent = await readFile(backedUp, "utf-8");
		assert.equal(backupContent, "v1");
		assert.deepEqual((await store.load()).entries, ["v1", "v2"]);
		void dir;
	} finally {
		await cleanup();
		await rm(backedUp!, { force: true });
	}
});

test("oversized load refuses injection and aborts mutations, file untouched", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(memoryPath(dir), "x".repeat(1_000_001), "utf-8");
		const loaded = await store.load();
		assert.equal(loaded.state, "oversized");
		assert.ok(loaded.conflictWarning);
		for (const attempt of [
			add(store, "new"),
			replace(store, "x", "y"),
			remove(store, "x"),
			store.applyBatch([{ action: "add", content: "new" }]),
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

test("batch replace normalizes CRLF content and old_text", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(memoryPath(dir), "old entry with CRLF\r\nsecond line", "utf-8");
		const batch = await store.applyBatch([
			{ action: "replace", old_text: "CRLF\r\nsecond", content: "new\r\nmultiline\r\ncontent" },
		]);
		assert.equal(batch.success, true, batch.error ?? "");
		assert.deepEqual((await store.load()).entries, ["new\nmultiline\ncontent"]);
		const raw = await readFile(memoryPath(dir), "utf-8");
		assert.ok(!raw.includes("\r"));
	} finally {
		await cleanup();
	}
});

test("replace creating a duplicate dedupes (single and batch)", async () => {
	const { store, cleanup } = await makeStore();
	try {
		await add(store, "alpha");
		await add(store, "beta");
		const single = await replace(store, "alpha", "beta");
		assert.equal(single.success, true, single.error ?? "");
		assert.equal(single.entryCount, 1);
		assert.deepEqual((await store.load()).entries, ["beta"]);

		await add(store, "gamma"); // entries: beta, gamma
		const batch = await store.applyBatch([{ action: "replace", old_text: "gamma", content: "beta" }]);
		assert.equal(batch.success, true, batch.error ?? "");
		assert.equal(batch.entryCount, 1);
		assert.deepEqual((await store.load()).entries, ["beta"]);
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
			target: "memory",
			limit: LIMIT,
			// Fail AFTER the tmp file is written so cleanup is actually exercised.
			renameFn: async () => { throw Object.assign(new Error("simulated rename failure"), { code: "ENOENT" }); },
		});
		await assert.rejects(add(store, "boom"), /disappeared during this mutation/);
		// Original file untouched, no tmp leftovers.
		assert.equal(await readFile(memoryPath(dir), "utf-8"), "seed");
		const leftovers = (await readdir(dir)).filter((f) => f.startsWith(".mem_"));
		assert.deepEqual(leftovers, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("vanished memory directory aborts mutations instead of rewriting divergent store", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await add(store, "precious");
		await rm(dir, { recursive: true, force: true });
		const result = await add(store, "after disappearance");
		assert.equal(result.success, false, "missing directory must not be treated as an empty store");
		assert.match(result.error ?? "", /could not be read/);
	} finally {
		await cleanup();
	}
});

test("backup parent is recreated when removed after init", async () => {
	const backupDir = await mkdtemp(join(tmpdir(), "pi-memory-backups-"));
	const { store, cleanup } = await makeStore(join(backupDir, "MEMORY.md.bak"));
	try {
		await add(store, "first");
		await rm(backupDir, { recursive: true, force: true });
		await add(store, "second");
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
		await add(store, "precious");
		// File deleted but directory intact (sync conflict / cleanup scenario).
		await rm(memoryPath(dir));
		const result = await add(store, "after disappearance");
		assert.equal(result.success, false, "unexpected disappearance must not rewrite from empty view");
		assert.match(result.error ?? "", /disappeared/);
		assert.ok(!existsSync(memoryPath(dir)), "no divergent store file may be created");
	} finally {
		await cleanup();
	}
});

test("confirmed unusable stores cannot be recreated after disappearing", async (t) => {
	for (const source of ["invalid UTF-8", "oversized", "symlink"] as const) {
		await t.test(source, async () => {
			const { store, dir, cleanup } = await makeStore();
			try {
				if (source === "invalid UTF-8") {
					await writeFile(memoryPath(dir), Buffer.from([0xff, 0xfe]));
				} else if (source === "oversized") {
					await writeFile(memoryPath(dir), "x".repeat(MAX_FILE_BYTES + 1));
				} else {
					await writeFile(join(dir, "real.md"), "preserve target");
					await symlink(join(dir, "real.md"), memoryPath(dir));
				}
				const loaded = await store.load();
				assert.ok(loaded.state === "unreadable" || loaded.state === "oversized", `${source} must be unusable`);
				await rm(memoryPath(dir));
				const result = await add(store, "must not recreate");
				assert.equal(result.success, false);
				assert.match(result.error ?? "", /disappeared/);
				assert.equal(existsSync(memoryPath(dir)), false);
			} finally {
				await cleanup();
			}
		});
	}
});

test("unconfirmed unreadable path remains recoverable for initial creation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-repair-"));
	const dir = join(root, "missing");
	const store = new MemoryStore({ directory: dir, target: "memory", limit: LIMIT });
	try {
		const loaded = await store.load();
		assert.equal(loaded.state, "unreadable");
		assert.match(loaded.conflictWarning ?? "", /presence could not be confirmed/);
		await mkdir(dir);
		const result = await add(store, "initial entry");
		assert.equal(result.success, true, result.error ?? "");
		assert.equal(await readFile(memoryPath(dir), "utf8"), "initial entry");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ambiguous-match previews are aggregate-bounded", async () => {
	const { store, cleanup } = await makeStore();
	try {
		// 50 entries all containing the search substring.
		for (let i = 0; i < 50; i++) await add(store, `shared-${i} unique tail ${i}`);
		const result = await replace(store, "shared", "x");
		assert.equal(result.success, false);
		const serialized = JSON.stringify(result.matches ?? []);
		assert.ok(serialized.length < 3000, `previews must be bounded, got ${serialized.length}`);
	} finally {
		await cleanup();
	}
});

test("file appearing during a creation-assumed mutation aborts before rename", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-appear-"));
	try {
		// Reload sees the store absent via open(); the persistence-time appearance
		// check is the only stat on MEMORY.md, so report existence there.
		const store = new MemoryStore({
			directory: dir,
			target: "memory",
			limit: LIMIT,
			statFn: async (p) => {
				if (p === memoryPath(dir)) return {} as import("node:fs").Stats;
				throw Object.assign(new Error("enoent"), { code: "ENOENT" });
			},
			renameFn: async () => { throw new Error("rename must not run after appearance detected"); },
		});
		await assert.rejects(add(store, "boom"), /appeared during this mutation/);
		assert.ok(!existsSync(memoryPath(dir)), "arrived content must be untouched");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("restrictive file mode survives atomic rewrite", async () => {
	const { store, dir, cleanup } = await makeStore();
	try {
		await add(store, "secret-ish");
		await chmod(memoryPath(dir), 0o600);
		await add(store, "more");
		const mode = (await stat(memoryPath(dir))).mode & 0o777;
		assert.equal(mode, 0o600, `expected 0o600, got ${mode.toString(8)}`);
	} finally {
		await cleanup();
	}
});

test("an existing store that cannot be fingerprinted aborts before mutation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-fingerprint-failure-"));
	const path = memoryPath(dir);
	try {
		await writeFile(path, "preserve me", "utf-8");
		let renamed = false;
		const store = new MemoryStore({
			directory: dir,
			target: "memory",
			limit: LIMIT,
			statFn: async () => { throw new Error("simulated stat failure"); },
			renameFn: async () => { renamed = true; },
		});
		const result = await add(store, "local mutation");
		assert.equal(result.success, false);
		assert.match(result.error ?? "", /could not be fingerprinted/);
		assert.equal(renamed, false);
		assert.equal(await readFile(path, "utf-8"), "preserve me");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("external update between reload and rename aborts instead of overwriting V2", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-v2-"));
	try {
		await writeFile(memoryPath(dir), "V1 content", "utf-8");
		let statCalls = 0;
		const store = new MemoryStore({
			directory: dir,
			target: "memory",
			limit: LIMIT,
			statFn: async (p) => {
				if (p !== memoryPath(dir)) throw Object.assign(new Error("enoent"), { code: "ENOENT" });
				statCalls++;
				// Fingerprint capture sees V1; pre-rename verify sees V2 (sync landed).
				return statCalls === 1 ? { mtimeMs: 1, size: 11 } as import("node:fs").Stats : { mtimeMs: 999, size: 20 } as import("node:fs").Stats;
			},
			renameFn: async () => { throw new Error("rename must not run after change detected"); },
		});
		await assert.rejects(add(store, "local mutation"), /changed during this mutation/);
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
			target: "memory",
			limit: LIMIT,
			statFn: async () => {
				statCalls++;
				if (statCalls === 2) await writeFile(path, "V2 content", "utf-8");
				return fingerprint;
			},
			renameFn: async () => { throw new Error("rename must not run after content changed"); },
		});
		await assert.rejects(add(store, "local mutation"), /changed during this mutation/);
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
		const store = new MemoryStore({ directory: dir, target: "memory", limit: LIMIT });
		const result = await add(store, "boom");
		assert.equal(result.success, false);
		assert.match(result.error ?? "", /symlink/);
	} finally {
		await cleanup();
	}
});

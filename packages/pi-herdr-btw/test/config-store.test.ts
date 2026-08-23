import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore } from "../internal/config.ts";

async function withStore(run: (store: ConfigStore) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "btw-config-"));
	try {
		await run(new ConfigStore(join(directory, "config.json")));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("load returns defaults when config is missing and preserves malformed JSON", async () => {
	await withStore(async (store) => {
		assert.deepEqual(await store.load(), { autoSubmit: false, tools: "inherit", split: "right" });
		await writeFile(store.path, "{ broken");
		await assert.rejects(store.load());
		assert.equal(await readFile(store.path, "utf8"), "{ broken");
	});
});

test("concurrent updates from two stores do not lose writes", async () => {
	await withStore(async (store) => {
		const other = new ConfigStore(store.path);
		await Promise.all([
			store.update((config) => ({ ...config, autoSubmit: true })),
			other.update((config) => ({ ...config, tools: "read-only" })),
			store.update((config) => ({ ...config, split: "down" })),
			other.update((config) => ({ ...config, autoSubmit: true })),
		]);
		assert.deepEqual(await store.load(), {
			autoSubmit: true,
			tools: "read-only",
			split: "down",
		});
	});
});

test("save persists config atomically and reset restores defaults", async () => {
	await withStore(async (store) => {
		await store.save({ autoSubmit: true, tools: "all", split: "down" });
		assert.deepEqual(await store.load(), { autoSubmit: true, tools: "all", split: "down" });
		assert.deepEqual(await store.reset(), { autoSubmit: false, tools: "inherit", split: "right" });
		assert.deepEqual(await store.load(), { autoSubmit: false, tools: "inherit", split: "right" });
	});
});

test("save rejects invalid config without writing", async () => {
	await withStore(async (store) => {
		await assert.rejects(
			// @ts-expect-error invalid value on purpose
			store.save({ autoSubmit: "yes", tools: "all", split: "down" }),
			/autoSubmit must be/,
		);
	});
});

test("stale lock file is reclaimed after the stale window", async () => {
	await withStore(async (store) => {
		const { mkdir, utimes } = await import("node:fs/promises");
		await mkdir(`${store.path}.lock`, { recursive: true });
		const old = new Date(Date.now() - 60_000);
		await utimes(`${store.path}.lock`, old, old);
		await store.save({ autoSubmit: true, tools: "none", split: "down" });
		assert.deepEqual(await store.load(), { autoSubmit: true, tools: "none", split: "down" });
	});
});

test("existing file contents are preserved through update round-trip", async () => {
	await withStore(async (store) => {
		await writeFile(
			store.path,
			JSON.stringify({ autoSubmit: true, tools: "read-only", split: "down" }, null, 2),
			{ mode: 0o600 },
		);
		await store.update((config) => ({ ...config, split: "right" }));
		const saved = await store.load();
		assert.deepEqual(saved, { autoSubmit: true, tools: "read-only", split: "right" });
	});
});

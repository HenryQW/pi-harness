import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createBtwConfigStore, DEFAULT_CONFIG } from "../internal/config.ts";

async function withStore(
	run: (agentDir: string, store: ReturnType<typeof createBtwConfigStore>) => Promise<void>,
): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "btw-config-"));
	try {
		await run(agentDir, createBtwConfigStore(agentDir));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("uses the config home without legacy fallback and preserves malformed JSON", async () => {
	await withStore(async (agentDir, store) => {
		const legacyPath = join(agentDir, "config", "pi-herdr-btw.json");
		const legacyContents = JSON.stringify({ autoSubmit: true, tools: "all", split: "down" });
		await mkdir(dirname(legacyPath), { recursive: true });
		await writeFile(legacyPath, legacyContents);

		assert.equal(store.path, join(agentDir, "config", "pi-herdr-btw", "config.json"));
		assert.deepEqual(store.loadSync(), { source: "missing", value: { ...DEFAULT_CONFIG } });
		await assert.rejects(readFile(store.path, "utf8"), { code: "ENOENT" });
		assert.equal(await readFile(legacyPath, "utf8"), legacyContents);

		await mkdir(dirname(store.path), { recursive: true });
		await writeFile(store.path, "{ broken");
		assert.throws(() => store.loadSync());
		await assert.rejects(store.update((config) => ({ ...config, split: "down" })));
		assert.equal(await readFile(store.path, "utf8"), "{ broken");
	});
});

test("concurrent shared updates do not lose config changes", async () => {
	await withStore(async (agentDir, store) => {
		const other = createBtwConfigStore(agentDir);
		await Promise.all([
			store.update((config) => ({ ...config, autoSubmit: true })),
			other.update((config) => ({ ...config, tools: "read-only" })),
			store.update((config) => ({ ...config, split: "down" })),
			other.update((config) => ({ ...config, autoSubmit: true })),
		]);
		assert.deepEqual(store.loadSync(), {
			source: "file",
			value: { autoSubmit: true, tools: "read-only", split: "down" },
		});
	});
});

test("save persists validated defaults after reset", async () => {
	await withStore(async (_agentDir, store) => {
		await mkdir(dirname(store.path), { recursive: true });
		await writeFile(store.path, "{ broken");
		await store.save({ ...DEFAULT_CONFIG });
		assert.deepEqual(store.loadSync(), { source: "file", value: { ...DEFAULT_CONFIG } });
	});
});

test("update rejects invalid config without writing", async () => {
	await withStore(async (_agentDir, store) => {
		await store.save({ autoSubmit: true, tools: "all", split: "down" });
		const before = await readFile(store.path, "utf8");
		await assert.rejects(
			// @ts-expect-error invalid value on purpose
			store.update(() => ({ autoSubmit: "yes", tools: "all", split: "down" })),
			/autoSubmit must be/,
		);
		assert.equal(await readFile(store.path, "utf8"), before);
	});
});

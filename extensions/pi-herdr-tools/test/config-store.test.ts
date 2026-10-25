import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createHerdrToolsConfigStore, DEFAULT_CONFIG } from "../internal/config.ts";

const defaults = { runtimeMs: 600_000, outputBytes: 10_485_760, concurrency: 4, retainedJobs: 1000, btw: { ...DEFAULT_CONFIG } };

async function withStore(
	run: (agentDir: string, store: ReturnType<typeof createHerdrToolsConfigStore>) => Promise<void>,
): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "btw-config-"));
	try {
		await run(agentDir, createHerdrToolsConfigStore(agentDir));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("uses the shared config home without legacy fallback and preserves malformed JSON", async () => {
	await withStore(async (agentDir, store) => {
		const legacyPath = join(agentDir, "config", "pi-herdr-btw", "config.json");
		const legacyContents = JSON.stringify({ autoSubmit: true, tools: "all", split: "down" });
		await mkdir(dirname(legacyPath), { recursive: true });
		await writeFile(legacyPath, legacyContents);

		assert.equal(store.path, join(agentDir, "config", "pi-herdr-tools", "config.json"));
		assert.deepEqual(store.loadSync(), { status: "ok", source: "missing", value: defaults, issues: [] });
		await assert.rejects(readFile(store.path, "utf8"), { code: "ENOENT" });
		assert.equal(await readFile(legacyPath, "utf8"), legacyContents);

		await mkdir(dirname(store.path), { recursive: true });
		await writeFile(store.path, "{ broken");
		const broken = store.loadSync();
		assert.equal(broken.status, "ok");
		assert.deepEqual(broken.status === "ok" && broken.value, defaults);
		assert.equal(broken.issues[0]?.kind, "invalid-json");
		await assert.rejects(store.update((config) => ({ ...config, btw: { ...config.btw, split: "down" } })));
		assert.equal(await readFile(store.path, "utf8"), "{ broken");
	});
});

test("concurrent shared updates keep both side-thread fields and command policy", async () => {
	await withStore(async (agentDir, store) => {
		const other = createHerdrToolsConfigStore(agentDir);
		await Promise.all([
			store.update((config) => ({ ...config, btw: { ...config.btw, autoSubmit: true } })),
			other.update((config) => ({ ...config, btw: { ...config.btw, tools: "read-only" } })),
			store.update((config) => ({ ...config, btw: { ...config.btw, split: "down" } })),
			other.update((config) => ({ ...config, concurrency: 1 })),
		]);
		assert.deepEqual(store.loadSync(), {
			status: "ok",
			source: "file",
			value: { ...defaults, concurrency: 1, btw: { autoSubmit: true, tools: "read-only", split: "down" } },
			issues: [],
		});
	});
});

test("update rejects invalid config without writing", async () => {
	await withStore(async (_agentDir, store) => {
		await store.save({ ...defaults, btw: { autoSubmit: true, tools: "all", split: "down" } });
		const before = await readFile(store.path, "utf8");
		await assert.rejects(
			// @ts-expect-error invalid value on purpose
			store.update((config) => ({ ...config, btw: { autoSubmit: "yes", tools: "all", split: "down" } })),
			/btw.autoSubmit: must be true or false/,
		);
		assert.equal(await readFile(store.path, "utf8"), before);
	});
});

test("invalid and unknown nested keys use field defaults and are reported", async () => {
	await withStore(async (_agentDir, store) => {
		await mkdir(dirname(store.path), { recursive: true });
		await writeFile(store.path, JSON.stringify({ concurrency: 2, btw: { autoSubmit: true, split: "left", tool: "none", volume: 3 } }));
		assert.deepEqual(store.loadSync(), {
			status: "ok",
			source: "file",
			value: { ...defaults, concurrency: 2, btw: { ...DEFAULT_CONFIG, autoSubmit: true } },
			issues: [
				{ kind: "unknown-key", key: "btw.volume", message: "unknown key" },
				{ kind: "invalid-value", key: "btw.tools", message: 'unknown key "tool"; did you mean "tools"?' },
				{ kind: "invalid-value", key: "btw.split", message: "must be one of right, down" },
			],
		});
	});
});

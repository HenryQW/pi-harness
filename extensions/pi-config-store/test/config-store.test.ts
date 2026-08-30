import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createConfigStore, extensionConfigDir, extensionConfigPath } from "../src/index.ts";

type Config = { count: number };

function parseConfig(value: unknown): Config {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
	const record = value as Record<string, unknown>;
	const count = record.count;
	if (Object.keys(record).length !== 1 || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
		throw new Error("count must be a non-negative safe integer");
	}
	return { count };
}

function createStore(agentDir: string) {
	return createConfigStore({
		extensionId: "pi-test-store",
		agentDir,
		defaults: () => ({ count: 0 }),
		parse: parseConfig,
	});
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-config-store-"));
	try {
		await run(agentDir);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("config paths reject traversal and have no filesystem side effects", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-config-store-path-"));
	try {
		assert.equal(extensionConfigDir("pi-test-store", agentDir), join(agentDir, "config", "pi-test-store"));
		assert.equal(extensionConfigPath("pi-test-store", agentDir), join(agentDir, "config", "pi-test-store", "config.json"));
		for (const extensionId of ["", ".", "..", "../escape", "/tmp", "pi/test", "pi\\test", "Pi-test", "pi_test", "pi.test"]) {
			assert.throws(() => extensionConfigPath(extensionId, agentDir), /extensionId/);
		}
		assert.deepEqual(await readdir(agentDir), []);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("missing config returns validated defaults without writing", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		assert.deepEqual(store.loadSync(), { source: "missing", value: { count: 0 } });
		assert.deepEqual(await readdir(agentDir), []);

		const invalidDefaults = createConfigStore({
			extensionId: "pi-invalid-defaults",
			agentDir,
			defaults: () => ({ count: -1 }),
			parse: parseConfig,
		});
		assert.throws(() => invalidDefaults.loadSync(), /count/);
	});
});

test("invalid files remain unchanged", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		await mkdir(dirname(store.path), { recursive: true });
		for (const contents of [
			Buffer.from("{ broken"),
			Buffer.from([0x7b, 0x80, 0x7d]),
			Buffer.alloc(64 * 1024 + 1, 0x20),
			Buffer.from('{"count":"wrong"}'),
		]) {
			await writeFile(store.path, contents);
			const before = await readFile(store.path);
			assert.throws(() => store.loadSync());
			assert.deepEqual(await readFile(store.path), before);
		}
	});
});

test("invalid mutations preserve the current file", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		await store.save({ count: 1 });
		const before = await readFile(store.path);
		await assert.rejects(store.save({ count: -1 }), /count/);
		await assert.rejects(store.update(() => ({ count: -1 })), /count/);
		assert.deepEqual(await readFile(store.path), before);
	});
});

test("concurrent updates do not lose changes", async () => {
	await withAgentDir(async (agentDir) => {
		const first = createStore(agentDir);
		const second = createStore(agentDir);
		await Promise.all(Array.from({ length: 12 }, (_, index) =>
			(index % 2 === 0 ? first : second).update(({ count }) => ({ count: count + 1 }))));
		assert.deepEqual(first.loadSync(), { source: "file", value: { count: 12 } });
	});
});

test("save is atomic and cleans failed temporary files", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		await store.save({ count: 1 });
		assert.deepEqual(store.loadSync(), { source: "file", value: { count: 1 } });
		assert.equal((await readdir(dirname(store.path))).some((entry) => entry.endsWith(".tmp")), false);

		await rm(store.path);
		await mkdir(store.path);
		await assert.rejects(store.save({ count: 2 }));
		assert.equal((await readdir(dirname(store.path))).some((entry) => entry.endsWith(".tmp")), false);
	});
});

test("saved config uses private modes where supported", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		await store.save({ count: 1 });
		if (process.platform !== "win32") {
			assert.equal((await stat(dirname(store.path))).mode & 0o777, 0o700);
			assert.equal((await stat(store.path)).mode & 0o777, 0o600);
		}
	});
});

test("remove preserves sibling files", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		await store.save({ count: 1 });
		const sibling = join(dirname(store.path), "usage.json");
		await writeFile(sibling, "keep");
		await store.remove();
		await assert.rejects(readFile(store.path), { code: "ENOENT" });
		assert.equal(await readFile(sibling, "utf8"), "keep");
	});
});

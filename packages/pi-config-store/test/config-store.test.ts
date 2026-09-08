import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	createConfigStore,
	extensionConfigDir,
	extensionConfigPath,
	readTextFileBounded,
	readTextFileBoundedSync,
	writePrivateTextFileAtomically,
} from "../src/index.ts";

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

const boundedReaders = [
	async (path: string, maxBytes: number) => readTextFileBoundedSync(path, maxBytes),
	(path: string, maxBytes: number) => readTextFileBounded(path, maxBytes),
];

test("bounded text reads enforce byte limits and strict UTF-8", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "input.txt");
		await writeFile(path, "é");
		for (const read of boundedReaders) {
			assert.equal(await read(path, 2), "é");
			for (const maxBytes of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				await assert.rejects(read(path, maxBytes), /positive safe integer/);
			}
		}

		const controller = new AbortController();
		controller.abort();
		await assert.rejects(readTextFileBounded(path, 2, { signal: controller.signal }), { name: "AbortError" });

		await writeFile(path, "éx");
		for (const read of boundedReaders) await assert.rejects(read(path, 2), /exceeds 2 bytes/);

		await writeFile(path, Buffer.from([0x80]));
		for (const read of boundedReaders) await assert.rejects(read(path, 1), TypeError);
		await rm(path);
	});
});

test("bounded text reads propagate missing files", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "missing.txt");
		for (const read of boundedReaders) {
			await assert.rejects(read(path, 1), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		}
	});
});

test("private text writes replace atomically with private modes", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "state", "usage.txt");
		await writePrivateTextFileAtomically(path, "first");
		await writePrivateTextFileAtomically(path, "second é");
		assert.equal(await readFile(path, "utf8"), "second é");
		assert.equal((await readdir(dirname(path))).some((entry) => entry.endsWith(".tmp")), false);
		if (process.platform !== "win32") {
			assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
			assert.equal((await stat(path)).mode & 0o777, 0o600);
		}
	});
});

test("private text writes clean temporary files after failure", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "state", "usage.txt");
		await mkdir(path, { recursive: true });
		await assert.rejects(writePrivateTextFileAtomically(path, "blocked"));
		assert.equal((await readdir(dirname(path))).some((entry) => entry.endsWith(".tmp")), false);
	});
});

test("already-aborted private text writes have no filesystem side effects", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "not-created", "usage.txt");
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(writePrivateTextFileAtomically(path, "blocked", { signal: controller.signal }), { name: "AbortError" });
		await assert.rejects(stat(dirname(path)), { code: "ENOENT" });
	});
});

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

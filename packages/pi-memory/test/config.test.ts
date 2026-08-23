import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	DEFAULT_MEMORY_CHAR_LIMIT,
	DEFAULT_USER_CHAR_LIMIT,
	loadMemoryConfig,
} from "../src/config.ts";

async function makeDir() {
	return mkdtemp(join(tmpdir(), "pi-memory-config-"));
}

test("absent file returns defaults", async () => {
	const path = join(await makeDir(), "pi-memory.json");
	const config = loadMemoryConfig(path);
	assert.equal(config.memoryCharLimit, DEFAULT_MEMORY_CHAR_LIMIT);
	assert.equal(config.userCharLimit, DEFAULT_USER_CHAR_LIMIT);
	assert.ok(config.directory.length > 0);
});

test("partial config merges with defaults", async () => {
	const dir = await makeDir();
	const path = join(dir, "pi-memory.json");
	await writeFile(path, JSON.stringify({ memoryCharLimit: 100 }));
	try {
		const config = loadMemoryConfig(path);
		assert.equal(config.memoryCharLimit, 100);
		assert.equal(config.userCharLimit, DEFAULT_USER_CHAR_LIMIT);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("valid full config accepted", async () => {
	const dir = await makeDir();
	const path = join(await makeDir(), "pi-memory.json");
	await writeFile(path, JSON.stringify({ directory: dir, memoryCharLimit: 42, userCharLimit: 7 }));
	try {
		assert.deepEqual(loadMemoryConfig(path), { directory: dir, memoryCharLimit: 42, userCharLimit: 7 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("malformed JSON throws and file bytes unchanged", async () => {
	const dir = await makeDir();
	const path = join(dir, "pi-memory.json");
	const bytes = "{ not json !!";
	await writeFile(path, bytes);
	try {
		assert.throws(() => loadMemoryConfig(path), new RegExp("pi-memory\\.json"));
		assert.equal(await readFile(path, "utf8"), bytes);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("non-object top level throws with file path", async () => {
	const dir = await makeDir();
	const path = join(dir, "pi-memory.json");
	await writeFile(path, "[1,2]");
	try {
		assert.throws(() => loadMemoryConfig(path), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("wrong types throw naming field", async () => {
	const dir = await makeDir();
	const path = join(dir, "pi-memory.json");
	try {
		for (const [field, value] of [
			["directory", 123],
			["memoryCharLimit", "big"],
			["userCharLimit", null],
		] as const) {
			await writeFile(path, JSON.stringify({ [field]: value }));
			assert.throws(() => loadMemoryConfig(path), new RegExp(field));
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("invalid limits throw", async () => {
	const dir = await makeDir();
	const path = join(dir, "pi-memory.json");
	try {
		for (const value of [-1, 0, 1.5, 100_001]) {
			await writeFile(path, JSON.stringify({ memoryCharLimit: value }));
			assert.throws(() => loadMemoryConfig(path), /memoryCharLimit/);
			await writeFile(path, JSON.stringify({ userCharLimit: value }));
			assert.throws(() => loadMemoryConfig(path), /userCharLimit/);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("relative directory throws, absolute accepted", async () => {
	const dir = await makeDir();
	const path = join(dir, "pi-memory.json");
	try {
		await writeFile(path, JSON.stringify({ directory: "relative/dir" }));
		assert.throws(() => loadMemoryConfig(path), /directory/);

		const absolute = resolve(await makeDir());
		await writeFile(path, JSON.stringify({ directory: absolute }));
		assert.equal(loadMemoryConfig(path).directory, absolute);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("unknown keys fail fast instead of silently using defaults", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-config-"));
	const configPath = join(dir, "pi-memory.json");
	try {
		await writeFile(configPath, JSON.stringify({ memoryCharLimits: 100 }));
		assert.throws(() => loadMemoryConfig(configPath), /Unknown key 'memoryCharLimits'/);
		// File preserved byte-for-byte.
		assert.equal(await readFile(configPath, "utf-8"), JSON.stringify({ memoryCharLimits: 100 }));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

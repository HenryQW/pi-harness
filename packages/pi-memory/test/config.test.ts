import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	configPath,
	DEFAULT_MEMORY_CHAR_LIMIT,
	DEFAULT_USER_CHAR_LIMIT,
	loadMemoryConfig,
} from "../src/config.ts";

async function makeDir() {
	return mkdtemp(join(tmpdir(), "pi-memory-config-"));
}

async function writeConfig(agentDir: string, contents: string | Uint8Array): Promise<string> {
	const path = configPath(agentDir);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents);
	return path;
}

test("absent config returns defaults without creating its home", async () => {
	const agentDir = await makeDir();
	try {
		const loaded = loadMemoryConfig(agentDir);
		assert.deepEqual(loaded, {
			source: "missing",
			value: {
				directory: join(agentDir, "config", "pi-memory", "memory"),
				memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
				userCharLimit: DEFAULT_USER_CHAR_LIMIT,
			},
		});
		await assert.rejects(readFile(configPath(agentDir), "utf8"), { code: "ENOENT" });
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("partial config merges with defaults", async () => {
	const agentDir = await makeDir();
	try {
		await writeConfig(agentDir, JSON.stringify({ memoryCharLimit: 100 }));
		const { value } = loadMemoryConfig(agentDir);
		assert.equal(value.memoryCharLimit, 100);
		assert.equal(value.userCharLimit, DEFAULT_USER_CHAR_LIMIT);
		assert.equal(value.directory, join(agentDir, "config", "pi-memory", "memory"));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("valid full config is accepted", async () => {
	const agentDir = await makeDir();
	const directory = await makeDir();
	try {
		await writeConfig(agentDir, JSON.stringify({ directory, memoryCharLimit: 42, userCharLimit: 7 }));
		assert.deepEqual(loadMemoryConfig(agentDir), {
			source: "file",
			value: { directory, memoryCharLimit: 42, userCharLimit: 7 },
		});
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

test("malformed JSON throws and leaves bytes unchanged", async () => {
	const agentDir = await makeDir();
	const bytes = "{ not json !!";
	try {
		const path = await writeConfig(agentDir, bytes);
		assert.throws(() => loadMemoryConfig(agentDir), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(await readFile(path, "utf8"), bytes);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("non-object top level throws with file path", async () => {
	const agentDir = await makeDir();
	try {
		const path = await writeConfig(agentDir, "[1,2]");
		assert.throws(() => loadMemoryConfig(agentDir), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("wrong types throw naming the field", async () => {
	const agentDir = await makeDir();
	try {
		for (const [field, value] of [
			["directory", 123],
			["memoryCharLimit", "big"],
			["userCharLimit", null],
		] as const) {
			await writeConfig(agentDir, JSON.stringify({ [field]: value }));
			assert.throws(() => loadMemoryConfig(agentDir), new RegExp(field));
		}
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("invalid limits throw", async () => {
	const agentDir = await makeDir();
	try {
		for (const value of [-1, 0, 1.5, 100_001]) {
			await writeConfig(agentDir, JSON.stringify({ memoryCharLimit: value }));
			assert.throws(() => loadMemoryConfig(agentDir), /memoryCharLimit/);
			await writeConfig(agentDir, JSON.stringify({ userCharLimit: value }));
			assert.throws(() => loadMemoryConfig(agentDir), /userCharLimit/);
		}
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("relative directory throws, absolute directory is accepted", async () => {
	const agentDir = await makeDir();
	const directory = await makeDir();
	try {
		await writeConfig(agentDir, JSON.stringify({ directory: "relative/dir" }));
		assert.throws(() => loadMemoryConfig(agentDir), /directory/);

		await writeConfig(agentDir, JSON.stringify({ directory }));
		assert.equal(loadMemoryConfig(agentDir).value.directory, directory);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

test("unknown keys fail fast and preserve the file", async () => {
	const agentDir = await makeDir();
	const contents = JSON.stringify({ memoryCharLimits: 100 });
	try {
		const path = await writeConfig(agentDir, contents);
		assert.throws(() => loadMemoryConfig(agentDir), /Unknown key 'memoryCharLimits'/);
		assert.equal(await readFile(path, "utf8"), contents);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("invalid UTF-8 fails as malformed and preserves the file", async () => {
	const agentDir = await makeDir();
	try {
		const bytes = Buffer.concat([Buffer.from(JSON.stringify({ directory: "/tmp/" }), "utf8"), Buffer.from([0xff])]);
		const path = await writeConfig(agentDir, bytes);
		assert.throws(() => loadMemoryConfig(agentDir), /invalid UTF-8/);
		assert.deepEqual(await readFile(path), bytes);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("control characters and oversized configs are rejected", async () => {
	const agentDir = await makeDir();
	try {
		await writeConfig(agentDir, JSON.stringify({ directory: "/tmp/\nx" }));
		assert.throws(() => loadMemoryConfig(agentDir), /must not contain control characters/);

		const oversized = "x".repeat(65 * 1024);
		const path = await writeConfig(agentDir, oversized);
		assert.throws(() => loadMemoryConfig(agentDir), /too large/);
		assert.equal(await readFile(path, "utf8"), oversized);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

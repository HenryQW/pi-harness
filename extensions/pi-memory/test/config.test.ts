import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT, memoryConfigStore } from "../src/config.ts";

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-memory-config-"));
	try {
		await run(agentDir);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

async function writeConfig(agentDir: string, contents: string): Promise<string> {
	const path = memoryConfigStore(agentDir).path;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents);
	return path;
}

test("absent config returns defaults without creating its home", async () => {
	await withAgentDir(async (agentDir) => {
		const store = memoryConfigStore(agentDir);
		assert.deepEqual(store.loadSync(), {
			status: "ok",
			source: "missing",
			value: {
				directory: join(agentDir, "config", "pi-memory", "memory"),
				memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
				userCharLimit: DEFAULT_USER_CHAR_LIMIT,
			},
			issues: [],
		});
		await assert.rejects(readFile(store.path, "utf8"), { code: "ENOENT" });
	});
});

test("valid full config is accepted", async () => {
	await withAgentDir(async (agentDir) => {
		await writeConfig(agentDir, JSON.stringify({ directory: "/tmp/memory", memoryCharLimit: 42, userCharLimit: 7 }));
		assert.deepEqual(memoryConfigStore(agentDir).loadSync(), {
			status: "ok",
			source: "file",
			value: { directory: "/tmp/memory", memoryCharLimit: 42, userCharLimit: 7 },
			issues: [],
		});
	});
});

test("unknown keys and invalid limits warn and fall back per key", async () => {
	await withAgentDir(async (agentDir) => {
		const contents = JSON.stringify({ memoryCharLimits: 100, memoryCharLimit: 0, userCharLimit: 7 });
		const path = await writeConfig(agentDir, contents);
		const loaded = memoryConfigStore(agentDir).loadSync();
		assert.ok(loaded.status === "ok");
		assert.equal(loaded.value.memoryCharLimit, DEFAULT_MEMORY_CHAR_LIMIT);
		assert.equal(loaded.value.userCharLimit, 7);
		assert.deepEqual(loaded.issues.map(({ kind, key }) => [kind, key]), [
			["unknown-key", "memoryCharLimits"],
			["invalid-value", "memoryCharLimit"],
		]);
		assert.equal(await readFile(path, "utf8"), contents);
	});
});

test("invalid directory or unreadable file disables memory instead of using the default directory", async () => {
	await withAgentDir(async (agentDir) => {
		for (const contents of [JSON.stringify({ directory: "relative/dir" }), JSON.stringify({ directory: "/tmp/\nx" }), JSON.stringify({ directroy: "/tmp/memory" }), "{ not json"]) {
			const path = await writeConfig(agentDir, contents);
			const loaded = memoryConfigStore(agentDir).loadSync();
			assert.equal(loaded.status, "disabled", contents);
			assert.equal(loaded.issues.length, 1);
			assert.equal(await readFile(path, "utf8"), contents);
		}
	});
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSubagentConfig, configPath } from "../extensions/config.ts";
import { DEFAULT_MAX_TURNS } from "../src/index.ts";

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-config-"));
	try {
		await run(agentDir);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

async function configDir(agentDir: string): Promise<void> {
	await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
}

test("missing config yields defaults without a legacy fallback", async () => {
	await withAgentDir(async (agentDir) => {
		const legacyPath = join(agentDir, "config", "pi-subagent", "pi-subagent.json");
		const legacy = JSON.stringify({ maxTurns: 1 });
		await configDir(agentDir);
		await writeFile(legacyPath, legacy);

		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded, { source: "missing", config: {} });
		assert.equal(loaded.config.maxTurns ?? DEFAULT_MAX_TURNS, 50);
		assert.equal(await readFile(legacyPath, "utf8"), legacy);
		await assert.rejects(() => readFile(configPath(agentDir), "utf8"), { code: "ENOENT" });
	});
});

test("valid maxSubagents, maxTurns, and timeout are accepted", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({
			maxSubagents: 3,
			maxTurns: 75,
			timeout: { idleMinutes: 15, maxMinutes: 60 },
		}));
		assert.deepEqual(readSubagentConfig(agentDir), {
			source: "file",
			config: {
				maxSubagents: 3,
				maxTurns: 75,
				timeout: { idleMinutes: 15, maxMinutes: 60 },
			},
		});
	});
});

test("malformed JSON reports an error and preserves defaults", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		const path = configPath(agentDir);
		const broken = "{ maxSubagents: ";
		await writeFile(path, broken);
		const loaded = readSubagentConfig(agentDir);
		assert.equal(loaded.source, "file");
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /not valid JSON/);
		assert.match(loaded.error!, /using defaults\.$/);
		assert.equal(await readFile(path, "utf8"), broken);
		assert.match(readSubagentConfig(agentDir).error!, /not valid JSON/);
	});
});

test("invalid UTF-8 reports an error and preserves the file", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		const path = configPath(agentDir);
		const bytes = Buffer.concat([Buffer.from('{"maxTurns": 1}'), Buffer.from([0xff])]);
		await writeFile(path, bytes);
		const loaded = readSubagentConfig(agentDir);
		assert.equal(loaded.source, "file");
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /couldn't be read/);
		assert.deepEqual(await readFile(path), bytes);
	});
});

test("invalid concurrency and turn limits report errors and preserve defaults", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({ maxSubagents: 0, maxTurns: 1.5 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /maxSubagents must be a safe integer >= 1, got 0/);
		assert.match(loaded.error!, /maxTurns must be a safe integer >= 1, got 1.5/);
	});
});

test("valid settings survive unrelated diagnostics", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({ maxSubagents: 3, maxTurns: 1.5 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, { maxSubagents: 3 });
		assert.match(loaded.error!, /invalid settings use defaults while valid settings still apply\.$/);
		assert.match(loaded.error!, /maxTurns must be a safe integer >= 1, got 1.5/);
	});
});

test("invalid timeout values report an error and preserve defaults", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({
			timeout: { idleMinutes: -1, maxMinutes: Infinity, unknownKey: 1 },
		}));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /timeout\.idleMinutes must be a positive number of minutes, got -1/);
		assert.match(loaded.error!, /timeout\.maxMinutes must be a positive number of minutes/);
		assert.match(loaded.error!, /unknown timeout\.unknownKey/);
	});
});

test("timeout values that overflow Node timers report an error", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({
			timeout: { idleMinutes: 50_000_000 },
		}));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /exceeds the maximum supported delay/);
	});
});

test("non-object timeout reports an error", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({ timeout: 5 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /timeout must be a JSON object, got 5/);
	});
});

test("non-object config root reports an error", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), "[1, 2]");
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /must contain a JSON object/);
	});
});

test("non-safe maxSubagents values report an error", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({ maxSubagents: 1e100 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /maxSubagents must be a safe integer >= 1/);
	});
});

test("config path uses the extension config home", () => {
	assert.equal(configPath("/agents"), join("/agents", "config", "pi-subagent", "config.json"));
});

test("unknown top-level keys report an error", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({ maxSubagent: 2 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /unknown config key "maxSubagent"/);
	});
});

test("effective maxMinutes must exceed idleMinutes when one field is omitted", async () => {
	await withAgentDir(async (agentDir) => {
		await configDir(agentDir);
		await writeFile(configPath(agentDir), JSON.stringify({
			timeout: { idleMinutes: 30 },
		}));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /timeout\.maxMinutes \(30\) must be greater than timeout\.idleMinutes \(30\)/);
	});
});

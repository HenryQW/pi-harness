import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSubagentConfig, configPath } from "../extensions/config.ts";

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-config-"));
	try {
		await run(agentDir);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("missing config file yields empty config", async () => {
	await withAgentDir(async (agentDir) => {
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.equal(loaded.error, undefined);
	});
});

test("valid maxSubagents and timeout are accepted", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({
			maxSubagents: 3,
			timeout: { idleMinutes: 15, maxMinutes: 60 },
		}));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {
			maxSubagents: 3,
			timeout: { idleMinutes: 15, maxMinutes: 60 },
		});
		assert.equal(loaded.error, undefined);
	});
});

test("malformed JSON reports an error and preserves defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "config", "pi-subagent", "pi-subagent.json");
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		const broken = "{ maxSubagents: ";
		await writeFile(path, broken);
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /not valid JSON/);
		const reread = readSubagentConfig(agentDir);
		assert.match(reread.error!, /not valid JSON/);
	});
});

test("invalid maxSubagents value reports an error and preserves defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({ maxSubagents: 0 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /maxSubagents must be a safe integer >= 1, got 0/);
	});
});

test("invalid timeout values report an error and preserve defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({
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
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({
			timeout: { idleMinutes: 50_000_000 },
		}));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /exceeds the maximum supported delay/);
	});
});

test("non-object timeout reports an error", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({ timeout: 5 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /timeout must be a JSON object, got 5/);
	});
});

test("non-object config root reports an error", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), "[1, 2]");
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /must contain a JSON object/);
	});
});

test("non-safe maxSubagents values report an error", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({ maxSubagents: 1e100 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /maxSubagents must be a safe integer >= 1/);
	});
});

test("config path uses the existing extension-named directory", () => {
	assert.equal(configPath("/agents"), join("/agents", "config", "pi-subagent", "pi-subagent.json"));
});

test("unknown top-level keys report an error", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({ maxSubagent: 2 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /unknown config key "maxSubagent"/);
	});
});

test("effective maxMinutes must exceed idleMinutes when one field is omitted", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config", "pi-subagent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({
			timeout: { idleMinutes: 30 },
		}));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /timeout\.maxMinutes \(30\) must be greater than timeout\.idleMinutes \(30\)/);
	});
});

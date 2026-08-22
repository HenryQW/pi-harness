import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSubagentConfig } from "../extensions/config.ts";

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
		assert.deepEqual(readSubagentConfig(agentDir), { config: {} });
	});
});

test("valid maxChildren is accepted", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({ maxChildren: 3 }));
		assert.deepEqual(readSubagentConfig(agentDir), { config: { maxChildren: 3 } });
	});
});

test("malformed JSON reports an error and preserves defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "config", "pi-subagent.json");
		await mkdir(join(agentDir, "config"), { recursive: true });
		const broken = "{ maxChildren: ";
		await writeFile(path, broken);
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /not valid JSON/);
		const reread = readSubagentConfig(agentDir);
		assert.match(reread.error!, /not valid JSON/);
	});
});

test("invalid maxChildren value reports an error and preserves defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), JSON.stringify({ maxChildren: 0 }));
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /maxChildren must be an integer >= 1, got 0/);
	});
});

test("non-object config root reports an error", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "config");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pi-subagent.json"), "[1, 2]");
		const loaded = readSubagentConfig(agentDir);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.error!, /must contain a JSON object/);
	});
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveExecutionPolicy } from "../extensions/config.ts";
import { createSubagentConfigStore, DEFAULT_SUBAGENT_CONFIG } from "../src/index.ts";

async function withStore(run: (store: ReturnType<typeof createSubagentConfigStore>) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-config-"));
	try {
		await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
		await run(createSubagentConfigStore(agentDir));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("missing config yields default limits without a legacy fallback", async () => {
	await withStore(async (store) => {
		const legacyPath = join(store.path, "..", "pi-subagent.json");
		await writeFile(legacyPath, JSON.stringify({ maxTurns: 1 }));
		const loaded = store.loadSync();
		assert.deepEqual(loaded, { status: "ok", source: "missing", value: DEFAULT_SUBAGENT_CONFIG, issues: [] });
		assert.deepEqual(resolveExecutionPolicy(store.path, loaded), {
			maxSubagents: 5, maxTurns: 50, childIdleMs: 600_000, childMaxMs: 1_800_000, maxCorrections: 1,
		});
		await assert.rejects(() => readFile(store.path, "utf8"), { code: "ENOENT" });
	});
});

test("valid execution limits, timeout, and roleDefaults are accepted", async () => {
	await withStore(async (store) => {
		const roleDefaults = { extensions: ["/provider.ts"], tools: ["read"], skills: [] };
		await writeFile(store.path, JSON.stringify({
			maxSubagents: 3, maxTurns: 1, maxTokens: 2_000, maxCorrections: 0, timeout: { idleMinutes: 15, maxMinutes: 60 }, roleDefaults,
		}));
		const loaded = store.loadSync();
		assert.deepEqual(loaded, { status: "ok", source: "file", value: {
			maxSubagents: 3, maxTurns: 1, maxTokens: 2_000, maxCorrections: 0, timeout: { idleMinutes: 15, maxMinutes: 60 }, roleDefaults,
		}, issues: [] });
		assert.deepEqual(resolveExecutionPolicy(store.path, loaded), {
			maxSubagents: 3, maxTurns: 1, maxTokens: 2_000, childIdleMs: 900_000, childMaxMs: 3_600_000, maxCorrections: 0,
		});
	});
});

test("unknown keys and invalid bounded limits warn and fall back per key to safe defaults", async () => {
	await withStore(async (store) => {
		await writeFile(store.path, JSON.stringify({
			maxSubagent: 2,
			maxSubagents: 0,
			maxTurns: 1.5,
			maxCorrections: 1,
			timeout: { idleMinutes: 50_000_000, maxMinutes: 45, sandbox: true },
			roleDefaults: { extensions: ["relative.ts"], tools: ["read"], mcps: [] },
		}));
		const loaded = store.loadSync();
		assert.equal(loaded.status, "ok");
		assert.deepEqual(loaded.issues.map(({ kind, key }) => [kind, key]), [
			["unknown-key", "maxSubagent"],
			["invalid-value", "maxSubagents"],
			["invalid-value", "maxTurns"],
			["unknown-key", "timeout.sandbox"],
			["invalid-value", "timeout.idleMinutes"],
			["invalid-value", "roleDefaults.extensions"],
			["unknown-key", "roleDefaults.mcps"],
		]);
		assert.deepEqual(loaded.status === "ok" && loaded.value, {
			...DEFAULT_SUBAGENT_CONFIG, timeout: { idleMinutes: 10, maxMinutes: 45 }, roleDefaults: { tools: ["read"] },
		});
	});
});

test("timeout that breaks the idle/max rule falls back to the default timeout", async () => {
	await withStore(async (store) => {
		await writeFile(store.path, JSON.stringify({ timeout: { idleMinutes: 30 } }));
		const loaded = store.loadSync();
		assert.equal(loaded.status, "ok");
		assert.match(loaded.issues[0]!.message, /maxMinutes \(30\) must be greater than idleMinutes \(30\)/);
		assert.deepEqual(loaded.status === "ok" && loaded.value.timeout, DEFAULT_SUBAGENT_CONFIG.timeout);
	});
});

test("invalid or misspelled maxTokens or malformed JSON disables delegation instead of removing the token limit", async () => {
	await withStore(async (store) => {
		for (const contents of [JSON.stringify({ maxTokens: 0, maxTurns: 3 }), JSON.stringify({ maxToken: 1_000 }), JSON.stringify({ MaxTokens: 1_000 }), "{ maxSubagents: "]) {
			await writeFile(store.path, contents);
			const loaded = store.loadSync();
			assert.equal(loaded.status, "disabled");
			assert.throws(() => resolveExecutionPolicy(store.path, loaded), /delegation is blocked until this file is corrected\.$/);
			assert.equal(await readFile(store.path, "utf8"), contents);
		}
	});
});

test("a misspelled bounded limit warns and keeps its finite default", async () => {
	await withStore(async (store) => {
		await writeFile(store.path, JSON.stringify({ maxTurn: 500, timeout: { maxMinute: 600 } }));
		const loaded = store.loadSync();
		assert.equal(loaded.status, "ok");
		assert.deepEqual(loaded.issues.map(({ key, message }) => [key, message]), [
			["maxTurns", 'unknown key "maxTurn"; did you mean "maxTurns"?'],
			["timeout.maxMinutes", 'unknown key "maxMinute"; did you mean "maxMinutes"?'],
		]);
		assert.deepEqual(loaded.status === "ok" && loaded.value, DEFAULT_SUBAGENT_CONFIG);
	});
});

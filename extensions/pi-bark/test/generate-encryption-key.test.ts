import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = "scripts/generate-encryption-key.ts";

function run(agentDir: string, ...args: string[]) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: join(import.meta.dirname, ".."),
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
}

test("key script stores, protects, replaces, and disables Bark push encryption", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-key-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const configPath = join(agentDir, "config", "pi-bark", "config.json");

	const generated = run(agentDir);
	assert.equal(generated.status, 0, generated.stderr);
	const firstKey = generated.stdout.match(/^Key: (.+)$/m)?.[1];
	assert.equal(firstKey?.length, 32);
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		serverUrl: "https://api.day.app",
		deviceKey: null,
		encryption: {
			algorithm: "AES256",
			mode: "GCM",
			padding: "noPadding",
			key: firstKey,
		},
		statusNotifications: { defaultEnabled: true, cwdOverrides: {} },
	});

	const protectedRun = run(agentDir);
	assert.equal(protectedRun.status, 1);
	assert.match(protectedRun.stderr, /already exists/);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).encryption.key, firstKey);

	const replaced = run(agentDir, "--force");
	assert.equal(replaced.status, 0, replaced.stderr);
	const replacementKey = replaced.stdout.match(/^Key: (.+)$/m)?.[1];
	assert.equal(replacementKey?.length, 32);
	assert.notEqual(replacementKey, firstKey);

	const disabled = run(agentDir, "--disable");
	assert.equal(disabled.status, 0, disabled.stderr);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).encryption, null);
});

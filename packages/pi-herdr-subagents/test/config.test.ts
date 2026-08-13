import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig } from "../internal/config.ts";

test("legacy maxConcurrentWorkers config is rejected", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
	try {
		const path = join(dir, "pi-herdr-subagents.json");
		await writeFile(path, JSON.stringify({ maxConcurrentWorkers: 1, models: {} }));

		assert.deepEqual(await readConfig(path), {
			value: { maxConcurrentSubagents: 10, models: {} },
			invalid: true,
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

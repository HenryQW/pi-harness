import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcess } from "../src/process.ts";

function options(cwd: string) {
	return { cwd, signal: new AbortController().signal, timeoutMs: 1_000 };
}

test("process adapter preserves ordinary exits and rejects spawn failures", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-process-"));
	t.after(async () => await rm(cwd, { recursive: true, force: true }));

	const result = await runProcess(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], options(cwd));
	assert.equal(result.code, 3);
	assert.equal(result.killed, false);
	assert.equal(result.stdout, "out");
	assert.equal(result.stderr, "err");

	await assert.rejects(
		runProcess(join(cwd, "missing-command"), [], options(cwd)),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
	);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toggleDependencyHook } from "../extensions/deps.ts";

test("disable keeps a hook that became unmanaged and a hook created concurrently", async (t) => {
	const gitDir = await mkdtemp(join(tmpdir(), "pi-deps-toggle-"));
	t.after(() => rm(gitDir, { recursive: true, force: true }));
	const hooks = join(gitDir, "hooks");
	const path = join(hooks, "post-checkout");
	await mkdir(hooks);
	await writeFile(path, "#!/bin/sh\n# pi-deps-managed-hook\n");

	await assert.rejects(
		toggleDependencyHook(gitDir, async (from, to) => {
			await writeFile(from, "user hook");
			await rename(from, to);
			await writeFile(from, "concurrent hook");
		}),
		/Cannot restore Git hook .*post-checkout; its content remains at .*post-checkout\.pi-deps-/,
	);

	const contents = await Promise.all((await readdir(hooks)).map((name) => readFile(join(hooks, name), "utf8")));
	assert.deepEqual(contents.sort(), ["concurrent hook", "user hook"]);
});

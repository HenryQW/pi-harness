import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("package loading registers all Herdr commands through one extension", async (t) => {
	const isolated = await mkdtemp(join(tmpdir(), "pi-herdr-tools-loading-"));
	t.after(() => rm(isolated, { recursive: true, force: true }));
	const packageRoot = fileURLToPath(new URL("../", import.meta.url));
	const loaded = await discoverAndLoadExtensions([packageRoot], isolated, isolated);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual(
		loaded.extensions.flatMap((extension) => [...extension.commands.keys()]).sort(),
		["btw", "clone-tab", "clone-worktree", "done", "rename"],
	);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Keep native session startup and its local stdio server outside the test runner's environment.
test("native child preserves MCP exposure with and without codemode or tool_search", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-native-mcp-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { stdout } = await promisify(execFile)(process.execPath, [
		fileURLToPath(new URL("./mcp-native-child.ts", import.meta.url)),
		import.meta.resolve("@earendil-works/pi-coding-agent"), root,
	], { env: { HOME: root, PI_CODING_AGENT_DIR: root }, timeout: 25_000, maxBuffer: 64 * 1024 });
	assert.match(stdout, /Native MCP exposure, calls, discovery, and Role activation passed\./);
});

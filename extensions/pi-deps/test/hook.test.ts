import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hook = fileURLToPath(new URL("../hooks/post-checkout.mjs", import.meta.url));

test("rejects Yarn Classic before creating installer state", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-deps-hook-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@1.x" }));
		writeFileSync(join(root, "yarn.lock"), "");

		const result = spawnSync(process.execPath, [hook, "0".repeat(40), "new-head", "1"], {
			cwd: root,
			encoding: "utf8",
		});

		assert.equal(result.error, undefined);
		assert.notEqual(result.status, 0, result.stderr);
		assert.match(result.stderr, /Yarn Classic 1\.x is not supported/);
		assert.equal(existsSync(join(root, ".git", "pi-deps")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

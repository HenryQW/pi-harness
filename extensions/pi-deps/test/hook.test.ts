import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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
		assert.equal(existsSync(join(root, ".context", "pi-harness", "pi-deps")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writes detached install results in the checkout and preserves invalid status", async (t) => {
	const temp = mkdtempSync(join(tmpdir(), "pi-deps-hook-"));
	t.after(() => rmSync(temp, { recursive: true, force: true }));
	const repo = join(temp, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: repo, env: { ...process.env,
		GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
	const root = join(temp, "checkout");
	execFileSync("git", ["worktree", "add", "-q", "--detach", root], { cwd: repo });
	writeFileSync(join(root, "package.json"), "{}");
	writeFileSync(join(root, "package-lock.json"), "{}");
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "npm"), "#!/bin/sh\necho installer-output\n", { mode: 0o755 });
	const run = () => spawnSync(process.execPath, [hook, "0".repeat(40), "new-head", "1"], {
		cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	});
	const stateDir = join(root, ".context", "pi-harness", "pi-deps");
	mkdirSync(stateDir, { recursive: true, mode: 0o755 });
	writeFileSync(join(stateDir, "install.log"), "old log\n", { mode: 0o644 });
	chmodSync(stateDir, 0o755);
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	const status = join(stateDir, "status.json");
	for (let i = 0; i < 100 && !readFileSync(status, "utf8").includes('"ok"'); i++) await delay(20);
	assert.equal(JSON.parse(readFileSync(status, "utf8")).state, "ok");
	assert.match(readFileSync(join(stateDir, "install.log"), "utf8"), /old log[\s\S]*installer-output/);
	assert.equal(statSync(stateDir).mode & 0o777, 0o700);
	for (const file of ["status.json", "install.log"]) assert.equal(statSync(join(stateDir, file)).mode & 0o777, 0o600);
	const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: root, encoding: "utf8" }).trim();
	assert.equal(existsSync(join(gitDir, "pi-deps")), false);
	writeFileSync(status, "{ invalid");
	const refused = run();
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /status is preserved/);
	assert.equal(readFileSync(status, "utf8"), "{ invalid");
});


test("hook refuses checkout-controlled state links without changing external content or modes", async (t) => {
	for (const link of [".context", ".context/pi-harness", ".context/pi-harness/pi-deps", ".context/pi-harness/pi-deps/status.json", ".context/pi-harness/pi-deps/install.log", "hardlink"]) {
		await t.test(link, () => {
			const temp = mkdtempSync(join(tmpdir(), "pi-deps-link-"));
			try {
				const root = join(temp, "repo"), outside = join(temp, "outside");
				mkdirSync(root); mkdirSync(outside); chmodSync(outside, 0o755);
				execFileSync("git", ["init", "-q"], { cwd: root });
				writeFileSync(join(root, "package.json"), "{}");
				writeFileSync(join(root, "package-lock.json"), "{}");
				const file = join(outside, "target");
				writeFileSync(file, '{"state":"ok"}'); chmodSync(file, 0o644);
				const target = join(root, link === "hardlink" ? ".context/pi-harness/pi-deps/install.log" : link);
				mkdirSync(join(target, ".."), { recursive: true });
				if (link === "hardlink") linkSync(file, target);
				else symlinkSync(link.endsWith(".json") || link.endsWith(".log") ? file : outside, target);
				const result = spawnSync(process.execPath, [hook, "0".repeat(40), "head", "1"], { cwd: root, encoding: "utf8" });
				assert.notEqual(result.status, 0);
				assert.match(result.stderr, /Unsafe state path is preserved/);
				assert.equal(readFileSync(file, "utf8"), '{"state":"ok"}');
				assert.equal(statSync(file).mode & 0o777, 0o644);
				assert.equal(statSync(outside).mode & 0o777, 0o755);
			} finally { rmSync(temp, { recursive: true, force: true }); }
		});
	}
});

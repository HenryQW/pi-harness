import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { withWorktreeLock } from "@henryqw/pi-herdr";
import { runLockedGit } from "../internal/locked-git.ts";

const client = JSON.stringify(import.meta.resolve("@henryqw/pi-herdr"));
const helper = JSON.stringify(new URL("../internal/locked-git.ts", import.meta.url).href);
const state = JSON.stringify(new URL("../internal/command-state.ts", import.meta.url).href);
async function waitFor(check: () => Promise<boolean>) {
	for (let n = 0; n < 250; n++) { if (await check()) return; await delay(20); }
	assert.fail("Fixture did not reach its expected state.");
}

for (const operation of ["remove", "pull"] as const)
test(`${operation} child retains all borrowed locks after actual parent death`, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-locked-git-"));
	const checkout = join(root, "checkout"), store = join(root, "store"), ready = join(root, "ready"), stop = join(root, "stop");
	await mkdir(checkout); await mkdir(store, { mode: 0o700 });
	await writeFile(join(root, "git"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const count = args[0] === "worktree" ? 2 : 1;
fs.writeFileSync(process.env.READY, JSON.stringify({ args, files: Array.from({ length: count }, (_, i) => fs.fstatSync(i + 3).isFile()) }));
const timer = setInterval(() => { if (fs.existsSync(process.env.STOP)) clearInterval(timer); }, 20);
`, { mode: 0o700 });
	const parent = spawn(process.execPath, ["--input-type=module", "-e", `
import { withWorktreeLock } from ${client};
import { withCommandRemovalGuard } from ${state};
import { runLockedGit } from ${helper};
const [checkout, store, operation] = process.argv.slice(1);
await withWorktreeLock(checkout, async fd => {
 if (operation === "remove") await withCommandRemovalGuard(store, checkout, storeFd => runLockedGit({ operation, checkout, cwd: checkout, force: false }, [fd, storeFd]));
 else await runLockedGit({ operation, cwd: checkout }, [fd]);
});`, checkout, store, operation], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: root + ":" + process.env.PATH, READY: ready, STOP: stop } });
	let errors = ""; parent.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8192); });
	const unlocked = async () => {
		try { await withWorktreeLock(checkout, () => withWorktreeLock(store, async () => {})); return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") return false; throw error; }
	};
	t.after(async () => { parent.kill("SIGKILL"); await writeFile(stop, "stop"); await waitFor(unlocked); await rm(root, { recursive: true, force: true }); });
	await waitFor(async () => {
		assert.equal(parent.exitCode, null, errors);
		try { await readFile(ready); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
	});
	const evidence = JSON.parse(await readFile(ready, "utf8"));
	assert.deepEqual(evidence.files, operation === "remove" ? [true, true] : [true]);
	assert.deepEqual(evidence.args, operation === "remove" ? ["worktree", "remove", checkout] : ["pull", "--ff-only"]);
	const exited = once(parent, "exit"); parent.kill("SIGKILL"); await exited;
	await assert.rejects(withWorktreeLock(checkout, async () => assert.fail("checkout lock lost")), { code: "ELOCKED" });
	if (operation === "remove") await assert.rejects(withWorktreeLock(store, async () => assert.fail("store lock lost")), { code: "ELOCKED" });
	await writeFile(stop, "stop");
	await waitFor(unlocked);
});

test("locked Git reports bounded stderr, signals, spawn errors, and missing descriptors", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-locked-git-errors-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "git"), `#!${process.execPath}
if (process.env.RESULT === "signal") process.kill(process.pid, "SIGTERM");
else { process.stderr.write("x".repeat(20000) + "\\nfinal diagnostic\\n"); process.exitCode = 7; }
`, { mode: 0o700 });
	for (const result of ["stderr", "signal", "spawn"]) {
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { withWorktreeLock } from ${client};
import { runLockedGit } from ${helper};
try { await withWorktreeLock(process.argv[1], fd => runLockedGit({ operation: "pull", cwd: process.env.RESULT === "spawn" ? process.argv[1] + "/missing" : process.argv[1] }, [fd])); }
catch (error) { console.log(JSON.stringify({ message: error.message, code: error.code })); }`, root], { encoding: "utf8", timeout: 10_000, maxBuffer: 16384, env: { ...process.env, PATH: root + ":" + process.env.PATH, RESULT: result } });
		assert.equal(child.status, 0, child.stderr);
		const error = JSON.parse(child.stdout);
		assert.ok(Buffer.byteLength(error.message) < 8500);
		if (result === "stderr") assert.match(error.message, /failed \(7\):[\s\S]*final diagnostic$/);
		else if (result === "signal") assert.match(error.message, /SIGTERM/);
		else assert.equal(error.code, "ENOENT");
	}
	await assert.rejects(runLockedGit({ operation: "pull", cwd: root }, [undefined as unknown as number]), /lock descriptors are unavailable/);
});

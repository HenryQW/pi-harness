import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withWorktreeLock } from "../dist/index.js";

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-lock-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "checkout");
	await mkdir(dir);
	return dir;
}
const client = JSON.stringify(new URL("../dist/index.js", import.meta.url).href);
function run(script: string, dir: string) {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir], { encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stdout + result.stderr);
}
async function holder(t: TestContext, dir: string) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { withWorktreeLock } from ${client};
		await withWorktreeLock(process.argv[1], () => new Promise(resolve => {
			process.once("message", resolve); process.send("locked");
		}));
		process.disconnect();`, dir], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
	t.after(() => child.kill("SIGKILL"));
	assert.deepEqual(await once(child, "message"), ["locked", undefined]);
	return child;
}
const contend = (dir: string) => assert.rejects(withWorktreeLock(dir, async () => assert.fail("must not enter")), { code: "ELOCKED" });

test("independent opens, canonical aliases, and a live process share one persistent lock", async (t) => {
	const dir = await fixture(t);
	const alias = `${dir}-alias`;
	await symlink(dir, alias);
	await withWorktreeLock(dir, async () => {
		await contend(dir);
		await contend(alias);
		run(`import assert from "node:assert/strict"; import { withWorktreeLock } from ${client};
			await assert.rejects(withWorktreeLock(process.argv[1], async () => assert.fail()), { code: "ELOCKED" });`, dir);
	});
	const info = await stat(`${dir}.lock`);
	assert.ok(info.isFile());
	assert.equal(info.mode & 0o777, 0o600);
	await writeFile(`${dir}.lock`, "retained");
	for (let index = 0; index < 10; index++) assert.equal(await withWorktreeLock(alias, async () => index), index);
	assert.equal((await stat(`${dir}.lock`)).ino, info.ino);
	assert.equal(await readFile(`${dir}.lock`, "utf8"), "retained");
});

test("a paused holder cannot be replaced after the former stale interval", { timeout: 20_000 }, async (t) => {
	const dir = await fixture(t);
	const child = await holder(t, dir);
	child.kill("SIGSTOP");
	await utimes(`${dir}.lock`, 0, 0);
	await delay(10_100);
	await contend(dir);
	child.kill("SIGCONT");
	const exited = once(child, "exit");
	child.send("release");
	assert.deepEqual(await exited, [0, null]);
	await withWorktreeLock(dir, async () => {});
});

test("process death releases the lock without deleting its sidecar", async (t) => {
	const dir = await fixture(t);
	const child = await holder(t, dir);
	await contend(dir);
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	await withWorktreeLock(dir, async () => {});
	assert.ok((await stat(`${dir}.lock`)).isFile());
});

test("an inherited descriptor retains exclusion after the original owner closes", async (t) => {
	const dir = await fixture(t);
	const child = await withWorktreeLock(dir, async (descriptor) => {
		const child = spawn(process.execPath, ["-e", 'setInterval(() => {}, 1000); console.log("ready");'], {
			stdio: ["ignore", "pipe", "inherit", descriptor],
		});
		t.after(() => child.kill("SIGKILL"));
		await once(child.stdout!, "data");
		return child;
	});
	await contend(dir);
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	await withWorktreeLock(dir, async () => {});
});

test("shell and Node descriptor locks exclude each other", async (t) => {
	const dir = await fixture(t);
	const command = process.platform === "darwin" ? "/usr/bin/lockf -t 0 9" : "flock -n -E 75 9";
	const shell = `exec 9>> "$1.lock"; ${command}`;
	await withWorktreeLock(dir, async () => {
		assert.equal(spawnSync("/bin/sh", ["-c", shell, "lock-test", dir]).status, 75);
	});
	const child = spawn("/bin/sh", ["-c", `${shell} || exit; echo locked; read release`, "lock-test", dir], { stdio: ["pipe", "pipe", "inherit"] });
	t.after(() => child.kill("SIGKILL"));
	await once(child.stdout!, "data");
	await contend(dir);
	const exited = once(child, "exit");
	child.stdin!.end("release\n");
	assert.deepEqual(await exited, [0, null]);
	await withWorktreeLock(dir, async () => {});
});

test("callback failure, missing paths, ordinary files, and checkout removal release resources", async (t) => {
	const dir = await fixture(t);
	const failure = new Error("operation failed");
	await assert.rejects(withWorktreeLock(dir, async () => { throw failure; }), (error) => error === failure);
	await withWorktreeLock(dir, async () => {});
	const file = join(dir, "spec.json");
	await writeFile(file, "{}");
	await withWorktreeLock(file, () => contend(file));
	await assert.rejects(withWorktreeLock(join(dir, "missing"), async () => assert.fail()), { code: "ENOENT" });
	await withWorktreeLock(dir, () => rm(dir, { recursive: true }));
	assert.ok((await stat(`${dir}.lock`)).isFile());
	await mkdir(dir);
	await withWorktreeLock(dir, async () => {});
});

for (const kind of ["directory", "symlink", "pipe"])
test(`refuse a legacy or unsafe ${kind} without deleting it`, async (t) => {
	const dir = await fixture(t);
	const path = `${dir}.lock`;
	if (kind === "directory") await mkdir(path);
	else if (kind === "symlink") await symlink(dir, path);
	else assert.equal(spawnSync("mkfifo", [path]).status, 0);
	await assert.rejects(withWorktreeLock(dir, async () => assert.fail()), kind === "directory" ? { code: "ELOCKED" } : /regular file|ELOOP/);
	if (kind === "directory") assert.ok((await stat(path)).isDirectory());
	await rm(path, { recursive: true });
	await withWorktreeLock(dir, async () => {});
});

test("native failures do not enter the callback and close failures preserve both errors", async (t) => {
	const dir = await fixture(t);
	run(`import assert from "node:assert/strict";
		import fs from "node:fs"; import cp from "node:child_process";
		import { syncBuiltinESMExports } from "node:module";
		import { mock } from "node:test";
		import { withWorktreeLock } from ${client};
		for (const result of [
			{ error: Object.assign(new Error("backend missing"), { code: "ENOENT" }) },
			{ status: 64, stderr: "unsupported descriptor syntax" },
			{ status: null, signal: "SIGTERM", stderr: "" },
		]) {
			const patched = mock.method(cp, "spawnSync", () => result); syncBuiltinESMExports();
			await assert.rejects(withWorktreeLock(process.argv[1], async () => assert.fail("entered")), /backend missing|descriptor lock failed/);
			patched.mock.restore(); syncBuiltinESMExports();
			await withWorktreeLock(process.argv[1], async () => {});
		}
		const close = fs.closeSync;
		for (const fails of [false, true]) {
			const failure = new Error("operation failed"), release = new Error("release failed");
			await assert.rejects(withWorktreeLock(process.argv[1], async () => {
				mock.method(fs, "closeSync", fd => { close(fd); throw release; }); syncBuiltinESMExports();
				if (fails) throw failure;
			}), error => fails ? (assert.deepEqual(error.errors, [failure, release]), true) : error === release);
			mock.restoreAll(); syncBuiltinESMExports();
			await withWorktreeLock(process.argv[1], async () => {});
		}`, dir);
});

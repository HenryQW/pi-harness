import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { withWorktreeLock } from "../dist/index.js";

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-lock-race-")));
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

test("heartbeat finishes before release, with no update left after release", async (t) => {
	const dir = await fixture(t);
	run(`import assert from "node:assert/strict";
		import { existsSync, statSync } from "node:fs";
		import { mock } from "node:test";
		import { withWorktreeLock } from ${client};
		const lockPath = process.argv[1] + ".lock";
		mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
		await withWorktreeLock(process.argv[1], async () => {
			const before = statSync(lockPath).mtimeMs;
			mock.timers.tick(5000);
			assert.ok(statSync(lockPath).mtimeMs > before, "heartbeat must finish before the timer returns");
		});
		assert.equal(existsSync(lockPath), false);
		mock.timers.tick(10_000);
		mock.timers.reset();`, dir);
});

for (const fails of [false, true])
test(`active lock compromise stays visible when the operation ${fails ? "rejects" : "succeeds"} and preserves the changed lock`, async (t) => {
	const dir = await fixture(t);
	run(`import assert from "node:assert/strict";
		import { stat, utimes } from "node:fs/promises";
		import { mock } from "node:test";
		import { withWorktreeLock } from ${client};
		const lockPath = process.argv[1] + ".lock";
		const failure = new Error("operation failed");
		mock.timers.enable({ apis: ["setTimeout"] });
		await assert.rejects(withWorktreeLock(process.argv[1], async () => {
			await utimes(lockPath, 0, 0);
			mock.timers.tick(5000);
			if (${fails}) throw failure;
		}), error => {
			if (${fails}) {
				assert.ok(error instanceof AggregateError);
				assert.equal(error.errors.length, 2);
				assert.equal(error.errors[0], failure);
				assert.equal(error.errors[1].code, "ECOMPROMISED");
			} else assert.equal(error.code, "ECOMPROMISED");
			return true;
		});
		assert.equal((await stat(lockPath)).mtimeMs, 0);
		mock.timers.reset();`, dir);
});

test("lock contention, operation errors, and release errors remain visible", async (t) => {
	const dir = await fixture(t);
	const failure = new Error("operation failed");
	await assert.rejects(withWorktreeLock(dir, async () => {
		await assert.rejects(withWorktreeLock(dir, async () => assert.fail("must not enter")), { code: "ELOCKED" });
		throw failure;
	}), (error) => error === failure);
	run(`import assert from "node:assert/strict";
		import { createRequire } from "node:module";
		import { withWorktreeLock } from ${client};
		const require = createRequire(${client});
		const fs = createRequire(require.resolve("proper-lockfile"))("graceful-fs");
		await assert.rejects(withWorktreeLock(process.argv[1], async () => {
			fs.rmdirSync = () => { throw Object.assign(new Error("release refused"), { code: "EACCES" }); };
		}), { code: "EACCES" });`, dir);
});

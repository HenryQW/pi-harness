import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnBounded } from "../src/index.ts";

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await delay(20);
	}
	throw new Error(`SIGTERM-ignoring descendant ${pid} remained alive`);
}

test("bounded spawn rejects streaming output beyond its cap", async () => {
	await assert.rejects(
		spawnBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(33))"], {
			cwd: process.cwd(),
			stdoutLimitBytes: 32,
		}),
		/stdout exceeded 32 bytes/,
	);
});

test("bounded spawn rejects when the child closes stdin before consuming it", async () => {
	await assert.rejects(
		spawnBounded(process.execPath, ["-e", "process.exit(0)"], {
			cwd: process.cwd(),
			stdin: "x".repeat(16 * 1024 * 1024),
		}),
		(error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "EPIPE",
	);
});

test("bounded spawn aborts and cleans up an in-flight child", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-process-abort-"));
	const pidPath = join(root, "child.pid");
	let childPid: number | undefined;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => {
		if (childPid === undefined) return;
		try {
			process.kill(childPid, "SIGKILL");
		} catch (error) {
			if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	});
	const controller = new AbortController();
	const running = spawnBounded(process.execPath, ["-e", [
		"const { writeFileSync } = require('node:fs');",
		`writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
		"setInterval(() => {}, 1_000);",
	].join("\n")], {
		cwd: root,
		signal: controller.signal,
	});
	const pidText = await waitForFile(pidPath, 500);
	const pid = Number(pidText);
	childPid = pid;
	assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid child PID: ${pidText}`);
	// The child is already running; abort the signal that owns its lifecycle.
	controller.abort(new Error("process cancelled"));
	await assert.rejects(running, /process cancelled/);
	await waitForExit(pid);
});

test("bounded spawn kills a SIGTERM-ignoring descendant after its leader closes", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-process-group-"));
	const pidPath = join(root, "descendant.pid");
	let descendantPid: number | undefined;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => {
		if (descendantPid === undefined) return;
		try {
			process.kill(descendantPid, "SIGKILL");
		} catch (error) {
			if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	});
	const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);";
	const leader = [
		"const { spawn } = require('node:child_process');",
		"const { writeFileSync } = require('node:fs');",
		`const child = spawn(process.execPath, [\"-e\", ${JSON.stringify(descendant)}], { stdio: \"ignore\" });`,
		"writeFileSync(process.argv[1], String(child.pid));",
		"setInterval(() => {}, 1_000);",
	].join("\n");
	const timedOut = assert.rejects(
		spawnBounded(process.execPath, ["-e", leader, pidPath], { cwd: root, timeoutMs: 1_000 }),
		/timed out after 1000ms/,
	);
	const pidText = await waitForFile(pidPath, 500);
	descendantPid = Number(pidText);
	assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, `invalid descendant PID: ${pidText}`);
	await timedOut;
	await waitForExit(descendantPid);
});

test("bounded spawn preserves strict UTF-8 output and a complete tail", async () => {
	const streamed = await spawnBounded(process.execPath, [
		"-e",
		"process.stdout.write(Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 0x78), Buffer.from('x🙂終')]))",
	], { cwd: process.cwd(), stdoutTailBytes: 6 });
	assert.equal(streamed.stdout, "終");
	assert.equal(streamed.stdoutTruncated, true);
	assert.ok(Buffer.byteLength(streamed.stdout, "utf8") <= 6);

	await assert.rejects(
		spawnBounded(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xff]))"], {
			cwd: process.cwd(),
			stdoutTailBytes: 20 * 1024,
		}),
		/stdout was not valid UTF-8/,
	);

	await assert.rejects(
		spawnBounded(process.execPath, ["-e", "process.stderr.write(Buffer.from([0xff]))"], { cwd: process.cwd() }),
		/stderr was not valid UTF-8/,
	);
});

test("bounded spawn accepts a cwd path with surrounding whitespace", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "pi-process-cwd-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const cwd = join(parent, " cwd ");
	await mkdir(cwd);
	const result = await spawnBounded(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd });
	assert.equal(await realpath(result.stdout), await realpath(cwd));
});

test("bounded spawn rejects invalid cwd values", async () => {
	for (const [name, cwd] of [
		["non-string", 42 as unknown],
		["empty", ""],
		["NUL", `${process.cwd()}\0`],
	] as const) {
		await assert.rejects(
			spawnBounded(process.execPath, ["-e", ""], { cwd: cwd as string }),
			(error: unknown) => error instanceof TypeError && error.message === "cwd must be a non-empty string",
			name,
		);
	}
});

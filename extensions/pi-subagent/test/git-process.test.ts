import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runGit } from "../src/git-process.ts";

const GIT_OUTPUT_LIMIT_BYTES = 1 * 1024 * 1024;

async function withFakeGit<T>(t: import("node:test").TestContext, operation: () => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-git-process-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "git"), `#!${process.execPath}
const { writeSync } = require("node:fs");
const mode = process.argv.at(-1);
if (mode === "under-limit") writeSync(1, "x".repeat(${64 * 1024 + 1}));
if (mode === "over-limit") writeSync(1, "x".repeat(${GIT_OUTPUT_LIMIT_BYTES + 1}));
if (mode === "killed-empty") process.kill(process.pid, "SIGTERM");
if (mode === "killed-stderr") {
	writeSync(2, "x".repeat(201));
	process.kill(process.pid, "SIGTERM");
}
`);
	await chmod(join(bin, "git"), 0o755);
	t.after(() => rm(root, { recursive: true, force: true }));
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
	try {
		return await operation();
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
}

test("runGit permits output above the package default under its explicit ceiling", async (t) => {
	const result = await withFakeGit(t, () => runGit(["under-limit"], process.cwd()));
	assert.equal(result.code, 0);
	assert.equal(Buffer.byteLength(result.stdout, "utf8"), 64 * 1024 + 1);
	assert.equal(result.stderr, "");
});

test("runGit names its explicit one MiB output limit", async (t) => {
	const result = await withFakeGit(t, () => runGit(["over-limit"], process.cwd()));
	assert.equal(result.code, -1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, `git stdout exceeded ${GIT_OUTPUT_LIMIT_BYTES} bytes`);
});

test("runGit reports a killed process with a default diagnostic", async (t) => {
	const result = await withFakeGit(t, () => runGit(["killed-empty"], process.cwd()));
	assert.deepEqual(result, { code: -1, stdout: "", stderr: "git was killed" });
});

test("runGit caps diagnostics from killed processes", async (t) => {
	const result = await withFakeGit(t, () => runGit(["killed-stderr"], process.cwd()));
	assert.equal(result.code, -1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "x".repeat(200));
});

test("runGit caps a pre-aborted non-Error reason", async () => {
	const controller = new AbortController();
	const reason = "r".repeat(201);
	controller.abort(reason);
	const result = await runGit(["pre-aborted"], process.cwd(), controller.signal);
	assert.deepEqual(result, { code: -1, stdout: "", stderr: reason.slice(0, 200) });
});

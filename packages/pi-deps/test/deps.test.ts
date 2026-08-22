import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import depsExtension from "../extensions/deps.ts";

const hook = new URL("../hooks/post-checkout.mjs", import.meta.url);
const zeroHead = "0".repeat(40);
const nextHead = "1".repeat(40);

async function temporaryDirectory(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function fakeManager(bin: string, name: string): Promise<void> {
	const path = join(bin, name);
	await writeFile(path, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.PI_DEPS_TEST_LOG, JSON.stringify([path.basename(process.argv[1]), ...process.argv.slice(2)]) + "\\n");
fs.mkdirSync(path.join(process.cwd(), path.basename(process.argv[1]) === "uv" ? ".venv" : "node_modules"));
`);
	await chmod(path, 0o755);
}

function runHook(root: string, bin: string, oldHead = zeroHead, pathOverride?: string) {
	return spawnSync(process.execPath, [hook.pathname, oldHead, nextHead, "1"], {
		cwd: root,
		env: {
			...process.env,
			PATH: pathOverride ?? `${bin}:${process.env.PATH ?? ""}`,
			PI_DEPS_TEST_LOG: join(root, "commands.log"),
		},
		encoding: "utf8",
	});
}

test("/deps toggles only its managed shared hook", async (t) => {
	const root = await temporaryDirectory(t);
	const gitDir = join(root, ".git");
	const notifications: string[] = [];
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const exec = (args: string[]) =>
		Promise.resolve({ stdout: args[1] === "--git-path" ? ".git/hooks\n" : ".git\n", stderr: "", code: 0, killed: false });
	depsExtension({
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			assert.equal(name, "deps");
			handler = options.handler;
		},
		exec: (_command: string, args: string[]) => exec(args),
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: root,
		ui: { notify: (message: string) => { notifications.push(message); } },
	} as unknown as ExtensionCommandContext;

	await handler!("", ctx);
	const installed = join(gitDir, "hooks", "post-checkout");
	const source = await readFile(hook, "utf8");
	assert.equal(await readFile(installed, "utf8"), source);
	assert.notEqual((await stat(installed)).mode & 0o111, 0);

	// Modified hook that still carries the marker stays owned and toggles off.
	await writeFile(installed, `${source}\n// locally edited\n`);
	await handler!("", ctx);
	await assert.rejects(readFile(installed), /ENOENT/);

	// Toggling again installs the current package source, refreshing older copies.
	await handler!("", ctx);
	assert.equal(await readFile(installed, "utf8"), source);
	await handler!("", ctx);
	await assert.rejects(readFile(installed), /ENOENT/);

	await mkdir(join(gitDir, "hooks"), { recursive: true });
	await writeFile(installed, "#!/bin/sh\necho existing\n");
	await assert.rejects(handler!("", ctx), /Refusing to modify unmanaged Git hook/);
	assert.equal(await readFile(installed, "utf8"), "#!/bin/sh\necho existing\n");
	assert.equal(notifications.length, 4);
});

test("/deps refuses non-default effective hooks directory", async (t) => {
	const root = await temporaryDirectory(t);
	const notifications: string[] = [];
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	depsExtension({
		registerCommand(_name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			handler = options.handler;
		},
		exec: async (_command: string, args: string[]) => ({
			stdout: args[1] === "--git-path" ? "/global/hooks\n" : ".git\n",
			stderr: "",
			code: 0,
			killed: false,
		}),
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: root,
		ui: { notify: (message: string) => { notifications.push(message); } },
	} as unknown as ExtensionCommandContext;

	await assert.rejects(handler!("", ctx), /Refusing non-default hooks directory/);
	assert.equal(notifications.length, 0);
});

test("creation hook chooses frozen Node install commands", async (t) => {
	const cases = [
		["npm", "package-lock.json", "npm@11.0.0", "", ["npm", "ci"]],
		["pnpm", "pnpm-lock.yaml", "pnpm@11.0.0", "", ["pnpm", "install", "--frozen-lockfile"]],
		["yarn", "yarn.lock", "yarn@4.0.0", "", ["yarn", "install", "--immutable"]],
		["bun", "bun.lock", "bun@1.3.0", "", ["bun", "install", "--frozen-lockfile"]],
	] as const;

	for (const [manager, lockfile, packageManager, lockContent, expected] of cases) {
		const root = await temporaryDirectory(t);
		const bin = join(root, "bin");
		await mkdir(bin);
		await fakeManager(bin, manager);
		await writeFile(join(root, "package.json"), JSON.stringify({ packageManager }));
		await writeFile(join(root, lockfile), lockContent);
		const result = runHook(root, bin);
		assert.equal(result.status, 0, result.stderr);
		const calls = (await readFile(join(root, "commands.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(calls, [expected]);
	}
});

test("creation hook runs Node then uv once and ignores normal checkouts", async (t) => {
	const root = await temporaryDirectory(t);
	const bin = join(root, "bin");
	await mkdir(bin);
	await fakeManager(bin, "npm");
	await fakeManager(bin, "uv");
	await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.0.0" }));
	await writeFile(join(root, "package-lock.json"), "{}");
	await writeFile(join(root, "uv.lock"), "");

	assert.equal(runHook(root, bin, nextHead).status, 0);
	await assert.rejects(readFile(join(root, "commands.log")), /ENOENT/);
	assert.equal(runHook(root, bin).status, 0);
	assert.deepEqual(
		(await readFile(join(root, "commands.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
		[["npm", "ci"], ["uv", "sync", "--locked"]],
	);
	assert.equal(runHook(root, bin).status, 0);
	assert.equal((await readFile(join(root, "commands.log"), "utf8")).trim().split("\n").length, 2);
});

test("creation hook rejects conflicting manager evidence", async (t) => {
	const root = await temporaryDirectory(t);
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.0.0" }));
	await writeFile(join(root, "package-lock.json"), "{}");
	await writeFile(join(root, "pnpm-lock.yaml"), "");

	const result = runHook(root, bin);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Conflicting Node lockfiles: npm, pnpm/);
});

test("creation hook rejects malformed packageManager declarations", async (t) => {
	for (const declared of ["npm", "@scope/cli@1.0.0"]) {
		const root = await temporaryDirectory(t);
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: declared }));
		await writeFile(join(root, "package-lock.json"), "{}");

		const result = runHook(root, bin);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Unsupported packageManager/);
	}
});

test("creation hook reports missing package manager executable", async (t) => {
	const root = await temporaryDirectory(t);
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.0.0" }));
	await writeFile(join(root, "package-lock.json"), "{}");

	const result = runHook(root, bin, zeroHead, bin);
	assert.equal(result.status, 127);
	assert.match(result.stderr, /failed to start npm/);
});

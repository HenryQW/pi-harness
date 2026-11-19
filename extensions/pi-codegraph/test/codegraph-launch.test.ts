import assert from "node:assert/strict";
import { test } from "node:test";
import { win32 } from "node:path";
import { resolveCodegraphLaunch } from "../extensions/codegraph-launch.ts";

const BIN = "C:\\Program Files\\nodejs";
const GLOBAL_ENTRY = win32.join(BIN, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
const LOCAL_BIN = win32.join("C:\\repo", "node_modules", ".bin");
const LOCAL_ENTRY = win32.join("C:\\repo", "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");

function present(...paths: string[]) {
	const set = new Set(paths);
	return (path: string) => set.has(path);
}

function resolve(paths: string[], pathValue = BIN) {
	return resolveCodegraphLaunch({ platform: "win32", env: { Path: pathValue }, isFile: present(...paths) });
}

test("other platforms keep the plain command", () => {
	assert.deepEqual(resolveCodegraphLaunch({ platform: "linux", env: {} }), { command: "codegraph", args: [] });
	assert.deepEqual(resolveCodegraphLaunch({ platform: "darwin", env: {} }), { command: "codegraph", args: [] });
});

test("a native executable wins over an npm shim beside it", () => {
	const launch = resolve([win32.join(BIN, "codegraph.exe"), win32.join(BIN, "codegraph.cmd"), GLOBAL_ENTRY, win32.join(BIN, "node.exe")]);
	assert.deepEqual(launch, { command: win32.join(BIN, "codegraph.exe"), args: [] });
});

test("a global npm install runs the package entry with the node beside it", () => {
	const launch = resolve([win32.join(BIN, "codegraph.cmd"), GLOBAL_ENTRY, win32.join(BIN, "node.exe")]);
	assert.deepEqual(launch, { command: win32.join(BIN, "node.exe"), args: [GLOBAL_ENTRY] });
});

test("a local node_modules install resolves the package one level above the shim", () => {
	const node = "C:\\Program Files\\nodejs\\node.exe";
	const launch = resolve([win32.join(LOCAL_BIN, "codegraph.cmd"), LOCAL_ENTRY, node], `${LOCAL_BIN};${BIN}`);
	assert.deepEqual(launch, { command: node, args: [LOCAL_ENTRY] });
});

test("PATH order decides which install starts", () => {
	const other = "D:\\tools";
	assert.deepEqual(resolve([win32.join(BIN, "codegraph.exe"), win32.join(other, "codegraph.exe")], `${other};${BIN}`), {
		command: win32.join(other, "codegraph.exe"),
		args: [],
	});
});

test("missing, half-installed, and node-less setups report an actionable error", () => {
	assert.match(resolve([]).error ?? "", /codegraph is not on PATH[\s\S]*npm install -g @colbymchenry\/codegraph/);
	assert.match(resolve([win32.join(BIN, "codegraph.cmd")]).error ?? "", /@colbymchenry\\codegraph is not installed/);
	assert.match(resolve([win32.join(BIN, "codegraph.cmd"), GLOBAL_ENTRY]).error ?? "", /No node\.exe can run/);
});

test("spaces and non-ASCII characters stay literal arguments", () => {
	const bin = "C:\\Users\\张三\\Program Files\\nodejs";
	const entry = win32.join(bin, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
	assert.deepEqual(resolve([win32.join(bin, "codegraph.cmd"), entry, win32.join(bin, "node.exe")], bin), {
		command: win32.join(bin, "node.exe"),
		args: [entry],
	});
});

test("an unreadable path is not reported as a missing install", () => {
	assert.throws(
		() =>
			resolveCodegraphLaunch({
				platform: "win32",
				env: { Path: BIN },
				isFile: () => {
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				},
			}),
		{ code: "EACCES" },
	);
});

test("PATH matching is case-insensitive like Windows", () => {
	const launch = resolveCodegraphLaunch({
		platform: "win32",
		env: { Path: `${BIN};C:\\other` },
		isFile: present(win32.join(BIN, "codegraph.exe")),
	});
	assert.equal(launch.command, win32.join(BIN, "codegraph.exe"));
});

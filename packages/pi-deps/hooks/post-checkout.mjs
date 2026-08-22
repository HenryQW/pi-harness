#!/usr/bin/env node
// pi-deps-managed-hook

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [, , oldHead, , checkoutKind] = process.argv;
if (!/^0+$/.test(oldHead ?? "") || checkoutKind !== "1") process.exit(0);

const root = process.cwd();
const path = (name) => join(root, name);
const isFile = (name) => {
	try { return statSync(path(name)).isFile(); } catch { return false; }
};
const isDirectory = (name) => {
	try { return statSync(path(name)).isDirectory(); } catch { return false; }
};

function run(command, args) {
	console.error(`pi-deps: ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) {
		console.error(`pi-deps: failed to start ${command}: ${result.error.message}`);
		process.exit(result.error.code === "ENOENT" ? 127 : 1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function nodeInstall() {
	const locks = [];
	if (isFile("package-lock.json") || isFile("npm-shrinkwrap.json")) locks.push("npm");
	if (isFile("pnpm-lock.yaml")) locks.push("pnpm");
	if (isFile("yarn.lock")) locks.push("yarn");
	if (isFile("bun.lock") || isFile("bun.lockb")) locks.push("bun");
	if (isFile("bun.lock") && isFile("bun.lockb")) throw new Error("Conflicting Bun lockfiles: bun.lock and bun.lockb");
	if (locks.length === 0) return;
	if (locks.length > 1) throw new Error(`Conflicting Node lockfiles: ${locks.join(", ")}`);
	if (!isFile("package.json")) throw new Error("Node lockfile found without package.json");

	let packageJson;
	try {
		packageJson = JSON.parse(readFileSync(path("package.json"), "utf8"));
	} catch (error) {
		throw new Error(`Cannot read package.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	const declared = packageJson?.packageManager;
	let manager = locks[0];
	if (declared !== undefined) {
		if (typeof declared !== "string" || !/^(npm|pnpm|yarn|bun)@.+$/.test(declared)) {
			throw new Error(`Unsupported packageManager: ${JSON.stringify(declared)}`);
		}
		manager = declared.slice(0, declared.indexOf("@"));
		if (manager !== locks[0]) {
			throw new Error(`packageManager ${manager} does not match ${locks[0]} lockfile`);
		}
	}

	if (isDirectory("node_modules") || (manager === "yarn" && isFile(".pnp.cjs"))) return;
	if (manager === "npm") run("npm", ["ci"]);
	else if (manager === "pnpm") run("pnpm", ["install", "--frozen-lockfile"]);
	else if (manager === "bun") run("bun", ["install", "--frozen-lockfile"]);
	else run("yarn", ["install", "--immutable"]);
}

try {
	nodeInstall();
	if (isFile("uv.lock") && !isDirectory(".venv")) run("uv", ["sync", "--locked"]);
} catch (error) {
	console.error(`pi-deps: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

#!/usr/bin/env node
// pi-deps-managed-hook

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installMode = "--pi-deps-install";

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function writeStatus(stateDir, status) {
	writeFileSync(join(stateDir, "status.json"), `${JSON.stringify(status)}\n`);
}

// Installer child: runs the frozen installs detached and records the outcome for watchers.
if (process.argv[2] === installMode) {
	const [, , , root, stateDir, commandsJson] = process.argv;
	try {
		process.chdir(root);
		for (const [command, args] of JSON.parse(commandsJson)) {
			console.error(`pi-deps: ${command} ${args.join(" ")}`);
			const result = spawnSync(command, args, { stdio: "inherit" });
			if (result.error) throw new Error(`failed to start ${command}: ${result.error.message}`);
			if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "signal"}`);
		}
		writeStatus(stateDir, { state: "ok" });
	} catch (error) {
		console.error(`pi-deps: ${errorMessage(error)}`);
		writeStatus(stateDir, { state: "error", message: errorMessage(error) });
		process.exit(1);
	}
	process.exit(0);
}

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

// Validation throws synchronously so configuration mistakes still fail worktree creation fast.
function nodeCommands() {
	const locks = [];
	if (isFile("package-lock.json") || isFile("npm-shrinkwrap.json")) locks.push("npm");
	if (isFile("pnpm-lock.yaml")) locks.push("pnpm");
	if (isFile("yarn.lock")) locks.push("yarn");
	if (isFile("bun.lock") || isFile("bun.lockb")) locks.push("bun");
	if (isFile("bun.lock") && isFile("bun.lockb")) throw new Error("Conflicting Bun lockfiles: bun.lock and bun.lockb");
	if (locks.length === 0) return [];
	if (locks.length > 1) throw new Error(`Conflicting Node lockfiles: ${locks.join(", ")}`);
	if (!isFile("package.json")) throw new Error("Node lockfile found without package.json");

	let packageJson;
	try {
		packageJson = JSON.parse(readFileSync(path("package.json"), "utf8"));
	} catch (error) {
		throw new Error(`Cannot read package.json: ${errorMessage(error)}`);
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

	if (isDirectory("node_modules") || (manager === "yarn" && isFile(".pnp.cjs"))) return [];
	if (manager === "npm") return [["npm", ["ci"]]];
	if (manager === "pnpm") return [["pnpm", ["install", "--frozen-lockfile"]]];
	if (manager === "bun") return [["bun", ["install", "--frozen-lockfile"]]];
	return [["yarn", ["install", "--immutable"]]];
}

function installCommands() {
	const commands = nodeCommands();
	if (isFile("uv.lock") && !isDirectory(".venv")) commands.push(["uv", ["sync", "--locked"]]);
	return commands;
}

try {
	const commands = installCommands();
	const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: root, encoding: "utf8" });
	if (git.error) throw new Error(`Cannot locate Git directory: ${git.error.message}`);
	if (git.status !== 0) {
		throw new Error(`Cannot locate Git directory: ${(git.stderr || "").trim() || `exit code ${git.status}`}`);
	}
	const stateDir = join(git.stdout.trim(), "pi-deps");
	const statusPath = join(stateDir, "status.json");
	if (commands.length === 0) {
		rmSync(statusPath, { force: true }); // stale outcome from an earlier run
		process.exit(0);
	}
	mkdirSync(stateDir, { recursive: true });
	writeStatus(stateDir, { state: "running" });
	const log = openSync(join(stateDir, "install.log"), "a");
	spawn(process.execPath, [fileURLToPath(import.meta.url), installMode, root, stateDir, JSON.stringify(commands)], {
		detached: true,
		stdio: ["ignore", log, log],
	}).unref();
} catch (error) {
	console.error(`pi-deps: ${errorMessage(error)}`);
	process.exit(1);
}

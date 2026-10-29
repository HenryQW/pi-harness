import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import depsExtension from "../extensions/deps.ts";

test("explicit dependency toggles affect only the selected repository and preserve hook protections", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-deps-workspace-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = join(root, "first repo"), second = join(root, "second"), linked = join(root, "linked");
	const exec = async (command: string, args: string[], options: { cwd: string }) => {
		const result = spawnSync(command, args, { ...options, encoding: "utf8" });
		return { code: result.status ?? 1, killed: result.signal !== null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	const git = async (cwd: string, args: string[]) => {
		const result = await exec("git", args, { cwd });
		assert.equal(result.code, 0, result.stderr);
	};
	for (const repo of [first, second]) { await mkdir(repo); await git(repo, ["init", "-q"]); }
	await git(first, ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
	await git(first, ["worktree", "add", "-q", "--detach", linked]);
	let toggle: (args: string, ctx: ExtensionContext) => Promise<void>;
	let start: (event: unknown, ctx: ExtensionContext) => void;
	const calls: string[] = [];
	depsExtension({ on: (event, handler) => { if (event === "session_start") start = handler; },
		registerCommand: (_name, command) => { toggle = command.handler; },
		exec: (command, args, options) => { calls.push(options.cwd); return exec(command, args, options); },
	} as unknown as ExtensionAPI);
	const ctx = { cwd: root, mode: "tui", ui: { notify() {} } } as unknown as ExtensionContext;
	start!({}, ctx);
	assert.deepEqual(calls, [root], "startup does not inspect child repositories");
	await assert.rejects(toggle!("", ctx), /Cannot locate/);
	await assert.rejects(toggle!("--project", ctx), /Usage/);
	await assert.rejects(toggle!("--project missing", ctx), /Cannot locate/);
	const hook = (repo: string) => join(repo, ".git/hooks/post-checkout");
	for (const repo of [first, second]) await assert.rejects(readFile(hook(repo)), { code: "ENOENT" });
	await toggle!("--project first repo", ctx);
	const installed = await readFile(hook(first), "utf8");
	assert.match(installed, /pi-deps-managed-hook/);
	await assert.rejects(readFile(hook(second)), { code: "ENOENT" });
	await git(second, ["config", "core.hooksPath", join(first, ".git/hooks")]);
	await assert.rejects(toggle!("--project second", ctx), /Refusing non-default hooks/);
	assert.equal(await readFile(hook(first), "utf8"), installed);
	await toggle!("--project linked", ctx);
	await assert.rejects(readFile(hook(first)), { code: "ENOENT" });
	await git(second, ["config", "--unset", "core.hooksPath"]);
	await toggle!("", { ...ctx, cwd: second });
	assert.match(await readFile(hook(second), "utf8"), /pi-deps-managed-hook/);
	await assert.rejects(readFile(hook(first)), { code: "ENOENT" });
});

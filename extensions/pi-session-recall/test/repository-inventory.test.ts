import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MAX_MANIFEST_BYTES,
	REPOSITORY_UNAVAILABLE_REASON,
	inventoryRepository,
} from "../extensions/repository-inventory.ts";

interface GitCall {
	command: string;
	args: string[];
	cwd: string | undefined;
	signal: AbortSignal | undefined;
}

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepository(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-inventory-"));
	runGit(root, ["init", "-q"]);
	return root;
}

function write(root: string, relativePath: string, content: string, mode?: number): string {
	const filePath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	if (mode !== undefined) fs.chmodSync(filePath, mode);
	return filePath;
}

function skill(name: string, description: string, sourcePath: string): object {
	return {
		name,
		description,
		source: "skill",
		sourceInfo: {
			path: sourcePath,
			source: "skill",
			scope: "project",
			origin: "top-level",
		},
	};
}

function makePi(commands: object[] = []): { pi: Pick<ExtensionAPI, "exec" | "getCommands">; calls: GitCall[] } {
	const calls: GitCall[] = [];
	return {
		pi: {
			async exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal }) {
				calls.push({ command, args, cwd: options?.cwd, signal: options?.signal });
				const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
				return {
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
					code: result.status ?? 1,
					killed: result.signal !== null,
				};
			},
			getCommands: () => commands,
		} as unknown as Pick<ExtensionAPI, "exec" | "getCommands">,
		calls,
	};
}

describe("repository inventory", () => {
	it("lists Git-visible automation surfaces in stable order from effective Pi commands", async () => {
		const root = makeRepository();
		try {
			write(root, ".gitignore", "ignored.sh\n");
			write(root, "package.json", JSON.stringify({ scripts: { zebra: "echo zebra", alpha: "echo alpha" } }));
			write(root, "packages/app/package.json", JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
			write(root, "scripts/zebra.sh", "#!/bin/sh\n", 0o755);
			write(root, "scripts/alpha.sh", "#!/bin/sh\n", 0o755);
			write(root, "AGENTS.md", "root instructions\n");
			write(root, "config/AGENTS.override.md", "override instructions\n");
			write(root, "CLAUDE.md", "untracked instructions\n");
			write(root, "scratch.sh", "#!/bin/sh\n", 0o755);
			write(root, "ignored.sh", "#!/bin/sh\n", 0o755);
			const inside = write(root, "skills/alpha/SKILL.md", "alpha\n");
			const zed = write(root, "skills/zed/SKILL.md", "zed\n");
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-inventory-skill-"));
			try {
				const external = write(outside, "SKILL.md", "outside\n");
				fs.symlinkSync(external, path.join(root, "skills", "escape.md"));
				runGit(root, ["add", ".gitignore", "package.json", "packages/app/package.json", "scripts", "AGENTS.md", "config/AGENTS.override.md"]);

				const controller = new AbortController();
				const { pi, calls } = makePi([
					skill("skill:zed", "Zed skill", zed),
					skill("skill:outside", "Outside skill", external),
					skill("skill:escape", "Escaped skill", path.join(root, "skills", "escape.md")),
					skill("skill:alpha", "Alpha skill", inside),
					{
						name: "prompt:ignored",
						description: "Not a skill",
						source: "prompt",
						sourceInfo: { path: inside, source: "prompt", scope: "project", origin: "top-level" },
					},
				]);
				const context = { cwd: root, signal: controller.signal };
				const inventory = await inventoryRepository(pi, context);

				assert.deepEqual(inventory, {
					available: true,
					gitRoot: fs.realpathSync(root),
					packageScripts: [
						{ path: "package.json", name: "alpha", command: "echo alpha" },
						{ path: "package.json", name: "zebra", command: "echo zebra" },
						{ path: "packages/app/package.json", name: "build", command: "tsc" },
						{ path: "packages/app/package.json", name: "test", command: "node --test" },
					],
					executableScripts: ["scratch.sh", "scripts/alpha.sh", "scripts/zebra.sh"],
					skills: [
						{ name: "skill:alpha", description: "Alpha skill", sourcePath: "skills/alpha/SKILL.md" },
						{ name: "skill:zed", description: "Zed skill", sourcePath: "skills/zed/SKILL.md" },
					],
					agentInstructions: ["AGENTS.md", "CLAUDE.md", "config/AGENTS.override.md"],
				});
				assert.deepEqual(await inventoryRepository(pi, context), inventory);
				assert.deepEqual(calls.slice(0, 3).map(({ command, args }) => ({ command, args })), [
					{ command: "git", args: ["rev-parse", "--show-toplevel"] },
					{ command: "git", args: ["ls-files", "--stage", "-z"] },
					{ command: "git", args: ["ls-files", "--others", "--exclude-standard", "-z"] },
				]);
				assert.ok(calls.every((call) => call.signal === controller.signal));
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a stable unavailable result outside Git or fails when a repository is required", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-not-git-"));
		try {
			const { pi } = makePi();
			const context = { cwd, signal: new AbortController().signal };
			assert.deepEqual(await inventoryRepository(pi, context, "optional"), {
				available: false,
				reason: REPOSITORY_UNAVAILABLE_REASON,
				packageScripts: [],
				executableScripts: [],
				skills: [],
				agentInstructions: [],
			});
			await assert.rejects(inventoryRepository(pi, context), /requires a Git repository/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects symlink and traversal manifest paths without reading outside the repository", async () => {
		const root = makeRepository();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-outside-manifest-"));
		try {
			const externalManifest = write(outside, "package.json", JSON.stringify({ scripts: { leaked: "echo leaked" } }));
			fs.mkdirSync(path.join(root, "escape"));
			fs.symlinkSync(externalManifest, path.join(root, "escape", "package.json"));
			runGit(root, ["add", "escape/package.json"]);
			const { pi } = makePi();
			await assert.rejects(
				inventoryRepository(pi, { cwd: root, signal: new AbortController().signal }),
				(error: Error) => /Unsafe repository manifest/.test(error.message) && error.message.includes('"escape/package.json"'),
			);

			const traversalPi = {
				exec: async (_command: string, args: string[]) => {
					if (args[0] === "rev-parse") return { stdout: `${root}\n`, stderr: "", code: 0, killed: false };
					return { stdout: "100644 deadbeef 0\t../outside/package.json\0", stderr: "", code: 0, killed: false };
				},
				getCommands: () => [],
			} as unknown as Pick<ExtensionAPI, "exec" | "getCommands">;
			await assert.rejects(
				inventoryRepository(traversalPi, { cwd: root, signal: new AbortController().signal }),
				(error: Error) => /Unsafe repository manifest/.test(error.message) && error.message.includes('"../outside/package.json"'),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects oversized and malformed manifests with their bounded repository paths", async () => {
		const oversizedRoot = makeRepository();
		const malformedRoot = makeRepository();
		try {
			write(oversizedRoot, "package.json", "x".repeat(MAX_MANIFEST_BYTES + 1));
			runGit(oversizedRoot, ["add", "package.json"]);
			const oversized = makePi();
			await assert.rejects(
				inventoryRepository(oversized.pi, { cwd: oversizedRoot, signal: new AbortController().signal }),
				/Oversized repository manifest \(1 MiB limit\): "package\.json"/,
			);

			write(malformedRoot, "nested/package.json", "{");
			runGit(malformedRoot, ["add", "nested/package.json"]);
			const malformed = makePi();
			await assert.rejects(
				inventoryRepository(malformed.pi, { cwd: malformedRoot, signal: new AbortController().signal }),
				(error: Error) => /Malformed repository manifest/.test(error.message) && error.message.includes('"nested/package.json"'),
			);
		} finally {
			fs.rmSync(oversizedRoot, { recursive: true, force: true });
			fs.rmSync(malformedRoot, { recursive: true, force: true });
		}
	});

	it("uses the descriptor-pinned manifest snapshot when the pathname is replaced", async () => {
		const root = makeRepository();
		try {
			const manifestPath = write(root, "package.json", JSON.stringify({ scripts: { before: "echo before" } }));
			const replacementPath = write(root, "replacement.json", JSON.stringify({ scripts: { after: "echo after" } }));
			runGit(root, ["add", "package.json"]);
			const { pi } = makePi();
			const realOpenSync = fs.openSync.bind(fs) as typeof fs.openSync;
			let replaced = false;
			fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
				const fd = realOpenSync(...args);
				if (!replaced && typeof args[0] === "string" && path.basename(args[0]) === "package.json") {
					replaced = true;
					fs.renameSync(replacementPath, manifestPath);
				}
				return fd;
			}) as typeof fs.openSync;
			try {
				const inventory = await inventoryRepository(pi, { cwd: root, signal: new AbortController().signal });
				assert.equal(replaced, true);
				assert.deepEqual(inventory.packageScripts, [{ path: "package.json", name: "before", command: "echo before" }]);
			} finally {
				fs.openSync = realOpenSync;
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("propagates cancellation from Git execution without exposing Git output", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const pi = {
			exec: async (_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
				receivedSignal = options?.signal;
				controller.abort();
				return { stdout: "sensitive git output", stderr: "sensitive git error", code: 1, killed: true };
			},
			getCommands: () => [],
		} as unknown as Pick<ExtensionAPI, "exec" | "getCommands">;
		await assert.rejects(
			inventoryRepository(pi, { cwd: os.tmpdir(), signal: controller.signal }),
			(error: Error) => /cancelled/.test(error.message) && !/sensitive/.test(error.message),
		);
		assert.equal(receivedSignal, controller.signal);
	});
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MAX_MANIFEST_BYTES,
	MAX_PACKAGE_MANIFESTS,
	REPOSITORY_UNAVAILABLE_REASON,
	inventoryRepository,
} from "../extensions/repository-inventory.ts";

const OID40 = "a".repeat(40);
const OID64 = "b".repeat(64);

type InventoryPi = Pick<ExtensionAPI, "getCommands">;

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepository(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-inventory-"));
	runGit(root, ["init", "-q"]);
	return fs.realpathSync(root);
}

function write(root: string, relativePath: string, content: string | Buffer, mode?: number): string {
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

function makePi(commands: object[] = []): InventoryPi {
	return { getCommands: () => commands } as unknown as InventoryPi;
}

async function withGitShim(body: string, run: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-git-shim-cwd-")));
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-git-shim-bin-"));
	const shim = path.join(bin, "git");
	write(bin, "git", `#!/usr/bin/env node\nconst args = process.argv.slice(2);\n${body}\n`, 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
	try {
		await run(cwd);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(bin, { recursive: true, force: true });
	}
}

function rootSuccess(): string {
	return `if (args[0] === "rev-parse") { process.stdout.write(process.cwd() + "\\n"); process.exit(0); }`;
}

function indexRecord(mode: string, oid: string, stage: string, relativePath: string | Buffer, finalNul = true): Buffer {
	return Buffer.concat([
		Buffer.from(`${mode} ${oid} ${stage}\t`, "ascii"),
		typeof relativePath === "string" ? Buffer.from(relativePath) : relativePath,
		...(finalNul ? [Buffer.from([0])] : []),
	]);
}

function indexShim(index: Buffer, options: { size?: string | Buffer; blob?: string | Buffer } = {}): string {
	const size = options.size ?? "2\n";
	const blob = options.blob ?? "{}";
	return `${rootSuccess()}
if (args[0] === "ls-files") { process.stdout.write(Buffer.from("${index.toString("base64")}", "base64")); process.exit(0); }
if (args[0] === "--no-replace-objects" && args[2] === "-s") { process.stdout.write(Buffer.from("${Buffer.from(size).toString("base64")}", "base64")); process.exit(0); }
if (args[0] === "--no-replace-objects" && args[2] === "blob") { process.stdout.write(Buffer.from("${Buffer.from(blob).toString("base64")}", "base64")); process.exit(0); }
process.exit(9);`;
}

async function rejectedMessage(run: Promise<unknown>): Promise<string> {
	try {
		await run;
		assert.fail("expected rejection");
	} catch (error) {
		return (error as Error).message;
	}
}

describe("repository inventory", { concurrency: false }, () => {
	it("returns a deterministic Git-index snapshot plus canonically contained effective skills", async () => {
		const root = makeRepository();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-inventory-skill-"));
		try {
			write(root, "package.json", JSON.stringify({ scripts: { zebra: "echo zebra", alpha: "echo alpha" } }));
			write(root, "packages/app/package.json", JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
			write(root, "scripts/zebra.sh", "#!/bin/sh\n", 0o755);
			write(root, "scripts/alpha.sh", "#!/bin/sh\n", 0o755);
			write(root, "AGENTS.md", "root instructions\n");
			write(root, "config/AGENTS.override.md", "override instructions\n", 0o755);
			write(root, "CLAUDE.md", "untracked instructions\n");
			write(root, "scratch.sh", "#!/bin/sh\n", 0o755);
			const inside = write(root, "skills/alpha/SKILL.md", "alpha\n");
			const zed = write(root, "skills/zed/SKILL.md", "zed\n");
			const external = write(outside, "SKILL.md", "outside\n");
			fs.symlinkSync(external, path.join(root, "skills", "escape.md"));
			runGit(root, ["add", "package.json", "packages/app/package.json", "scripts", "AGENTS.md", "config/AGENTS.override.md"]);

			const pi = makePi([
				skill("skill:zed", "Zed skill", zed),
				skill("skill:outside", "Outside skill", external),
				skill("skill:escape", "Escaped skill", path.join(root, "skills", "escape.md")),
				skill("skill:alpha", "Alpha skill", inside),
				{ name: "prompt:ignored", source: "prompt", sourceInfo: { path: inside } },
			]);
			const context = { cwd: root, signal: new AbortController().signal };
			const inventory = await inventoryRepository(pi, context);

			assert.deepEqual(inventory, {
				available: true,
				gitRoot: root,
				packageScripts: [
					{ path: "package.json", name: "alpha", command: "echo alpha" },
					{ path: "package.json", name: "zebra", command: "echo zebra" },
					{ path: "packages/app/package.json", name: "build", command: "tsc" },
					{ path: "packages/app/package.json", name: "test", command: "node --test" },
				],
				executableScripts: ["config/AGENTS.override.md", "scripts/alpha.sh", "scripts/zebra.sh"],
				skills: [
					{ name: "skill:alpha", description: "Alpha skill", sourcePath: "skills/alpha/SKILL.md" },
					{ name: "skill:zed", description: "Zed skill", sourcePath: "skills/zed/SKILL.md" },
				],
				agentInstructions: ["AGENTS.md", "config/AGENTS.override.md"],
				provenance: {
					packageScripts: "git-index",
					executableScripts: "git-index",
					agentInstructions: "git-index",
					skills: "pi-effective-registry",
				},
				worktreeVerified: false,
			});
			assert.deepEqual(await inventoryRepository(pi, context), inventory);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("returns the optional unavailable shape outside Git and fails required mode", async () => {
		const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-not-git-")));
		try {
			const context = { cwd, signal: new AbortController().signal };
			assert.deepEqual(await inventoryRepository(makePi(), context, "optional"), {
				available: false,
				reason: REPOSITORY_UNAVAILABLE_REASON,
				packageScripts: [],
				executableScripts: [],
				skills: [],
				agentInstructions: [],
				worktreeVerified: false,
			});
			await assert.rejects(inventoryRepository(makePi(), context), /requires a Git repository/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fails closed for spawn, cancellation, exit, stderr, and stream overflow without leaking output", async (t) => {
		await t.test("spawn error", async () => {
			const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-no-git-")));
			const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-recall-empty-path-"));
			const previousPath = process.env.PATH;
			process.env.PATH = emptyPath;
			try {
				assert.match(await rejectedMessage(inventoryRepository(makePi(), { cwd, signal: new AbortController().signal })), /could not start Git/);
			} finally {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				fs.rmSync(cwd, { recursive: true, force: true });
				fs.rmSync(emptyPath, { recursive: true, force: true });
			}
		});

		await t.test("cancellation", async () => {
			await withGitShim(`if (args[0] === "rev-parse") setInterval(() => {}, 1000);`, async (cwd) => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 30);
				assert.match(await rejectedMessage(inventoryRepository(makePi(), { cwd, signal: controller.signal })), /cancelled/);
			});
		});

		const cases = [
			["nonzero exit", `${rootSuccess()}\nprocess.exit(7);`, /command failed/],
			["unexpected stderr", `process.stderr.write("sensitive-stderr"); process.stdout.write(process.cwd() + "\\n");`, /unexpected stderr/],
			["stdout overflow", `process.stdout.write("sensitive-stdout" + "x".repeat(5000));`, /stdout exceeded/],
			["stderr overflow", `process.stderr.write("sensitive-stderr" + "x".repeat(5000));`, /stderr exceeded/],
		] as const;
		for (const [name, body, expected] of cases) {
			await t.test(name, async () => {
				await withGitShim(body, async (cwd) => {
					const message = await rejectedMessage(inventoryRepository(makePi(), { cwd, signal: new AbortController().signal }));
					assert.match(message, expected);
					assert.doesNotMatch(message, /sensitive/);
				});
			});
		}
	});

	it("rejects invalid UTF-8 and malformed, unterminated, duplicate, or conflicted index records", async (t) => {
		await t.test("invalid UTF-8 root", async () => {
			await withGitShim(`process.stdout.write(Buffer.from([0xff, 0x0a]));`, async (cwd) => {
				await assert.rejects(inventoryRepository(makePi(), { cwd, signal: new AbortController().signal }), /resolve the Git root/);
			});
		});

		const malformed = [
			["invalid UTF-8 path", indexRecord("100644", OID40, "0", Buffer.from([0xff]))],
			["missing final NUL", indexRecord("100644", OID40, "0", "package.json", false)],
			["malformed mode", indexRecord("10064x", OID40, "0", "file")],
			["unsupported non-package mode", indexRecord("040000", OID40, "0", "tree")],
			["malformed stage", indexRecord("100644", OID40, "4", "file")],
			["short object id", indexRecord("100644", "a".repeat(39), "0", "file")],
			["long object id", indexRecord("100644", "a".repeat(65), "0", "file")],
			["non-hex object id", indexRecord("100644", `${"a".repeat(39)}z`, "0", "file")],
		] as const;
		for (const [name, listing] of malformed) {
			await t.test(name, async () => {
				await withGitShim(indexShim(listing), async (cwd) => {
					await assert.rejects(inventoryRepository(makePi(), { cwd, signal: new AbortController().signal }), /invalid Git index listing|invalid repository path/);
				});
			});
		}

		await t.test("duplicate stage-0 path", async () => {
			const listing = Buffer.concat([
				indexRecord("100644", OID40, "0", "same"),
				indexRecord("100755", OID40, "0", "same"),
			]);
			await withGitShim(indexShim(listing), async (cwd) => {
				await assert.rejects(inventoryRepository(makePi(), { cwd, signal: new AbortController().signal }), /duplicate Git index/);
			});
		});

		await t.test("conflict stage", async () => {
			await withGitShim(indexShim(indexRecord("100644", OID40, "2", "package.json")), async (cwd) => {
				await assert.rejects(inventoryRepository(makePi(), { cwd, signal: new AbortController().signal }), /conflicted Git index/);
			});
		});
	});

	it("accepts exact 64-hex object IDs and rejects invalid blob encoding, byte counts, and JSON", async (t) => {
		await t.test("64-hex object id", async () => {
			await withGitShim(indexShim(indexRecord("100644", OID64, "0", "package.json")), async (cwd) => {
				const inventory = await inventoryRepository(makePi(), { cwd, signal: new AbortController().signal });
				assert.deepEqual(inventory.packageScripts, []);
			});
		});

		const failures = [
			["invalid UTF-8 blob", { size: "1\n", blob: Buffer.from([0xff]) }, /Malformed repository manifest/],
			["literal replacement character", { size: "3\n", blob: "�" }, /Malformed repository manifest/],
			["short blob", { size: "3\n", blob: "{}" }, /incorrect Git blob size/],
			["malformed JSON", { size: "1\n", blob: "{" }, /Malformed repository manifest/],
			["malformed size", { size: "2x\n", blob: "{}" }, /invalid Git object size/],
		] as const;
		for (const [name, options, expected] of failures) {
			await t.test(name, async () => {
				await withGitShim(indexShim(indexRecord("100644", OID40, "0", "package.json"), options), async (cwd) => {
					await assert.rejects(inventoryRepository(makePi(), { cwd, signal: new AbortController().signal }), expected);
				});
			});
		}
	});

	it("rejects package symlinks, gitlinks, trees, and unsupported modes before parsing their blobs", async (t) => {
		await t.test("symlink target text is valid JSON", async () => {
			const root = makeRepository();
			try {
				fs.symlinkSync('{"scripts":{"spoof":"echo spoof"}}', path.join(root, "package.json"));
				runGit(root, ["add", "package.json"]);
				await assert.rejects(inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal }), /Unsupported repository manifest mode/);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		for (const mode of ["160000", "040000", "100600"]) {
			await t.test(`mode ${mode}`, async () => {
				await withGitShim(indexShim(indexRecord(mode, OID40, "0", "nested/package.json")), async (cwd) => {
					await assert.rejects(inventoryRepository(makePi(), { cwd, signal: new AbortController().signal }), /Unsupported repository manifest mode/);
				});
			});
		}
	});

	it("enforces package count and individual and cumulative manifest byte limits", async (t) => {
		await t.test("more than 512 manifests", async () => {
			const root = makeRepository();
			try {
				for (let index = 0; index <= MAX_PACKAGE_MANIFESTS; index++) write(root, `${index}/package.json`, "{}");
				runGit(root, ["add", "."]);
				await assert.rejects(inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal }), /512 package manifest limit/);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		await t.test("individual manifest over 1 MiB", async () => {
			const root = makeRepository();
			try {
				write(root, "package.json", "x".repeat(MAX_MANIFEST_BYTES + 1));
				runGit(root, ["add", "package.json"]);
				await assert.rejects(inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal }), /Oversized repository manifest/);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		await t.test("cumulative declarations over 16 MiB", async () => {
			const root = makeRepository();
			try {
				const manifest = "x".repeat(MAX_MANIFEST_BYTES);
				for (let index = 0; index < 17; index++) write(root, `${index}/package.json`, manifest);
				runGit(root, ["add", "."]);
				await assert.rejects(inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal }), /16 MiB total manifest limit/);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});

	it("ignores replacement refs when reading indexed package objects", async () => {
		const root = makeRepository();
		try {
			write(root, "package.json", JSON.stringify({ scripts: { original: "echo original" } }));
			runGit(root, ["add", "package.json"]);
			const original = runGit(root, ["rev-parse", ":package.json"]).trim();
			const replacementPath = write(root, "replacement.json", JSON.stringify({ scripts: { spoofed: "echo spoofed" } }));
			const replacement = execFileSync("git", ["hash-object", "-w", replacementPath], { cwd: root, encoding: "utf8" }).trim();
			runGit(root, ["replace", original, replacement]);

			assert.deepEqual((await inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal })).packageScripts, [
				{ path: "package.json", name: "original", command: "echo original" },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reflects staged add, change, and delete", async () => {
		const root = makeRepository();
		try {
			write(root, "package.json", JSON.stringify({ scripts: { before: "echo before" } }));
			runGit(root, ["add", "package.json"]);
			assert.deepEqual((await inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal })).packageScripts.map((script) => script.name), ["before"]);
			runGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);

			write(root, "package.json", JSON.stringify({ scripts: { after: "echo after" } }));
			write(root, "nested/package.json", JSON.stringify({ scripts: { added: "echo added" } }));
			runGit(root, ["add", "."]);
			assert.deepEqual((await inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal })).packageScripts.map((script) => script.name), ["added", "after"]);

			runGit(root, ["rm", "--cached", "package.json"]);
			assert.deepEqual((await inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal })).packageScripts.map((script) => script.name), ["added"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not inspect unstaged deletions, content, chmod, symlinks, or untracked files", async () => {
		const root = makeRepository();
		try {
			write(root, "package.json", JSON.stringify({ scripts: { indexed: "echo indexed" } }));
			write(root, "bin/run", "#!/bin/sh\n", 0o755);
			write(root, "AGENTS.md", "indexed instructions\n");
			runGit(root, ["add", "."]);

			fs.rmSync(path.join(root, "package.json"));
			fs.symlinkSync('{"scripts":{"worktree":"echo worktree"}}', path.join(root, "package.json"));
			fs.rmSync(path.join(root, "AGENTS.md"));
			fs.chmodSync(path.join(root, "bin", "run"), 0o644);
			write(root, "untracked/package.json", JSON.stringify({ scripts: { untracked: "echo untracked" } }));
			write(root, "untracked.sh", "#!/bin/sh\n", 0o755);
			write(root, "CLAUDE.md", "untracked instructions\n");

			const inventory = await inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal });
			assert.deepEqual(inventory.packageScripts, [{ path: "package.json", name: "indexed", command: "echo indexed" }]);
			assert.deepEqual(inventory.executableScripts, ["bin/run"]);
			assert.deepEqual(inventory.agentInstructions, ["AGENTS.md"]);
			assert.equal(inventory.worktreeVerified, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses index modes for executables and regular instruction files", async () => {
		const root = makeRepository();
		try {
			write(root, "bin/executable", "#!/bin/sh\n", 0o755);
			write(root, "bin/plain", "plain\n", 0o644);
			write(root, "AGENTS.md", "instructions\n", 0o755);
			fs.symlinkSync("missing-target", path.join(root, "CLAUDE.md"));
			runGit(root, ["add", "."]);
			const inventory = await inventoryRepository(makePi(), { cwd: root, signal: new AbortController().signal });
			assert.deepEqual(inventory.executableScripts, ["AGENTS.md", "bin/executable"]);
			assert.deepEqual(inventory.agentInstructions, ["AGENTS.md"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

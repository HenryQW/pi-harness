import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const pnpm = process.env.npm_execpath ?? "pnpm";
const rootManifest = JSON.parse(readFileSync(join(scripts, "../package.json"), "utf8"));
const names = ["core", "consumer", "leaf", "other"];

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "affected-workspaces-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const write = (path, content) => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), content);
	};
	const manifest = (name, fields) => {
		const file = `packages/${name}/package.json`;
		write(file, JSON.stringify({ ...JSON.parse(readFileSync(join(cwd, file), "utf8")), ...fields }));
	};
	const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const commit = () => { git("add", "."); git("commit", "-qm", "test change"); };
	write("package.json", JSON.stringify({ name: "test-root", private: true, packageManager: rootManifest.packageManager }));
	// The fixture needs no installed dependencies. Do not let script execution install them.
	write("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - extensions/*\nverifyDepsBeforeRun: false\n");
	write(".gitignore", "node_modules/\n");
	mkdirSync(join(cwd, "extensions"));
	for (const name of names) {
		const dependency = name === "consumer" ? "core" : name === "leaf" ? "consumer" : undefined;
		write(`packages/${name}/package.json`, JSON.stringify({
			name: `@test/${name}`, version: "1.0.0",
			devDependencies: dependency ? { [`@test/${dependency}`]: "workspace:*" } : {},
			scripts: { test: "node test.cjs" },
		}));
		write(`packages/${name}/source.js`, "original\n");
		write(`packages/${name}/test.cjs`, `console.log('TESTED ${name}', JSON.stringify(process.argv.slice(2)));\n`);
	}
	git("init", "--initial-branch=main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	commit();
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	const run = (args = ["--affected", "origin/main"], executable = pnpm) => spawnSync(process.execPath, [join(scripts, "test-workspaces.mjs"), ...args], {
		cwd, encoding: "utf8", env: { ...process.env, npm_execpath: executable }, timeout: 30_000,
	});
	return { cwd, write, manifest, git, commit, run };
}

function tested(result) {
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return [...result.stdout.matchAll(/^TESTED (\w+)/gm)].map((match) => match[1]).sort();
}

test("changed package selects transitive development dependents, using the merge base of a diverged base", (t) => {
	const f = fixture(t);
	f.write("packages/core/source.js", "changed\n");
	f.commit();
	const head = f.git("rev-parse", "HEAD");
	f.git("checkout", "-qb", "actual-base", "origin/main");
	f.write("packages/other/source.js", "base-only change\n");
	f.commit();
	f.git("checkout", "--detach", head);
	assert.deepEqual(tested(f.run(["--affected", "--", "actual-base"])), ["consumer", "core", "leaf"]);
});

test("default affected base, unchanged head, and full-run arguments retain their meanings", (t) => {
	const f = fixture(t);
	f.write("node_modules/ignored.js", "ignored\n");
	assert.deepEqual(tested(f.run(["--affected"])), []);
	f.write("packages/other/source.js", "changed\n");
	f.commit();
	assert.deepEqual(tested(f.run(["--affected"])), ["other"]);
	const full = f.run(["sample-argument"]);
	assert.deepEqual(tested(full), [...names].sort());
	assert.match(full.stdout, /TESTED other \["--","sample-argument"\]/);
});

test("local changes select dependents without changing the index; untracked shared files use the full suite", async (t) => {
	for (const state of ["unstaged", "staged", "untracked", "untracked-shared"]) {
		await t.test(state, (t) => {
			const f = fixture(t);
			const file = state === "untracked-shared" ? "scripts/new.mjs"
				: state === "untracked" ? "packages/core/new\nfile.js" : "packages/core/source.js";
			f.write(file, "local change\n");
			if (state === "unstaged") f.write("packages/other/source.js", "second package\n");
			if (state === "staged") f.git("add", ".");
			const staged = f.git("diff", "--cached");
			assert.deepEqual(tested(f.run()), ["unstaged", "untracked-shared"].includes(state) ? [...names].sort() : ["consumer", "core", "leaf"]);
			assert.equal(f.git("diff", "--cached"), staged);
		});
	}
});

test("staging an untracked file between reads still selects its package and dependents", (t) => {
	const f = fixture(t);
	const file = "packages/core/new.js";
	f.write(file, "new source\n");
	const bin = join(f.cwd, ".git", "bin");
	// Stage after whichever path query runs first, with its result already captured.
	f.write(".git/bin/git", `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const env = { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} };
const args = process.argv.slice(2);
const output = execFileSync('git', args, { env });
if (['diff', 'ls-files'].includes(args[0]) && !existsSync('.git/staged-between-reads')) {
	execFileSync('git', ['add', '--', ${JSON.stringify(file)}], { env });
	writeFileSync('.git/staged-between-reads', '');
}
process.stdout.write(output);
`);
	chmodSync(join(bin, "git"), 0o755);
	const result = spawnSync(process.execPath, [join(scripts, "test-workspaces.mjs"), "--affected", "origin/main"], {
		cwd: f.cwd, encoding: "utf8", timeout: 30_000,
		env: { ...process.env, npm_execpath: pnpm, PATH: `${bin}${delimiter}${process.env.PATH}` },
	});
	assert.equal(f.git("diff", "--cached", "--name-only"), file);
	assert.deepEqual(tested(result), ["consumer", "core", "leaf"]);
});

test("version-only changes retain direct and transitive consumers across dependency fields and ranges", async (t) => {
	for (const [field, before, after, range] of [
		["dependencies", "1.0.0", "1.0.1", "^1.0.0"],
		["devDependencies", "0.1.0", "0.2.0", "^0.1.0"],
		["optionalDependencies", "0.1.0", "0.2.0", "0.1.0"],
		["peerDependencies", "0.1.0", "0.2.0", "^0.1.0"],
	]) {
		await t.test(`${field}: ${range} with ${after}`, (t) => {
			const f = fixture(t);
			f.manifest("core", { version: before });
			f.manifest("consumer", { devDependencies: {}, [field]: { "@test/core": range } });
			f.commit();
			f.git("update-ref", "refs/remotes/origin/main", "HEAD");
			f.manifest("core", { version: after });
			f.write("packages/core/source.js", "published source change\n");
			assert.deepEqual(tested(f.run()), ["consumer", "core", "leaf"]);
		});
	}
});

test("version-only changes use the full suite for aliases or path references that can hide consumers", async (t) => {
	for (const reference of ["npm:@test/core@0.1.0", "workspace:@test/core@*", "link:../core"]) {
		await t.test(reference, (t) => {
			const f = fixture(t);
			f.manifest("core", { version: "0.1.0" });
			f.manifest("consumer", { devDependencies: { alias: reference } });
			f.commit();
			f.git("update-ref", "refs/remotes/origin/main", "HEAD");
			f.manifest("core", { version: "0.2.0" });
			const result = f.run();
			assert.deepEqual(tested(result), [...names].sort());
			assert.match(result.stdout, /unsupported dependency reference/);
		});
	}
});

test("version-only comparison does not ignore nested version fields or parse failures", async (t) => {
	for (const change of ["nested-version", "invalid-json"]) {
		await t.test(change, (t) => {
			const f = fixture(t);
			f.manifest("core", { config: { version: "1" } });
			f.commit();
			f.git("update-ref", "refs/remotes/origin/main", "HEAD");
			if (change === "invalid-json") f.write("packages/core/package.json", "{");
			else f.manifest("core", { version: "1.0.1", config: { version: "2" } });
			const result = f.run();
			if (change === "invalid-json") {
				assert.equal(result.status, 1);
				assert.match(result.stdout, /Run all workspace tests: cannot compare package manifest/);
			} else {
				assert.deepEqual(tested(result), [...names].sort());
				assert.match(result.stdout, /package manifest changed beyond version/);
			}
		});
	}
});

test("global changes, manifests, removals, renames, and undeclared cross-package test consumers use the full suite", async (t) => {
	for (const change of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "scripts/shared.mjs", "evals/shared.ts", "website/check.ts", "package-manifest", "added-manifest", "packages/core/nested/package.json", "remove", "rename", "type-change", "remove-package", "cross-package-test"]) {
		await t.test(change, (t) => {
			const f = fixture(t);
			if (change === "remove") rmSync(join(f.cwd, "packages/core/source.js"));
			else if (change === "rename") renameSync(join(f.cwd, "packages/core/source.js"), join(f.cwd, "packages/other/moved.js"));
			else if (change === "type-change") {
				rmSync(join(f.cwd, "packages/core/source.js"));
				symlinkSync("../other/source.js", join(f.cwd, "packages/core/source.js"));
			} else if (change === "added-manifest") {
				f.write("packages/new/package.json", JSON.stringify({ name: "@test/new", version: "1.0.0" }));
			} else if (change === "package-manifest") {
				const manifest = JSON.parse(readFileSync(join(f.cwd, "packages/consumer/package.json"), "utf8"));
				manifest.devDependencies = {};
				f.write("packages/consumer/package.json", JSON.stringify(manifest));
			} else if (change === "remove-package") rmSync(join(f.cwd, "packages/other"), { recursive: true });
			else if (change === "cross-package-test") {
				f.write("extensions/subagent/package.json", JSON.stringify({ name: "@henryqw/pi-subagent", version: "1.0.0", dependencies: { "@test/core": "workspace:*" } }));
				f.commit();
				f.git("update-ref", "refs/remotes/origin/main", "HEAD");
				f.write("packages/core/source.js", "changed\n");
			} else if (change === "pnpm-lock.yaml") f.write(change, "lockfileVersion: '9.0'\nimporters: {}\n");
			else if (change === "pnpm-workspace.yaml") f.write(change, "packages:\n  - packages/*\n  - extensions/*\nverifyDepsBeforeRun: false\n# changed\n");
			else if (change === "package.json") f.write(change, JSON.stringify({ name: "changed-root", private: true, packageManager: rootManifest.packageManager }));
			else f.write(change, "# changed\n");
			if (!["package-manifest", "remove", "rename", "type-change"].includes(change)) f.commit();
			const result = f.run();
			assert.deepEqual(tested(result), names.filter((name) => change !== "remove-package" || name !== "other").sort());
			assert.match(result.stdout, /Run all workspace tests:/);
		});
	}
});

test("invalid bases, unrelated or ambiguous history, and extra arguments fail", async (t) => {
	for (const state of ["missing-base", "unrelated-base", "ambiguous-base", "extra-argument"]) {
		await t.test(state, (t) => {
			const f = fixture(t);
			let args = ["--affected", "origin/main"];
			if (state === "missing-base") args[1] = "no-such-base";
			else if (state === "unrelated-base") {
				const tree = f.git("rev-parse", "HEAD^{tree}");
				args[1] = f.git("commit-tree", tree, "-m", "unrelated");
			} else if (state === "ambiguous-base") {
				const tree = f.git("rev-parse", "HEAD^{tree}");
				const left = f.git("commit-tree", tree, "-p", "HEAD", "-m", "left");
				const right = f.git("commit-tree", tree, "-p", "HEAD", "-m", "right");
				const head = f.git("commit-tree", tree, "-p", left, "-p", right, "-m", "head merge");
				args[1] = f.git("commit-tree", tree, "-p", right, "-p", left, "-m", "base merge");
				f.git("update-ref", "HEAD", head);
			} else if (state === "extra-argument") args.push("extra");
			const result = f.run(args);
			assert.equal(result.status, 1, result.stderr);
			assert.doesNotMatch(result.stdout, /TESTED/);
		});
	}
});

test("selection command errors, malformed output, and omitted packages fail instead of skipping tests", async (t) => {
	for (const response of ["process.stderr.write('selector failed'); process.exit(23)", "console.log('not json')", "console.log('{}')", "console.log('[]')"]) {
		await t.test(response, (t) => {
			const f = fixture(t);
			f.write("packages/core/source.js", "changed\n");
			f.commit();
			const executable = join(f.cwd, ".git", "test-pnpm");
			writeFileSync(executable, `#!/usr/bin/env node\nconst { spawnSync } = require('node:child_process');\nif (process.argv.includes('--recursive')) { const child = spawnSync(${JSON.stringify(pnpm)}, process.argv.slice(2), { stdio: 'inherit' }); process.exit(child.status ?? 1); }\n${response};\n`);
			chmodSync(executable, 0o755);
			const result = f.run(undefined, executable);
			assert.equal(result.status, 1, result.stderr);
			assert.doesNotMatch(result.stdout, /TESTED/);
			assert.match(result.stderr, /selector failed|SyntaxError|invalid workspace list|omitted a required package/);
		});
	}
});

test("root commands keep root tests and forward the affected base through pnpm", (t) => {
	const f = fixture(t);
	const { scripts: rootScripts } = rootManifest;
	f.write("package.json", JSON.stringify({ name: "test-root", private: true, packageManager: rootManifest.packageManager, scripts: {
		test: rootScripts.test, "test:affected": rootScripts["test:affected"], "test:root": "node root-test.cjs",
	} }));
	f.write("root-test.cjs", "console.log('ROOT TESTS');\n");
	for (const file of ["test-workspaces.mjs", "affected-workspaces.mjs"]) f.write(`scripts/${file}`, readFileSync(join(scripts, file), "utf8"));
	f.commit();
	f.git("update-ref", "refs/heads/actual-base", "HEAD");
	f.write("packages/other/source.js", "changed\n");
	f.commit();
	for (const [args, expected] of [[["run", "test:affected", "--", "actual-base"], ["other"]], [["test"], [...names].sort()]]) {
		const result = spawnSync(pnpm, args, { cwd: f.cwd, encoding: "utf8", timeout: 30_000 });
		assert.deepEqual(tested(result), expected);
		assert.match(result.stdout, /^ROOT TESTS$/m);
	}
});

test("a selected package test failure remains a failure", (t) => {
	const f = fixture(t);
	f.write("packages/other/test.cjs", "process.exit(7);\n");
	f.commit();
	const result = f.run();
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /Workspace test failed: @test\/other/);
});

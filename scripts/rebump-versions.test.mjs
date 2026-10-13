import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "rebump-versions.mjs");
const manifest = "extensions/example/package.json";

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function git(cwd, ...args) {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function json(fields) {
  return `${JSON.stringify({ name: "@test/example", ...fields }, null, 2)}\n`;
}

function commit(repo, files, message) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
}

// Creates a repository with conflicting main and feature branches, then stops `operation` on the conflicts.
function conflictedRepo(t, operation, base, main, branch) {
  const repo = mkdtempSync(join(tmpdir(), "rebump-versions-"));
  t.after(() => rmSync(repo, { force: true, recursive: true }));
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  commit(repo, base, "base");
  git(repo, "checkout", "-b", "feature");
  commit(repo, branch, "feature");
  git(repo, "checkout", "main");
  commit(repo, main, "main");
  git(repo, "checkout", "feature");
  const result = run(repo, "git", operation === "merge" ? ["merge", "main"] : ["rebase", "main"]);
  assert.notEqual(result.status, 0, "expected a conflict");
  return repo;
}

function rebump(repo) {
  return run(repo, process.execPath, [scriptPath]);
}

function unmerged(repo) {
  return git(repo, "diff", "--name-only", "--diff-filter=U").trim().split("\n").filter(Boolean);
}

test("merge applies the branch patch bump to main's minor bump and keeps other field changes", (t) => {
  const repo = conflictedRepo(t, "merge",
    { [manifest]: json({ version: "1.0.0", description: "old", type: "module", main: "index.js", license: "MIT" }), "README.md": "base\n" },
    { [manifest]: json({ version: "1.1.0", description: "old", type: "module", main: "index.js", license: "Apache-2.0" }), "README.md": "main\n" },
    { [manifest]: json({ version: "1.0.1", description: "new", type: "module", main: "index.js", license: "MIT" }), "README.md": "branch\n" },
  );

  const result = rebump(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^extensions\/example\/package\.json: 1\.0\.0 -> 1\.0\.1 \(patch\) => 1\.1\.1$/m);
  assert.match(result.stdout, /Remaining unmerged paths:\n- README\.md\n/);
  assert.equal(readFileSync(join(repo, manifest), "utf8"), json({ version: "1.1.1", description: "new", type: "module", main: "index.js", license: "Apache-2.0" }));
  assert.deepEqual(unmerged(repo), ["README.md"]);
  git(repo, "rev-parse", "--verify", "MERGE_HEAD");
});

test("rebase reads main from the onto side", (t) => {
  const repo = conflictedRepo(t, "rebase",
    { [manifest]: json({ version: "1.0.0" }) },
    { [manifest]: json({ version: "1.2.3" }) },
    { [manifest]: json({ version: "1.1.0" }) },
  );

  const result = rebump(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.0\.0 -> 1\.1\.0 \(minor\) => 1\.3\.0/);
  assert.match(result.stdout, /No unmerged paths remain\./);
  assert.equal(readFileSync(join(repo, manifest), "utf8"), json({ version: "1.3.0" }));
});

test("leaves package.json conflicted when the branch did not bump", (t) => {
  const repo = conflictedRepo(t, "merge",
    { [manifest]: json({ version: "1.0.0", description: "old" }) },
    { [manifest]: json({ version: "1.0.1", description: "main" }) },
    { [manifest]: json({ version: "1.0.0", description: "branch" }) },
  );

  const result = rebump(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /package\.json: left conflicted \(branch did not bump 1\.0\.0\)/);
  assert.deepEqual(unmerged(repo), [manifest]);
});

test("leaves package.json untouched when other fields also conflict", (t) => {
  const repo = conflictedRepo(t, "merge",
    { [manifest]: json({ version: "1.0.0", description: "old" }) },
    { [manifest]: json({ version: "1.1.0", description: "main" }) },
    { [manifest]: json({ version: "1.0.1", description: "branch" }) },
  );
  const before = readFileSync(join(repo, manifest), "utf8");

  const result = rebump(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /left conflicted \(fields other than "version" conflict\)/);
  assert.equal(readFileSync(join(repo, manifest), "utf8"), before);
  assert.deepEqual(unmerged(repo), [manifest]);
});

test("fails without a merge or rebase in progress", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "rebump-versions-"));
  t.after(() => rmSync(repo, { force: true, recursive: true }));
  git(repo, "init");

  const result = rebump(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No merge or rebase is in progress/);
});

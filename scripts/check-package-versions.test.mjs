import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkerPath = join(dirname(fileURLToPath(import.meta.url)), "check-package-versions.mjs");

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

test("no-arg mode checks packages moved between workspace roots", () => {
  const repo = mkdtempSync(join(tmpdir(), "package-version-gate-"));

  try {
    const packageDir = join(repo, "extensions", "example");
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(join(repo, "packages"));
    mkdirSync(join(repo, "extensions", "stale-package", "dist"), { recursive: true });
    writeFileSync(join(packageDir, "index.js"), "export const value = 1;\n");
    writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "@test/example", version: "1.0.0", files: ["index.js"] }, null, 2)}\n`);

    for (const args of [
      ["init", "--initial-branch=main"],
      ["config", "user.name", "Test"],
      ["config", "user.email", "test@example.com"],
      ["add", "."],
      ["commit", "-m", "initial"],
      ["update-ref", "refs/remotes/origin/main", "HEAD"],
    ]) {
      const result = run(repo, "git", args);
      assert.equal(result.status, 0, result.stderr);
    }

    const explicitRevisions = run(repo, process.execPath, [checkerPath, "--", "origin/main", "HEAD"]);
    assert.equal(explicitRevisions.status, 0, explicitRevisions.stderr);

    const movedPackageDir = join(repo, "packages", "example");
    renameSync(packageDir, movedPackageDir);
    writeFileSync(join(movedPackageDir, "index.js"), "export const value = 2;\n");
    assert.equal(run(repo, "git", ["add", "-A"]).status, 0);

    const unchangedVersion = run(repo, process.execPath, [checkerPath]);
    assert.equal(unchangedVersion.status, 1);
    assert.match(unchangedVersion.stderr, /@test\/example: version remains 1\.0\.0/);
    assert.doesNotMatch(unchangedVersion.stderr, /fatal:/);

    writeFileSync(join(movedPackageDir, "package.json"), `${JSON.stringify({ name: "@test/example", version: "1.0.1", files: ["index.js"] }, null, 2)}\n`);

    const bumpedVersion = run(repo, process.execPath, [checkerPath]);
    assert.equal(bumpedVersion.status, 0, bumpedVersion.stderr);
    assert.match(bumpedVersion.stdout, /Package version checks passed\./);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectInstallablePackages, renderInstaller } from "./generate-installer.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(scriptDir, "..");
const repoRoot = resolve(websiteDir, "..");
const installerPath = join(websiteDir, "public", "install.sh");

function packageNamesFromInstaller(source) {
  const match = source.match(/# BEGIN GENERATED EXTENSIONS\nEXTENSIONS='\n([\s\S]*?)\n'\n# END GENERATED EXTENSIONS/);
  assert.ok(match, "install.sh has generated extension markers");
  return match[1].split("\n").filter(Boolean);
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
}

function withInstaller(herdrSource, callback) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-harness-installer-"));
  const binDirectory = join(temporaryDirectory, "bin");
  const logPath = join(temporaryDirectory, "commands.log");

  try {
    mkdirSync(binDirectory);
    writeExecutable(join(binDirectory, "pi"), `#!/bin/sh\nprintf 'pi %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\n`);
    writeExecutable(join(binDirectory, "herdr"), herdrSource);
    writeExecutable(join(binDirectory, "curl"), `#!/bin/sh\nprintf 'curl\\n' >> "$PI_HARNESS_TEST_LOG"\nexit 1\n`);

    callback({
      commands: () => readFileSync(logPath, "utf8").trim().split("\n"),
      runInstaller: () => spawnSync("sh", [installerPath, "--all"], {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: temporaryDirectory,
          PATH: `${binDirectory}:${process.env.PATH}`,
          PI_HARNESS_TEST_LOG: logPath,
          TERM: "dumb",
        },
      }),
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

test("installer stays synchronized with every public Pi package", () => {
  const source = readFileSync(installerPath, "utf8");
  const names = collectInstallablePackages(repoRoot);

  assert.deepEqual(packageNamesFromInstaller(source), names);
  assert.equal(renderInstaller(source, names), source);
  assert.ok(!names.includes("@henryqw/pi-config-store"));
  assert.ok(!names.includes("@henryqw/pi-herdr"));
});

test("all mode probes compatible Herdr and installs every extension", () => {
  const names = collectInstallablePackages(repoRoot);

  withInstaller(`#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nprintf 'herdr 0.7.4\\n'\n`, ({ commands, runInstaller }) => {
    assert.equal(runInstaller().status, 0);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      ...names.map((name) => `pi install npm:${name}`),
    ]);
  });
});

test("a broken existing Herdr stops before extension installation", () => {
  withInstaller(`#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nexit 1\n`, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start.*0\.7\.4\+/);
    assert.deepEqual(commands(), ["pi --version", "herdr --version"]);
  });
});

test("an unrecognized existing Herdr version stops before extension installation", () => {
  withInstaller(`#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nprintf 'development build\\n'\n`, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not report a recognized semantic version.*0\.7\.4\+/);
    assert.deepEqual(commands(), ["pi --version", "herdr --version"]);
  });
});

test("an older existing Herdr reports the required version floor", () => {
  withInstaller(`#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nprintf 'herdr 0.7.3\\n'\n`, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Herdr 0\.7\.3.*Herdr 0\.7\.4\+ is required/);
    assert.deepEqual(commands(), ["pi --version", "herdr --version"]);
  });
});

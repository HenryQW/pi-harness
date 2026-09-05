import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
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

test("installer stays synchronized with every public Pi package", () => {
  const source = readFileSync(installerPath, "utf8");
  const names = collectInstallablePackages(repoRoot);

  assert.deepEqual(packageNamesFromInstaller(source), names);
  assert.equal(renderInstaller(source, names), source);
  assert.ok(!names.includes("@henryqw/pi-config-store"));
  assert.ok(!names.includes("@henryqw/pi-herdr"));
});

test("all mode skips installed prerequisites and installs every extension", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-harness-installer-"));
  const binDirectory = join(temporaryDirectory, "bin");
  const logPath = join(temporaryDirectory, "commands.log");
  const names = collectInstallablePackages(repoRoot);

  try {
    mkdirSync(binDirectory);
    writeExecutable(join(binDirectory, "pi"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\n`);
    writeExecutable(join(binDirectory, "herdr"), "#!/bin/sh\nexit 0\n");
    writeExecutable(join(binDirectory, "curl"), `#!/bin/sh\nprintf 'curl\\n' >> "$PI_HARNESS_TEST_LOG"\nexit 1\n`);

    execFileSync("sh", [installerPath, "--all"], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: temporaryDirectory,
        PATH: `${binDirectory}:${process.env.PATH}`,
        PI_HARNESS_TEST_LOG: logPath,
        TERM: "dumb",
      },
    });

    const commands = readFileSync(logPath, "utf8").trim().split("\n");
    assert.deepEqual(commands, ["--version", ...names.map((name) => `install npm:${name}`)]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

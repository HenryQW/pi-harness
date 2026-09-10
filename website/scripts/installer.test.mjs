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

function withInstaller(piSource, herdrSource, callback, {
  piLatest = "0.85.1",
  herdrLatest = "0.9.0",
  extensions,
} = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-harness-installer-"));
  const binDirectory = join(temporaryDirectory, "bin");
  const logPath = join(temporaryDirectory, "commands.log");
  const fixtureInstallerPath = join(temporaryDirectory, "install.sh");

  try {
    mkdirSync(binDirectory);
    const installer = readFileSync(installerPath, "utf8");
    writeFileSync(
      fixtureInstallerPath,
      extensions ? renderInstaller(installer, extensions) : installer,
    );
    writeExecutable(join(binDirectory, "pi"), piSource);
    writeExecutable(join(binDirectory, "herdr"), herdrSource);
    writeExecutable(join(binDirectory, "curl"), `#!/bin/sh
case "$*" in
  *https://pi.dev/api/installer/releases/latest*) printf '{"version":"${piLatest}"}\\n' ;;
  *https://herdr.dev/latest.json*) printf '{"version":"${herdrLatest}"}\\n' ;;
  *) exit 1 ;;
esac
`);

    callback({
      commands: () => readFileSync(logPath, "utf8").trim().split("\n"),
      runInstaller: (...args) => spawnSync("sh", [fixtureInstallerPath, ...(args.length ? args : ["--all"])], {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: temporaryDirectory,
          PATH: `${binDirectory}:${process.env.PATH}`,
          PI_HARNESS_TEST_DIR: temporaryDirectory,
          PI_HARNESS_TEST_LOG: logPath,
          TERM: "dumb",
        },
      }),
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function updatableTool(name, current, latest) {
  return `#!/bin/sh
printf '${name} %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"
state="$PI_HARNESS_TEST_DIR/${name}-version"
case "$1" in
  --version)
    version='${current}'
    if [ -f "$state" ]; then IFS= read -r version < "$state"; fi
    printf '${name} %s\\n' "$version"
    ;;
  update) printf '${latest}\\n' > "$state" ;;
esac
`;
}

function compatibleTool(name, version) {
  return `#!/bin/sh
printf '${name} %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"
printf '${name} ${version}\\n'
`;
}

function legacyPi({ installFails = false, uninstallFails = false, removalPersists = false } = {}) {
  return `#!/bin/sh
printf 'pi %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"
marker="$PI_HARNESS_TEST_DIR/pi-initialized"
source="$PI_HARNESS_TEST_DIR/legacy-source"
if [ ! -f "$marker" ]; then
  : > "$marker"
  : > "$source"
fi
case "$1" in
  --version) printf 'pi 0.85.1\\n' ;;
  install)
    ${installFails ? "[ \"$2\" != \"npm:@henryqw/pi-herdr-btw\" ] || exit 1" : ":"}
    ;;
  list) [ ! -f "$source" ] || printf 'User packages:\\n  npm:@henryqw/pi-auto-dag\\n    /tmp/pi-auto-dag\\n' ;;
  uninstall)
    ${uninstallFails ? "exit 1" : removalPersists ? ":" : "rm -f \"$source\""}
    ;;
esac
`;
}

const compatiblePi = compatibleTool("pi", "0.85.1");
const compatibleHerdr = compatibleTool("herdr", "0.9.0");
const baseHerdr = compatibleTool("herdr", "0.7.4");

test("installer package discovery ignores directories without manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-harness-packages-"));

  try {
    mkdirSync(join(root, "extensions", "stale-package", "dist"), { recursive: true });
    mkdirSync(join(root, "extensions", "example"));
    writeFileSync(join(root, "extensions", "example", "package.json"), JSON.stringify({
      name: "@henryqw/example",
      pi: {},
    }));

    assert.deepEqual(collectInstallablePackages(root), ["@henryqw/example"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("installer stays synchronized with every public Pi package", () => {
  const source = readFileSync(installerPath, "utf8");
  const names = collectInstallablePackages(repoRoot);

  assert.deepEqual(packageNamesFromInstaller(source), names);
  assert.equal(renderInstaller(source, names), source);
  assert.ok(!names.includes("@henryqw/pi-config-store"));
  assert.ok(!names.includes("@henryqw/pi-herdr"));
  assert.ok(!names.includes("@henryqw/pi-auto-dag"));
  assert.ok(names.includes("@henryqw/pi-orchestrator"));
});

test("all mode requires Herdr 0.9.0, installs every extension, and skips absent legacy cleanup", () => {
  const names = collectInstallablePackages(repoRoot);

  withInstaller(compatiblePi, compatibleHerdr, ({ commands, runInstaller }) => {
    assert.equal(runInstaller().status, 0);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      ...names.map((name) => `pi install npm:${name}`),
      "pi list",
    ]);
  });
});

test("pi-herdr-btw alone retains the Herdr 0.7.4 floor", () => {
  withInstaller(compatiblePi, baseHerdr, ({ commands, runInstaller }) => {
    assert.equal(runInstaller().status, 0);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      "pi install npm:@henryqw/pi-herdr-btw",
    ]);
  }, {
    extensions: ["@henryqw/pi-herdr-btw"],
    herdrLatest: "0.7.4",
  });
});

test("orchestrator alone rejects Herdr below 0.9.0", () => {
  const olderHerdr = compatibleTool("herdr", "0.8.9");
  withInstaller(compatiblePi, olderHerdr, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Herdr 0\.8\.9.*Herdr 0\.9\.0\+ is required/);
    assert.deepEqual(commands(), ["pi --version", "herdr --version"]);
  }, { extensions: ["@henryqw/pi-orchestrator"] });
});

test("update flag approves available Pi and Herdr updates", () => {
  const names = collectInstallablePackages(repoRoot);
  const pi = updatableTool("pi", "0.85.1", "0.85.2");
  const herdr = updatableTool("herdr", "0.8.2", "0.9.0");

  withInstaller(pi, herdr, ({ commands, runInstaller }) => {
    assert.equal(runInstaller("--all", "--update").status, 0);
    assert.deepEqual(commands(), [
      "pi --version",
      "pi update --self",
      "pi --version",
      "herdr --version",
      "herdr update",
      "herdr --version",
      ...names.map((name) => `pi install npm:${name}`),
      "pi list",
    ]);
  }, { piLatest: "0.85.2", herdrLatest: "0.9.0" });
});

test("an approved update failure stops before extension installation", () => {
  const pi = `#!/bin/sh
printf 'pi %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"
case "$1" in
  --version) printf 'pi 0.85.1\\n' ;;
  update) exit 1 ;;
esac
`;

  withInstaller(pi, compatibleHerdr, ({ commands, runInstaller }) => {
    const result = runInstaller("--all", "--update");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pi update failed/);
    assert.deepEqual(commands(), ["pi --version", "pi update --self"]);
  }, { piLatest: "0.85.2" });
});

test("a skipped Herdr update still enforces the selected 0.9.0 floor", () => {
  const herdr = updatableTool("herdr", "0.8.2", "0.9.0");

  withInstaller(compatiblePi, herdr, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Skipping the Herdr update because no interactive terminal is available/);
    assert.match(result.stderr, /Herdr 0\.8\.2.*Herdr 0\.9\.0\+ is required/);
    assert.deepEqual(commands(), ["pi --version", "herdr --version"]);
  });
});

test("an approved Herdr update must reach the selected 0.9.0 floor", () => {
  const herdr = updatableTool("herdr", "0.8.2", "0.8.3");

  withInstaller(compatiblePi, herdr, ({ commands, runInstaller }) => {
    const result = runInstaller("--all", "--update");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Herdr 0\.8\.3.*Herdr 0\.9\.0\+ is required/);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      "herdr update",
      "herdr --version",
    ]);
  });
});

test("a broken existing Pi stops before extension installation", () => {
  withInstaller(`#!/bin/sh\nprintf 'pi %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nexit 1\n`, compatibleHerdr, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start.*0\.85\.1\+/);
    assert.deepEqual(commands(), ["pi --version"]);
  });
});

test("an unrecognized existing Pi version stops before extension installation", () => {
  withInstaller(`#!/bin/sh\nprintf 'pi %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nprintf 'development build\\n'\n`, compatibleHerdr, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not report a recognized semantic version.*0\.85\.1\+/);
    assert.deepEqual(commands(), ["pi --version"]);
  });
});

test("an older existing Pi reports the required version floor", () => {
  withInstaller(`#!/bin/sh\nprintf 'pi %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nprintf 'pi 0.85.0\\n'\n`, compatibleHerdr, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pi 0\.85\.0.*Pi 0\.85\.1\+ is required/);
    assert.deepEqual(commands(), ["pi --version"]);
  });
});

test("a broken existing Herdr reports the selected floor", () => {
  withInstaller(compatiblePi, `#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nexit 1\n`, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start.*0\.9\.0\+/);
    assert.deepEqual(commands(), ["pi --version", "herdr --version"]);
  });
});

test("an unrecognized existing Herdr version reports the selected floor", () => {
  withInstaller(compatiblePi, `#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"\nprintf 'development build\\n'\n`, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not report a recognized semantic version.*0\.9\.0\+/);
    assert.deepEqual(commands(), ["pi --version", "herdr --version"]);
  });
});

test("an older existing Herdr reports the orchestrator floor", () => {
  withInstaller(compatiblePi, compatibleTool("herdr", "0.8.9"), ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Herdr 0\.8\.9.*Herdr 0\.9\.0\+ is required/);
    assert.deepEqual(commands(), ["pi --version", "herdr --version"]);
  });
});

test("an orchestrator upgrade removes only the exact retired npm source after installation", () => {
  withInstaller(legacyPi(), compatibleHerdr, ({ commands, runInstaller }) => {
    assert.equal(runInstaller().status, 0);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      "pi install npm:@henryqw/pi-orchestrator",
      "pi install npm:@henryqw/pi-herdr-btw",
      "pi list",
      "pi uninstall npm:@henryqw/pi-auto-dag",
      "pi list",
    ]);
  }, { extensions: ["@henryqw/pi-orchestrator", "@henryqw/pi-herdr-btw"] });
});

test("legacy cleanup does not run when a selected replacement install fails", () => {
  withInstaller(legacyPi({ installFails: true }), compatibleHerdr, ({ commands, runInstaller }) => {
    assert.equal(runInstaller().status, 1);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      "pi install npm:@henryqw/pi-orchestrator",
      "pi install npm:@henryqw/pi-herdr-btw",
    ]);
  }, { extensions: ["@henryqw/pi-orchestrator", "@henryqw/pi-herdr-btw"] });
});

test("legacy cleanup ignores package-name substrings", () => {
  const pi = `#!/bin/sh
printf 'pi %s\\n' "$*" >> "$PI_HARNESS_TEST_LOG"
case "$1" in
  --version) printf 'pi 0.85.1\\n' ;;
  list) printf 'User packages:\\n  npm:@henryqw/pi-auto-dag-copy\\n    /tmp/pi-auto-dag\\n' ;;
esac
`;
  withInstaller(pi, compatibleHerdr, ({ commands, runInstaller }) => {
    assert.equal(runInstaller().status, 0);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      "pi install npm:@henryqw/pi-orchestrator",
      "pi list",
    ]);
  }, { extensions: ["@henryqw/pi-orchestrator"] });
});

test("a failed legacy uninstall aborts", () => {
  withInstaller(legacyPi({ uninstallFails: true }), compatibleHerdr, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not remove retired Pi package source npm:@henryqw\/pi-auto-dag/);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      "pi install npm:@henryqw/pi-orchestrator",
      "pi list",
      "pi uninstall npm:@henryqw/pi-auto-dag",
    ]);
  }, { extensions: ["@henryqw/pi-orchestrator"] });
});

test("failed proof of legacy removal aborts", () => {
  withInstaller(legacyPi({ removalPersists: true }), compatibleHerdr, ({ commands, runInstaller }) => {
    const result = runInstaller();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm:@henryqw\/pi-auto-dag is still installed/);
    assert.deepEqual(commands(), [
      "pi --version",
      "herdr --version",
      "pi install npm:@henryqw/pi-orchestrator",
      "pi list",
      "pi uninstall npm:@henryqw/pi-auto-dag",
      "pi list",
    ]);
  }, { extensions: ["@henryqw/pi-orchestrator"] });
});

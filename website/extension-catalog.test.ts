import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectCatalog, extensions, homepageExtensions, supportLibraries } from "./extension-catalog.ts";

test("catalog classifies package docs from manifest Pi metadata", () => {
  assert.ok(extensions.length > 0);
  assert.ok(extensions.every((item) => Object.hasOwn(item, "pi")));
  assert.deepEqual(
    supportLibraries.map((item) => item.directory),
    ["pi-config-store", "pi-herdr"]
  );
  assert.ok(supportLibraries.every((item) => !Object.hasOwn(item, "pi") && !item.private));
  assert.deepEqual(homepageExtensions, extensions.filter((item) => !item.private));
});

test("catalog ignores directories without package manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "extension-catalog-"));

  try {
    mkdirSync(join(root, "extensions", "stale-package", "dist"), { recursive: true });
    mkdirSync(join(root, "packages", "library"), { recursive: true });
    writeFileSync(join(root, "packages", "library", "package.json"), JSON.stringify({
      description: "Support library",
      name: "@test/library",
      version: "1.0.0",
    }));

    assert.deepEqual(collectCatalog(root).map((item) => item.directory), ["library"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

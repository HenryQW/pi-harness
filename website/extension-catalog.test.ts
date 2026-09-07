import assert from "node:assert/strict";
import test from "node:test";

import { extensions, homepageExtensions, supportLibraries } from "./extension-catalog.ts";

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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

import { extensions, repoRoot } from "./extension-catalog.ts";

function headings(path: string): string[] {
  return fromMarkdown(readFileSync(path, "utf8")).children
    .filter((node) => node.type === "heading" && node.depth === 2)
    .map((node) => toString(node));
}

const canonical = headings(join(repoRoot, "extensions", "README-template.md"));

for (const { directory } of extensions) {
  test(`${directory} README uses only canonical H2 headings in order`, () => {
    const actual = headings(join(repoRoot, "extensions", directory, "README.md"));
    assert.deepEqual(actual, canonical.filter((heading) => actual.includes(heading)),
      "Follow extensions/README-template.md; place package-specific topics under a canonical H2 using H3.");
  });
}

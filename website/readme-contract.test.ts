import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

import { prose, splitSentences } from "./ste.ts";

// The catalog resolves its paths from the website working directory.
process.chdir(import.meta.dirname);
const { extensions, repoRoot } = await import("./extension-catalog.ts");

function headings(path: string): string[] {
  return fromMarkdown(readFileSync(path, "utf8")).children
    .filter((node) => node.type === "heading" && node.depth === 2)
    .map((node) => toString(node));
}

function introductionSentenceCount(markdown: string): number {
  let inIntroduction = false;
  let count = 0;
  for (const node of fromMarkdown(markdown).children) {
    if (node.type === "heading" && node.depth === 1) inIntroduction = true;
    if (inIntroduction && node.type === "heading" && node.depth === 2) break;
    if (!inIntroduction || node.type !== "paragraph") continue;
    const text = prose(node).text.trim();
    if (text.startsWith("Inspired by")) continue;
    count += splitSentences(text).filter((sentence) => /[\p{L}\p{N}\uFFFC]/u.test(sentence)).length;
  }
  return count;
}

test("README introduction counts prose sentences across paragraphs", () => {
  assert.equal(introductionSentenceCount([
    "Before the title.", "# Package", "First. Second!", "Third?", "Fourth.",
    "![Image.](./image.svg)", "Inspired by [another project](https://example.com). Read it.",
    "## Use", "Not part of the introduction.",
  ].join("\n\n")), 4);
  assert.equal(introductionSentenceCount('# Package\n\n"Read." Use `a.b. c.`.\n\n![Image](./image.svg)'), 2);
});

const canonical = headings(join(repoRoot, "extensions", "README-template.md"));

for (const { directory } of extensions) {
  test(`${directory} README introduction has at most three sentences`, () => {
    const count = introductionSentenceCount(readFileSync(join(repoRoot, "extensions", directory, "README.md"), "utf8"));
    assert.ok(count <= 3, `Introduction has ${count} sentences; maximum 3. Keep attribution in an "Inspired by" paragraph.`);
  });
  test(`${directory} README uses only canonical H2 headings in order`, () => {
    const actual = headings(join(repoRoot, "extensions", directory, "README.md"));
    assert.deepEqual(actual, canonical.filter((heading) => actual.includes(heading)),
      "Follow extensions/README-template.md; place package-specific topics under a canonical H2 using H3.");
  });
}

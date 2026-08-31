import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inlineRelativeSvgImages,
  linkRelativeImagesToGitHub,
  linkRelativeMarkdownToGitHub,
} from "./repository-markdown.ts";

test("inlines a README-local SVG using its target, not its alt text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-svg-"));
  try {
    const docs = join(root, "extensions", "pi-subagent", "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "delegate-flow.svg"), "<svg/>");

    assert.equal(
      await inlineRelativeSvgImages(
        "![Delegate Flow lifecycle](./docs/delegate-flow.svg)",
        "extensions/pi-subagent/README.md",
        root
      ),
      "![Delegate Flow lifecycle](data:image/svg+xml;base64,PHN2Zy8+)"
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("links relative images to raw GitHub files", () => {
  assert.equal(
    linkRelativeImagesToGitHub(
      "![Flow](./docs/delegate-flow.svg)",
      "extensions/pi-subagent/README.md"
    ),
    "![Flow](https://raw.githubusercontent.com/HenryQW/pi-harness/main/extensions/pi-subagent/docs/delegate-flow.svg)"
  );
  assert.equal(
    linkRelativeImagesToGitHub(
      "![Dependencies](./docs/extension-dependency-graph.svg)",
      "README.md"
    ),
    "![Dependencies](https://raw.githubusercontent.com/HenryQW/pi-harness/main/docs/extension-dependency-graph.svg)"
  );
});

test("links extension Markdown files to GitHub", () => {
  const markdown = [
    "[orchestration](./docs/orchestration.md#delegation-fields)",
    "[role](./examples/roles/reviewer.md)",
    "[skill](./skills/pi-subagent-delegated-development/SKILL.md)",
  ].join("\n");

  assert.equal(
    linkRelativeMarkdownToGitHub(markdown, "extensions/pi-subagent/README.md"),
    [
      "[orchestration](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/docs/orchestration.md#delegation-fields)",
      "[role](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/examples/roles/reviewer.md)",
      "[skill](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/skills/pi-subagent-delegated-development/SKILL.md)",
    ].join("\n")
  );
});

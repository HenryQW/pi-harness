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
    const docs = join(root, "extensions", "example", "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "architecture.svg"), "<svg/>");

    assert.equal(
      await inlineRelativeSvgImages(
        "![Package architecture](./docs/architecture.svg)",
        "extensions/example/README.md",
        root
      ),
      "![Package architecture](data:image/svg+xml;base64,PHN2Zy8+)"
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("links relative images to raw GitHub files", () => {
  assert.equal(
    linkRelativeImagesToGitHub(
      "![Architecture](./docs/architecture.svg)",
      "extensions/example/README.md"
    ),
    "![Architecture](https://raw.githubusercontent.com/HenryQW/pi-harness/main/extensions/example/docs/architecture.svg)"
  );
});

test("links extension Markdown files to GitHub", () => {
  const markdown = [
    "[orchestration](./docs/orchestration.md#delegation-fields)",
    "[role](./examples/roles/reviewer.md)",
    "[context](./CONTEXT.md)",
  ].join("\n");

  assert.equal(
    linkRelativeMarkdownToGitHub(markdown, "extensions/pi-subagent/README.md"),
    [
      "[orchestration](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/docs/orchestration.md#delegation-fields)",
      "[role](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/examples/roles/reviewer.md)",
      "[context](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/CONTEXT.md)",
    ].join("\n")
  );
});

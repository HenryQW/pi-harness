import assert from "node:assert/strict";
import test from "node:test";

import { linkRelativeMarkdownToGitHub } from "./repository-markdown.ts";

test("links extension Markdown files to GitHub", () => {
  const markdown = [
    "[orchestration](./docs/orchestration.md#delegation-fields)",
    "[role](./examples/roles/synthesizer.md)",
    "[skill](./skills/pi-subagent-delegated-development/SKILL.md)",
  ].join("\n");

  assert.equal(
    linkRelativeMarkdownToGitHub(markdown, "extensions/pi-subagent/README.md"),
    [
      "[orchestration](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/docs/orchestration.md#delegation-fields)",
      "[role](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/examples/roles/synthesizer.md)",
      "[skill](https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/skills/pi-subagent-delegated-development/SKILL.md)",
    ].join("\n")
  );
});

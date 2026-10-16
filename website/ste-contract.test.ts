import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { catalog, repoRoot } from "./extension-catalog.ts";
import { checkSte, parseAvoidTerms } from "./ste.ts";

const readmes = [
  { directory: "root", path: "README.md" },
  ...catalog.map((item) => ({
    directory: item.directory,
    path: `${Object.hasOwn(item, "pi") ? "extensions" : "packages"}/${item.directory}/README.md`,
  })),
];

for (const { directory, path } of readmes) {
  test(`ste: ${directory} README`, () => {
    let context = "";
    if (directory !== "root") {
      try {
        context = readFileSync(join(repoRoot, dirname(path), "CONTEXT.md"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const issues = checkSte(readFileSync(join(repoRoot, path), "utf8"), { avoidTerms: parseAvoidTerms(context) });
    assert.equal(issues.length, 0, issues.map(({ line, rule, message }) => `${path}:${line} ${rule}: ${message}`).join("\n"));
  });
}

const check = (markdown: string) => checkSte(markdown, { avoidTerms: [] });
const words = (count: number) => Array(count).fill("word").join(" ");

test("ste checker: sentence and paragraph limits include only prose words", () => {
  assert.deepEqual(check(`${words(25)}.\n\n${"Short. ".repeat(6)}`), []);
  assert.deepEqual(check(`${words(26)}.\n\n${"Short. ".repeat(7)}`).map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: "sentence-length" },
    { line: 3, rule: "paragraph-length" },
  ]);
  assert.deepEqual(check(`${words(24)} \\! \\? — \\.`), []);
  assert.deepEqual(check(`${words(25)}! ${words(25)}? ${words(25)}.`), []);
  assert.deepEqual(check('"Read." '.repeat(7)).map(({ rule }) => rule), ["paragraph-length"]);
});

test("ste checker: ordered procedures use 20 words and reject passive forms", () => {
  const markdown = [
    `1. ${words(20)}.`,
    `2. ${words(21)}.`,
    "3. The file is quickly written. It was built. Be prepared.",
    "4. The file is not deleted. It isn't saved.",
    "   - The file is saved.",
    "",
    "The file is saved.",
    "",
    "- The file is saved.",
  ].join("\n");
  assert.deepEqual(check(markdown).map(({ line, rule }) => ({ line, rule })), [
    { line: 2, rule: "sentence-length" },
    { line: 3, rule: "passive-procedure" },
    { line: 3, rule: "passive-procedure" },
    { line: 3, rule: "passive-procedure" },
    { line: 4, rule: "passive-procedure" },
    { line: 4, rule: "passive-procedure" },
    { line: 5, rule: "passive-procedure" },
  ]);
  assert.deepEqual(check("1. Save the file. The file is new.\n2. Use `is written` as text.\n3. Make sure that the indicator is red."), []);
});

test("ste checker: code, HTML, images, and link targets do not supply prose", () => {
  const markdown = [
    "```text", "Please ensure it is saved.", "```", "",
    "<div>Please ensure it is saved.</div>", "",
    "![Please ensure](https://example.com/via)", "",
    `1. ${words(19)} \`Please ensure. It is saved.\`.`, "",
    "[Read this](https://example.com/please) and `ensure` it works.", "",
    "![please][image]", "", "[image]: https://example.com/ensure", "",
    "[Please](https://example.com/ensure) read this.",
  ].join("\n");
  assert.deepEqual(check(markdown), [
    { line: 17, rule: "unapproved-word", message: '"Please" is not approved STE; use delete it' },
  ]);
});

test("ste checker: headings and table cells use word rules, not length limits", () => {
  const markdown = [
    `# ${words(26)} via`, "",
    "| Name | Text |", "| --- | --- |",
    `| Ensure | ${words(26)}. ${"Short. ".repeat(7)} |`,
  ].join("\n");
  assert.deepEqual(check(markdown).map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: "unapproved-word" },
    { line: 5, rule: "unapproved-word" },
  ]);
});

test("ste checker: word boundaries, inflections, and inline phrases retain source lines", () => {
  const markdown = [
    "Utilizes, utilising, leveraged, leveraging, ensured, ensuring, attempted, attempting, assists, facilitates, commenced, obtaining.",
    "Use this in **order**", "to proceed via a link, e.g. this one.",
    "Deviation, attemptsLog, and elsewhere are valid.",
  ].join("\n\n");
  const issues = check(markdown).filter(({ rule }) => rule === "unapproved-word");
  assert.equal(issues.length, 14); // The blank line prevents a cross-paragraph phrase match.
  assert.deepEqual(issues.slice(-2), [
    { line: 5, rule: "unapproved-word", message: '"via" is not approved STE; use through, with, or by' },
    { line: 5, rule: "unapproved-word", message: '"e.g." is not approved STE; use for example' },
  ]);
  assert.deepEqual(check("Use this in **order**\nto proceed."), [
    { line: 1, rule: "unapproved-word", message: '"in order\nto" is not approved STE; use to' },
  ]);
});

test("ste checker: context definitions override avoid entries before and after them", () => {
  const terms = parseAvoidTerms([
    "**Display title**:",
    "_Avoid_: SEMANTIC BRANCH, old title",
    "**Semantic branch**:",
    "_Avoid_: display TITLE, old branch",
  ].join("\n"));
  assert.deepEqual(terms, [
    { term: "old title", approved: "Display title" },
    { term: "old branch", approved: "Semantic branch" },
  ]);
});

test("ste checker: context terms use the nearest bold term and only short phrases", () => {
  const terms = parseAvoidTerms([
    "_Avoid_: orphan term", "**First term**:",
    "_Avoid_: single, two words, three short words, four very short words, five words are too many, invalid (term), **not a term**",
    "**Second term**:", "_Avoid_: old-name v2/path, old option",
  ].join("\n"));
  assert.deepEqual(terms, [
    { term: "two words", approved: "First term" },
    { term: "three short words", approved: "First term" },
    { term: "four very short words", approved: "First term" },
    { term: "old-name v2/path", approved: "Second term" },
    { term: "old option", approved: "Second term" },
  ]);
  assert.deepEqual(checkSte("Use TWO **WORDS**.\n\nUse old options or `old option`.\n\nUse old-name v2/path.", { avoidTerms: terms }), [
    { line: 1, rule: "avoid-term", message: '"TWO WORDS" is an avoided term; use "First term"' },
    { line: 5, rule: "avoid-term", message: '"old-name v2/path" is an avoided term; use "Second term"' },
  ]);
});

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

type AvoidTerm = { term: string; approved: string };
type Issue = { line: number; rule: string; message: string };
type Node = {
  type: string;
  value?: string;
  ordered?: boolean | null;
  children?: Node[];
  position?: { start: { line: number } };
};

export function parseAvoidTerms(markdown: string): AvoidTerm[] {
  const terms: AvoidTerm[] = [];
  const defined = new Set<string>();
  let approved = "";
  for (const line of markdown.split(/\r?\n/)) {
    const avoid = line.match(/^\s*_Avoid_:\s*(.*)$/);
    if (!avoid) {
      for (const match of line.matchAll(/\*\*([^*]+)\*\*/g)) {
        approved = match[1];
        defined.add(approved.toLowerCase());
      }
      continue;
    }
    if (!approved) continue;
    for (const entry of avoid[1].split(",")) {
      const term = entry.trim();
      const words = term.split(/ +/).length;
      if (/^[a-z\d /-]+$/i.test(term) && words >= 2 && words <= 4) {
        terms.push({ term, approved });
      }
    }
  }
  return terms.filter(({ term }) => !defined.has(term.toLowerCase()));
}

const unapproved = [
  ["utili[sz](?:e[sd]?|ing)", "use"],
  ["leverag(?:e[sd]?|ing)", "use"],
  ["ensur(?:e[sd]?|ing)", "make sure"],
  ["in\\s+order\\s+to", "to"],
  ["prior\\s+to", "before"],
  ["via", "through, with, or by"],
  ["e\\.g\\.", "for example"],
  ["i\\.e\\.", "that is"],
  ["etc\\.", "name all items"],
  ["whilst", "while"],
  ["thus|hence", "so"],
  ["simply|please", "delete it"],
  ["attempt(?:s|ed|ing)?", "try"],
  ["facilitate|assist", "help"],
  ["obtain", "get"],
  ["commence", "start"],
  ["a\\s+number\\s+of", "some or several"],
  ["in\\s+the\\s+event\\s+that", "if"],
  ["due\\s+to\\s+the\\s+fact\\s+that", "because"],
];

function wholePhrase(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, "giu");
}

// Keep a source line for each character, including text across inline markup.
function prose(node: Node): { text: string; lines: number[] } {
  if (["code", "html", "image", "imageReference"].includes(node.type)) return { text: "", lines: [] };
  if (node.children) {
    const parts = node.children.map(prose);
    return { text: parts.map((part) => part.text).join(""), lines: parts.flatMap((part) => part.lines) };
  }
  const text = node.type === "inlineCode" ? "\uFFFC" : node.type === "break" ? "\n" : node.value ?? "";
  let line = node.position!.start.line;
  const lines = text.split("").map((character) => {
    const current = line;
    if (character === "\n") line++;
    return current;
  });
  return { text, lines };
}

export function checkSte(markdown: string, options: { avoidTerms: AvoidTerm[] }): Issue[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const issues: Issue[] = [];
  const wordRules = [
    ...unapproved.map(([pattern, approved]) => ({
      pattern: wholePhrase(pattern), rule: "unapproved-word",
      message: (word: string) => `"${word}" is not approved STE; use ${approved}`,
    })),
    ...options.avoidTerms.map(({ term, approved }) => ({
      pattern: wholePhrase(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s+")),
      rule: "avoid-term",
      message: (word: string) => `"${word}" is an avoided term; use "${approved}"`,
    })),
  ];

  function visit(node: Node, procedure = false): void {
    if (["paragraph", "heading", "tableCell"].includes(node.type)) {
      const { text, lines } = prose(node);
      const report = (index: number, rule: string, message: string) => {
        issues.push({ line: lines[index] ?? node.position!.start.line, rule, message });
      };
      for (const { pattern, rule, message } of wordRules) {
        for (const match of text.matchAll(pattern)) report(match.index, rule, message(match[0]));
      }
      if (procedure) {
        const passive = wholePhrase("(?:am|is|are|was|were|be|been|being)\\s+(?:[a-z]+ly\\s+)?(?:[a-z]+ed|built|chosen|done|given|known|made|shown|sent|taken|written)");
        for (const match of text.matchAll(passive)) {
          report(match.index, "passive-procedure", `"${match[0]}" is passive in a procedure; use active voice`);
        }
      }
      if (node.type === "paragraph") {
        const sentences = text.split(/(?<=[.!?])(?=\s|$)/);
        let offset = 0;
        let count = 0;
        for (const sentence of sentences) {
          const words = (sentence.match(/\S+/g) ?? []).filter((word) => /[\p{L}\p{N}\uFFFC]/u.test(word)).length;
          if (words) count++;
          const max = procedure ? 20 : 25;
          if (words > max) {
            report(offset + sentence.search(/\S/), "sentence-length",
              `Sentence has ${words} words; maximum ${max}: ${sentence.trim().replaceAll("\uFFFC", "[code]")}`);
          }
          offset += sentence.length;
        }
        if (count > 6) report(0, "paragraph-length", `Paragraph has ${count} sentences; maximum 6`);
      }
      return;
    }
    for (const child of node.children ?? []) visit(child, procedure || (node.type === "list" && node.ordered === true));
  }
  visit(tree);
  return issues.sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule));
}

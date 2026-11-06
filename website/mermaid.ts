import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BlumeConfig } from "blume";

type CodeNode = { lang?: string | null; value: string };
type Context = { replaceNode: (node: CodeNode, replacement: { type: "html"; value: string }) => void };
type Integration = NonNullable<BlumeConfig["integrations"]>[number];

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

// Use a raw node, not a component node, so README files keep Markdown semantics.
export const mermaidFencePlugin = {
  // Astro caches rendered Markdown; include this plugin's source in its cache identity.
  name: `docs-mermaid:${createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex")}`,
  code(node: CodeNode, context: Context) {
    if (node.lang !== "mermaid") return;
    context.replaceNode(node, {
      type: "html",
      value: `<docs-mermaid class="not-prose"><div class="mermaid-output" role="region" aria-label="Diagram" tabindex="0" hidden></div><p role="status" hidden>Cannot show this diagram. Read the source below.</p><details><summary>Diagram source</summary><pre tabindex="0"><code>${escapeHtml(node.value)}</code></pre></details></docs-mermaid>`,
    });
  },
};

export const mermaid = (): Integration => ({
  name: "docs-mermaid",
  hooks: {
    "astro:config:setup": ({ config, injectScript, updateConfig }) => {
      const processor = config.markdown.processor;
      if (processor?.name !== "satteri") {
        throw new Error("Mermaid diagrams require Blume's Satteri Markdown processor.");
      }
      const options = processor.options as { mdastPlugins: typeof mermaidFencePlugin[] };
      options.mdastPlugins.push(mermaidFencePlugin);
      // Prepare Mermaid's dependencies before its first lazy import.
      updateConfig({ vite: { optimizeDeps: { include: ["mermaid"] } } });
      const client = fileURLToPath(new URL("./mermaid-client.ts", import.meta.url));
      injectScript("page", `import { registerMermaid } from ${JSON.stringify(client)}; registerMermaid();`);
    },
  },
});

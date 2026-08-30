import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineConfig } from "blume";
import type { ContentSource } from "blume/sources/types.ts";

const repoRoot = join(import.meta.dirname, "..");
const packageNames = readdirSync(join(repoRoot, "packages"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const docs = [
  { editPath: "README.md", path: join(repoRoot, "README.md"), ref: "index.md" },
  ...packageNames.map((name) => ({
    editPath: `packages/${name}/README.md`,
    path: join(repoRoot, "packages", name, "README.md"),
    ref: `packages/${name}/index.md`,
  })),
];
const docsByRef = new Map(docs.map((doc) => [doc.ref, doc]));
const readDoc = async ({ path, ref }: (typeof docs)[number]) => {
  const text = await readFile(path, "utf8");
  return ref === "index.md"
    ? text.replace("](./example.png)", "](/example.png)")
    : text;
};
const packageDocs: ContentSource = {
  name: "packages",
  staged: true,
  load: async () => ({
    diagnostics: [],
    entries: await Promise.all(
      docs.map(async ({ editPath, ref, ...doc }) => {
        const text = await readDoc({ editPath, ref, ...doc });
        return {
          body: { format: "md" as const, text },
          data: {},
          editUrl: `https://github.com/HenryQW/pi-packages/edit/main/${editPath}`,
          raw: text,
          ref,
        };
      })
    ),
  }),
  read: (ref) => readDoc(docsByRef.get(ref)!),
};

export default defineConfig({
  title: "Pi packages",
  description: "Opinionated Pi extensions by Henry Wang.",
  content: {
    root: ".",
    sources: [{ type: "custom", source: packageDocs }],
  },
  deployment: {
    output: "static",
    site: "https://pi.henry.wang",
  },
  github: {
    owner: "HenryQW",
    repo: "pi-packages",
    dir: "website",
  },
  navigation: {
    sidebar: [
      "/",
      {
        label: "Packages",
        collapsed: false,
        items: packageNames.map((name) => `/packages/${name}`),
      },
    ],
  },
  redirects: [
    {
      from: "/deprecated",
      to: "https://github.com/HenryQW/pi-packages/tree/main/deprecated",
    },
    {
      from: "/docs/releasing",
      to: "https://github.com/HenryQW/pi-packages/blob/main/docs/releasing.md",
    },
    {
      from: "/packages/pi-subagent/docs/orchestration",
      to: "https://github.com/HenryQW/pi-packages/blob/main/packages/pi-subagent/docs/orchestration.md",
    },
    {
      from: "/packages/pi-subagent/docs/adr/001-composable-ephemeral-execution",
      to: "https://github.com/HenryQW/pi-packages/blob/main/packages/pi-subagent/docs/adr/001-composable-ephemeral-execution.md",
    },
    {
      from: "/packages/pi-subagent/examples/roles/scout",
      to: "https://github.com/HenryQW/pi-packages/blob/main/packages/pi-subagent/examples/roles/scout.md",
    },
    {
      from: "/packages/pi-subagent/examples/roles/synthesizer",
      to: "https://github.com/HenryQW/pi-packages/blob/main/packages/pi-subagent/examples/roles/synthesizer.md",
    },
    {
      from: "/packages/pi-subagent/skills/pi-subagent-delegated-development/SKILL",
      to: "https://github.com/HenryQW/pi-packages/blob/main/packages/pi-subagent/skills/pi-subagent-delegated-development/SKILL.md",
    },
  ],
  search: { provider: "orama" },
  ai: { llmsTxt: true },
  theme: { accent: "blue", radius: "sm" },
});

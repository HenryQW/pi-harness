import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineConfig } from "blume";
import type { ContentSource } from "blume/sources/types.ts";

import { packages, repoRoot } from "./package-catalog.ts";
const docs = [
  {
    data: {
      seo: {
        description: "Repository notes, package relationships, and development commands.",
      },
      title: "Repository overview",
    },
    editPath: "README.md",
    path: join(repoRoot, "README.md"),
    ref: "index.md",
    slug: "overview",
  },
  ...packages.map(({ description, directory, name }) => ({
    data: { seo: { description }, title: name },
    editPath: `packages/${directory}/README.md`,
    path: join(repoRoot, "packages", directory, "README.md"),
    ref: `packages/${directory}/index.md`,
    slug: `packages/${directory}`,
  })),
];
const docsByRef = new Map(docs.map((doc) => [doc.ref, doc]));
const readDoc = async ({ editPath, path }: (typeof docs)[number]) => {
  const text = (await readFile(path, "utf8")).replace(/^# .+\n+/, "");
  return editPath === "README.md"
    ? text.replace(/\]\(\.\/([^)]+)\)/g, (_, target: string) =>
        `](/${target.replace(/\.md$/, "")})`
      )
    : text;
};
const packageDocs: ContentSource = {
  name: "packages",
  staged: true,
  load: async () => ({
    diagnostics: [],
    entries: await Promise.all(
      docs.map(async ({ data, editPath, ref, slug, ...doc }) => {
        const text = await readDoc({ data, editPath, ref, slug, ...doc });
        const raw = `---\ntitle: ${JSON.stringify(data.title)}\nseo:\n  description: ${JSON.stringify(data.seo.description)}\n---\n\n${text}`;
        return {
          body: { format: "md" as const, text },
          data,
          editUrl: `https://github.com/HenryQW/pi-packages/edit/main/${editPath}`,
          raw,
          ref,
          slug,
        };
      })
    ),
  }),
  read: (ref) => {
    const doc = docsByRef.get(ref);
    if (!doc) throw new Error(`Unknown documentation ref: ${ref}`);
    return readDoc(doc);
  },
};

export default defineConfig({
  title: "Henry Pi Harness",
  description: "Documentation for Henry Wang's Pi extensions.",
  logo: { image: "/favicon.ico", text: "Henry Pi Harness" },
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
      "/overview",
      {
        label: "Packages",
        collapsed: false,
        items: packages.map(({ directory }) => `/packages/${directory}`),
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
  seo: {
    og: {
      description: "Built on Pi. Tuned by Henry.",
      logo: "/og-logo.svg",
      palette: {
        accent: "#1d4ed8",
        background: "#101828",
        border: "#394152",
        foreground: "#f0eee9",
        muted: "#cdd1d9",
      },
    },
  },
  ai: { llmsTxt: true },
  theme: {
    accent: "#1d4ed8",
    background: { dark: "#101828", light: "#f0eee9" },
    fonts: { body: "geist", display: "geist", mono: "geist-mono" },
    radius: "sm",
  },
});

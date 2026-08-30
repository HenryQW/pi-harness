import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineConfig } from "blume";
import type { ContentSource } from "blume/sources/types.ts";

import { extensions, repoRoot } from "./extension-catalog.ts";
import { npmBadgeUrl } from "./npm-badge.ts";

const docs = [
  {
    data: {
      seo: {
        description: "Repository notes, extension relationships, and development commands.",
      },
      title: "Repository overview",
    },
    editPath: "README.md",
    npm: null,
    path: join(repoRoot, "README.md"),
    ref: "index.md",
    slug: "overview",
  },
  ...extensions.map(({ description, directory, name, version }) => ({
    data: { seo: { description }, title: name },
    editPath: `extensions/${directory}/README.md`,
    npm: { name, version },
    path: join(repoRoot, "extensions", directory, "README.md"),
    ref: `extensions/${directory}/index.md`,
    slug: `extensions/${directory}`,
  })),
];
const docsByRef = new Map(docs.map((doc) => [doc.ref, doc]));
const readDoc = async ({ editPath, npm, path }: (typeof docs)[number]) => {
  const text = (await readFile(path, "utf8")).replace(/^# .+\n+/, "");
  if (editPath === "README.md") {
    return text.replace(/\]\(\.\/([^)]+)\)/g, (_, target: string) => {
      const route = target.replace(/\.md$/, "");
      return `](/${route})`;
    });
  }

  if (!npm) return text;
  const npmUrl = `https://www.npmjs.com/package/${npm.name}`;
  const badgeUrl = npmBadgeUrl(npm.name).replaceAll("&", "&amp;");
  const imageUrl = `https://raw.githubusercontent.com/HenryQW/pi-harness/main/${editPath.replace(/README\.md$/, "example.png")}`;
  const stats = `<div class="not-prose my-6 flex flex-wrap items-center gap-3"><span class="text-sm text-muted-foreground">v${npm.version}</span><a href="${npmUrl}" aria-label="View ${npm.name} on npm"><img alt="Monthly npm downloads" height="20" src="${badgeUrl}" width="144"></a></div>`;
  return `${stats}\n\n${text.replaceAll("](./example.png)", `](${imageUrl})`)}`;
};
const extensionDocs: ContentSource = {
  name: "extensions",
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
          editUrl: `https://github.com/HenryQW/pi-harness/edit/main/${editPath}`,
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
    sources: [{ type: "custom", source: extensionDocs }],
  },
  deployment: {
    output: "static",
    site: "https://pi.henry.wang",
  },
  github: {
    owner: "HenryQW",
    repo: "pi-harness",
    dir: "website",
  },
  navigation: {
    sidebar: [
      "/overview",
      {
        label: "Extensions",
        collapsed: false,
        items: extensions.map(({ directory }) => `/extensions/${directory}`),
      },
    ],
  },
  redirects: [
    {
      from: "/deprecated",
      to: "https://github.com/HenryQW/pi-harness/tree/main/deprecated",
    },
    {
      from: "/docs/releasing",
      to: "https://github.com/HenryQW/pi-harness/blob/main/docs/releasing.md",
    },
    {
      from: "/packages/pi-subagent/docs/orchestration",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/docs/orchestration.md",
    },
    {
      from: "/extensions/pi-subagent/docs/orchestration",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/docs/orchestration.md",
    },
    {
      from: "/packages/pi-subagent/docs/adr/001-composable-ephemeral-execution",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/docs/adr/001-composable-ephemeral-execution.md",
    },
    {
      from: "/extensions/pi-subagent/docs/adr/001-composable-ephemeral-execution",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/docs/adr/001-composable-ephemeral-execution.md",
    },
    {
      from: "/packages/pi-subagent/examples/roles/scout",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/examples/roles/scout.md",
    },
    {
      from: "/extensions/pi-subagent/examples/roles/scout",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/examples/roles/scout.md",
    },
    {
      from: "/packages/pi-subagent/examples/roles/synthesizer",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/examples/roles/synthesizer.md",
    },
    {
      from: "/extensions/pi-subagent/examples/roles/synthesizer",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/examples/roles/synthesizer.md",
    },
    {
      from: "/packages/pi-subagent/skills/pi-subagent-delegated-development/SKILL",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/skills/pi-subagent-delegated-development/SKILL.md",
    },
    {
      from: "/extensions/pi-subagent/skills/pi-subagent-delegated-development/SKILL",
      to: "https://github.com/HenryQW/pi-harness/blob/main/extensions/pi-subagent/skills/pi-subagent-delegated-development/SKILL.md",
    },
  ],
  search: { provider: "orama" },
  seo: {
    agentReadability: true,
    og: {
      description: "Built on Pi. Tuned by Henry.",
      logo: "/og-logo.svg",
      palette: {
        accent: "oklch(0.488 0.217 264.4)",
        background: "oklch(0.21 0.034 263.4)",
        border: "oklch(0.949 0.007 88.6 / 0.18)",
        foreground: "oklch(0.949 0.007 88.6)",
        muted: "oklch(0.86 0.012 264.5)",
      },
    },
  },
  ai: {
    llmsTxt: {
      enabled: true,
      openapi: false,
    },
    openInChat: ["claude", "chatgpt", "cursor"],
  },
  theme: {
    accent: {
      dark: "oklch(0.77 0.116 264.4)",
      light: "oklch(0.488 0.217 264.4)",
    },
    background: {
      dark: "oklch(0.21 0.034 263.4)",
      light: "oklch(0.949 0.007 88.6)",
    },
    fonts: { body: "geist", display: "geist", mono: "geist-mono" },
    radius: "sm",
  },
});

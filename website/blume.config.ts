import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineConfig } from "blume";
import type { ContentSource } from "blume/sources/types.ts";

import { extensions, repoRoot } from "./extension-catalog.ts";
import { licenseBadgeUrl, npmBadgeUrl, versionBadgeUrl } from "./npm-badge.ts";
import {
  inlineRelativeSvgImages,
  linkRelativeImagesToGitHub,
  linkRelativeMarkdownToGitHub,
} from "./repository-markdown.ts";

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
  const text = linkRelativeImagesToGitHub(
    await inlineRelativeSvgImages(
      (await readFile(path, "utf8")).replace(/^# .+\n+/, ""),
      editPath,
      repoRoot
    ),
    editPath
  );
  if (editPath === "README.md") {
    return text.replace(/\]\(\.\/([^)]+)\)/g, (_, target: string) => {
      const route = target.replace(/\.md$/, "");
      return `](/${route})`;
    });
  }

  if (!npm) return text;
  const npmUrl = `https://www.npmjs.com/package/${npm.name}`;
  const badgeUrl = npmBadgeUrl(npm.name).replaceAll("&", "&amp;");
  const versionBadge = versionBadgeUrl(npm.version).replaceAll("&", "&amp;");
  const licenseUrl = `https://github.com/HenryQW/pi-harness/blob/main/${editPath.replace(/README\.md$/, "LICENSE")}`;
  const licenseBadge = licenseBadgeUrl(npm.name).replaceAll("&", "&amp;");
  const stats = `<div class="not-prose my-6 flex flex-wrap items-center gap-3"><a href="${npmUrl}" aria-label="View ${npm.name} version v${npm.version} on npm"><img alt="Version v${npm.version}" height="20" src="${versionBadge}" width="96"></a><div class="ml-auto flex flex-wrap items-center justify-end gap-3"><a href="${npmUrl}" aria-label="View ${npm.name} on npm"><img alt="Monthly npm downloads" height="20" src="${badgeUrl}" width="144"></a><a href="${licenseUrl}" aria-label="View the MIT license for ${npm.name}"><img alt="MIT license" height="20" src="${licenseBadge}" width="78"></a></div></div>`;
  const linkedText = linkRelativeMarkdownToGitHub(text, editPath);
  return `${stats}\n\n${linkedText}`;
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
  description: "Focused Pi extensions for memory, subagents, Git workflows, model routing, and better interaction.",
  feedback: false,
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

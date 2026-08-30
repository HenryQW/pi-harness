import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const repository = new URL("https://github.com/HenryQW/pi-harness/blob/main/");
const rawRepository = new URL("https://raw.githubusercontent.com/HenryQW/pi-harness/main/");

export const inlineRelativeSvgImages = async (
  markdown: string,
  editPath: string,
  repoRoot: string
) => {
  const imagePattern = /!\[([^\]]*)\]\((\.{1,2}\/[^)\s]+\.svg)\)/g;
  const targets = [...new Set([...markdown.matchAll(imagePattern)].map(([, , target]) => target))];
  if (!targets.length) return markdown;

  const base = resolve(repoRoot, dirname(editPath));
  const images = new Map(
    await Promise.all(
      targets.map(async (target) => {
        const source = resolve(base, target);
        const sourceRelative = relative(repoRoot, source);
        if (
          sourceRelative === ".." ||
          sourceRelative.startsWith(`..${sep}`) ||
          isAbsolute(sourceRelative)
        ) {
          throw new Error(`SVG image must stay inside the repository: ${target}`);
        }
        return [
          target,
          `data:image/svg+xml;base64,${(await readFile(source)).toString("base64")}`,
        ];
      })
    )
  );

  return markdown.replace(imagePattern, (_, alt: string, target: string) => {
    const image = images.get(target);
    if (!image) throw new Error(`Missing inlined SVG image: ${target}`);
    return `![${alt}](${image})`;
  });
};

export const linkRelativeImagesToGitHub = (markdown: string, editPath: string) => {
  const readme = new URL(editPath, rawRepository);
  return markdown.replace(
    /!\[([^\]]*)\]\((\.\.?\/[^)\s]+)\)/g,
    (_, alt: string, target: string) => `![${alt}](${new URL(target, readme)})`
  );
};

export const linkRelativeMarkdownToGitHub = (markdown: string, editPath: string) => {
  const readme = new URL(editPath, repository);
  return markdown.replace(
    /\]\((\.\.?\/[^)\s]+\.md(?:#[^)\s]+)?)\)/g,
    (_, target: string) => `](${new URL(target, readme)})`
  );
};

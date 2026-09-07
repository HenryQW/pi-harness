import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = join(process.cwd(), "..");

export function collectCatalog(repositoryRoot = repoRoot) {
  return ["extensions", "packages"].flatMap((root) =>
    readdirSync(join(repositoryRoot, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(repositoryRoot, root, entry.name, "package.json")))
      .map((entry) => {
        const directory = entry.name;
        const manifest = JSON.parse(
          readFileSync(join(repositoryRoot, root, directory, "package.json"), "utf8")
        ) as { description: string; name: string; pi?: unknown; private?: boolean; version: string };
        return { directory, ...manifest };
      })
  ).sort((a, b) => a.directory.localeCompare(b.directory));
}

export const catalog = collectCatalog();

export const extensions = catalog.filter((item) => Object.hasOwn(item, "pi"));
export const supportLibraries = catalog.filter((item) => !Object.hasOwn(item, "pi"));
export const homepageExtensions = extensions.filter((extension) => !extension.private);

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = join(process.cwd(), "..");
export const packages = readdirSync(join(repoRoot, "packages"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = entry.name;
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages", directory, "package.json"), "utf8")
    ) as { description: string; name: string; version: string };
    return { directory, ...manifest };
  })
  .sort((a, b) => a.directory.localeCompare(b.directory));

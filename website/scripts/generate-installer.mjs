import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(scriptDir, "..");
const repoRoot = resolve(websiteDir, "..");
const installerPath = join(websiteDir, "public", "install.sh");
const generatedExtensions = /(# BEGIN GENERATED EXTENSIONS\nEXTENSIONS='\n)([\s\S]*?)(\n'\n# END GENERATED EXTENSIONS)/;
const packageName = /^@henryqw\/[a-z0-9][a-z0-9-]*$/;

/**
 * Pi loads installed packages in install order, and boundary handlers run in load order. The root manifest's
 * pi.extensions list sets that order; packages absent from it go last, by name.
 */
export function collectInstallablePackages(root = repoRoot) {
  const extensionsDir = join(root, "extensions");
  const loadOrder = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pi.extensions
    .map((path) => path.split("/")[2]);
  const rank = (directory) => (loadOrder.indexOf(directory) + 1 || loadOrder.length + 1);
  const packages = readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(extensionsDir, entry.name, "package.json")))
    .map((entry) => {
      const manifestPath = join(extensionsDir, entry.name, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.private || !Object.hasOwn(manifest, "pi")) return null;
      if (typeof manifest.name !== "string" || !packageName.test(manifest.name)) {
        throw new Error(`Invalid installable package name in ${manifestPath}`);
      }
      return { directory: entry.name, name: manifest.name };
    })
    .filter(Boolean)
    .sort((a, b) => rank(a.directory) - rank(b.directory) || (a.name < b.name ? -1 : 1));
  const names = packages.map(({ name }) => name);

  if (new Set(names).size !== names.length) {
    throw new Error("Installable package names must be unique.");
  }
  return names;
}

export function renderInstaller(source, names) {
  if (!generatedExtensions.test(source)) {
    throw new Error("install.sh is missing generated extension markers.");
  }
  return source.replace(generatedExtensions, `$1${names.join("\n")}$3`);
}

function main() {
  const source = readFileSync(installerPath, "utf8");
  const output = renderInstaller(source, collectInstallablePackages());
  const check = process.argv.includes("--check");

  if (check) {
    if (output !== source) {
      throw new Error("website/public/install.sh is stale. Run pnpm --filter @henryqw/pi-docs run generate:installer.");
    }
    return;
  }

  if (output !== source) writeFileSync(installerPath, output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(scriptDir, "..");
const repoRoot = resolve(websiteDir, "..");
const installerPath = join(websiteDir, "public", "install.sh");
const generatedExtensions = /(# BEGIN GENERATED EXTENSIONS\nEXTENSIONS='\n)([\s\S]*?)(\n'\n# END GENERATED EXTENSIONS)/;
const packageName = /^@henryqw\/[a-z0-9][a-z0-9-]*$/;

export function collectInstallablePackages(root = repoRoot) {
  const extensionsDir = join(root, "extensions");
  const names = readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = join(extensionsDir, entry.name, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.private || !manifest.pi) return null;
      if (typeof manifest.name !== "string" || !packageName.test(manifest.name)) {
        throw new Error(`Invalid installable package name in ${manifestPath}`);
      }
      return manifest.name;
    })
    .filter(Boolean)
    .sort();

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

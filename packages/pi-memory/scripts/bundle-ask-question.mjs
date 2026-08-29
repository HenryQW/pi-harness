import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-ask-question");
const destination = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@henryqw", "pi-ask-question");
const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const path of ["package.json", ...manifest.files]) {
	await cp(join(packageDir, path), join(destination, path), { recursive: true });
}

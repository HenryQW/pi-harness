import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("published extension relative imports resolve within the package", () => {
	const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: root,
		encoding: "utf8",
	})) as [{ files: { path: string }[] }];
	const files = new Set(pack.files.map(({ path }) => path));
	for (const file of files) {
		if (!file.startsWith("extensions/") || !file.endsWith(".ts")) continue;
		const source = readFileSync(resolve(root, file), "utf8");
		for (const match of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
			const target = relative(root, resolve(root, dirname(file), match[1]!)).split(sep).join("/");
			assert.ok(files.has(target), `${file} imports ${match[1]}, but ${target} is absent from the npm package`);
		}
	}
});

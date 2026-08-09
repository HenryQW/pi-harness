import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const suite = process.argv[2];
const files = suite
	? [join("test", `${suite}.test.ts`)]
	: readdirSync("test").filter((file) => file.endsWith(".test.ts")).sort().map((file) => join("test", file));

if (!files.length || files.some((file) => !existsSync(file))) {
	throw new Error(`Unknown pi-auto-dag test suite: ${suite ?? "(none)"}`);
}

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});

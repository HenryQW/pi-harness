import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { affectedWorkspaces } from "./affected-workspaces.mjs";

const packageManagerExecPath = process.env.npm_execpath;
if (!packageManagerExecPath) throw new Error("Package manager executable is required to run workspace tests.");

const concurrency = 3;
const testArgs = process.argv.slice(2);
let selected = null;
if (testArgs[0] === "--affected") {
	testArgs.shift();
	if (testArgs[0] === "--") testArgs.shift();
	const base = testArgs.shift() ?? "origin/main";
	if (testArgs.length) throw new Error("Usage: pnpm run test:affected [<base-revision>]");
	selected = affectedWorkspaces(base, packageManagerExecPath);
}
const workspaces = ["extensions", "packages"]
	.flatMap((root) => readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(`${root}/${entry.name}/package.json`))
		.map((entry) => JSON.parse(readFileSync(`${root}/${entry.name}/package.json`, "utf8"))))
	.filter((manifest) => manifest.scripts?.test)
	.map((manifest) => manifest.name);

if (!workspaces.length) throw new Error("No workspace test scripts found.");

const prioritizedWorkspaces = ["@henryqw/pi-subagent", "@henryqw/pi-pr"];
const scheduledWorkspaces = [
	...prioritizedWorkspaces.filter((workspace) => workspaces.includes(workspace)),
	...workspaces.filter((workspace) => !prioritizedWorkspaces.includes(workspace)),
].filter((workspace) => selected === null || selected.includes(workspace));
console.log(`Workspace test scripts (${scheduledWorkspaces.length}): ${scheduledWorkspaces.join(", ") || "none"}`);
const failures = [];

function run(workspace) {
	return new Promise((resolve) => {
		const args = ["--filter", workspace, "run", "test"];
		if (testArgs.length) args.push("--", ...testArgs);
		const child = spawn(packageManagerExecPath, args, { stdio: "inherit" });
		child.once("error", (error) => {
			console.error(`Failed to start tests for ${workspace}: ${error.message}`);
			resolve(1);
		});
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

let next = 0;
async function worker() {
	while (next < scheduledWorkspaces.length) {
		const workspace = scheduledWorkspaces[next++];
		const code = await run(workspace);
		if (code !== 0) failures.push({ workspace, code });
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, scheduledWorkspaces.length) }, worker));

if (failures.length) {
	for (const { workspace, code } of failures) {
		console.error(`Workspace test failed: ${workspace} (exit ${code})`);
	}
	process.exitCode = 1;
}

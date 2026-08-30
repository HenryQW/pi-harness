import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const packageManagerExecPath = process.env.npm_execpath;
if (!packageManagerExecPath) throw new Error("Package manager executable is required to run workspace tests.");

const concurrency = 2;
const testArgs = process.argv.slice(2);
const workspaces = readdirSync("extensions", { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => JSON.parse(readFileSync(`extensions/${entry.name}/package.json`, "utf8")))
	.filter((manifest) => manifest.scripts?.test)
	.map((manifest) => manifest.name);

if (!workspaces.length) throw new Error("No workspace test scripts found.");

const prioritizedWorkspaces = ["@henryqw/pi-subagent"];
const scheduledWorkspaces = [
	...prioritizedWorkspaces.filter((workspace) => workspaces.includes(workspace)),
	...workspaces.filter((workspace) => !prioritizedWorkspaces.includes(workspace)),
];
const failures = [];

function run(workspace) {
	return new Promise((resolve) => {
		const args = ["--filter", workspace, "run", "test"];
		if (workspace === "@henryqw/pi-subagent") args.push("--", "--test-concurrency=2", ...testArgs);
		else if (testArgs.length) args.push("--", ...testArgs);
		const child = spawn(process.execPath, [packageManagerExecPath, ...args], { stdio: "inherit" });
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

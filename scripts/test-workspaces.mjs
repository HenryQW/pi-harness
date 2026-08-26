import { spawn, spawnSync } from "node:child_process";

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) throw new Error("npm_execpath is required to run workspace tests.");

const concurrency = 2;
const testArgs = process.argv.slice(2);

const discovery = spawnSync(process.execPath, [npmExecPath, "pkg", "get", "name", "scripts.test", "--workspaces", "--json"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});

if (discovery.error) throw discovery.error;
if (discovery.status !== 0) process.exit(discovery.status ?? 1);

const manifests = JSON.parse(discovery.stdout);
if (!manifests || typeof manifests !== "object" || Array.isArray(manifests)) {
	throw new Error("npm did not return workspace package metadata.");
}

const workspaces = Object.entries(manifests)
	.filter(([, manifest]) => manifest && typeof manifest === "object" && Object.hasOwn(manifest, "scripts.test"))
	.map(([workspace]) => workspace);

if (!workspaces.length) throw new Error("No workspace test scripts found.");

// This suite has sub-100ms timing expectations and must not contend with another workspace runner.
const serialWorkspaces = new Set(["@henryqw/pi-subagent"]);
const serial = workspaces.filter((workspace) => serialWorkspaces.has(workspace));
const parallel = workspaces.filter((workspace) => !serialWorkspaces.has(workspace));
const failures = [];

function run(workspace) {
	return new Promise((resolve) => {
		const args = ["run", "test", "--workspace", workspace];
		if (testArgs.length) args.push("--", ...testArgs);
		const child = spawn(process.execPath, [npmExecPath, ...args], { stdio: "inherit" });
		child.once("error", (error) => {
			console.error(`Failed to start tests for ${workspace}: ${error.message}`);
			resolve(1);
		});
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

for (const workspace of serial) {
	const code = await run(workspace);
	if (code !== 0) failures.push({ workspace, code });
}

let next = 0;
async function worker() {
	while (next < parallel.length) {
		const workspace = parallel[next++];
		const code = await run(workspace);
		if (code !== 0) failures.push({ workspace, code });
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, parallel.length) }, worker));

if (failures.length) {
	for (const { workspace, code } of failures) {
		console.error(`Workspace test failed: ${workspace} (exit ${code})`);
	}
	process.exitCode = 1;
}

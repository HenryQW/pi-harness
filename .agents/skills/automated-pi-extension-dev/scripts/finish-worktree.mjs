import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { withPathLock } from "../../../../packages/pi-herdr/src/path-lock.ts";
import { extensionConfigDir } from "../../../../packages/pi-config-store/src/index.ts";
import { withCommandRemovalGuard } from "../../../../extensions/pi-herdr-tools/internal/command-state.ts";

const [workspace, number] = process.argv.slice(2);
function requireState(condition, message) {
	if (!condition) throw new Error(message);
}
function run(command, args, ...descriptors) {
	return execFileSync(command, args, {
		encoding: "utf8", maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe", ...descriptors],
	}).trimEnd();
}
const within = (path, root) => path === root || path.startsWith(`${root}/`);
function panePath(cwd) {
	requireState(typeof cwd === "string" && isAbsolute(cwd), "Pane directory is not an absolute path; cleanup refused.");
	let ancestor = cwd;
	const suffix = [];
	for (;;) {
		try { return join(realpathSync(ancestor), ...suffix); }
		catch (error) {
			if (error.code !== "ENOENT") throw error;
			// A dangling link is not proof that this pane is unrelated to the checkout.
			try { lstatSync(ancestor); }
			catch (missing) {
				if (missing.code !== "ENOENT" || dirname(ancestor) === ancestor) throw missing;
				suffix.unshift(basename(ancestor));
				ancestor = dirname(ancestor);
				continue;
			}
			throw new Error(`Pane directory cannot be resolved; cleanup refused: ${cwd}`, { cause: error });
		}
	}
}

try {
	requireState(workspace && /^\d+$/.test(number), "Usage: finish-worktree.sh <Herdr workspace id> <merged PR number>");
	// The first record is the primary checkout. --porcelain selects machine-readable output; -z uses null separators.
	const primary = run("git", ["worktree", "list", "--porcelain", "-z"]).split("\0")[0];
	requireState(primary.startsWith("worktree "), "Git returned no primary checkout.");
	const main = realpathSync(primary.slice("worktree ".length));
	// --json selects the returned fields.
	const pr = JSON.parse(run("gh", ["pr", "view", number, "--json", "state,baseRefName,headRefOid,headRefName"]));
	requireState(pr.state === "MERGED", `PR #${number} is not merged`);
	const worktrees = JSON.parse(run("herdr", ["worktree", "list"])).result.worktrees;
	const matches = worktrees.filter((worktree) => worktree.open_workspace_id === workspace);
	requireState(matches.length === 1, `Expected one worktree in workspace ${workspace}`);
	const path = realpathSync(matches[0].path);
	requireState(path !== main, "Refuse to remove the primary checkout.");
	await withPathLock(path, async (descriptor) => {
		const store = join(extensionConfigDir("pi-herdr-tools"), "commands");
		// Lock order is checkout, then command store. Keep publication excluded through removal.
		await withCommandRemovalGuard(store, path, async (storeDescriptor) => {
			// -C selects the checkout; --abbrev-ref returns the branch name.
			const git = (checkout, ...args) => run("git", ["-C", checkout, ...args], descriptor, storeDescriptor);
			requireState(git(main, "rev-parse", "--abbrev-ref", "HEAD") === pr.baseRefName, `PR #${number} did not merge into the primary branch`);
			requireState(git(path, "rev-parse", "--abbrev-ref", "HEAD") === pr.headRefName, `${path} is not on the PR branch`);
			requireState(git(path, "rev-parse", "HEAD") === pr.headRefOid, `${path} HEAD differs from the merged PR head`);
			requireState(!git(path, "status", "--porcelain"), `${path} has uncommitted changes`);
			const agents = JSON.parse(run("herdr", ["agent", "list"], descriptor, storeDescriptor)).result.agents;
			requireState(!agents.some((agent) => agent.workspace_id === workspace && agent.agent_status === "working"), `An agent in ${workspace} is still working`);
			const panes = JSON.parse(run("herdr", ["api", "snapshot"], descriptor, storeDescriptor)).result.snapshot.panes;
			const users = panes.filter((pane) => pane.workspace_id !== workspace &&
				(within(pane.cwd, matches[0].path) || within(panePath(pane.cwd), path)));
			requireState(!users.length, `Panes in other workspaces use ${path}: ${users.map((pane) => pane.pane_id).join(", ")}`);
			git(main, "worktree", "remove", path);
		});
		run("herdr", ["workspace", "close", workspace], descriptor);
	});
	// Never hold the linked-checkout lock while acquiring the primary-checkout lock.
	await withPathLock(main, async (descriptor) => {
		requireState(run("git", ["-C", main, "rev-parse", "--abbrev-ref", "HEAD"], descriptor) === pr.baseRefName, "Primary branch changed; pull refused.");
		// --ff-only refuses a merge commit; -q suppresses progress output; --short sets the displayed hash length.
		run("git", ["-C", main, "pull", "--ff-only", "-q"], descriptor);
		const head = run("git", ["-C", main, "rev-parse", "--short=8", "HEAD"], descriptor);
		console.log(`Done: removed ${path}, closed ${workspace}, ${pr.baseRefName} at ${head}`);
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

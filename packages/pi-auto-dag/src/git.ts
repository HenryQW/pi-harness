import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { commandFailure, commandOutput, runCommand, type CommandRunner } from "./command.ts";

export async function resolveGitTopLevel(
	cwd: string,
	runner: CommandRunner = runCommand,
): Promise<string> {
	const start = resolve(cwd);
	const reportedRoot = await commandOutput(runner, "git", ["rev-parse", "--show-toplevel"], start);
	const canonicalStart = await realpath(start);
	const canonicalRoot = await realpath(resolve(start, reportedRoot));
	const root = resolve(start, relative(canonicalStart, canonicalRoot));
	return await canonicalPath(root) === canonicalRoot ? root : canonicalRoot;
}

export async function inspectIntegrationBranch(
	mainWorktree: string,
	runner: CommandRunner = runCommand,
) {
	return inspectIntegrationBranchAtRoot(await integrationRoot(mainWorktree, runner), runner);
}

export async function inspectIntegrationCandidate(
	mainWorktree: string,
	runner: CommandRunner = runCommand,
) {
	const root = await integrationRoot(mainWorktree, runner);
	const current = await inspectActiveIntegrationWorktreeAtRoot(root, runner);
	const candidate = await inspectIntegrationBranchAtRoot(root, runner, current.branch);
	return { ...current, default_branch: candidate.default_branch };
}

export async function inspectActiveIntegrationWorktree(
	mainWorktree: string,
	runner: CommandRunner = runCommand,
) {
	return inspectActiveIntegrationWorktreeAtRoot(await integrationRoot(mainWorktree, runner), runner);
}

async function integrationRoot(mainWorktree: string, runner: CommandRunner): Promise<string> {
	const root = resolve(mainWorktree);
	if (await realpath(await resolveGitTopLevel(root, runner)) !== await realpath(root)) {
		throw new Error(`Delivery Graph must be started from its main integration worktree: ${root}`);
	}
	return root;
}

async function inspectActiveIntegrationWorktreeAtRoot(root: string, runner: CommandRunner) {
	const dirty = await commandOutput(runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
	if (dirty) throw new Error("Main integration worktree is dirty");
	const branch = await readCurrentBranch(runner, root);
	if (branch === undefined) throw new Error("Main integration worktree is detached");
	return { branch, head: await commandOutput(runner, "git", ["rev-parse", "HEAD"], root) };
}

async function inspectIntegrationBranchAtRoot(root: string, runner: CommandRunner, currentBranch?: string) {
	const integrationBranch = currentBranch ?? await readCurrentBranch(runner, root);
	if (integrationBranch === undefined) throw new Error("Main integration worktree is detached");
	const { name: defaultBranch } = await resolveDefaultBranch(root, runner);
	if (integrationBranch === defaultBranch) {
		throw new Error(`Main integration worktree must not use the default branch: ${defaultBranch}`);
	}
	return { integration_branch: integrationBranch, default_branch: defaultBranch };
}

export async function verifySingleCommit(
	runner: CommandRunner,
	mainWorktree: string,
	worktree: string,
	base: string,
	commit: string,
	label: string,
	baseLabel = "recorded base",
): Promise<string> {
	if (await pathExists(join(worktree, ".context"))) throw new Error(`${label} child worktree must not contain .context`);
	if (await commandOutput(runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], worktree)) {
		throw new Error(`${label} worktree is not clean`);
	}
	const canonical = await commandOutput(runner, "git", ["rev-parse", "--verify", `${commit}^{commit}`], worktree);
	if (await commandOutput(runner, "git", ["rev-parse", "HEAD"], worktree) !== canonical) {
		throw new Error(`${label} requested commit is not worktree HEAD`);
	}
	if ((await commandOutput(runner, "git", ["rev-list", "--parents", "-n", "1", canonical], mainWorktree)).split(/\s+/).length > 2) {
		throw new Error(`${label} commit must not be a merge commit`);
	}
	const ancestorArgs = ["merge-base", "--is-ancestor", base, canonical];
	const ancestor = await runner("git", ancestorArgs, { cwd: mainWorktree });
	if (ancestor.code === 1) {
		throw new Error(`${label} commit is not based on its ${baseLabel}`);
	}
	if (ancestor.code !== 0) throw new Error(commandFailure("git", ancestorArgs, ancestor));
	if (await commandOutput(runner, "git", ["rev-list", "--count", `${base}..${canonical}`], mainWorktree) !== "1") {
		throw new Error(`${label} must contain exactly one commit over its ${baseLabel}`);
	}
	return canonical;
}

export async function readCurrentBranch(runner: CommandRunner, worktree: string): Promise<string | undefined> {
	const args = ["symbolic-ref", "--quiet", "--short", "HEAD"];
	const result = await runner("git", args, { cwd: worktree });
	if (result.code === 1) return undefined;
	if (result.code !== 0) throw new Error(commandFailure("git", args, result));
	const branch = result.stdout.trim();
	if (!branch) throw new Error(`Git reported an empty branch for worktree ${worktree}`);
	return branch;
}

export async function assertAttachedBranch(
	runner: CommandRunner,
	worktree: string,
	expectedBranch: string,
	label: string,
): Promise<void> {
	const actual = await readCurrentBranch(runner, worktree);
	const worktreeLabel = label.endsWith("worktree") ? label : `${label} worktree`;
	if (actual === undefined) throw new Error(`${worktreeLabel} is detached; expected branch ${expectedBranch}`);
	if (actual !== expectedBranch) throw new Error(`${label} branch changed from ${expectedBranch} to ${actual}`);
}

export async function findAppliedCherryPick(
	runner: CommandRunner,
	mainWorktree: string,
	integrationBranch: string,
	previousHead: string,
	commit: string,
	label: string,
): Promise<string | undefined> {
	await assertAttachedBranch(runner, mainWorktree, integrationBranch, label);
	const head = await commandOutput(runner, "git", ["rev-parse", "HEAD"], mainWorktree);
	const message = await commandOutput(runner, "git", ["log", "-1", "--format=%B", head], mainWorktree);
	if (!message.includes(`(cherry picked from commit ${commit})`)) return undefined;
	return (await commandOutput(runner, "git", ["rev-parse", `${head}^`], mainWorktree)) === previousHead ? head : undefined;
}

export async function ensureChildWorktree(
	runner: CommandRunner,
	mainWorktree: string,
	worktree: string,
	branch: string,
	base: string,
	label: string,
): Promise<void> {
	if (!(await pathExists(worktree))) {
		await mkdir(dirname(worktree), { recursive: true });
		const args = await localBranchExists(runner, mainWorktree, branch)
			? ["worktree", "add", worktree, branch]
			: ["worktree", "add", "-b", branch, worktree, base];
		await commandOutput(runner, "git", args, mainWorktree);
	}
	const reportedRoot = await commandOutput(runner, "git", ["-C", worktree, "rev-parse", "--show-toplevel"], mainWorktree);
	if (await canonicalPath(reportedRoot) !== await canonicalPath(worktree)) {
		throw new Error(`${label} worktree is not the recorded child worktree`);
	}
	if (await pathExists(join(worktree, ".context"))) throw new Error(`${label} child worktree must not contain .context`);
	await assertAttachedBranch(runner, worktree, branch, `${label} child worktree`);
}

export async function retireChildWorktree(
	runner: CommandRunner,
	mainWorktree: string,
	worktree: string,
	branch: string,
	label: string,
	beforeRemove?: () => Promise<void>,
): Promise<void> {
	if (await pathExists(worktree)) {
		await beforeRemove?.();
		await assertAttachedBranch(runner, worktree, branch, `${label} child worktree`);
		if (await commandOutput(runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], worktree)) {
			throw new Error(`${label} worktree is dirty; refusing cleanup`);
		}
		try {
			await commandOutput(runner, "git", ["worktree", "remove", worktree], mainWorktree);
		} catch (error) {
			if (!(await worktreeIsAbsent(runner, mainWorktree, worktree))) throw error;
		}
	}
	if (!(await worktreeIsAbsent(runner, mainWorktree, worktree))) {
		throw new Error(`${label} worktree removal could not be confirmed`);
	}
}

export async function deleteExpectedBranch(
	runner: CommandRunner,
	mainWorktree: string,
	branch: string,
	expectedCommit: string,
	label: string,
): Promise<void> {
	if (!(await localBranchExists(runner, mainWorktree, branch))) return;
	const ref = localBranchRef(branch);
	if (await commandOutput(runner, "git", ["rev-parse", "--verify", ref], mainWorktree) !== expectedCommit) {
		throw new Error(`${label} branch no longer points to its reviewed commit`);
	}
	try {
		await commandOutput(runner, "git", ["branch", "-D", "--", branch], mainWorktree);
	} catch (error) {
		if (await localBranchExists(runner, mainWorktree, branch)) throw error;
		return;
	}
	if (await localBranchExists(runner, mainWorktree, branch)) {
		throw new Error(`${label} branch deletion could not be confirmed`);
	}
}

async function resolveDefaultBranch(root: string, runner: CommandRunner): Promise<{ name: string; ref: string }> {
	const remoteArgs = ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"];
	const remoteHead = await runner("git", remoteArgs, { cwd: root });
	if (remoteHead.code === 0) {
		const ref = remoteHead.stdout.trim();
		const prefix = "refs/remotes/origin/";
		const name = ref.slice(prefix.length);
		if (name && ref.startsWith(prefix)) return { name, ref };
		throw new Error(`Invalid origin HEAD symbolic ref: ${ref}`);
	}
	if (remoteHead.code !== 1) throw new Error(commandFailure("git", remoteArgs, remoteHead));

	for (const candidate of ["main", "master"]) {
		const args = ["show-ref", "--verify", "--quiet", localBranchRef(candidate)];
		const result = await runner("git", args, { cwd: root });
		if (result.code === 0) return { name: candidate, ref: localBranchRef(candidate) };
		if (result.code !== 1) throw new Error(commandFailure("git", args, result));
	}
	throw new Error("Cannot determine the repository default branch");
}

async function localBranchExists(runner: CommandRunner, mainWorktree: string, branch: string): Promise<boolean> {
	const args = ["show-ref", "--verify", "--quiet", localBranchRef(branch)];
	const result = await runner("git", args, { cwd: mainWorktree });
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new Error(commandFailure("git", args, result));
}

async function worktreeIsAbsent(runner: CommandRunner, mainWorktree: string, worktree: string): Promise<boolean> {
	if (await pathExists(worktree)) return false;
	const expected = await canonicalPath(worktree);
	const worktrees = (await commandOutput(runner, "git", ["worktree", "list", "--porcelain"], mainWorktree))
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
	return !(await Promise.all(worktrees.map(async (path) => await canonicalPath(path)))).includes(expected);
}

function localBranchRef(branch: string): string {
	return `refs/heads/${branch}`;
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		try {
			return join(await realpath(dirname(path)), basename(path));
		} catch {
			return resolve(path);
		}
	}
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

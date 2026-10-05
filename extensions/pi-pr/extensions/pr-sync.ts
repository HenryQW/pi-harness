import { spawnBounded, type Exec, type ExecOptions } from "@henryqw/pi-process";
import { cloneCurrentPullRequest, loadCurrentPullRequest, samePullRequestSnapshot, type CurrentPullRequest } from "./pr-github.ts";
import {
	extensionExecApi,
	inspectWorktreeState,
	isAncestor,
	parseSingleOutputLine,
	readHead,
	requiredOid,
	runChecked,
	withWorktreeLock,
} from "./pr-execution.ts";

export type SyncLocalHeadOptions = {
	cwd: string;
	authority: CurrentPullRequest;
	signal?: AbortSignal;
	agentDir?: string;
	exec?: Exec;
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
};

export type SyncLocalHeadResult = { kind: "fast-forwarded" | "rebased" | "unchanged"; head: string };

/**
 * Bring the local branch up to the published PR head without pushing.
 * Behind: fast-forward (Git refuses when local changes overlap). Diverged and
 * clean: rebase local commits onto the PR head; a conflict aborts back to the
 * original HEAD. Never stashes, resets, or rewrites the remote.
 */
export async function syncLocalHead(options: SyncLocalHeadOptions): Promise<SyncLocalHeadResult> {
	const authority = cloneCurrentPullRequest(options.authority);
	if (authority.lifecycle !== "open" || authority.target.provenance !== "configured") {
		throw new Error("Local sync requires a configured open pull request");
	}
	const exec = options.exec ?? spawnBounded;
	const load = options.loadCurrentPullRequest ?? loadCurrentPullRequest;
	const execOptions: ExecOptions = { cwd: options.cwd, signal: options.signal };
	const target = authority.head.oid;
	return await withWorktreeLock(options.cwd, async () => {
		const discovery = await load(extensionExecApi(exec, options.cwd, options.signal), { cwd: options.cwd, signal: options.signal });
		if (discovery.kind !== "current" || !samePullRequestSnapshot(authority, discovery.pullRequest)) {
			throw new Error("Local sync cancelled: PR identity or remote head changed");
		}
		const branch = parseSingleOutputLine((await runChecked(exec, "git", ["branch", "--show-current"], execOptions)).stdout, "current branch");
		if (branch !== authority.target.branch) throw new Error("Local sync cancelled: current branch changed");
		const worktree = await inspectWorktreeState(exec, execOptions);
		if (worktree === "operation") throw new Error("Local sync cancelled: a Git operation is in progress");
		await runChecked(exec, "git", [
			"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", authority.headFetchSource, target,
		], execOptions);
		await runChecked(exec, "git", ["cat-file", "-e", `${target}^{commit}`], execOptions);
		const head = await readHead(exec, execOptions);
		if (head === target || await isAncestor(exec, execOptions, target, head)) return { kind: "unchanged", head };
		if (await isAncestor(exec, execOptions, head, target)) {
			const merge = await exec("git", ["merge", "--ff-only", target], execOptions);
			if (merge.killed) throw new Error("git merge --ff-only was killed; its outcome is unknown");
			if (merge.code !== 0) {
				throw new Error(`Local changes overlap the PR head update; commit or move them, then run /pr: ${merge.stderr.trim() || merge.stdout.trim()}`);
			}
			return { kind: "fast-forwarded", head: await verifySynced(exec, execOptions, target) };
		}
		if (worktree !== "clean") throw new Error("Local sync cancelled: diverged local commits need a clean worktree");
		const mergeBase = requiredOid(parseSingleOutputLine((await runChecked(exec, "git", ["merge-base", target, head], execOptions)).stdout, "sync fork point"), "sync fork point");
		const mergeCommits = (await runChecked(exec, "git", ["rev-list", "--max-count=1", "--min-parents=2", `${mergeBase}..${head}`], execOptions)).stdout.trim();
		if (mergeCommits) throw new Error("Local sync cannot rebase local merge commits onto the PR head; rebase manually");
		const rebase = await exec("git", ["-c", "core.editor=true", "-c", "rebase.updateRefs=false", "rebase", "--no-autostash", target], execOptions);
		if (rebase.killed) throw new Error("git rebase was killed; its outcome is unknown");
		if (rebase.code !== 0) {
			await runChecked(exec, "git", ["rebase", "--abort"], execOptions);
			if (await readHead(exec, execOptions) !== head) throw new Error("Local sync aborted a conflicting rebase but HEAD did not return to the original commit");
			throw new Error(`Local commits conflict with the PR head; rebase manually: ${rebase.stderr.trim() || rebase.stdout.trim()}`);
		}
		return { kind: "rebased", head: await verifySynced(exec, execOptions, target) };
	}, { agentDir: options.agentDir, signal: options.signal });
}

async function verifySynced(exec: Exec, execOptions: ExecOptions, target: string): Promise<string> {
	const head = await readHead(exec, execOptions);
	if (!(await isAncestor(exec, execOptions, target, head)) || await inspectWorktreeState(exec, execOptions) === "operation") {
		throw new Error("Local sync did not leave a branch descended from the PR head");
	}
	return head;
}

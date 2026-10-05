import type { PrRun } from "./pr-run.ts";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import { cloneCurrentPullRequest, loadCurrentPullRequest, readValidatedRemoteAuthority, samePullRequestSnapshot, type CurrentPullRequest } from "./pr-github.ts";
import { extensionExecApi, inspectWorktree, inspectWorktreeState, isAncestor, parseNulPaths, parseStatusSnapshot, readHead, readRemoteOid, requiredText, runChecked, validatePaths, withWorktreeLock } from "./pr-execution.ts";

type Check = { command: string; args: string[] };
type Options = { run?: PrRun; cwd: string; authority: CurrentPullRequest; signal?: AbortSignal; agentDir?: string; exec?: Exec; loadCurrentPullRequest?: typeof loadCurrentPullRequest };

/**
 * One local publication attempt. An uncertain push consumes the run, even when a later read recovers.
 * A dirty branch that diverged from the PR head may inspect and commit; validation and publication
 * still require a descendant HEAD, so the active /pr syncs the committed branch first.
 */
export class PullRequestWorkPublisher {
	private readonly authority: CurrentPullRequest;
	private readonly exec: Exec;
	private readonly load: typeof loadCurrentPullRequest;
	private readonly options: Options;
	private initialHead?: string;
	private status?: string;
	private validatedHead?: string;
	private consumed = false;

	constructor(options: Options) {
		if (options.authority.lifecycle !== "open" || options.authority.target.provenance !== "configured") {
			throw new Error("Local publication requires a configured open pull request");
		}
		if (options.authority.local.head === "behind") {
			throw new Error("Local publication requires a branch that is not behind the published PR head");
		}
		this.options = options;
		this.authority = cloneCurrentPullRequest(options.authority);
		this.exec = options.exec ?? spawnBounded;
		this.load = options.loadCurrentPullRequest ?? loadCurrentPullRequest;
	}

	private execOptions() { return { cwd: this.options.cwd, signal: this.options.signal }; }

	private async authorityCheck(): Promise<void> {
		const { cwd, signal } = this.options;
		const discovery = await this.load(extensionExecApi(this.exec, cwd, signal), { cwd, signal });
		if (discovery.kind !== "current" || !samePullRequestSnapshot(this.authority, discovery.pullRequest)) {
			throw new Error("Local publication cancelled: PR identity or remote head changed");
		}
		const remote = await readValidatedRemoteAuthority(extensionExecApi(this.exec, cwd, signal), { cwd, signal }, this.authority.target.remote);
		if (remote.fetchSource !== this.authority.target.fetchSource || remote.host !== this.authority.target.host ||
			remote.repository.toLowerCase() !== this.authority.target.repository.toLowerCase()) {
			throw new Error("Local publication cancelled: push destination changed");
		}
		if (await readRemoteOid(this.exec, this.execOptions(), this.authority.target.fetchSource, this.authority.target.ref) !== this.authority.head.oid) {
			throw new Error("Local publication cancelled: remote lease changed");
		}
		const branch = requiredText((await runChecked(this.exec, "git", ["branch", "--show-current"], this.execOptions())).stdout.trim(), "current branch");
		if (branch !== this.authority.target.branch) throw new Error("Local publication cancelled: branch changed");
	}

	async inspect(): Promise<{ paths: string[]; head: string; originalHead: string; diverged: boolean }> {
		if (this.consumed) throw new Error("Commit or publication run is consumed; inspect its outcome in a fresh /pr");
		if (this.status !== undefined) throw new Error("Pending changes already inspected");
		return await withWorktreeLock(this.options.cwd, async () => {
			await this.authorityCheck();
			if (await inspectWorktreeState(this.exec, this.execOptions()) === "operation") throw new Error("Git operation in progress");
			const head = await readHead(this.exec, this.execOptions());
			const diverged = !(await isAncestor(this.exec, this.execOptions(), this.authority.head.oid, head));
			const status = (await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions())).stdout;
			const paths = validatePaths([...parseStatusSnapshot(status).keys()], "Pending paths");
			// Clean divergence belongs to local sync; only pending work justifies committing on a diverged HEAD.
			if (diverged && !paths.length) throw new Error("Local HEAD is not a descendant of the published PR head");
			this.initialHead = head;
			this.status = status;
			return { paths, head, originalHead: this.authority.head.oid, diverged };
		}, { agentDir: this.options.agentDir, signal: this.options.signal });
	}

	async commit(pathsInput: string[], message: string): Promise<{ head: string; diverged: boolean }> {
		if (!this.initialHead || this.status === undefined || this.consumed) throw new Error("Pending changes must be inspected first");
		const paths = validatePaths(pathsInput, "Commit paths");
		if (!paths.length || paths.some((path) => !parseStatusSnapshot(this.status!).has(path))) {
			throw new Error("Commit paths must be reviewed pending paths");
		}
		requiredText(message, "commit message");
		return await withWorktreeLock(this.options.cwd, async () => {
			await this.authorityCheck();
			if (await readHead(this.exec, this.execOptions()) !== this.initialHead ||
				await inspectWorktreeState(this.exec, this.execOptions()) === "operation" ||
				(await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions())).stdout !== this.status) {
				throw new Error("Pending changes moved after inspection; inspect again in a new /pr");
			}
			// Never let an already-staged unrelated path enter this commit.
			const staged = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--cached", "--no-renames", "--name-only", "-z"], this.execOptions())).stdout, "Staged paths");
			if (staged.some((path) => !paths.includes(path))) throw new Error("Unrelated staged changes require an ownership decision");
			this.consumed = true;
			await runChecked(this.exec, "git", ["--literal-pathspecs", "add", "-A", "--", ...paths], this.execOptions());
			await runChecked(this.exec, "git", ["commit", "-m", message], this.execOptions());
			const head = await readHead(this.exec, this.execOptions());
			this.initialHead = head;
			this.status = undefined;
			this.validatedHead = undefined;
			this.consumed = false;
			return { head, diverged: !(await isAncestor(this.exec, this.execOptions(), this.authority.head.oid, head)) };
		}, { agentDir: this.options.agentDir, signal: this.options.signal });
	}

	async validate(checks: Check[]): Promise<{ head: string; checks: number }> {
		if (!this.initialHead || this.validatedHead || this.consumed) throw new Error("Local publication validation is unavailable");
		return await withWorktreeLock(this.options.cwd, async () => {
			await this.authorityCheck();
			if (await inspectWorktree(this.exec, this.execOptions()) !== "clean") throw new Error("Unrelated pending changes remain; ask about ownership before publishing");
			const head = await readHead(this.exec, this.execOptions());
			if (!(await isAncestor(this.exec, this.execOptions(), this.authority.head.oid, head))) {
				throw new Error("Local HEAD is not a descendant of the published PR head");
			}
			this.options.run?.beginChecks("publish-work", head, checks);
			try {
				await runChecked(this.exec, "git", ["diff", "--check", this.authority.head.oid, head], this.execOptions());
				for (const check of checks) await runChecked(this.exec, check.command, check.args, this.execOptions());
				await this.authorityCheck();
				if (await readHead(this.exec, this.execOptions()) !== head || await inspectWorktree(this.exec, this.execOptions()) !== "clean") throw new Error("Validation changed local HEAD or worktree");
			} catch (error) {
				this.status = undefined;
				this.options.run?.checksFailed();
				throw error;
			}
			this.validatedHead = head;
			return { head, checks: checks.length + 1 };
		}, { agentDir: this.options.agentDir, signal: this.options.signal });
	}

	async publish(): Promise<{ kind: "published"; head: string }> {
		if (!this.validatedHead) throw new Error("Local work is not validated");
		const head = this.validatedHead;
		this.validatedHead = undefined; // A response loss must never allow a second push.
		return await withWorktreeLock(this.options.cwd, async () => {
			await this.authorityCheck();
			if (await inspectWorktree(this.exec, this.execOptions()) !== "clean" || await readHead(this.exec, this.execOptions()) !== head) {
				throw new Error("Validated local HEAD or worktree changed");
			}
			const original = this.authority.head.oid;
			if (head === original) return { kind: "published", head };
			this.options.run?.beforePush(original, head);
			this.consumed = true; // An uncertain push cannot reopen inspect, commit, or validation.
			let error: unknown;
			try {
				await runChecked(this.exec, "git", ["push", "--porcelain", `--force-with-lease=refs/heads/${this.authority.target.ref}:${original}`,
					"--recurse-submodules=no", "--", this.authority.target.fetchSource,
					`${head}:refs/heads/${this.authority.target.ref}`], this.execOptions());
			} catch (failure) { error = failure; }
			let remote: string | null;
			try { remote = await readRemoteOid(this.exec, this.execOptions(), this.authority.target.fetchSource, this.authority.target.ref); }
			catch { throw new Error("Local publication outcome unknown; do not retry"); }
			if (remote === head) { this.options.run?.observeRemote(head); return { kind: "published", head }; }
			if (remote === original) throw new Error(`Local publication not applied${error ? `: ${String(error)}` : ""}`);
			throw new Error("Local publication outcome unknown; do not retry");
		}, { agentDir: this.options.agentDir, signal: this.options.signal });
	}
}

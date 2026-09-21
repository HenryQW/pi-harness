import { spawnBounded, type Exec, type ExecOptions } from "@henryqw/pi-process";
import {
	cloneCurrentPullRequest,
	loadCurrentPullRequest,
	samePullRequestSnapshot,
	type CurrentPullRequest,
	type PullRequestLoadContext,
} from "./pr-github.ts";
import {
	assertOnlyDeclaredStatusChanged,
	extensionExecApi,
	inspectWorktree,
	isAncestor,
	parseNulPaths,
	parseSingleOutputLine,
	readHead,
	readRemoteOid,
	requiredOid,
	resolveRepositoryFetchSource,
	runChecked,
	validateResolvedConflictPaths,
	withWorktreeLock,
} from "./pr-execution.ts";

type UpdateBranchPhase = "ready" | "conflict-awaiting-user" | "verified" | "published" | "blocked";

type UpdateBranchState = {
	phase: UpdateBranchPhase;
	verifiedHead?: string;
	conflict?: { paths: string[]; statusBaseline: string };
};

type UpdateBranchResult =
	| { kind: "verified"; head: string; fastForward: boolean }
	| { kind: "conflict"; paths: string[] }
	| { kind: "published"; head: string };

type Load = typeof loadCurrentPullRequest;

export type UpdateBranchOptions = {
	cwd: string;
	authority: CurrentPullRequest;
	signal?: AbortSignal;
	agentDir?: string;
	exec?: Exec;
	loadCurrentPullRequest?: Load;
};

function sameAuthority(frozen: CurrentPullRequest, fresh: CurrentPullRequest): boolean {
	return samePullRequestSnapshot(frozen, fresh) && frozen.base.oid === fresh.base.oid &&
		fresh.lifecycle === "open" && (fresh.conditions.baseUpdateRequired || fresh.conditions.conflict);
}

export class PullRequestBranchUpdater {
	readonly state: UpdateBranchState = { phase: "ready" };

	private readonly cwd: string;
	private readonly authority: CurrentPullRequest;
	private readonly signal?: AbortSignal;
	private readonly agentDir?: string;
	private readonly exec: Exec;
	private readonly load: Load;

	constructor(options: UpdateBranchOptions) {
		if (!options.authority || options.authority.lifecycle !== "open" || options.authority.target.provenance !== "configured") {
			throw new TypeError("Branch update requires a configured open pull request");
		}
		if (!options.authority.conditions.baseUpdateRequired && !options.authority.conditions.conflict) {
			throw new TypeError("Pull request does not require a branch update");
		}
		this.cwd = options.cwd;
		this.authority = cloneCurrentPullRequest(options.authority);
		this.signal = options.signal;
		this.agentDir = options.agentDir;
		this.exec = options.exec ?? spawnBounded;
		this.load = options.loadCurrentPullRequest ?? loadCurrentPullRequest;
	}

	private execOptions(extra: Partial<ExecOptions> = {}): ExecOptions {
		return { cwd: this.cwd, signal: this.signal, ...extra };
	}

	private pi() {
		return extensionExecApi(this.exec, this.cwd, this.signal);
	}

	private context(): PullRequestLoadContext {
		return { cwd: this.cwd, signal: this.signal ?? new AbortController().signal };
	}

	private async freshAuthority(expectedHead: string, requireClean: boolean): Promise<CurrentPullRequest> {
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind !== "current" || !sameAuthority(this.authority, discovery.pullRequest)) {
			throw new Error("Branch update cancelled: frozen pull request authority changed");
		}
		const branch = parseSingleOutputLine((await runChecked(this.exec, "git", ["branch", "--show-current"], this.execOptions())).stdout, "current branch");
		if (branch !== this.authority.target.branch) throw new Error("Branch update cancelled: current branch changed");
		if (requireClean && await inspectWorktree(this.exec, this.execOptions()) !== "clean") {
			throw new Error("Branch update cancelled: worktree is dirty or a Git operation is in progress");
		}
		const head = await readHead(this.exec, this.execOptions());
		if (head !== expectedHead) throw new Error("Branch update cancelled: local HEAD changed");
		return discovery.pullRequest;
	}

	private async verifyMerge(originalHead: string): Promise<{ head: string; fastForward: boolean }> {
		const head = await readHead(this.exec, this.execOptions());
		const parentsOutput = parseSingleOutputLine((await runChecked(this.exec, "git", ["rev-list", "--parents", "-n", "1", "HEAD"], this.execOptions())).stdout, "merge parents");
		const commits = parentsOutput.split(" ").map((value, index) => requiredOid(value, index === 0 ? "merged HEAD" : "merge parent"));
		if (commits[0] !== head) throw new Error("Branch update merge verification returned a different HEAD");
		let fastForward = false;
		if (head === this.authority.base.oid && commits.length >= 2 && await isAncestor(this.exec, this.execOptions(), originalHead, head)) {
			fastForward = true;
		} else if (commits.length !== 3 || commits[1] !== originalHead || commits[2] !== this.authority.base.oid) {
			throw new Error("Branch update did not produce the exact configured fast-forward or two-parent merge");
		}
		if (await inspectWorktree(this.exec, this.execOptions()) !== "clean") {
			throw new Error("Branch update merge left a dirty worktree or Git operation in progress");
		}
		this.state.phase = "verified";
		this.state.verifiedHead = head;
		delete this.state.conflict;
		return { head, fastForward };
	}

	private async captureConflict(): Promise<string[]> {
		const mergeHead = requiredOid(parseSingleOutputLine((await runChecked(this.exec, "git", ["rev-parse", "--verify", "MERGE_HEAD^{commit}"], this.execOptions())).stdout, "MERGE_HEAD"), "MERGE_HEAD");
		if (mergeHead !== this.authority.base.oid) throw new Error("Failed merge did not retain the frozen base");
		const paths = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.execOptions())).stdout, "Unmerged paths");
		if (!paths.length) throw new Error("git merge failed without bounded unmerged paths");
		const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions());
		this.state.phase = "conflict-awaiting-user";
		this.state.conflict = { paths, statusBaseline: status.stdout };
		return paths;
	}

	async merge(): Promise<UpdateBranchResult> {
		if (this.state.phase !== "ready") throw new Error("Branch update merge action was already consumed");
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshAuthority(this.authority.head.oid, true);
			const source = await resolveRepositoryFetchSource(this.exec, this.execOptions(), {
				host: this.authority.host,
				repository: this.authority.base.repository,
			});
			this.state.phase = "blocked";
			await runChecked(this.exec, "git", [
				"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", source, this.authority.base.oid,
			], this.execOptions());
			await runChecked(this.exec, "git", ["cat-file", "-e", `${this.authority.base.oid}^{commit}`], this.execOptions());
			await this.freshAuthority(this.authority.head.oid, true);
			if (await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, this.authority.head.oid)) {
				this.state.phase = "verified";
				this.state.verifiedHead = this.authority.head.oid;
				return { kind: "verified", head: this.authority.head.oid, fastForward: false };
			}

			const result = await this.exec("git", ["merge", "--no-edit", this.authority.base.oid], this.execOptions());
			if (result.killed) throw new Error("git merge was killed; its outcome is unknown");
			if (result.code === 0) {
				const verified = await this.verifyMerge(this.authority.head.oid);
				return { kind: "verified", ...verified };
			}
			try {
				const paths = await this.captureConflict();
				return { kind: "conflict", paths: [...paths] };
			} catch (error) {
				const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
				throw new Error(`git merge failed: ${detail}; ${error instanceof Error ? error.message : String(error)}`);
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async continue(resolvedPaths: readonly string[]): Promise<UpdateBranchResult> {
		if (this.state.phase !== "conflict-awaiting-user" || !this.state.conflict) {
			throw new Error("Branch update has no conflict awaiting continuation");
		}
		const paths = validateResolvedConflictPaths(resolvedPaths, this.state.conflict.paths);
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshAuthority(this.authority.head.oid, false);
			const mergeHead = requiredOid(parseSingleOutputLine((await runChecked(this.exec, "git", ["rev-parse", "--verify", "MERGE_HEAD^{commit}"], this.execOptions())).stdout, "MERGE_HEAD"), "MERGE_HEAD");
			if (mergeHead !== this.authority.base.oid) throw new Error("Branch update merge context changed");
			const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions());
			assertOnlyDeclaredStatusChanged(this.state.conflict!.statusBaseline, status.stdout, paths);

			this.state.phase = "blocked";
			await runChecked(this.exec, "git", ["add", "--", ...paths], this.execOptions());
			const unmerged = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.execOptions())).stdout, "Unmerged paths");
			if (unmerged.length) throw new Error(`Conflict paths remain unresolved: ${unmerged.join(", ")}`);

			await runChecked(this.exec, "git", ["-c", "core.editor=true", "merge", "--continue"], this.execOptions());
			const verified = await this.verifyMerge(this.authority.head.oid);
			return { kind: "verified", ...verified };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async publish(): Promise<UpdateBranchResult> {
		if (this.state.phase !== "verified" || !this.state.verifiedHead) {
			throw new Error("Branch update is not ready to publish");
		}
		const head = this.state.verifiedHead;
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshAuthority(head, true);
			if (!(await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, head))) {
				throw new Error("Verified branch no longer contains the frozen base");
			}
			const original = this.authority.target.remoteOid;
			if (original === null) throw new Error("Current pull request remote ref is absent");
			if (!(await isAncestor(this.exec, this.execOptions(), original, head))) {
				throw new Error("Published branch would not be a fast-forward of the frozen remote OID");
			}
			await this.freshAuthority(head, true);
			this.state.phase = "blocked";
			await runChecked(this.exec, "git", [
				"push", "--porcelain", `--force-with-lease=refs/heads/${this.authority.target.ref}:${original}`,
				"--recurse-submodules=no", "--", this.authority.target.fetchSource,
				`${head}:refs/heads/${this.authority.target.ref}`,
			], this.execOptions());
			const remote = await readRemoteOid(this.exec, this.execOptions(), this.authority.target.fetchSource, this.authority.target.ref);
			if (remote !== head) throw new Error("Published remote ref did not match verified HEAD");
			this.state.phase = "published";
			return { kind: "published", head };
		}, { agentDir: this.agentDir, signal: this.signal });
	}
}

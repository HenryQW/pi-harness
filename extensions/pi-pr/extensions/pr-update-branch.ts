import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
	inspectGitOperation,
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
	conflict?: { paths: string[]; statusBaseline: string; head: string };
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
		fresh.lifecycle === "open" && fresh.conditions.conflict;
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
		if (!options.authority || options.authority.target.provenance !== "configured") {
			throw new TypeError("Branch update requires a configured open pull request");
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

	private async verifyRebase(): Promise<UpdateBranchResult> {
		const head = await readHead(this.exec, this.execOptions());
		if (await inspectWorktree(this.exec, this.execOptions()) !== "clean" ||
			!(await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, head))) {
			throw new Error("Rebase did not leave a clean branch based on the frozen base");
		}
		this.state.phase = "verified";
		this.state.verifiedHead = head;
		delete this.state.conflict;
		return { kind: "verified", head, fastForward: false };
	}

	private async captureConflict(): Promise<UpdateBranchResult> {
		if (await inspectGitOperation(this.exec, this.execOptions()) === null) {
			throw new Error("Failed rebase did not retain an in-progress Git operation");
		}
		const paths = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.execOptions())).stdout, "Unmerged paths");
		if (!paths.length) throw new Error("git rebase failed without bounded unmerged paths");
		const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions());
		this.state.phase = "conflict-awaiting-user";
		this.state.conflict = { paths, statusBaseline: status.stdout, head: await readHead(this.exec, this.execOptions()) };
		return { kind: "conflict", paths };
	}

	async rebase(): Promise<UpdateBranchResult> {
		if (this.state.phase !== "ready") throw new Error("Branch conflict rebase action was already consumed");
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
				return await this.verifyRebase();
			}
			const mergeBase = requiredOid(parseSingleOutputLine((await runChecked(this.exec, "git", [
				"merge-base", this.authority.base.oid, this.authority.head.oid,
			], this.execOptions())).stdout, "rebase fork point"), "rebase fork point");
			const mergeCommits = (await runChecked(this.exec, "git", [
				"rev-list", "--max-count=1", "--min-parents=2", `${mergeBase}..${this.authority.head.oid}`,
			], this.execOptions())).stdout.trim();
			if (mergeCommits) throw new Error("Branch update cannot rebase a branch with merge commits; preserve its resolutions manually");
			await this.freshAuthority(this.authority.head.oid, true);
			const result = await this.exec("git", ["-c", "core.editor=true", "-c", "rebase.backend=merge", "rebase", "--no-autostash", "--onto", this.authority.base.oid, mergeBase], this.execOptions());
			if (result.killed) throw new Error("git rebase was killed; its outcome is unknown");
			if (result.code === 0) return await this.verifyRebase();
			try {
				return await this.captureConflict();
			} catch (error) {
				throw new Error(`git rebase failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}; ${error instanceof Error ? error.message : String(error)}`);
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async continue(resolvedPaths: readonly string[]): Promise<UpdateBranchResult> {
		if (this.state.phase !== "conflict-awaiting-user" || !this.state.conflict) {
			throw new Error("Branch rebase has no conflict awaiting continuation");
		}
		const paths = validateResolvedConflictPaths(resolvedPaths, this.state.conflict.paths);
		return await withWorktreeLock(this.cwd, async () => {
			const discovery = await this.load(this.pi(), this.context());
			if (discovery.kind !== "current" || !sameAuthority(this.authority, discovery.pullRequest)) {
				throw new Error("Branch rebase authority changed");
			}
			const path = parseSingleOutputLine((await runChecked(this.exec, "git", ["rev-parse", "--git-path", "rebase-merge/head-name"], this.execOptions())).stdout, "rebase branch marker");
			if ((await readFile(resolve(this.cwd, path), "utf8")).trim() !== `refs/heads/${this.authority.target.branch}` ||
				await readHead(this.exec, this.execOptions()) !== this.state.conflict!.head) {
				throw new Error("Branch rebase context changed");
			}
			const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions());
			assertOnlyDeclaredStatusChanged(this.state.conflict!.statusBaseline, status.stdout, paths);
			this.state.phase = "blocked";
			await runChecked(this.exec, "git", ["--literal-pathspecs", "add", "--", ...paths], this.execOptions());
			const unmerged = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.execOptions())).stdout, "Unmerged paths");
			if (unmerged.length) throw new Error(`Conflict paths remain unresolved: ${unmerged.join(", ")}`);
			const result = await this.exec("git", ["-c", "core.editor=true", "rebase", "--continue"], this.execOptions());
			if (result.killed) throw new Error("git rebase continuation was killed; its outcome is unknown");
			if (result.code === 0) return await this.verifyRebase();
			return await this.captureConflict();
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
			await this.freshAuthority(head, true);
			if (head === original) {
				this.state.phase = "published";
				return { kind: "published", head };
			}
			this.state.phase = "blocked";
			let pushError: unknown;
			try {
				await runChecked(this.exec, "git", [
					"push", "--porcelain", `--force-with-lease=refs/heads/${this.authority.target.ref}:${original}`,
					"--recurse-submodules=no", "--", this.authority.target.fetchSource,
					`${head}:refs/heads/${this.authority.target.ref}`,
				], this.execOptions());
			} catch (error) {
				pushError = error;
			}
			let remote: string | null;
			try {
				remote = await readRemoteOid(this.exec, this.execOptions(), this.authority.target.fetchSource, this.authority.target.ref);
			} catch {
				throw new Error("Rebase push outcome is unknown; do not retry");
			}
			if (remote === head) {
				this.state.phase = "published";
				return { kind: "published", head };
			}
			if (remote === original) throw new Error(`Rebase push was not applied${pushError ? ": " + String(pushError) : ""}`);
			throw new Error("Rebase push outcome is unknown; remote ref has an unexpected OID; do not retry");
		}, { agentDir: this.agentDir, signal: this.signal });
	}
}

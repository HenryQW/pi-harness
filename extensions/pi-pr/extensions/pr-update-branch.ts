import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadCurrentPullRequest,
	samePullRequestSnapshot,
	type CurrentPullRequest,
	type PullRequestLoadContext,
} from "./pr-github.ts";
import {
	assertOnlyDeclaredStatusChanged,
	inspectWorktree,
	isAncestor,
	parseNulPaths,
	readHead,
	readRemoteOid,
	requiredOid,
	resolveRepositoryFetchSource,
	runChecked,
	spawnBounded,
	withWorktreeLock,
	type AttemptState,
	type Exec,
	type ExecOptions,
} from "./pr-execution.ts";

export type UpdateBranchPhase = "ready" | "conflict-awaiting-user" | "verified" | "published" | "blocked";

export type UpdateBranchState = {
	phase: UpdateBranchPhase;
	attempts: {
		fetchBase: AttemptState;
		merge: AttemptState;
		stage: AttemptState;
		continueMerge: AttemptState;
		push: AttemptState;
	};
	verifiedHead?: string;
	conflict?: { paths: string[]; statusBaseline: string };
};

export type UpdateBranchResult =
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

function cloneAuthority(value: CurrentPullRequest): CurrentPullRequest {
	return {
		...value,
		url: new URL(value.url.href),
		conditions: { ...value.conditions },
		local: { ...value.local },
		base: { ...value.base },
		head: { ...value.head },
		target: { ...value.target },
	};
}

function sameAuthority(frozen: CurrentPullRequest, fresh: CurrentPullRequest): boolean {
	return samePullRequestSnapshot(frozen, fresh) && frozen.base.oid === fresh.base.oid &&
		fresh.lifecycle === "open" && (fresh.conditions.baseUpdateRequired || fresh.conditions.conflict);
}

function singleLine(output: string, label: string): string {
	const normalized = output.replace(/\r\n/g, "\n");
	const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
	if (lines.length !== 1 || !lines[0]) throw new Error(`${label} returned invalid output`);
	return lines[0];
}

function validateDeclaredPaths(paths: readonly string[], expected: readonly string[]): string[] {
	if (!Array.isArray(paths)) throw new TypeError("resolvedPaths must be an array");
	const encoded = `${paths.join("\0")}${paths.length ? "\0" : ""}`;
	const parsed = parseNulPaths(encoded, "Resolved conflict paths");
	if (expected.some((path) => !parsed.includes(path))) {
		throw new Error("Resolved paths must include every original conflict path");
	}
	return parsed;
}

export class PullRequestBranchUpdater {
	readonly state: UpdateBranchState = {
		phase: "ready",
		attempts: { fetchBase: "none", merge: "none", stage: "none", continueMerge: "none", push: "none" },
	};

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
		this.authority = cloneAuthority(options.authority);
		this.signal = options.signal;
		this.agentDir = options.agentDir;
		this.exec = options.exec ?? spawnBounded;
		this.load = options.loadCurrentPullRequest ?? loadCurrentPullRequest;
	}

	private execOptions(extra: Partial<ExecOptions> = {}): ExecOptions {
		return { cwd: this.cwd, signal: this.signal, ...extra };
	}

	private pi(): Pick<ExtensionAPI, "exec"> {
		return {
			exec: (command, args, options) => this.exec(command, args, {
				cwd: options?.cwd ?? this.cwd,
				signal: options?.signal ?? this.signal,
				timeoutMs: options?.timeout,
			}),
		} as Pick<ExtensionAPI, "exec">;
	}

	private context(): PullRequestLoadContext {
		return { cwd: this.cwd, signal: this.signal ?? new AbortController().signal };
	}

	private async freshAuthority(expectedHead: string, requireClean: boolean): Promise<CurrentPullRequest> {
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind !== "current" || !sameAuthority(this.authority, discovery.pullRequest)) {
			throw new Error("Branch update cancelled: frozen pull request authority changed");
		}
		const branch = singleLine((await runChecked(this.exec, "git", ["branch", "--show-current"], this.execOptions())).stdout, "current branch");
		if (branch !== this.authority.target.branch) throw new Error("Branch update cancelled: current branch changed");
		if (requireClean && await inspectWorktree(this.exec, this.execOptions()) !== "clean") {
			throw new Error("Branch update cancelled: worktree is dirty or a Git operation is in progress");
		}
		const head = await readHead(this.exec, this.execOptions());
		if (head !== expectedHead) throw new Error("Branch update cancelled: local HEAD changed");
		return discovery.pullRequest;
	}

	private async liveBaseMatches(): Promise<void> {
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind !== "current" || !sameAuthority(this.authority, discovery.pullRequest)) {
			throw new Error("Branch update cancelled: live base or pull request authority changed");
		}
	}

	private async verifyMerge(originalHead: string): Promise<{ head: string; fastForward: boolean }> {
		const head = await readHead(this.exec, this.execOptions());
		const parentsOutput = singleLine((await runChecked(this.exec, "git", ["rev-list", "--parents", "-n", "1", "HEAD"], this.execOptions())).stdout, "merge parents");
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
		const mergeHead = requiredOid(singleLine((await runChecked(this.exec, "git", ["rev-parse", "--verify", "MERGE_HEAD^{commit}"], this.execOptions())).stdout, "MERGE_HEAD"), "MERGE_HEAD");
		if (mergeHead !== this.authority.base.oid) throw new Error("Failed merge did not retain the frozen base");
		const paths = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.execOptions())).stdout, "Unmerged paths");
		if (!paths.length) throw new Error("git merge failed without bounded unmerged paths");
		const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions());
		this.state.phase = "conflict-awaiting-user";
		this.state.conflict = { paths, statusBaseline: status.stdout };
		return paths;
	}

	async merge(): Promise<UpdateBranchResult> {
		if (this.state.phase !== "ready" || this.state.attempts.fetchBase !== "none" || this.state.attempts.merge !== "none") {
			throw new Error("Branch update merge action was already consumed");
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshAuthority(this.authority.head.oid, true);
			const source = await resolveRepositoryFetchSource(this.exec, this.execOptions(), {
				host: this.authority.host,
				repository: this.authority.base.repository,
			});
			this.state.attempts.fetchBase = "attempting";
			try {
				await runChecked(this.exec, "git", [
					"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", source, this.authority.base.oid,
				], this.execOptions());
				await runChecked(this.exec, "git", ["cat-file", "-e", `${this.authority.base.oid}^{commit}`], this.execOptions());
				this.state.attempts.fetchBase = "applied";
			} catch (error) {
				this.state.attempts.fetchBase = "unknown";
				throw error;
			}
			await this.freshAuthority(this.authority.head.oid, true);
			if (await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, this.authority.head.oid)) {
				this.state.phase = "verified";
				this.state.verifiedHead = this.authority.head.oid;
				return { kind: "verified", head: this.authority.head.oid, fastForward: false };
			}

			this.state.attempts.merge = "attempting";
			let result;
			try {
				result = await this.exec("git", ["merge", "--no-edit", this.authority.base.oid], this.execOptions());
			} catch (error) {
				this.state.attempts.merge = "unknown";
				throw error;
			}
			if (result.killed) {
				this.state.attempts.merge = "unknown";
				throw new Error("git merge was killed; its outcome is unknown");
			}
			if (result.code === 0) {
				try {
					const verified = await this.verifyMerge(this.authority.head.oid);
					this.state.attempts.merge = "applied";
					return { kind: "verified", ...verified };
				} catch (error) {
					this.state.attempts.merge = "unknown";
					throw error;
				}
			}
			try {
				const paths = await this.captureConflict();
				this.state.attempts.merge = "applied";
				return { kind: "conflict", paths: [...paths] };
			} catch (error) {
				this.state.attempts.merge = "blocked";
				this.state.phase = "blocked";
				const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
				throw new Error(`git merge failed: ${detail}; ${error instanceof Error ? error.message : String(error)}`);
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async continue(resolvedPaths: readonly string[]): Promise<UpdateBranchResult> {
		if (this.state.phase !== "conflict-awaiting-user" || !this.state.conflict) {
			throw new Error("Branch update has no conflict awaiting continuation");
		}
		const paths = validateDeclaredPaths(resolvedPaths, this.state.conflict.paths);
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshAuthority(this.authority.head.oid, false);
			const mergeHead = requiredOid(singleLine((await runChecked(this.exec, "git", ["rev-parse", "--verify", "MERGE_HEAD^{commit}"], this.execOptions())).stdout, "MERGE_HEAD"), "MERGE_HEAD");
			if (mergeHead !== this.authority.base.oid) throw new Error("Branch update merge context changed");
			const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions());
			assertOnlyDeclaredStatusChanged(this.state.conflict!.statusBaseline, status.stdout, paths);

			if (this.state.attempts.stage !== "none") throw new Error("Conflict staging action was already consumed");
			this.state.attempts.stage = "attempting";
			try {
				await runChecked(this.exec, "git", ["add", "--", ...paths], this.execOptions());
				this.state.attempts.stage = "applied";
			} catch (error) {
				this.state.attempts.stage = "unknown";
				throw error;
			}
			const unmerged = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.execOptions())).stdout, "Unmerged paths");
			if (unmerged.length) {
				this.state.phase = "blocked";
				throw new Error(`Conflict paths remain unresolved: ${unmerged.join(", ")}`);
			}

			this.state.attempts.continueMerge = "attempting";
			try {
				await runChecked(this.exec, "git", ["-c", "core.editor=true", "merge", "--continue"], this.execOptions());
				const verified = await this.verifyMerge(this.authority.head.oid);
				this.state.attempts.continueMerge = "applied";
				return { kind: "verified", ...verified };
			} catch (error) {
				this.state.attempts.continueMerge = "unknown";
				throw error;
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async publish(): Promise<UpdateBranchResult> {
		if (this.state.phase !== "verified" || !this.state.verifiedHead || this.state.attempts.push !== "none") {
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
			this.state.attempts.push = "attempting";
			try {
				await runChecked(this.exec, "git", [
					"push", "--porcelain", `--force-with-lease=refs/heads/${this.authority.target.ref}:${original}`,
					"--recurse-submodules=no", "--", this.authority.target.fetchSource,
					`${head}:refs/heads/${this.authority.target.ref}`,
				], this.execOptions());
				const remote = await readRemoteOid(this.exec, this.execOptions(), this.authority.target.fetchSource, this.authority.target.ref);
				if (remote !== head) throw new Error("Published remote ref did not match verified HEAD");
				this.state.attempts.push = "applied";
				this.state.phase = "published";
				return { kind: "published", head };
			} catch (error) {
				this.state.attempts.push = "unknown";
				throw error;
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}
}

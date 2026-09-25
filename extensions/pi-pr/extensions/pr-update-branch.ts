import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { extensionConfigDir, readTextFileBounded, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
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
	isRecord,
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

type RebaseRecovery = { version: 1; phase: "pending" | "verified" | "published"; identity: string;
	original: string; remote: string; verified: string | null };

function recoveryIdentity(pr: CurrentPullRequest): string {
	return JSON.stringify([pr.id, pr.number, pr.url.href, pr.host, pr.base.repository, pr.base.ref, pr.base.oid,
		pr.head.repository, pr.head.ref, pr.target.provenance, pr.target.branch, pr.target.remote,
		pr.target.ref, pr.target.repository, pr.target.host, pr.target.fetchSource]);
}

function recoveryPath(cwd: string, pr: CurrentPullRequest, agentDir?: string): string {
	const key = createHash("sha256").update(`${resolve(cwd)}\n${pr.url.href}`).digest("hex");
	return join(extensionConfigDir("pi-pr", agentDir), "update-branch", `${key}.json`);
}

async function readRecovery(path: string, signal?: AbortSignal): Promise<RebaseRecovery | null> {
	let raw: string;
	try { raw = await readTextFileBounded(path, 4096, { signal }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let record: unknown;
	try { record = JSON.parse(raw); } catch { throw new Error(`Invalid branch update recovery is preserved at ${path}`); }
	if (!isRecord(record) || Object.keys(record).sort().join(",") !== "identity,original,phase,remote,verified,version" ||
		record.version !== 1 || !["pending", "verified", "published"].includes(record.phase as string) ||
		typeof record.identity !== "string" || record.identity.length > 2048 ||
		typeof record.original !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(record.original) ||
		typeof record.remote !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(record.remote) ||
		(record.verified !== null && (typeof record.verified !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(record.verified))) ||
		(record.phase === "pending" && record.verified !== null) ||
		(record.phase !== "pending" && record.verified === null)) {
		throw new Error(`Invalid branch update recovery is preserved at ${path}`);
	}
	return record as RebaseRecovery;
}

function assertVerifiedRecovery(record: RebaseRecovery, pr: CurrentPullRequest, path: string): void {
	if (record.identity !== recoveryIdentity(pr) || record.remote !== record.original ||
		![record.remote, record.verified].includes(pr.head.oid) || pr.target.remoteOid !== pr.head.oid) {
		throw new Error(`Branch update recovery authority changed; record preserved at ${path}`);
	}
	if (record.phase === "pending") throw new Error(`Branch rebase outcome is unverified; recover manually from ${path}; do not replay it`);
}

export async function inspectVerifiedRebaseRecovery(pr: CurrentPullRequest, options: { cwd: string; agentDir?: string; signal?: AbortSignal }): Promise<boolean> {
	const path = recoveryPath(options.cwd, pr, options.agentDir);
	const record = await readRecovery(path, options.signal);
	if (!record || record.phase === "published") return false;
	assertVerifiedRecovery(record, pr, path);
	return true;
}

export class PullRequestBranchUpdater {
	readonly state: UpdateBranchState = { phase: "ready" };

	private readonly cwd: string;
	private readonly authority: CurrentPullRequest;
	private readonly signal?: AbortSignal;
	private readonly agentDir?: string;
	private readonly exec: Exec;
	private readonly load: Load;
	private recovered = false;
	private recoveredRecord?: RebaseRecovery;

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

	private async freshAuthority(expectedHead: string, requireClean: boolean, published = false): Promise<CurrentPullRequest> {
		const discovery = await this.load(this.pi(), this.context());
		const comparison = published ? {
			...this.authority,
			head: { ...this.authority.head, oid: expectedHead },
			target: { ...this.authority.target, remoteOid: expectedHead },
		} : this.authority;
		if (discovery.kind !== "current" || (published
			? !samePullRequestSnapshot(comparison, discovery.pullRequest) ||
				this.authority.base.oid !== discovery.pullRequest.base.oid || discovery.pullRequest.lifecycle !== "open"
			: !sameAuthority(this.authority, discovery.pullRequest))) {
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

	private async writeRecovery(phase: RebaseRecovery["phase"], verified: string | null): Promise<void> {
		const path = recoveryPath(this.cwd, this.authority, this.agentDir);
		const existing = await readRecovery(path, this.signal);
		const identity = recoveryIdentity(this.authority);
		const original = this.recoveredRecord?.original ?? this.authority.head.oid;
		const remote = this.recoveredRecord?.remote ?? this.authority.target.remoteOid;
		if (!remote) throw new Error("Branch update remote ref is absent");
		if (existing && existing.phase !== "published" &&
			(existing.identity !== identity || existing.original !== original || existing.remote !== remote || phase === "pending")) {
			throw new Error(`Branch update recovery must be inspected before replacement: ${path}`);
		}
		await writePrivateTextFileAtomically(path, `${JSON.stringify({ version: 1, phase, identity,
			original, remote, verified })}\n`, { signal: this.signal });
	}

	async recoveryLaunchAction(): Promise<"rebase"> {
		const path = recoveryPath(this.cwd, this.authority, this.agentDir);
		const recovery = await readRecovery(path, this.signal);
		if (!recovery || recovery.phase === "published") return "rebase";
		assertVerifiedRecovery(recovery, this.authority, path);
		const head = recovery.verified!;
		const branch = parseSingleOutputLine((await runChecked(this.exec, "git", ["branch", "--show-current"], this.execOptions())).stdout, "current branch");
		if (branch !== this.authority.target.branch || await inspectWorktree(this.exec, this.execOptions()) !== "clean" ||
			await readHead(this.exec, this.execOptions()) !== head ||
			!(await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, head))) {
			throw new Error("Branch update recovery does not match a clean verified branch; do not replay the rebase");
		}
		this.state.phase = "verified";
		this.state.verifiedHead = head;
		this.recoveredRecord = recovery;
		this.recovered = true;
		return "rebase"; // The prompted action returns the verified result without replaying Git.
	}

	private async verifyRebase(): Promise<UpdateBranchResult> {
		const head = await readHead(this.exec, this.execOptions());
		if (await inspectWorktree(this.exec, this.execOptions()) !== "clean" ||
			!(await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, head))) {
			throw new Error("Rebase did not leave a clean branch based on the frozen base");
		}
		await this.writeRecovery("verified", head);
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
		if (this.recovered && this.state.phase === "verified" && this.state.verifiedHead) {
			this.recovered = false;
			return { kind: "verified", head: this.state.verifiedHead, fastForward: false };
		}
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
			await this.writeRecovery("pending", null);
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
			const original = this.recoveredRecord?.remote ?? this.authority.target.remoteOid;
			if (original === null) throw new Error("Current pull request remote ref is absent");
			const remoteBefore = await readRemoteOid(this.exec, this.execOptions(), this.authority.target.fetchSource, this.authority.target.ref);
			if (remoteBefore !== original && remoteBefore !== head) throw new Error("Rebase push outcome is unknown; remote ref has an unexpected OID; do not retry");
			await this.freshAuthority(head, true, remoteBefore === head && head !== original);
			if (!(await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, head))) {
				throw new Error("Verified branch no longer contains the frozen base");
			}
			if (remoteBefore === head) {
				await this.writeRecovery("published", head);
				this.state.phase = "published";
				return { kind: "published", head };
			}
			await this.freshAuthority(head, true);
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
				await this.writeRecovery("published", head);
				this.state.phase = "published";
				return { kind: "published", head };
			}
			if (remote === original) throw new Error(`Rebase push was not applied${pushError ? ": " + String(pushError) : ""}`);
			throw new Error("Rebase push outcome is unknown; remote ref has an unexpected OID; do not retry");
		}, { agentDir: this.agentDir, signal: this.signal });
	}
}

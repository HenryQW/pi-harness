import type { PrRun } from "./pr-run.ts";
import { readFile, rm } from "node:fs/promises";
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
	inspectWorktreeState,
	isAncestor,
	parseNulPaths,
	parseSingleOutputLine,
	inspectGitOperation,
	hasExactKeys,
	isRecord,
	pushWithLease,
	readHead,
	readRemoteOid,
	recordRemoteTrackingRef,
	requiredOid,
	resolveRepositoryFetchSource,
	runChecked,
	validatePaths,
	withWorktreeLock,
} from "./pr-execution.ts";

type UpdateStrategy = "rebase" | "merge";

type UpdateBranchPhase = "ready" | "conflict-awaiting-user" | "verified" | "published" | "blocked";

type UpdateBranchState = {
	phase: UpdateBranchPhase;
	verifiedHead?: string;
	conflict?: { paths: string[]; statusBaseline: string; head: string; markers: string[] };
};

type UpdateBranchResult =
	| { kind: "verified"; head: string }
	| { kind: "conflict"; paths: string[]; strategy: UpdateStrategy }
	| { kind: "published"; head: string }
	| { kind: "stale"; reason: string; authority: CurrentPullRequest; aborted?: true };

// Only pre-mutation preflight can authorize a fresh routing snapshot, never a replay.
class StaleRebaseRoute extends Error {
	readonly authority: CurrentPullRequest;
	constructor(reason: string, authority: CurrentPullRequest) {
		super(reason);
		this.authority = authority;
	}
}

type Load = typeof loadCurrentPullRequest;

export type UpdateBranchOptions = {
	run: PrRun;
	cwd: string;
	authority: CurrentPullRequest;
	signal?: AbortSignal;
	agentDir?: string;
	exec?: Exec;
	loadCurrentPullRequest?: Load;
};

// Base OID drift is checked separately: a base that only advanced keeps the frozen rebase valid.
function sameAuthority(frozen: CurrentPullRequest, fresh: CurrentPullRequest): boolean {
	return samePullRequestSnapshot(frozen, fresh) &&
		fresh.lifecycle === "open" && (fresh.conditions.conflict || fresh.conditions.baseUpdateRequired);
}

type RebaseRecovery = { version: 1; phase: "pending" | "verified" | "published"; identity: string;
	original: string; remote: string; verified: string | null };

const isOid = (value: unknown): value is string => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

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
	if (!isRecord(record) || !hasExactKeys(record, ["identity", "original", "phase", "remote", "verified", "version"]) ||
		record.version !== 1 || !["pending", "verified", "published"].includes(record.phase as string) ||
		typeof record.identity !== "string" || record.identity.length > 2048 ||
		!isOid(record.original) || !isOid(record.remote) || (record.verified !== null && !isOid(record.verified)) ||
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
	if (record.phase === "pending") throw new Error(`Branch update outcome is unverified; recover manually from ${path}; do not replay it`);
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

	private readonly run: PrRun;
	private readonly cwd: string;
	private readonly authority: CurrentPullRequest;
	private readonly signal?: AbortSignal;
	private readonly agentDir?: string;
	private readonly exec: Exec;
	private readonly load: Load;
	private strategy: UpdateStrategy = "rebase";
	private recovered = false;
	private recoveredRecord?: RebaseRecovery;

	constructor(options: UpdateBranchOptions) {
		if (!options.authority || options.authority.target.provenance !== "configured") {
			throw new TypeError("Branch update requires a configured open pull request");
		}
		this.cwd = options.cwd;
		this.run = options.run;
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
		return { cwd: this.cwd, signal: this.signal };
	}

	private async freshAuthority(expectedHead: string, requireClean: boolean, published = false, beforeRebase = false): Promise<CurrentPullRequest> {
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind !== "current") throw new Error("Branch update cancelled: pull request is no longer current");
		const fresh = discovery.pullRequest;
		const comparison = beforeRebase || published ? {
			...this.authority,
			head: { ...this.authority.head, oid: beforeRebase ? fresh.head.oid : expectedHead },
			target: { ...this.authority.target, remoteOid: beforeRebase ? fresh.target.remoteOid : expectedHead },
		} : this.authority;
		if (!samePullRequestSnapshot(comparison, fresh) || fresh.lifecycle !== "open" ||
			(!beforeRebase && (!published && !(fresh.conditions.conflict || fresh.conditions.baseUpdateRequired) ||
				!(await this.baseAdvancedFromFrozen(fresh))))) {
			throw new Error("Branch update cancelled: frozen pull request authority changed (identity, lifecycle, destination, or post-rebase authority)");
		}
		const branch = parseSingleOutputLine((await runChecked(this.exec, "git", ["branch", "--show-current"], this.execOptions())).stdout, "current branch");
		if (branch !== this.authority.target.branch) throw new Error("Branch update cancelled: current branch changed");
		if (requireClean && await inspectWorktreeState(this.exec, this.execOptions()) !== "clean") {
			throw new Error("Branch update cancelled: worktree is dirty or a Git operation is in progress");
		}
		const head = await readHead(this.exec, this.execOptions());
		const reasons: string[] = [];
		if (beforeRebase) {
			if (fresh.target.remoteOid !== this.authority.target.remoteOid || fresh.head.oid !== expectedHead) {
				if (this.authority.target.remoteOid !== expectedHead || fresh.target.remoteOid !== fresh.head.oid ||
					head !== fresh.head.oid || !(await isAncestor(this.exec, this.execOptions(), expectedHead, head))) {
					throw new Error("Branch update cancelled: frozen pull request authority changed; head/remote drift is not a clean, already-published fast-forward");
				}
				reasons.push("Published PR head advanced by fast-forward");
			} else if (head !== expectedHead && await isAncestor(this.exec, this.execOptions(), expectedHead, head)) {
				reasons.push("Local HEAD is ahead of the frozen PR head");
			} else if (head !== expectedHead) {
				throw new Error("Branch update cancelled: local HEAD does not match the expected head");
			}
			if (fresh.base.oid !== this.authority.base.oid) reasons.push("Base OID changed");
			if (!fresh.conditions.conflict && !fresh.conditions.baseUpdateRequired) {
				reasons.push(this.authority.conditions.conflict ? "PR conflict cleared" : "Required base update cleared");
			}
		} else if (head !== expectedHead) {
			throw new Error("Branch update cancelled: local HEAD does not match the expected head");
		}
		if (reasons.length) {
			if (fresh.target.remoteOid !== fresh.head.oid) {
				throw new Error("Branch update cancelled: PR head and remote lease disagree");
			}
			const path = recoveryPath(this.cwd, this.authority, this.agentDir);
			const recovery = await readRecovery(path, this.signal);
			if (recovery && recovery.phase !== "published") {
				throw new Error(`Branch update recovery requires reconciliation; record preserved at ${path}; do not replan or replay`);
			}
			this.signal?.throwIfAborted();
			throw new StaleRebaseRoute(`${reasons.join("; ")}; cancelled before rebase or publication`, cloneCurrentPullRequest(fresh));
		}
		return fresh;
	}

	// After the rebase starts, GitHub rediscovers mergeability against a base that only advanced.
	private async baseAdvancedFromFrozen(fresh: CurrentPullRequest): Promise<boolean> {
		if (fresh.base.oid === this.authority.base.oid) return true;
		const source = await resolveRepositoryFetchSource(this.exec, this.execOptions(), {
			host: this.authority.host,
			repository: this.authority.base.repository,
		});
		await runChecked(this.exec, "git", [
			"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", source, fresh.base.oid,
		], this.execOptions());
		return await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, fresh.base.oid);
	}

	// Nothing is published while a conflict waits, so abort restores the frozen head for fresh routing.
	private async abandonRebase(fresh: CurrentPullRequest | undefined): Promise<UpdateBranchResult> {
		this.state.phase = "blocked";
		const original = this.authority.head.oid;
		await runChecked(this.exec, "git", [this.strategy, "--abort"], this.execOptions());
		const branch = parseSingleOutputLine((await runChecked(this.exec, "git", ["branch", "--show-current"], this.execOptions())).stdout, "current branch");
		if (branch !== this.authority.target.branch || await readHead(this.exec, this.execOptions()) !== original ||
			await inspectWorktreeState(this.exec, this.execOptions()) !== "clean") {
			throw new Error(`Branch update authority changed; abort did not restore clean ${original}; recover manually`);
		}
		await rm(recoveryPath(this.cwd, this.authority, this.agentDir), { force: true });
		delete this.state.conflict;
		const reason = `Branch update authority changed; ${this.strategy} aborted and ${original} restored before publication`;
		if (!fresh) throw new Error(`${reason}; pull request is no longer current`);
		return { kind: "stale", reason, authority: cloneCurrentPullRequest(fresh), aborted: true };
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
		if (branch !== this.authority.target.branch || await inspectWorktreeState(this.exec, this.execOptions()) !== "clean" ||
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
		const branch = parseSingleOutputLine((await runChecked(this.exec, "git", ["branch", "--show-current"], this.execOptions())).stdout, "current branch");
		if (branch !== this.authority.target.branch || await inspectWorktreeState(this.exec, this.execOptions()) !== "clean" ||
			!(await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, head))) {
			throw new Error("Branch update did not leave the expected clean branch based on the frozen base");
		}
		if (this.strategy === "merge") {
			const parents = parseSingleOutputLine((await runChecked(this.exec, "git", [
				"rev-list", "--parents", "-n", "1", "HEAD",
			], this.execOptions())).stdout, "merge parents").split(" ");
			if (parents.length !== 3 || parents[0] !== head || parents[1] !== this.authority.head.oid ||
				parents[2] !== this.authority.base.oid) {
				throw new Error("Branch update did not produce the exact first and second merge parents; recover manually");
			}
		}
		await this.writeRecovery("verified", head);
		this.state.phase = "verified";
		this.state.verifiedHead = head;
		delete this.state.conflict;
		return { kind: "verified", head };
	}

	private async conflictMarkers(): Promise<string[]> {
		const merge = this.strategy === "merge";
		if (await inspectGitOperation(this.exec, this.execOptions()) !== (merge ? "MERGE_HEAD" : "rebase-merge")) {
			throw new Error(`Branch ${this.strategy} context changed`);
		}
		const names = merge ? ["MERGE_HEAD", "ORIG_HEAD"] :
			["rebase-merge/head-name", "rebase-merge/orig-head", "rebase-merge/onto", "REBASE_HEAD"];
		const markers: string[] = [];
		for (const name of names) {
			const path = parseSingleOutputLine((await runChecked(this.exec, "git", ["rev-parse", "--git-path", name], this.execOptions())).stdout, name);
			try { markers.push(await readFile(resolve(this.cwd, path), "utf8")); }
			catch (error) { throw new Error(`Branch ${this.strategy} context changed: cannot read ${name}`, { cause: error }); }
		}
		const expected = merge ? [this.authority.base.oid, this.authority.head.oid] :
			[`refs/heads/${this.authority.target.branch}`, this.authority.head.oid, this.authority.base.oid];
		const branch = (await runChecked(this.exec, "git", ["branch", "--show-current"], this.execOptions())).stdout.trim();
		if (expected.some((value, index) => markers[index]!.trim() !== value) ||
			branch !== (merge ? this.authority.target.branch : "") || (!merge && !isOid(markers[3]!.trim()))) {
			throw new Error(`Branch ${this.strategy} context changed`);
		}
		return markers;
	}

	/** Inspect only operation identity; never replace the original status baseline. */
	async hasLiveConflict(): Promise<boolean> {
		if (this.signal?.aborted || this.state.phase !== "conflict-awaiting-user" || !this.state.conflict) return false;
		try { await this.assertConflictContext(); return true; }
		catch { return false; }
	}

	private async assertConflictContext(): Promise<void> {
		try {
			const conflict = this.state.conflict!;
			const markers = await this.conflictMarkers();
			if (await readHead(this.exec, this.execOptions()) !== conflict.head ||
				markers.some((value, index) => value !== conflict.markers[index])) {
				throw new Error(`Branch ${this.strategy} context changed`);
			}
		} catch (error) {
			this.state.phase = "blocked";
			delete this.state.conflict;
			throw error;
		}
	}

	private async captureConflict(): Promise<UpdateBranchResult> {
		const markers = await this.conflictMarkers();
		const paths = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.execOptions())).stdout, "Unmerged paths");
		if (!paths.length) throw new Error(`git ${this.strategy} failed without bounded unmerged paths`);
		const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions());
		this.state.phase = "conflict-awaiting-user";
		const head = await readHead(this.exec, this.execOptions());
		if (this.strategy === "merge" && head !== this.authority.head.oid) throw new Error("Branch merge context changed");
		this.state.conflict = { paths, statusBaseline: status.stdout, head, markers };
		return { kind: "conflict", paths, strategy: this.strategy };
	}

	async rebase(): Promise<UpdateBranchResult> {
		if (this.recovered && this.state.phase === "verified" && this.state.verifiedHead) {
			this.recovered = false;
			return { kind: "verified", head: this.state.verifiedHead };
		}
		if (this.state.phase !== "ready") throw new Error("Branch conflict rebase action was already consumed");
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshAuthority(this.authority.head.oid, true, false, true);
			const source = await resolveRepositoryFetchSource(this.exec, this.execOptions(), {
				host: this.authority.host,
				repository: this.authority.base.repository,
			});
			this.state.phase = "blocked";
			await runChecked(this.exec, "git", [
				"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", source, this.authority.base.oid,
			], this.execOptions());
			await runChecked(this.exec, "git", ["cat-file", "-e", `${this.authority.base.oid}^{commit}`], this.execOptions());
			await this.freshAuthority(this.authority.head.oid, true, false, true);
			if (await isAncestor(this.exec, this.execOptions(), this.authority.base.oid, this.authority.head.oid)) {
				return await this.verifyRebase();
			}
			const mergeBase = requiredOid(parseSingleOutputLine((await runChecked(this.exec, "git", [
				"merge-base", this.authority.base.oid, this.authority.head.oid,
			], this.execOptions())).stdout, "rebase fork point"), "rebase fork point");
			const mergeCommits = (await runChecked(this.exec, "git", [
				"rev-list", "--max-count=1", "--min-parents=2", `${mergeBase}..${this.authority.head.oid}`,
			], this.execOptions())).stdout.trim();
			this.strategy = mergeCommits ? "merge" : "rebase";
			await this.freshAuthority(this.authority.head.oid, true, false, true);
			await this.writeRecovery("pending", null);
			const args = this.strategy === "merge"
				? ["merge", "--no-ff", "--no-edit", "--no-autostash", this.authority.base.oid]
				: ["-c", "core.editor=true", "-c", "rebase.backend=merge", "-c", "rebase.updateRefs=false", "rebase", "--no-autostash", "--onto", this.authority.base.oid, mergeBase];
			const result = await this.exec("git", args, this.execOptions());
			if (result.killed) throw new Error(`git ${this.strategy} was killed; its outcome is unknown`);
			if (result.code === 0) return await this.verifyRebase();
			try {
				return await this.captureConflict();
			} catch (error) {
				throw new Error(`git ${this.strategy} failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}; ${error instanceof Error ? error.message : String(error)}`);
			}
		}, { agentDir: this.agentDir, signal: this.signal }).catch((error: unknown) => {
			if (!(error instanceof StaleRebaseRoute)) throw error;
			this.signal?.throwIfAborted();
			this.state.phase = "blocked";
			return { kind: "stale" as const, reason: error.message, authority: error.authority };
		});
	}

	async continue(resolvedPaths: readonly string[]): Promise<UpdateBranchResult> {
		if (this.state.phase !== "conflict-awaiting-user" || !this.state.conflict) {
			throw new Error("Branch rebase has no conflict awaiting continuation");
		}
		const paths = validatePaths(resolvedPaths, "Resolved conflict paths");
		if (this.state.conflict.paths.some((path) => !paths.includes(path))) {
			throw new Error("Resolved paths must include every original conflict path");
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.assertConflictContext();
			const discovery = await this.load(this.pi(), { ...this.context(),
				...(this.strategy === "rebase" ? { rebaseBranch: this.authority.target.branch } : {}) });
			await this.assertConflictContext();
			const fresh = discovery.kind === "current" ? discovery.pullRequest : undefined;
			const stale = !fresh || !sameAuthority(this.authority, fresh) || !(await this.baseAdvancedFromFrozen(fresh));
			await this.assertConflictContext();
			// Undeclared edits block both continuation and abort, which would reset them.
			const latestStatus = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.execOptions());
			assertOnlyDeclaredStatusChanged(this.state.conflict!.statusBaseline, latestStatus.stdout, paths);
			if (stale) return await this.abandonRebase(fresh);
			this.state.phase = "blocked";
			await runChecked(this.exec, "git", ["--literal-pathspecs", "add", "--", ...paths], this.execOptions());
			const unmerged = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.execOptions())).stdout, "Unmerged paths");
			if (unmerged.length) throw new Error(`Conflict paths remain unresolved: ${unmerged.join(", ")}`);
			const result = await this.exec("git", ["-c", "core.editor=true", "-c", "rebase.updateRefs=false", this.strategy, "--continue"], this.execOptions());
			if (result.killed) throw new Error(`git ${this.strategy} continuation was killed; its outcome is unknown`);
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
				this.run.observeRemote(head);
				await recordRemoteTrackingRef(this.exec, this.execOptions(), this.authority.target.remote, this.authority.target.ref, head, original);
				await this.writeRecovery("published", head);
				this.state.phase = "published";
				return { kind: "published", head };
			}
			await this.freshAuthority(head, true);
			this.run.beforePush(original, head);
			this.state.phase = "blocked";
			let pushError: unknown;
			try {
				await pushWithLease(this.exec, this.execOptions(), this.authority.target.fetchSource, this.authority.target.ref, original, head);
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
				this.run.observeRemote(head);
				await recordRemoteTrackingRef(this.exec, this.execOptions(), this.authority.target.remote, this.authority.target.ref, head, original);
				await this.writeRecovery("published", head);
				this.state.phase = "published";
				return { kind: "published", head };
			}
			if (remote === original) throw new Error(`Rebase push was not applied${pushError ? ": " + String(pushError) : ""}`);
			throw new Error("Rebase push outcome is unknown; remote ref has an unexpected OID; do not retry");
		}, { agentDir: this.agentDir, signal: this.signal });
	}
}

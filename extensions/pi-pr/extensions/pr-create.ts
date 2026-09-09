import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	branchTrackingRef,
	fetchBranchTrackingRef,
	findExactHeadPullRequests,
	loadCurrentPullRequest,
	loadPullRequestPublication,
	readPullRequestBaseRefOid,
	readTrackingOid,
	readValidatedRemoteAuthority,
	setBranchUpstream,
	verifyBranchUpstream,
	type BranchUpstreamTarget,
	type PullRequestLoadContext,
	type PullRequestPublication,
} from "./pr-github.ts";
import type { PullRequestTarget } from "./pr-routing.ts";
import {
	assertOnlyDeclaredStatusChanged,
	inspectWorktree,
	isAncestor,
	parseNulPaths,
	readHead,
	readRemoteOid,
	requiredOid,
	requiredText,
	resolveRepositoryFetchSource,
	runChecked,
	spawnBounded,
	withWorktreeLock,
	type AttemptState,
	type Exec,
	type ExecOptions,
} from "./pr-execution.ts";

const BASE_RERUN = "Rerun /pr --base=<host>/<owner>/<repository>:<ref>";
const MAX_REMOTE_BRANCHES = 128;
const MAX_TITLE_BYTES = 256;
const MAX_BODY_BYTES = 64 * 1024;

type Load = typeof loadCurrentPullRequest;

export type CreateBaseAuthority = {
	host: string;
	repository: string;
	ref: string;
	oid: string;
	fetchSource: string;
};

export type CreatePhase = "unprepared" | "prepared" | "conflict-awaiting-user" | "verified" | "pushed" | "published" | "blocked";

export type CreatePullRequestState = {
	phase: CreatePhase;
	attempts: {
		fetchBase: AttemptState;
		merge: AttemptState;
		stage: AttemptState;
		continueMerge: AttemptState;
		push: AttemptState;
		fetchTracking: AttemptState;
		setUpstream: AttemptState;
		pullRequest: AttemptState;
	};
	base?: CreateBaseAuthority;
	mergeHead?: string;
	publicationHead?: string;
	conflict?: { paths: string[]; statusBaseline: string; originalHead: string };
	url?: string;
};

export type CreatePullRequestResult =
	| { kind: "prepared"; base: CreateBaseAuthority; mergeBase: string }
	| { kind: "verified"; head: string; fastForward: boolean }
	| { kind: "conflict"; paths: string[] }
	| { kind: "pushed"; head: string }
	| { kind: "published"; url: string };

export type CreatePullRequestOptions = {
	cwd: string;
	target: PullRequestTarget;
	signal?: AbortSignal;
	agentDir?: string;
	exec?: Exec;
	loadCurrentPullRequest?: Load;
};

function sameTarget(left: PullRequestTarget, right: PullRequestTarget, expectedRemoteOid = left.remoteOid): boolean {
	return left.branch === right.branch && left.remote === right.remote && left.ref === right.ref &&
		left.repository.toLowerCase() === right.repository.toLowerCase() && left.host === right.host &&
		left.fetchSource === right.fetchSource && right.remoteOid === expectedRemoteOid;
}

function line(output: string, label: string): string {
	const normalized = output.replace(/\r\n/g, "\n");
	const values = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
	if (values.length !== 1 || !values[0]) throw new Error(`${label} returned invalid output`);
	return values[0];
}

function configuredValues(output: string): string[] {
	if (output === "") return [];
	const normalized = output.replace(/\r\n/g, "\n");
	const values = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
	if (values.some((value) => !value) || new Set(values).size !== values.length) {
		throw new Error("Git configuration returned invalid values");
	}
	return values;
}

function parseExplicitBase(value: string): Omit<CreateBaseAuthority, "oid" | "fetchSource"> {
	const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+):(.+)$/.exec(value);
	if (!match || match[2] === "." || match[2] === ".." || match[3] === "." || match[3] === "..") {
		throw new Error(`Invalid base authority. ${BASE_RERUN}`);
	}
	return { host: match[1]!.toLowerCase(), repository: `${match[2]}/${match[3]}`, ref: requiredText(match[4], "base ref") };
}

function resolvedPaths(paths: readonly string[], expected: readonly string[]): string[] {
	if (!Array.isArray(paths)) throw new TypeError("resolvedPaths must be an array");
	const parsed = parseNulPaths(`${paths.join("\0")}${paths.length ? "\0" : ""}`, "Resolved conflict paths");
	if (expected.some((path) => !parsed.includes(path))) {
		throw new Error("Resolved paths must include every original conflict path");
	}
	return parsed;
}

export class PullRequestCreator {
	readonly state: CreatePullRequestState = {
		phase: "unprepared",
		attempts: {
			fetchBase: "none", merge: "none", stage: "none", continueMerge: "none", push: "none",
			fetchTracking: "none", setUpstream: "none", pullRequest: "none",
		},
	};

	private readonly cwd: string;
	private readonly target: PullRequestTarget;
	private readonly noTarget: boolean;
	private readonly signal?: AbortSignal;
	private readonly agentDir?: string;
	private readonly exec: Exec;
	private readonly load: Load;

	constructor(options: CreatePullRequestOptions) {
		if (!options.target || options.target.remoteOid !== null && !requiredOid(options.target.remoteOid, "remote OID")) {
			throw new TypeError("PR creation requires a validated creation target");
		}
		this.cwd = options.cwd;
		this.target = { ...options.target };
		this.noTarget = options.target.provenance === "inferred" && options.target.remoteOid === null;
		this.signal = options.signal;
		this.agentDir = options.agentDir;
		this.exec = options.exec ?? spawnBounded;
		this.load = options.loadCurrentPullRequest ?? loadCurrentPullRequest;
	}

	private options(extra: Partial<ExecOptions> = {}): ExecOptions {
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

	private async freshNone(): Promise<void> {
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind !== "none" || !sameTarget(this.target, discovery.creationTarget)) {
			throw new Error("PR creation cancelled: fresh complete discovery is no longer none");
		}
		const branch = line((await runChecked(this.exec, "git", ["branch", "--show-current"], this.options())).stdout, "current branch");
		if (branch !== this.target.branch) throw new Error("PR creation cancelled: current branch changed");
	}

	private async originAuthority() {
		return await readValidatedRemoteAuthority(this.pi(), this.context(), "origin");
	}

	private async inferBaseRef(): Promise<{ authority: Awaited<ReturnType<PullRequestCreator["originAuthority"]>>; ref: string }> {
		const authority = await this.originAuthority();
		const refs = await runChecked(this.exec, "git", [
			"for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)", "refs/remotes/origin",
		], this.options());
		const rows = configuredValues(refs.stdout);
		if (rows.length > MAX_REMOTE_BRANCHES) throw new Error(`${BASE_RERUN}; more than ${MAX_REMOTE_BRANCHES} base candidates exist`);
		const originOwnsTarget = authority.host === this.target.host &&
			authority.repository.toLowerCase() === this.target.repository.toLowerCase();
		const candidates: Array<{ ref: string; score: number }> = [];
		for (const row of rows) {
			const parts = row.split("\t");
			if (parts.length !== 3) throw new Error(`Base inference is unsafe. ${BASE_RERUN}`);
			const prefix = "refs/remotes/origin/";
			if (!parts[0]!.startsWith(prefix)) throw new Error(`Base inference is unsafe. ${BASE_RERUN}`);
			const ref = parts[0]!.slice(prefix.length);
			if (ref === "HEAD" || originOwnsTarget && ref === this.target.ref) continue;
			if (!ref || parts[2] !== "") throw new Error(`Base inference is unsafe. ${BASE_RERUN}`);
			const oid = requiredOid(parts[1], "remote base OID");
			const distance = line((await runChecked(this.exec, "git", ["rev-list", "--left-right", "--count", `HEAD...${oid}`], this.options())).stdout, "base distance");
			const counts = /^(\d+)\s+(\d+)$/.exec(distance);
			if (!counts) throw new Error(`Base inference is unsafe. ${BASE_RERUN}`);
			const score = Number(counts[1]) + Number(counts[2]);
			if (!Number.isSafeInteger(score)) throw new Error(`Base inference is unsafe. ${BASE_RERUN}`);
			candidates.push({ ref, score });
		}
		if (!candidates.length) throw new Error(`Base cannot be inferred. ${BASE_RERUN}`);
		const minimum = Math.min(...candidates.map(({ score }) => score));
		const nearest = candidates.filter(({ score }) => score === minimum);
		if (nearest.length !== 1) throw new Error(`Base is ambiguous. ${BASE_RERUN}`);
		return { authority, ref: nearest[0]!.ref };
	}

	private async resolveBase(explicit?: string): Promise<Omit<CreateBaseAuthority, "oid">> {
		if (explicit !== undefined) {
			const parsed = parseExplicitBase(explicit);
			if (parsed.host !== this.target.host.toLowerCase()) {
				throw new Error("PR creation base and head must use the same GitHub host");
			}
			await runChecked(this.exec, "git", ["check-ref-format", "--branch", parsed.ref], this.options());
			return { ...parsed, fetchSource: await resolveRepositoryFetchSource(this.exec, this.options(), parsed) };
		}
		const configured = await runChecked(this.exec, "git", [
			"config", "--get-all", `branch.${this.target.branch}.gh-merge-base`,
		], this.options(), [0, 1]);
		const values = configured.code === 1 && configured.stdout === "" ? [] : configuredValues(configured.stdout);
		if (values.length > 1) throw new Error(`Configured base is ambiguous. ${BASE_RERUN}`);
		if (values.length === 1) {
			await runChecked(this.exec, "git", ["check-ref-format", "--branch", values[0]!], this.options());
			const authority = await this.originAuthority();
			return { ...authority, ref: values[0]! };
		}
		const inferred = await this.inferBaseRef();
		await runChecked(this.exec, "git", ["check-ref-format", "--branch", inferred.ref], this.options());
		return { ...inferred.authority, ref: inferred.ref };
	}

	private async liveBase(): Promise<string> {
		if (!this.state.base) throw new Error("PR creation base is unavailable");
		return await readPullRequestBaseRefOid(this.pi(), this.context(), this.state.base);
	}

	private async requireCleanHead(): Promise<string> {
		if (await inspectWorktree(this.exec, this.options()) !== "clean") {
			throw new Error("PR creation requires a clean worktree with no Git operation in progress");
		}
		return await readHead(this.exec, this.options());
	}

	async prepare(explicitBase?: string): Promise<CreatePullRequestResult> {
		if (this.state.phase !== "unprepared" || this.state.attempts.fetchBase !== "none") {
			throw new Error("PR creation prepare action was already consumed");
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			const base = await this.resolveBase(explicitBase);
			if (base.host !== this.target.host.toLowerCase()) {
				throw new Error("PR creation base and head must use the same GitHub host");
			}
			const oid = await readPullRequestBaseRefOid(this.pi(), this.context(), base);
			this.state.base = { ...base, oid };
			this.state.attempts.fetchBase = "attempting";
			try {
				await runChecked(this.exec, "git", [
					"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", base.fetchSource, oid,
				], this.options());
				await runChecked(this.exec, "git", ["cat-file", "-e", `${oid}^{commit}`], this.options());
				this.state.attempts.fetchBase = "applied";
			} catch (error) {
				this.state.attempts.fetchBase = "unknown";
				throw error;
			}
			await this.freshNone();
			if (await this.liveBase() !== oid) throw new Error("PR creation cancelled: base ref moved during prepare");
			const mergeBase = requiredOid(line((await runChecked(this.exec, "git", ["merge-base", "HEAD", oid], this.options())).stdout, "merge base"), "merge base");
			this.state.phase = "prepared";
			return { kind: "prepared", base: { ...this.state.base }, mergeBase };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	private async verifyMerge(originalHead: string): Promise<{ head: string; fastForward: boolean }> {
		const base = this.state.base!;
		const head = await readHead(this.exec, this.options());
		const commits = line((await runChecked(this.exec, "git", ["rev-list", "--parents", "-n", "1", "HEAD"], this.options())).stdout, "merge parents")
			.split(" ").map((value, index) => requiredOid(value, index ? "merge parent" : "merged HEAD"));
		if (commits[0] !== head) throw new Error("PR creation merge verification returned a different HEAD");
		let fastForward = false;
		if (head === base.oid && commits.length >= 2 && await isAncestor(this.exec, this.options(), originalHead, head)) fastForward = true;
		else if (commits.length !== 3 || commits[1] !== originalHead || commits[2] !== base.oid) {
			throw new Error("PR creation did not produce the exact configured fast-forward or two-parent merge");
		}
		await this.requireCleanHead();
		this.state.phase = "verified";
		this.state.mergeHead = head;
		delete this.state.conflict;
		return { head, fastForward };
	}

	private async captureConflict(originalHead: string): Promise<string[]> {
		const base = this.state.base!;
		const mergeHead = requiredOid(line((await runChecked(this.exec, "git", ["rev-parse", "--verify", "MERGE_HEAD^{commit}"], this.options())).stdout, "MERGE_HEAD"), "MERGE_HEAD");
		if (mergeHead !== base.oid) throw new Error("Failed merge did not retain the frozen base");
		const paths = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.options())).stdout, "Unmerged paths");
		if (!paths.length) throw new Error("git merge failed without bounded unmerged paths");
		const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.options());
		this.state.phase = "conflict-awaiting-user";
		this.state.conflict = { paths, statusBaseline: status.stdout, originalHead };
		return paths;
	}

	async merge(): Promise<CreatePullRequestResult> {
		if (this.state.phase !== "prepared" || !this.state.base || this.state.attempts.merge !== "none") {
			throw new Error("PR creation is not prepared for merge");
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			const originalHead = await this.requireCleanHead();
			if (await isAncestor(this.exec, this.options(), this.state.base!.oid, originalHead)) {
				this.state.phase = "verified";
				this.state.mergeHead = originalHead;
				return { kind: "verified", head: originalHead, fastForward: false };
			}
			this.state.attempts.merge = "attempting";
			let result;
			try {
				result = await this.exec("git", ["merge", "--no-edit", this.state.base!.oid], this.options());
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
					const verified = await this.verifyMerge(originalHead);
					this.state.attempts.merge = "applied";
					return { kind: "verified", ...verified };
				} catch (error) {
					this.state.attempts.merge = "unknown";
					throw error;
				}
			}
			try {
				const paths = await this.captureConflict(originalHead);
				this.state.attempts.merge = "applied";
				return { kind: "conflict", paths };
			} catch (error) {
				this.state.attempts.merge = "blocked";
				this.state.phase = "blocked";
				throw new Error(`git merge failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}; ${error instanceof Error ? error.message : String(error)}`);
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async continue(pathsInput: readonly string[]): Promise<CreatePullRequestResult> {
		if (this.state.phase !== "conflict-awaiting-user" || !this.state.conflict || !this.state.base) {
			throw new Error("PR creation has no conflict awaiting continuation");
		}
		if (this.state.attempts.stage !== "none" || this.state.attempts.continueMerge !== "none") {
			throw new Error("PR creation conflict continuation was already consumed");
		}
		const paths = resolvedPaths(pathsInput, this.state.conflict.paths);
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			if (await readHead(this.exec, this.options()) !== this.state.conflict!.originalHead) throw new Error("PR creation merge HEAD changed");
			const mergeHead = requiredOid(line((await runChecked(this.exec, "git", ["rev-parse", "--verify", "MERGE_HEAD^{commit}"], this.options())).stdout, "MERGE_HEAD"), "MERGE_HEAD");
			if (mergeHead !== this.state.base!.oid) throw new Error("PR creation merge context changed");
			const status = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.options());
			assertOnlyDeclaredStatusChanged(this.state.conflict!.statusBaseline, status.stdout, paths);
			this.state.attempts.stage = "attempting";
			try {
				await runChecked(this.exec, "git", ["add", "--", ...paths], this.options());
				this.state.attempts.stage = "applied";
			} catch (error) {
				this.state.attempts.stage = "unknown";
				throw error;
			}
			const unmerged = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--name-only", "-z", "--diff-filter=U"], this.options())).stdout, "Unmerged paths");
			if (unmerged.length) throw new Error(`Conflict paths remain unresolved: ${unmerged.join(", ")}`);
			this.state.attempts.continueMerge = "attempting";
			try {
				await runChecked(this.exec, "git", ["-c", "core.editor=true", "merge", "--continue"], this.options());
				const verified = await this.verifyMerge(this.state.conflict!.originalHead);
				this.state.attempts.continueMerge = "applied";
				return { kind: "verified", ...verified };
			} catch (error) {
				this.state.attempts.continueMerge = "unknown";
				throw error;
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	private async configureNoTargetUpstream(head: string): Promise<void> {
		const target: BranchUpstreamTarget = {
			branch: this.target.branch,
			remote: this.target.remote,
			ref: this.target.ref,
			fetchSource: this.target.fetchSource,
			remoteOid: head,
		};
		this.state.attempts.fetchTracking = "attempting";
		try {
			await fetchBranchTrackingRef(this.pi(), this.context(), target);
			if (await readTrackingOid(this.pi(), this.context(), branchTrackingRef(target)) !== head) {
				throw new Error("Fetched tracking ref did not match published HEAD");
			}
			this.state.attempts.fetchTracking = "applied";
		} catch (error) {
			this.state.attempts.fetchTracking = "unknown";
			throw error;
		}
		this.state.attempts.setUpstream = "attempting";
		try {
			await setBranchUpstream(this.pi(), this.context(), target);
			await verifyBranchUpstream(this.pi(), this.context(), target);
			this.state.attempts.setUpstream = "applied";
		} catch (error) {
			this.state.attempts.setUpstream = "unknown";
			throw error;
		}
	}

	async push(): Promise<CreatePullRequestResult> {
		if (this.state.phase !== "verified" || !this.state.base || this.state.attempts.push !== "none") {
			throw new Error("PR creation is not ready to push");
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			const head = await this.requireCleanHead();
			if (!(await isAncestor(this.exec, this.options(), this.state.base!.oid, head))) {
				throw new Error("PR creation HEAD does not contain the frozen base");
			}
			const original = this.target.remoteOid;
			if (original !== null && !(await isAncestor(this.exec, this.options(), original, head))) {
				throw new Error("PR creation push would not fast-forward the frozen remote OID");
			}
			await this.freshNone();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			if (await this.requireCleanHead() !== head) throw new Error("PR creation cancelled: local HEAD changed before push");
			this.state.publicationHead = head;
			this.state.attempts.push = "attempting";
			try {
				await runChecked(this.exec, "git", [
					"push", "--porcelain", `--force-with-lease=refs/heads/${this.target.ref}:${original ?? ""}`,
					"--recurse-submodules=no", "--", this.target.fetchSource, `${head}:refs/heads/${this.target.ref}`,
				], this.options());
				if (await readRemoteOid(this.exec, this.options(), this.target.fetchSource, this.target.ref) !== head) {
					throw new Error("Published remote ref did not match captured HEAD");
				}
				this.state.attempts.push = "applied";
			} catch (error) {
				this.state.attempts.push = "unknown";
				throw error;
			}
			this.state.phase = "pushed";
			if (this.noTarget) await this.configureNoTargetUpstream(head);
			return { kind: "pushed", head };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	private async publishedAuthority(): Promise<void> {
		const head = this.state.publicationHead!;
		if (this.noTarget && this.state.attempts.setUpstream !== "applied") {
			const branch = line((await runChecked(this.exec, "git", ["branch", "--show-current"], this.options())).stdout, "current branch");
			const authority = await readValidatedRemoteAuthority(this.pi(), this.context(), this.target.remote);
			if (branch !== this.target.branch || authority.host !== this.target.host ||
				authority.repository.toLowerCase() !== this.target.repository.toLowerCase() ||
				authority.fetchSource !== this.target.fetchSource ||
				await readRemoteOid(this.exec, this.options(), this.target.fetchSource, this.target.ref) !== head) {
				throw new Error("Published target authority changed");
			}
			return;
		}
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind === "none") {
			if (!sameTarget(this.target, discovery.creationTarget, head)) throw new Error("Published target authority changed");
			return;
		}
		if (discovery.kind !== "current" || !sameTarget(this.target, discovery.pullRequest.target, head) ||
			discovery.pullRequest.head.oid !== head) throw new Error("Published pull request authority changed");
	}

	private async exactCandidate(): Promise<PullRequestPublication | null> {
		const candidates = await findExactHeadPullRequests(this.pi(), this.context(), {
			host: this.target.host,
			repository: this.target.repository,
			ref: this.target.ref,
		});
		if (candidates.length > 1) throw new Error("Multiple exact-head pull requests exist");
		if (!candidates.length) return null;
		if (candidates[0]!.headOid !== this.state.publicationHead) throw new Error("Exact-head pull request has the wrong OID");
		const publication = await loadPullRequestPublication(this.pi(), this.context(), candidates[0]!.url);
		if (publication.lifecycle !== "open" || publication.head.repository.toLowerCase() !== this.target.repository.toLowerCase() ||
			publication.head.ref !== this.target.ref || publication.head.oid !== this.state.publicationHead) {
			throw new Error("Exact-head pull request metadata is not canonical");
		}
		return publication;
	}

	async publish(titleInput: string, body: string): Promise<CreatePullRequestResult> {
		if (this.state.phase !== "pushed" || !this.state.base || !this.state.publicationHead || this.state.attempts.pullRequest !== "none") {
			throw new Error("PR creation is not ready to publish metadata");
		}
		const title = requiredText(titleInput, "pull request title");
		if (Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES) throw new Error(`Pull request title exceeds ${MAX_TITLE_BYTES} bytes`);
		if (typeof body !== "string" || body.includes("\0") || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
			throw new Error(`Pull request body must be at most ${MAX_BODY_BYTES} bytes without NUL`);
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.publishedAuthority();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			const before = await this.exactCandidate();
			if (before && (before.base.repository.toLowerCase() !== this.state.base!.repository.toLowerCase() || before.base.ref !== this.state.base!.ref)) {
				throw new Error("Exact-head pull request targets a different base");
			}
			const repository = `${this.state.base!.host}/${this.state.base!.repository}`;
			const headOwner = this.target.repository.split("/")[0]!;
			const args = before
				? ["pr", "edit", String(before.number), "--repo", repository, "--title", title, "--body-file", "-"]
				: ["pr", "create", "--repo", repository, "--head", `${headOwner}:${this.target.ref}`, "--base", this.state.base!.ref, "--title", title, "--body-file", "-"];
			this.state.attempts.pullRequest = "attempting";
			try {
				await runChecked(this.exec, "gh", args, this.options({ stdin: body }));
			} catch (error) {
				this.state.attempts.pullRequest = "unknown";
				throw error;
			}
			try {
				const after = await this.exactCandidate();
				if (!after || after.base.repository.toLowerCase() !== this.state.base!.repository.toLowerCase() ||
					after.base.ref !== this.state.base!.ref || after.title !== title || after.body !== body) {
					throw new Error("Published pull request did not retain canonical identity, title, and body");
				}
				this.state.attempts.pullRequest = "applied";
				this.state.phase = "published";
				this.state.url = after.url.href;
				return { kind: "published", url: after.url.href };
			} catch (error) {
				this.state.attempts.pullRequest = "unknown";
				throw error;
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}
}

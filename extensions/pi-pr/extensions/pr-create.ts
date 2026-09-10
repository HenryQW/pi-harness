import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	branchTrackingRef,
	fetchBranchTrackingRef,
	findExactHeadPullRequests,
	loadCurrentPullRequest,
	loadPullRequestPublication,
	preflightPullRequestCreation,
	readBranchUpstreamConfiguration,
	readPullRequestBaseRefOid,
	readTrackingOid,
	readValidatedRemoteAuthority,
	restoreBranchUpstreamConfiguration,
	setBranchUpstream,
	verifyBranchUpstream,
	type BranchUpstreamConfiguration,
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
	runChecked,
	spawnBounded,
	withWorktreeLock,
	type AttemptState,
	type Exec,
	type ExecOptions,
} from "./pr-execution.ts";

const MAX_TITLE_BYTES = 256;
const MAX_BODY_BYTES = 64 * 1024;
const CREATE_AUTHORITY_QUERY = "query($baseOwner:String!,$baseName:String!,$headOwner:String!,$headName:String!){base:repository(owner:$baseOwner,name:$baseName){id nameWithOwner}head:repository(owner:$headOwner,name:$headName){id nameWithOwner owner{__typename}}createInput:__type(name:\"CreatePullRequestInput\"){inputFields{name}}}";
const CREATE_PULL_REQUEST_MUTATION = "mutation($repositoryId:ID!,$baseRefName:String!,$headRepositoryId:ID!,$headRefName:String!,$title:String!,$body:String!){createPullRequest(input:{repositoryId:$repositoryId,baseRefName:$baseRefName,headRepositoryId:$headRepositoryId,headRefName:$headRefName,title:$title,body:$body}){pullRequest{url}}}";

type Load = typeof loadCurrentPullRequest;

export type CreateBaseAuthority = {
	host: string;
	repository: string;
	ref: string;
	oid: string;
	fetchSource: string;
};

export type CreatePhase = "unprepared" | "prepared" | "conflict-awaiting-user" | "verified" | "pushed" | "published" | "blocked";

type CrossRepositoryCreateAuthority = {
	baseRepositoryId: string;
	headRepositoryId: string;
	headOwnerType: "Organization" | "User";
};

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
	createAuthority?: CrossRepositoryCreateAuthority;
	mergeHead?: string;
	publicationHead?: string;
	conflict?: { paths: string[]; statusBaseline: string; originalHead: string };
	originalUpstream?: BranchUpstreamConfiguration;
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

function sameUpstreamConfiguration(left: BranchUpstreamConfiguration, right: BranchUpstreamConfiguration): boolean {
	return left.remote.length === right.remote.length && left.remote.every((value, index) => value === right.remote[index]) &&
		left.merge.length === right.merge.length && left.merge.every((value, index) => value === right.merge[index]);
}

function line(output: string, label: string): string {
	const normalized = output.replace(/\r\n/g, "\n");
	const values = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
	if (values.length !== 1 || !values[0]) throw new Error(`${label} returned invalid output`);
	return values[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphQlResponse(output: string, action: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error(`${action} returned invalid GraphQL output`);
	}
	if (!isRecord(value)) throw new Error(`${action} returned invalid GraphQL output`);
	const errors = value.errors;
	if (errors !== undefined) {
		if (!Array.isArray(errors) || errors.some((error) => !isRecord(error) || typeof error.message !== "string" || !error.message)) {
			throw new Error(`${action} returned invalid GraphQL errors`);
		}
		if (errors.length) throw new Error(`${action} failed: ${errors.map((error) => error.message).join("; ")}`);
	}
	return value;
}

function parseCreateAuthority(
	output: string,
	baseRepository: string,
	headRepository: string,
): CrossRepositoryCreateAuthority {
	const response = graphQlResponse(output, "PR creation preflight");
	const data = response.data;
	const base = isRecord(data) ? data.base : undefined;
	const head = isRecord(data) ? data.head : undefined;
	const owner = isRecord(head) ? head.owner : undefined;
	const createInput = isRecord(data) ? data.createInput : undefined;
	if (!isRecord(base) || !isRecord(head) || !isRecord(owner)) {
		throw new Error("PR creation preflight returned invalid repository authority");
	}
	const baseName = requiredText(base.nameWithOwner, "base repository name");
	const headName = requiredText(head.nameWithOwner, "head repository name");
	const baseRepositoryId = requiredText(base.id, "base repository id");
	const headRepositoryId = requiredText(head.id, "head repository id");
	const headOwnerType = owner.__typename;
	if (baseName.toLowerCase() !== baseRepository.toLowerCase() || headName.toLowerCase() !== headRepository.toLowerCase() ||
		(headOwnerType !== "Organization" && headOwnerType !== "User")) {
		throw new Error("PR creation preflight returned different repository authority");
	}
	if (headOwnerType === "Organization") {
		if (!isRecord(createInput)) throw new Error("PR creation preflight returned invalid API capability");
		const inputFields = createInput.inputFields;
		if (!Array.isArray(inputFields)) throw new Error("PR creation preflight returned invalid API capability");
		const names = new Set(inputFields.map((field) => isRecord(field) ? field.name : undefined));
		for (const name of ["repositoryId", "baseRefName", "headRepositoryId", "headRefName", "title", "body"]) {
			if (!names.has(name)) throw new Error("GitHub API cannot create an exact organization-owned cross-repository pull request");
		}
	}
	return { baseRepositoryId, headRepositoryId, headOwnerType };
}

function parseCreatedUrl(output: string, host: string, baseRepository: string): URL {
	const response = graphQlResponse(output, "Create pull request");
	const data = response.data;
	const mutation = isRecord(data) ? data.createPullRequest : undefined;
	const pullRequest = isRecord(mutation) ? mutation.pullRequest : undefined;
	const value = isRecord(pullRequest) ? pullRequest.url : undefined;
	if (typeof value !== "string") throw new Error("Create pull request returned invalid GraphQL output");
	const url = new URL(value);
	const prefix = `/${baseRepository.toLowerCase()}/pull/`;
	if (url.protocol !== "https:" || url.hostname.toLowerCase() !== host.toLowerCase() ||
		!url.pathname.toLowerCase().startsWith(prefix) || !/^[1-9]\d*$/.test(url.pathname.slice(prefix.length)) ||
		url.search || url.hash || url.username || url.password) {
		throw new Error("Create pull request returned a different repository URL");
	}
	return url;
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
	private explicitBase?: string;

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
		const discovery = await this.load(this.pi(), this.context(), undefined, undefined, this.explicitBase);
		if (discovery.kind !== "none" || !sameTarget(this.target, discovery.creationTarget)) {
			throw new Error("PR creation cancelled: fresh complete discovery is no longer none");
		}
		const branch = line((await runChecked(this.exec, "git", ["branch", "--show-current"], this.options())).stdout, "current branch");
		if (branch !== this.target.branch) throw new Error("PR creation cancelled: current branch changed");
	}

	private async liveBase(): Promise<string> {
		if (!this.state.base) throw new Error("PR creation base is unavailable");
		return await readPullRequestBaseRefOid(this.pi(), this.context(), this.state.base);
	}

	private async preflightCrossRepositoryCreation(): Promise<void> {
		if (!this.state.base || this.state.base.repository.toLowerCase() === this.target.repository.toLowerCase()) return;
		const [baseOwner, baseName] = this.state.base.repository.split("/");
		const [headOwner, headName] = this.target.repository.split("/");
		const result = await runChecked(this.exec, "gh", [
			"api", "graphql", "--hostname", this.state.base.host,
			"-f", `query=${CREATE_AUTHORITY_QUERY}`,
			"-F", `baseOwner=${baseOwner}`,
			"-F", `baseName=${baseName}`,
			"-F", `headOwner=${headOwner}`,
			"-F", `headName=${headName}`,
		], this.options());
		this.state.createAuthority = parseCreateAuthority(result.stdout, this.state.base.repository, this.target.repository);
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
			this.explicitBase = explicitBase;
			await this.freshNone();
			const preflight = await preflightPullRequestCreation(
				this.pi(),
				this.context(),
				this.target,
				this.explicitBase,
			);
			if (preflight.ahead === 0) {
				throw new Error("PR creation requires at least one commit ahead of the selected base");
			}
			const { base } = preflight;
			this.state.base = {
				host: base.host,
				repository: base.repository,
				ref: base.ref,
				oid: base.oid,
				fetchSource: base.fetchSource,
			};
			this.state.attempts.fetchBase = "attempting";
			try {
				await runChecked(this.exec, "git", [
					"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", base.fetchSource, base.oid,
				], this.options());
				await runChecked(this.exec, "git", ["cat-file", "-e", `${base.oid}^{commit}`], this.options());
				this.state.attempts.fetchBase = "applied";
			} catch (error) {
				this.state.attempts.fetchBase = "unknown";
				throw error;
			}
			await this.freshNone();
			if (await readHead(this.exec, this.options()) !== preflight.head) {
				throw new Error("PR creation cancelled: local HEAD changed during prepare");
			}
			if (await this.liveBase() !== base.oid) throw new Error("PR creation cancelled: base ref moved during prepare");
			this.state.phase = "prepared";
			return { kind: "prepared", base: { ...this.state.base }, mergeBase: base.mergeBase };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	private async verifyMerge(originalHead: string): Promise<{ head: string; fastForward: boolean }> {
		const base = this.state.base!;
		const head = await readHead(this.exec, this.options());
		const commits = line((await runChecked(this.exec, "git", ["rev-list", "--parents", "-n", "1", head], this.options())).stdout, "merge parents")
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

	private upstreamTarget(head: string): BranchUpstreamTarget {
		return {
			branch: this.target.branch,
			remote: this.target.remote,
			ref: this.target.ref,
			fetchSource: this.target.fetchSource,
			remoteOid: head,
		};
	}

	private async captureNoTargetUpstream(): Promise<void> {
		if (!this.noTarget || this.state.originalUpstream !== undefined) return;
		this.state.originalUpstream = await readBranchUpstreamConfiguration(this.pi(), this.context(), this.target.branch);
	}

	private async fetchNoTargetTracking(head: string): Promise<void> {
		if (this.state.attempts.fetchTracking === "applied") return;
		if (this.state.attempts.fetchTracking !== "none" && this.state.attempts.fetchTracking !== "unknown") {
			throw new Error("PR creation tracking fetch cannot be retried");
		}
		const target = this.upstreamTarget(head);
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
	}

	private async configureNoTargetUpstream(head: string): Promise<void> {
		const original = this.state.originalUpstream;
		if (!original) throw new Error("PR creation original branch upstream is unavailable");
		if (!sameUpstreamConfiguration(
			await readBranchUpstreamConfiguration(this.pi(), this.context(), this.target.branch),
			original,
		)) {
			throw new Error("PR creation cancelled: branch upstream changed before setup");
		}
		await this.fetchNoTargetTracking(head);
		const target = this.upstreamTarget(head);
		this.state.attempts.setUpstream = "attempting";
		try {
			await setBranchUpstream(this.pi(), this.context(), target);
			await verifyBranchUpstream(this.pi(), this.context(), target);
			this.state.attempts.setUpstream = "applied";
		} catch (error) {
			this.state.attempts.setUpstream = "unknown";
			const rollbackContext = { cwd: this.cwd, signal: new AbortController().signal };
			try {
				await restoreBranchUpstreamConfiguration(this.pi(), rollbackContext, target, original);
			} catch {
				this.state.phase = "blocked";
				throw new Error("PR creation upstream setup failed and rollback was incomplete");
			}
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
			await this.preflightCrossRepositoryCreation();
			await this.freshNone();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			if (await this.requireCleanHead() !== head) throw new Error("PR creation cancelled: local HEAD changed before push");
			if (this.noTarget) await this.captureNoTargetUpstream();
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
			if (this.noTarget) await this.fetchNoTargetTracking(head);
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
		const discovery = await this.load(this.pi(), this.context(), undefined, undefined, this.explicitBase);
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
		const retryingUpstream = this.noTarget && this.state.attempts.pullRequest === "applied";
		if (
			this.state.phase !== "pushed" || !this.state.base || !this.state.publicationHead ||
			(this.state.attempts.pullRequest !== "none" && !retryingUpstream)
		) {
			throw new Error("PR creation is not ready to publish metadata");
		}
		if (this.noTarget && !this.state.originalUpstream) {
			throw new Error("PR creation original branch upstream is unavailable");
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
			let after: PullRequestPublication;
			if (retryingUpstream) {
				if (!before || before.title !== title || before.body !== body) {
					throw new Error("Published pull request changed before upstream completion");
				}
				after = before;
			} else {
				const repository = `${this.state.base!.host}/${this.state.base!.repository}`;
				const sameRepository = this.state.base!.repository.toLowerCase() === this.target.repository.toLowerCase();
				const organizationAuthority = !sameRepository && this.state.createAuthority?.headOwnerType === "Organization"
					? this.state.createAuthority
					: undefined;
				if (!sameRepository && !this.state.createAuthority) {
					throw new Error("Cross-repository PR creation was not preflighted before push");
				}
				const args = before
					? ["pr", "edit", String(before.number), "--repo", repository, "--title", title, "--body-file", "-"]
					: organizationAuthority
					? [
						"api", "graphql", "--hostname", this.state.base!.host,
						"-f", `query=${CREATE_PULL_REQUEST_MUTATION}`,
						"-f", `repositoryId=${organizationAuthority.baseRepositoryId}`,
						"-f", `baseRefName=${this.state.base!.ref}`,
						"-f", `headRepositoryId=${organizationAuthority.headRepositoryId}`,
						"-f", `headRefName=${this.target.ref}`,
						"-f", `title=${title}`,
						"-f", `body=${body}`,
					]
					: [
						"pr", "create", "--repo", repository, "--head",
						sameRepository ? this.target.ref : `${this.target.repository.split("/")[0]}:${this.target.ref}`,
						"--base", this.state.base!.ref, "--title", title, "--body-file", "-",
					];
				this.state.attempts.pullRequest = "attempting";
				try {
					const created = await runChecked(this.exec, "gh", args, this.options({ stdin: organizationAuthority ? undefined : body }));
					if (!before && organizationAuthority) {
						parseCreatedUrl(created.stdout, this.state.base!.host, this.state.base!.repository);
					}
				} catch (error) {
					this.state.attempts.pullRequest = "unknown";
					throw error;
				}
				try {
					const refreshed = await this.exactCandidate();
					if (!refreshed || refreshed.base.repository.toLowerCase() !== this.state.base!.repository.toLowerCase() ||
						refreshed.base.ref !== this.state.base!.ref || refreshed.title !== title || refreshed.body !== body) {
						throw new Error("Published pull request did not retain canonical identity, title, and body");
					}
					after = refreshed;
					this.state.attempts.pullRequest = "applied";
				} catch (error) {
					this.state.attempts.pullRequest = "unknown";
					throw error;
				}
			}
			if (this.noTarget) await this.configureNoTargetUpstream(this.state.publicationHead!);
			this.state.phase = "published";
			this.state.url = after.url.href;
			return { kind: "published", url: after.url.href };
		}, { agentDir: this.agentDir, signal: this.signal });
	}
}

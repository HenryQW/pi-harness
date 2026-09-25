import { spawnBounded, type Exec, type ExecOptions } from "@henryqw/pi-process";
import {
	branchTrackingRef,
	fetchBranchTrackingRef,
	findExactHeadPullRequests,
	loadCurrentPullRequest,
	loadPullRequestPublication,
	preflightPullRequestCreation,
	readPullRequestBaseRefOid,
	readTrackingOid,
	readValidatedRemoteAuthority,
	setBranchUpstream,
	verifyBranchUpstream,
	type BranchUpstreamTarget,
	type PullRequestLoadContext,
	type PullRequestPublication,
} from "./pr-github.ts";
import {
	isPullRequestCreationEligible,
	type PullRequestTarget,
} from "./pr-routing.ts";
import {
	extensionExecApi,
	inspectWorktree,
	inspectWorktreeState,
	parseNulPaths,
	parseStatusSnapshot,
	validateResolvedConflictPaths,
	isAncestor,
	isRecord,
	parseSingleOutputLine,
	readHead,
	readRemoteOid,
	requiredOid,
	requiredText,
	runChecked,
	withWorktreeLock,
} from "./pr-execution.ts";

const MAX_TITLE_BYTES = 256;
const MAX_BODY_BYTES = 64 * 1024;
const CREATE_AUTHORITY_QUERY = "query($baseOwner:String!,$baseName:String!,$headOwner:String!,$headName:String!){base:repository(owner:$baseOwner,name:$baseName){id nameWithOwner}head:repository(owner:$headOwner,name:$headName){id nameWithOwner owner{__typename}}createInput:__type(name:\"CreatePullRequestInput\"){inputFields{name}}}";
const CREATE_PULL_REQUEST_MUTATION = "mutation($repositoryId:ID!,$baseRefName:String!,$headRepositoryId:ID!,$headRefName:String!,$title:String!,$body:String!){createPullRequest(input:{repositoryId:$repositoryId,baseRefName:$baseRefName,headRepositoryId:$headRepositoryId,headRefName:$headRefName,title:$title,body:$body}){pullRequest{url}}}";

type Load = typeof loadCurrentPullRequest;

type CreateBaseAuthority = {
	host: string;
	repository: string;
	ref: string;
	oid: string;
	fetchSource: string;
};

type CreatePhase = "unprepared" | "prepared" | "verified" | "pushed" | "published" | "blocked";

type CrossRepositoryCreateAuthority = {
	baseRepositoryId: string;
	headRepositoryId: string;
	headOwnerType: "Organization" | "User";
};

type CreatePullRequestState = {
	phase: CreatePhase;
	base?: CreateBaseAuthority;
	createAuthority?: CrossRepositoryCreateAuthority;
	pending?: { head: string; status: string };
	publicationHead?: string;
	verifiedHead?: string;
};

type CreatePullRequestResult =
	| { kind: "prepared"; base: CreateBaseAuthority; mergeBase: string }
	| { kind: "verified"; head: string; fastForward: boolean }
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

export class PullRequestCreator {
	readonly state: CreatePullRequestState = { phase: "unprepared" };

	private readonly cwd: string;
	private readonly target: PullRequestTarget;
	private readonly noTarget: boolean;
	private noTargetUpstreamConfigured = false;
	private readonly signal?: AbortSignal;
	private readonly agentDir?: string;
	private readonly exec: Exec;
	private readonly load: Load;

	constructor(options: CreatePullRequestOptions) {
		if (options.target.remoteOid !== null) requiredOid(options.target.remoteOid, "remote OID");
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

	private pi() {
		return extensionExecApi(this.exec, this.cwd, this.signal);
	}

	private context(): PullRequestLoadContext {
		return { cwd: this.cwd, signal: this.signal ?? new AbortController().signal };
	}

	private async freshNone() {
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind !== "none" || !sameTarget(this.target, discovery.creationTarget)) {
			throw new Error("PR creation cancelled: fresh complete discovery is no longer none");
		}
		const branch = parseSingleOutputLine((await runChecked(this.exec, "git", ["branch", "--show-current"], this.options())).stdout, "current branch");
		if (branch !== this.target.branch) throw new Error("PR creation cancelled: current branch changed");
		return discovery;
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

	async prepare(): Promise<CreatePullRequestResult> {
		if (this.state.phase !== "unprepared") {
			throw new Error("PR creation prepare action was already consumed");
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			const preflight = await preflightPullRequestCreation(
				this.pi(),
				this.context(),
				this.target,
			);
			if (preflight.worktree === "operation") {
				throw new Error("PR creation cannot prepare while a Git operation is in progress");
			}
			if (!isPullRequestCreationEligible({ ...preflight, relation: "distinct-ref" })) {
				throw new Error("PR creation requires at least one commit ahead of the selected base or pending work");
			}
			const { base } = preflight;
			this.state.base = {
				host: base.host,
				repository: base.repository,
				ref: base.ref,
				oid: base.oid,
				fetchSource: base.fetchSource,
			};
			this.state.phase = "blocked";
			await runChecked(this.exec, "git", [
				"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", base.fetchSource, base.oid,
			], this.options());
			await runChecked(this.exec, "git", ["cat-file", "-e", `${base.oid}^{commit}`], this.options());
			const fresh = await this.freshNone();
			if (await readHead(this.exec, this.options()) !== preflight.head) {
				throw new Error("PR creation cancelled: local HEAD changed during prepare");
			}
			if (await this.liveBase() !== base.oid) throw new Error("PR creation cancelled: base ref moved during prepare");
			if (!isPullRequestCreationEligible(fresh.branch)) {
				throw new Error("PR creation cancelled: branch no longer has a committed change or pending work");
			}
			this.state.phase = "prepared";
			return { kind: "prepared", base: { ...this.state.base }, mergeBase: base.mergeBase };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async inspect(): Promise<{ paths: string[]; head: string }> {
		if (this.state.phase !== "prepared") throw new Error("PR creation must be prepared before inspecting pending work");
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			if (await inspectWorktreeState(this.exec, this.options()) === "operation") throw new Error("Git operation in progress");
			const head = await readHead(this.exec, this.options());
			const status = (await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.options())).stdout;
			const paths = [...parseStatusSnapshot(status).keys()];
			parseNulPaths(paths.map((path) => `${path}\0`).join(""), "Pending paths");
			this.state.pending = { head, status };
			return { paths, head };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async commit(pathsInput: string[], message: string): Promise<{ head: string }> {
		if (this.state.phase !== "prepared" || !this.state.pending) throw new Error("PR creation has no inspected pending work");
		const paths = validateResolvedConflictPaths(pathsInput, []);
		if (!paths.length || paths.some((path) => !parseStatusSnapshot(this.state.pending!.status).has(path))) {
			throw new Error("Commit paths must be reviewed pending paths");
		}
		requiredText(message, "commit message");
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			if (await readHead(this.exec, this.options()) !== this.state.pending!.head ||
				await inspectWorktreeState(this.exec, this.options()) === "operation" ||
				(await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.options())).stdout !== this.state.pending!.status) {
				throw new Error("Pending work changed after inspection");
			}
			const staged = parseNulPaths((await runChecked(this.exec, "git", ["diff", "--cached", "--name-only", "-z"], this.options())).stdout, "Staged paths");
			if (staged.some((path) => !paths.includes(path))) throw new Error("Unrelated staged changes require an ownership decision");
			this.state.pending = undefined; // Commit outcome may be uncertain; never replay it.
			await runChecked(this.exec, "git", ["add", "-A", "--", ...paths], this.options());
			await runChecked(this.exec, "git", ["commit", "-m", message], this.options());
			return { head: await readHead(this.exec, this.options()) };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async verify(): Promise<CreatePullRequestResult> {
		if (this.state.phase !== "prepared" || !this.state.base) {
			throw new Error("PR creation is not prepared for verification");
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			const head = await this.requireCleanHead();
			if (!isPullRequestCreationEligible((await this.freshNone()).branch) || await readHead(this.exec, this.options()) !== head) {
				throw new Error("PR creation changed during verification or no longer has a committed change");
			}
			this.state.verifiedHead = head;
			this.state.phase = "verified";
			return { kind: "verified", head, fastForward: false };
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
		await fetchBranchTrackingRef(this.pi(), this.context(), target);
		if (await readTrackingOid(this.pi(), this.context(), branchTrackingRef(target)) !== head) {
			throw new Error("Fetched tracking ref did not match published HEAD");
		}
		await setBranchUpstream(this.pi(), this.context(), target);
		await verifyBranchUpstream(this.pi(), this.context(), target);
	}

	async push(): Promise<CreatePullRequestResult> {
		if (this.state.phase !== "verified" || !this.state.base || !this.state.verifiedHead) {
			throw new Error("PR creation is not ready to push");
		}
		return await withWorktreeLock(this.cwd, async () => {
			await this.freshNone();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			const head = await this.requireCleanHead();
			if (head !== this.state.verifiedHead) throw new Error("PR creation verified HEAD changed");
			const original = this.target.remoteOid;
			if (original !== null && !(await isAncestor(this.exec, this.options(), original, head))) {
				throw new Error("PR creation push would not fast-forward the frozen remote OID");
			}
			await this.preflightCrossRepositoryCreation();
			await this.freshNone();
			if (await this.liveBase() !== this.state.base!.oid) throw new Error("PR creation cancelled: frozen base moved");
			if (await this.requireCleanHead() !== head) throw new Error("PR creation cancelled: local HEAD changed before push");
			this.state.publicationHead = head;
			this.state.phase = "blocked";
			await runChecked(this.exec, "git", [
				"push", "--porcelain", `--force-with-lease=refs/heads/${this.target.ref}:${original ?? ""}`,
				"--recurse-submodules=no", "--", this.target.fetchSource, `${head}:refs/heads/${this.target.ref}`,
			], this.options());
			if (await readRemoteOid(this.exec, this.options(), this.target.fetchSource, this.target.ref) !== head) {
				throw new Error("Published remote ref did not match captured HEAD");
			}
			this.state.phase = "pushed";
			if (this.noTarget) {
				await this.configureNoTargetUpstream(head);
				this.noTargetUpstreamConfigured = true;
			}
			return { kind: "pushed", head };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	private async publishedAuthority(): Promise<void> {
		const head = this.state.publicationHead!;
		if (this.noTarget && !this.noTargetUpstreamConfigured) {
			const branch = parseSingleOutputLine((await runChecked(this.exec, "git", ["branch", "--show-current"], this.options())).stdout, "current branch");
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
		if (this.state.phase !== "pushed" || !this.state.base || !this.state.publicationHead) {
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
			this.state.phase = "blocked";
			const created = await runChecked(this.exec, "gh", args, this.options({ stdin: organizationAuthority ? undefined : body }));
			if (!before && organizationAuthority) {
				parseCreatedUrl(created.stdout, this.state.base!.host, this.state.base!.repository);
			}
			const after = await this.exactCandidate();
			if (!after || after.base.repository.toLowerCase() !== this.state.base!.repository.toLowerCase() ||
				after.base.ref !== this.state.base!.ref || after.title !== title || after.body !== body) {
				throw new Error("Published pull request did not retain canonical identity, title, and body");
			}
			this.state.phase = "published";
			return { kind: "published", url: after.url.href };
		}, { agentDir: this.agentDir, signal: this.signal });
	}
}

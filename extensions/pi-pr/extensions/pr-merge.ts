import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { LocalMergeSafety } from "./pr-routing.ts";

export type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

export type Exec = (
	command: string,
	args: string[],
	options: { cwd: string },
) => Promise<ExecResult>;

export type MergeMethod = "merge" | "rebase" | "squash";

const FINAL_PULL_REQUEST_QUERY = "query($pullRequestId:ID!){node(id:$pullRequestId){...on PullRequest{id state headRefOid baseRefName baseRefOid repository{nameWithOwner}}}}";
const MERGE_PULL_REQUEST_MUTATION = "mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!,$mergeMethod:PullRequestMergeMethod!){mergePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid,mergeMethod:$mergeMethod}){pullRequest{id state}}}";
const GIT_OPERATION_STATES = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];

export type InspectLocalMergeSafetyInput = {
	exec: Exec;
	cwd: string;
	expectedHead: string;
	headFetchSource: string;
};

export type MergeMethodSelectionInput = {
	allowedMergeMethods: readonly MergeMethod[];
	viewerDefaultMergeMethod?: MergeMethod | null;
};

export type ExecuteGitHubMergeInput = MergeMethodSelectionInput & InspectLocalMergeSafetyInput & {
	pullRequestId: string;
	hostname: string;
	expectedBase: {
		repository: string;
		ref: string;
		oid: string;
	};
};

function commandText(command: string, args: string[]): string {
	return [command, ...args].join(" ");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function commandFailure(command: string, args: string[], detail: string): Error {
	return new Error(`${commandText(command, args)} failed: ${detail}`);
}

async function runCommand(
	exec: Exec,
	cwd: string,
	command: string,
	args: string[],
	allowedCodes: readonly number[] = [0],
): Promise<ExecResult> {
	let result: ExecResult;
	try {
		result = await exec(command, args, { cwd });
	} catch (error) {
		throw commandFailure(command, args, errorText(error));
	}

	if (result.killed || !allowedCodes.includes(result.code)) {
		const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "command was killed" : `exit code ${result.code}`);
		throw commandFailure(command, args, detail);
	}
	return result;
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredOutput(result: ExecResult, label: string): string {
	const output = result.stdout.trim();
	if (!output) throw new Error(`${label} returned no output`);
	return output;
}

function validateInspectionInput(input: InspectLocalMergeSafetyInput): void {
	requiredText(input.cwd, "cwd");
	requiredText(input.expectedHead, "expected PR head");
	requiredText(input.headFetchSource, "PR head fetch source");
	if (typeof input.exec !== "function") throw new TypeError("exec must be a function");
}

/** Inspect local state without changing branches, the index, or the worktree. */
export async function inspectLocalMergeSafety(input: InspectLocalMergeSafetyInput): Promise<LocalMergeSafety> {
	validateInspectionInput(input);

	const status = await runCommand(input.exec, input.cwd, "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
	const stateOutput = requiredOutput(
		await runCommand(input.exec, input.cwd, "git", [
			"rev-parse",
			...GIT_OPERATION_STATES.flatMap((state) => ["--git-path", state]),
		]),
		"Git operation state paths",
	);
	const statePaths = stateOutput.replace(/\r\n/g, "\n").split("\n");
	if (statePaths.length !== GIT_OPERATION_STATES.length || statePaths.some((path) => !path)) {
		throw new Error("Git operation state path resolution returned invalid output");
	}
	let operationInProgress = false;
	for (const [index, path] of statePaths.entries()) {
		try {
			await lstat(resolve(input.cwd, path));
			operationInProgress = true;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") continue;
			const detail = isRecord(error) && typeof error.code === "string" ? error.code : errorText(error);
			throw new Error(`Git operation state inspection failed for ${GIT_OPERATION_STATES[index]}: ${detail}`);
		}
	}
	const worktree = status.stdout.length === 0 && !operationInProgress ? "clean" : "dirty";

	await runCommand(input.exec, input.cwd, "git", [
		"fetch",
		"--no-write-fetch-head",
		"--no-tags",
		"--no-recurse-submodules",
		input.headFetchSource,
		input.expectedHead,
	]);
	await runCommand(input.exec, input.cwd, "git", ["cat-file", "-e", `${input.expectedHead}^{commit}`]);

	const localHead = requiredOutput(
		await runCommand(input.exec, input.cwd, "git", ["rev-parse", "--verify", "HEAD"]),
		"local HEAD",
	);
	if (localHead === input.expectedHead) return { worktree, head: "equal" };

	const localAncestor = await runCommand(
		input.exec,
		input.cwd,
		"git",
		["merge-base", "--is-ancestor", "HEAD", input.expectedHead],
		[0, 1],
	);
	if (localAncestor.code === 0) return { worktree, head: "behind" };

	const expectedAncestor = await runCommand(
		input.exec,
		input.cwd,
		"git",
		["merge-base", "--is-ancestor", input.expectedHead, "HEAD"],
		[0, 1],
	);
	return { worktree, head: expectedAncestor.code === 0 ? "ahead" : "diverged" };
}

function validateMergeMethods(input: MergeMethodSelectionInput): void {
	if (!Array.isArray(input.allowedMergeMethods)) throw new TypeError("allowedMergeMethods must be an array");
	if (input.allowedMergeMethods.some((method) => method !== "merge" && method !== "rebase" && method !== "squash")) {
		throw new TypeError("allowedMergeMethods contains an unsupported method");
	}
	if (
		input.viewerDefaultMergeMethod !== undefined &&
		input.viewerDefaultMergeMethod !== null &&
		input.viewerDefaultMergeMethod !== "merge" &&
		input.viewerDefaultMergeMethod !== "rebase" &&
		input.viewerDefaultMergeMethod !== "squash"
	) throw new TypeError("viewerDefaultMergeMethod is unsupported");
}

export function selectMergeMethod(input: MergeMethodSelectionInput): MergeMethod {
	validateMergeMethods(input);
	if (input.allowedMergeMethods.length === 1) return input.allowedMergeMethods[0]!;
	if (input.allowedMergeMethods.includes("squash")) return "squash";
	if (
		input.viewerDefaultMergeMethod !== undefined &&
		input.viewerDefaultMergeMethod !== null &&
		input.allowedMergeMethods.includes(input.viewerDefaultMergeMethod)
	) return input.viewerDefaultMergeMethod;
	throw new Error("No deterministic GitHub merge method is available");
}

function validateExecuteInput(input: ExecuteGitHubMergeInput): void {
	validateInspectionInput(input);
	requiredText(input.pullRequestId, "pullRequestId");
	requiredText(input.hostname, "hostname");
	if (!isRecord(input.expectedBase)) throw new TypeError("expectedBase must be an object");
	requiredText(input.expectedBase.repository, "expected base repository");
	requiredText(input.expectedBase.ref, "expected base ref");
	requiredText(input.expectedBase.oid, "expected base OID");
}

function parseGraphQLResponse(output: string, action: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error(`${action}: invalid GraphQL output`);
	}
	if (!isRecord(value)) throw new Error(`${action}: invalid GraphQL output`);
	const errors = value.errors;
	if (errors !== undefined) {
		if (!Array.isArray(errors)) throw new Error(`${action}: invalid GraphQL output`);
		if (errors.length > 0) {
			const messages = errors.map((error) => isRecord(error) && typeof error.message === "string" && error.message ? error.message : undefined);
			if (messages.some((message) => message === undefined)) throw new Error(`${action}: invalid GraphQL errors`);
			throw new Error(`${action}: ${messages.join("; ")}`);
		}
	}
	return value;
}

function parseFinalPullRequest(output: string, input: ExecuteGitHubMergeInput): void {
	const value = parseGraphQLResponse(output, "GitHub merge revalidation failed");
	const data = value.data;
	const pullRequest = isRecord(data) ? data.node : undefined;
	const repository = isRecord(pullRequest) ? pullRequest.repository : undefined;
	if (
		!isRecord(pullRequest) || !isRecord(repository) ||
		![pullRequest.id, pullRequest.state, pullRequest.headRefOid, pullRequest.baseRefName, pullRequest.baseRefOid, repository.nameWithOwner]
			.every((field) => typeof field === "string" && field && field.trim() === field && !/[\u0000-\u001f\u007f]/.test(field))
	) throw new Error("GitHub merge revalidation failed: invalid GraphQL output");
	if (pullRequest.id !== input.pullRequestId) {
		throw new Error("GitHub merge cancelled: pull request identity changed");
	}
	if (pullRequest.state !== "OPEN") throw new Error("GitHub merge cancelled: pull request is no longer open");
	if (
		pullRequest.headRefOid !== input.expectedHead ||
		repository.nameWithOwner !== input.expectedBase.repository ||
		pullRequest.baseRefName !== input.expectedBase.ref ||
		pullRequest.baseRefOid !== input.expectedBase.oid
	) throw new Error("GitHub merge cancelled: pull request context changed after local inspection");
}

function parseMergeResponse(output: string, expectedId: string): void {
	const value = parseGraphQLResponse(output, "GitHub merge failed");
	const data = value.data;
	const mutation = isRecord(data) ? data.mergePullRequest : undefined;
	const pullRequest = isRecord(mutation) ? mutation.pullRequest : undefined;
	if (!isRecord(pullRequest)) throw new Error("GitHub merge failed: invalid GraphQL output");
	const id = pullRequest.id;
	const state = pullRequest.state;
	if (typeof id !== "string" || !id || typeof state !== "string" || !state) {
		throw new Error("GitHub merge failed: invalid GraphQL output");
	}
	if (id !== expectedId) throw new Error(`GitHub merge returned unexpected pull request id ${id}`);
	if (state !== "MERGED") throw new Error(`GitHub merge returned pull request ${id} in state ${state}`);
}

export async function executeGitHubMerge(input: ExecuteGitHubMergeInput): Promise<void> {
	validateExecuteInput(input);
	const method = selectMergeMethod(input);
	const local = await inspectLocalMergeSafety(input);
	if (local.worktree !== "clean" || (local.head !== "equal" && local.head !== "behind")) {
		throw new Error(`Local merge safety check failed: worktree is ${local.worktree}, HEAD is ${local.head}`);
	}
	const revalidated = await runCommand(input.exec, input.cwd, "gh", [
		"api",
		"graphql",
		"--hostname",
		input.hostname,
		"-f",
		`query=${FINAL_PULL_REQUEST_QUERY}`,
		"-F",
		`pullRequestId=${input.pullRequestId}`,
	]);
	parseFinalPullRequest(requiredOutput(revalidated, "GitHub merge revalidation"), input);
	const merged = await runCommand(input.exec, input.cwd, "gh", [
		"api",
		"graphql",
		"--hostname",
		input.hostname,
		"-f",
		`query=${MERGE_PULL_REQUEST_MUTATION}`,
		"-F",
		`pullRequestId=${input.pullRequestId}`,
		"-F",
		`expectedHeadOid=${input.expectedHead}`,
		"-F",
		`mergeMethod=${method.toUpperCase()}`,
	]);
	parseMergeResponse(requiredOutput(merged, "GitHub merge"), input.pullRequestId);
}

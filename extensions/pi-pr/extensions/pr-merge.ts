import type { Exec } from "@henryqw/pi-process";
import {
	inspectWorktreeState,
	isAncestor,
	isRecord,
	parseGraphQLResponse,
	readHead,
	runChecked,
} from "./pr-execution.ts";
import type { LocalMergeSafety } from "./pr-routing.ts";
import type { MergeMethod } from "./pr-run.ts";

const MERGE_PULL_REQUEST_MUTATION = "mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!,$mergeMethod:PullRequestMergeMethod!){mergePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid,mergeMethod:$mergeMethod}){pullRequest{id state}}}";

type InspectLocalMergeSafetyInput = {
	exec: Exec;
	cwd: string;
	expectedHead: string;
	headFetchSource: string;
};

type InspectedLocalMergeSafety = LocalMergeSafety & {
	headOid: string;
};

type ExecuteGitHubMergeInput = InspectLocalMergeSafetyInput & {
	pullRequestId: string;
	hostname: string;
	/** Configured merge method; GitHub rejects a method the repository does not allow. */
	mergeMethod?: MergeMethod;
	expectedBase: {
		repository: string;
		ref: string;
		oid: string;
	};
	revalidateReadiness: (local: InspectedLocalMergeSafety) => Promise<void>;
};

/** Inspect local state without changing branches, the index, or the worktree. */
export async function inspectLocalMergeSafety(input: InspectLocalMergeSafetyInput): Promise<InspectedLocalMergeSafety> {
	const worktree = await inspectWorktreeState(input.exec, { cwd: input.cwd }) === "clean" ? "clean" : "dirty";
	await runChecked(input.exec, "git", [
		"fetch",
		"--no-write-fetch-head",
		"--no-tags",
		"--no-recurse-submodules",
		input.headFetchSource,
		input.expectedHead,
	], { cwd: input.cwd });
	await runChecked(input.exec, "git", ["cat-file", "-e", `${input.expectedHead}^{commit}`], { cwd: input.cwd });

	const headOid = await readHead(input.exec, { cwd: input.cwd });
	if (headOid === input.expectedHead) return { worktree, head: "equal", headOid };

	if (await isAncestor(input.exec, { cwd: input.cwd }, headOid, input.expectedHead)) return { worktree, head: "behind", headOid };
	return { worktree, head: await isAncestor(input.exec, { cwd: input.cwd }, input.expectedHead, headOid) ? "ahead" : "diverged", headOid };
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
	const local = await inspectLocalMergeSafety(input);
	if (local.worktree !== "clean" || (local.head !== "equal" && local.head !== "behind")) {
		throw new Error(`Local merge safety check failed: worktree is ${local.worktree}, HEAD is ${local.head}`);
	}
	await input.revalidateReadiness(local);
	if (await inspectWorktreeState(input.exec, { cwd: input.cwd }) !== "clean") {
		throw new Error("Final local merge safety check failed: worktree is dirty");
	}
	const finalHead = await readHead(input.exec, { cwd: input.cwd });
	if (finalHead !== local.headOid) {
		throw new Error(`Final local merge safety check failed: HEAD changed from ${local.headOid} to ${finalHead}`);
	}
	const merged = await runChecked(input.exec, "gh", [
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
		`mergeMethod=${(input.mergeMethod ?? "squash").toUpperCase()}`,
	], { cwd: input.cwd });
	const output = merged.stdout.trim();
	if (!output) throw new Error("GitHub merge returned no output");
	parseMergeResponse(output, input.pullRequestId);
}

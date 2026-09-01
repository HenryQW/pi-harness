import assert from "node:assert/strict";
import test from "node:test";
import {
	executeGitHubMerge,
	inspectLocalMergeSafety,
	selectMergeMethod,
	type Exec,
	type ExecResult,
} from "../extensions/pr-merge.ts";

const cwd = "/repo";
const hostname = "github.com";
const pullRequestId = "PR_kwDOExample";
const expectedHead = "expected-head";

function result(stdout = "", code = 0, stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

type Call = { command: string; args: string[]; cwd: string };

function mockExec(responses: Array<ExecResult | Error>): { exec: Exec; calls: Call[] } {
	let index = 0;
	const calls: Call[] = [];
	const exec: Exec = async (command, args, options) => {
		calls.push({ command, args: [...args], cwd: options.cwd });
		const response = responses[index++];
		if (response === undefined) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		if (response instanceof Error) throw response;
		return response;
	};
	return { exec, calls };
}

function inspectInput(exec: Exec) {
	return {
		exec,
		cwd,
		expectedHead,
		headFetchSource: "git@github.com:acme/fork.git",
	};
}

function command(call: Call): [string, string[]] {
	return [call.command, call.args];
}

test("requires a clean tree and classifies every relation to the fetched PR head", async () => {
	const cases: Array<{
		name: string;
		status: string;
		localHead: string;
		ancestry?: number[];
		expected: { worktree: "clean" | "dirty"; head: "equal" | "behind" | "ahead" | "diverged" };
	}> = [
		{ name: "equal", status: "", localHead: expectedHead, expected: { worktree: "clean", head: "equal" } },
		{ name: "behind", status: "", localHead: "local-behind", ancestry: [0], expected: { worktree: "clean", head: "behind" } },
		{ name: "ahead", status: "", localHead: "local-ahead", ancestry: [1, 0], expected: { worktree: "clean", head: "ahead" } },
		{ name: "diverged", status: "", localHead: "local-diverged", ancestry: [1, 1], expected: { worktree: "clean", head: "diverged" } },
		{ name: "dirty equal", status: " M file.ts\n", localHead: expectedHead, expected: { worktree: "dirty", head: "equal" } },
	];

	for (const candidate of cases) {
		const responses: ExecResult[] = [
			result(candidate.status),
			result(),
			result(`${expectedHead}\n`),
			result(`${candidate.localHead}\n`),
		];
		for (const code of candidate.ancestry ?? []) responses.push(result("", code));
		const { exec, calls } = mockExec(responses);

		assert.deepEqual(await inspectLocalMergeSafety(inspectInput(exec)), candidate.expected, candidate.name);
		assert.deepEqual(calls.map(command), [
			["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
			["git", ["fetch", "--no-write-fetch-head", "--no-tags", "git@github.com:acme/fork.git", expectedHead]],
			["git", ["cat-file", "-e", `${expectedHead}^{commit}`]],
			["git", ["rev-parse", "--verify", "HEAD"]],
			...(candidate.ancestry?.map((_, index) => [
				"git",
				index === 0
					? ["merge-base", "--is-ancestor", "HEAD", expectedHead]
					: ["merge-base", "--is-ancestor", expectedHead, "HEAD"],
			] as [string, string[]]) ?? []),
		], candidate.name);
		assert.ok(calls.every(({ command: executable, args }) =>
			executable !== "git" || !["reset", "rebase", "stash"].includes(args[0] ?? "")
		), candidate.name);
		assert.ok(calls.every(({ args }) => !args.some((arg) => arg === "--force" || arg === "--force-with-lease")), candidate.name);
	}
});

test("fetches from the explicit source instead of the PR repository identity", async () => {
	const { exec, calls } = mockExec([
		result(),
		result(),
		result(`${expectedHead}\n`),
		result(`${expectedHead}\n`),
	]);

	await inspectLocalMergeSafety({
		...inspectInput(exec),
		headFetchSource: "ssh://git@github.com/acme/fork.git",
	});

	assert.deepEqual(command(calls[1]!), [
		"git",
		["fetch", "--no-write-fetch-head", "--no-tags", "ssh://git@github.com/acme/fork.git", expectedHead],
	]);
	assert.equal(calls[1]!.args.includes("acme/project"), false);
});

test("fetches before accepting an equal head and rejects an unavailable advertised object", async () => {
	const { exec, calls } = mockExec([result(), result(), result("", 1, "missing object")]);

	await assert.rejects(
		inspectLocalMergeSafety(inspectInput(exec)),
		/git cat-file -e expected-head\^\{commit\} failed: missing object/,
	);
	assert.equal(calls.length, 3);
	assert.deepEqual(command(calls[1]!), [
		"git",
		["fetch", "--no-write-fetch-head", "--no-tags", "git@github.com:acme/fork.git", expectedHead],
	]);
});

test("surfaces fetch failures without attempting ancestry checks", async () => {
	const { exec, calls } = mockExec([result(), result("", 1, "remote unavailable")]);

	await assert.rejects(
		inspectLocalMergeSafety(inspectInput(exec)),
		/git fetch --no-write-fetch-head --no-tags git@github\.com:acme\/fork\.git expected-head failed: remote unavailable/,
	);
	assert.equal(calls.length, 2);
});

test("rejects a missing fetch source before any command or mutation", async () => {
	const { exec, calls } = mockExec([]);
	const input = inspectInput(exec);
	delete (input as { headFetchSource?: string }).headFetchSource;

	await assert.rejects(
		executeGitHubMerge({
			...input,
			pullRequestId,
			hostname,
			allowedMergeMethods: ["squash"],
		}),
		/PR head fetch source must be a non-empty string/,
	);
	assert.deepEqual(calls, []);
});

test("selects a deterministic allowed merge method", () => {
	assert.equal(selectMergeMethod({ allowedMergeMethods: ["merge"] }), "merge");
	assert.equal(selectMergeMethod({ allowedMergeMethods: ["merge", "rebase"], viewerDefaultMergeMethod: "rebase" }), "rebase");
	assert.equal(selectMergeMethod({ allowedMergeMethods: ["merge", "squash"], viewerDefaultMergeMethod: "merge" }), "squash");
	assert.equal(selectMergeMethod({ allowedMergeMethods: ["rebase"] }), "rebase");
});

test("fails when no sole method, squash, or allowed viewer default exists", () => {
	assert.throws(
		() => selectMergeMethod({ allowedMergeMethods: ["merge", "rebase"], viewerDefaultMergeMethod: null }),
		/No deterministic GitHub merge method is available/,
	);
	assert.throws(
		() => selectMergeMethod({ allowedMergeMethods: ["merge", "rebase"], viewerDefaultMergeMethod: "squash" }),
		/No deterministic GitHub merge method is available/,
	);
});

test("does not issue a merge mutation when fresh local safety checks fail", async () => {
	const cases: Array<{ name: string; responses: ExecResult[]; error: RegExp }> = [
		{
			name: "dirty",
			responses: [result(" M file.ts\n"), result(), result(`${expectedHead}\n`), result(`${expectedHead}\n`)],
			error: /Local merge safety check failed: worktree is dirty/,
		},
		{
			name: "ahead",
			responses: [result(), result(), result(`${expectedHead}\n`), result("local-ahead\n"), result("", 1), result("", 0)],
			error: /Local merge safety check failed: worktree is clean, HEAD is ahead/,
		},
		{
			name: "diverged",
			responses: [result(), result(), result(`${expectedHead}\n`), result("local-diverged\n"), result("", 1), result("", 1)],
			error: /Local merge safety check failed: worktree is clean, HEAD is diverged/,
		},
		{
			name: "missing advertised object",
			responses: [result(), result(), result("", 1, "missing object")],
			error: /git cat-file -e expected-head\^\{commit\} failed: missing object/,
		},
		{
			name: "fetch failure",
			responses: [result(), result("", 1, "remote unavailable")],
			error: /git fetch --no-write-fetch-head --no-tags git@github\.com:acme\/fork\.git expected-head failed: remote unavailable/,
		},
	];

	for (const candidate of cases) {
		const { exec, calls } = mockExec(candidate.responses);
		await assert.rejects(
			executeGitHubMerge({
				...inspectInput(exec),
				pullRequestId,
				hostname,
				allowedMergeMethods: ["squash"],
			}),
			candidate.error,
		);
		assert.equal(
			calls.some(({ command: executable, args }) => executable === "gh" && args[0] === "api" && args[1] === "graphql"),
			false,
			candidate.name,
		);
	}
});

test("executes the selected method with exact GraphQL variables and atomic head check", async () => {
	const mutation = "mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!,$mergeMethod:PullRequestMergeMethod!){mergePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid,mergeMethod:$mergeMethod}){pullRequest{id state}}}";
	const cases: Array<{ name: string; localHead: string; ancestry?: number[] }> = [
		{ name: "equal", localHead: expectedHead },
		{ name: "behind", localHead: "local-behind", ancestry: [0] },
	];

	for (const candidate of cases) {
		const responses: ExecResult[] = [
			result(),
			result(),
			result(`${expectedHead}\n`),
			result(`${candidate.localHead}\n`),
		];
		for (const code of candidate.ancestry ?? []) responses.push(result("", code));
		responses.push(result(JSON.stringify({ data: { mergePullRequest: { pullRequest: { id: pullRequestId, state: "MERGED" } } } })));
		const { exec, calls } = mockExec(responses);

		await executeGitHubMerge({
			...inspectInput(exec),
			pullRequestId,
			hostname,
			allowedMergeMethods: ["merge", "squash"],
			viewerDefaultMergeMethod: "merge",
		});

		assert.deepEqual(calls.at(-1), {
			command: "gh",
			args: [
				"api",
				"graphql",
				"--hostname",
				hostname,
				"-f",
				`query=${mutation}`,
				"-F",
				`pullRequestId=${pullRequestId}`,
				"-F",
				`expectedHeadOid=${expectedHead}`,
				"-F",
				"mergeMethod=SQUASH",
			],
			cwd,
		}, candidate.name);
	}
});

test("rejects GraphQL errors and malformed or non-merged responses without retrying", async () => {
	const response = (body: unknown) => JSON.stringify(body);
	const cases: Array<{ name: string; output: string; error: RegExp }> = [
		{
			name: "GraphQL error",
			output: response({ errors: [{ message: "merge blocked" }] }),
			error: /GitHub merge failed: merge blocked/,
		},
		{
			name: "malformed JSON",
			output: "not JSON",
			error: /GitHub merge failed: invalid GraphQL output/,
		},
		{
			name: "malformed data",
			output: response({ data: { mergePullRequest: null } }),
			error: /GitHub merge failed: invalid GraphQL output/,
		},
		{
			name: "unexpected id",
			output: response({ data: { mergePullRequest: { pullRequest: { id: "PR_other", state: "MERGED" } } } }),
			error: /GitHub merge returned unexpected pull request id PR_other/,
		},
		{
			name: "not merged",
			output: response({ data: { mergePullRequest: { pullRequest: { id: pullRequestId, state: "OPEN" } } } }),
			error: /GitHub merge returned pull request PR_kwDOExample in state OPEN/,
		},
	];

	for (const candidate of cases) {
		const { exec, calls } = mockExec([
			result(),
			result(),
			result(`${expectedHead}\n`),
			result(`${expectedHead}\n`),
			result(candidate.output),
		]);
		await assert.rejects(
			executeGitHubMerge({ ...inspectInput(exec), pullRequestId, hostname, allowedMergeMethods: ["squash"] }),
			candidate.error,
			candidate.name,
		);
		assert.equal(calls.length, 5, candidate.name);
		assert.equal(calls.at(-1)?.command, "gh", candidate.name);
		assert.deepEqual(calls.at(-1)?.args.slice(0, 4), ["api", "graphql", "--hostname", hostname], candidate.name);
	}
});

test("surfaces GitHub CLI merge failures without retrying", async () => {
	const { exec, calls } = mockExec([
		result(),
		result(),
		result(`${expectedHead}\n`),
		result(`${expectedHead}\n`),
		result("", 1, "merge blocked"),
	]);

	await assert.rejects(
		executeGitHubMerge({ ...inspectInput(exec), pullRequestId, hostname, allowedMergeMethods: ["squash"] }),
		/gh api graphql --hostname github\.com .* failed: merge blocked/,
	);
	assert.equal(calls.length, 5);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const expectedHead = "a".repeat(40);
const localBehind = "b".repeat(40);
const localAhead = "c".repeat(40);
const localDiverged = "d".repeat(40);
const changedHead = "e".repeat(40);
const expectedBase = {
	repository: "acme/project",
	ref: "main",
	oid: "f".repeat(40),
};

function result(stdout = "", code = 0, stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

type Call = { command: string; args: string[]; cwd: string };

const GIT_OPERATION_STATES = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];
const STATE_PATH_ARGS = [
	"rev-parse",
	"--git-path", "MERGE_HEAD",
	"--git-path", "rebase-merge",
	"--git-path", "rebase-apply",
	"--git-path", "CHERRY_PICK_HEAD",
	"--git-path", "REVERT_HEAD",
	"--git-path", "sequencer",
];
const STATE_PATH_OUTPUT = GIT_OPERATION_STATES
	.map((state) => `/repo/.git/${state}`).join("\n") + "\n";

function mockExec(
	responses: Array<ExecResult | Error>,
	stateResult: ExecResult | Error = result(STATE_PATH_OUTPUT),
): { exec: Exec; calls: Call[] } {
	let index = 0;
	const calls: Call[] = [];
	const exec: Exec = async (command, args, options) => {
		calls.push({ command, args: [...args], cwd: options.cwd });
		const response = command === "git" && args.join("\0") === STATE_PATH_ARGS.join("\0")
			? stateResult
			: responses[index++];
		if (response === undefined) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		if (response instanceof Error) throw response;
		return response;
	};
	return { exec, calls };
}

function runGit(cwd: string, args: string[]): ExecResult {
	const command = spawnSync("git", args, { cwd, encoding: "utf8" });
	return result(command.stdout ?? "", command.status ?? 1, command.stderr ?? "");
}

function git(cwd: string, ...args: string[]): string {
	const command = runGit(cwd, args);
	assert.equal(command.code, 0, `${args.join(" ")} failed: ${command.stderr}`);
	return command.stdout.trim();
}

function inspectInput(exec: Exec) {
	return {
		exec,
		cwd,
		expectedHead,
		expectedBase,
		headFetchSource: "git@github.com:acme/fork.git",
		revalidateReadiness: async () => {},
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
		expected: { worktree: "clean" | "dirty"; head: "equal" | "behind" | "ahead" | "diverged"; headOid: string };
	}> = [
		{ name: "equal", status: "", localHead: expectedHead, expected: { worktree: "clean", head: "equal", headOid: expectedHead } },
		{ name: "behind", status: "", localHead: localBehind, ancestry: [0], expected: { worktree: "clean", head: "behind", headOid: localBehind } },
		{ name: "ahead", status: "", localHead: localAhead, ancestry: [1, 0], expected: { worktree: "clean", head: "ahead", headOid: localAhead } },
		{ name: "diverged", status: "", localHead: localDiverged, ancestry: [1, 1], expected: { worktree: "clean", head: "diverged", headOid: localDiverged } },
		{ name: "dirty equal", status: " M file.ts\n", localHead: expectedHead, expected: { worktree: "dirty", head: "equal", headOid: expectedHead } },
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
			["git", STATE_PATH_ARGS],
			["git", ["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "git@github.com:acme/fork.git", expectedHead]],
			["git", ["cat-file", "-e", `${expectedHead}^{commit}`]],
			["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
			...(candidate.ancestry?.map((_, index) => [
				"git",
				index === 0
					? ["merge-base", "--is-ancestor", candidate.localHead, expectedHead]
					: ["merge-base", "--is-ancestor", expectedHead, candidate.localHead],
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

	assert.deepEqual(command(calls[2]!), [
		"git",
		["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "ssh://git@github.com/acme/fork.git", expectedHead],
	]);
	assert.equal(calls[2]!.args.includes("acme/project"), false);
});

test("fetches before accepting an equal head and rejects an unavailable advertised object", async () => {
	const { exec, calls } = mockExec([result(), result(), result("", 1, "missing object")]);

	await assert.rejects(
		inspectLocalMergeSafety(inspectInput(exec)),
		new RegExp(`git cat-file -e ${expectedHead}\\^\\{commit\\} failed: missing object`),
	);
	assert.equal(calls.length, 4);
	assert.deepEqual(command(calls[2]!), [
		"git",
		["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "git@github.com:acme/fork.git", expectedHead],
	]);
});

test("surfaces fetch failures without attempting ancestry checks", async () => {
	const { exec, calls } = mockExec([result(), result("", 1, "remote unavailable")]);

	await assert.rejects(
		inspectLocalMergeSafety(inspectInput(exec)),
		new RegExp(`git fetch --no-write-fetch-head --no-tags --no-recurse-submodules git@github\\.com:acme/fork\\.git ${expectedHead} failed: remote unavailable`),
	);
	assert.equal(calls.length, 3);
});

test("fails visibly when Git operation state paths cannot be resolved", async () => {
	const failed = mockExec([result()], result("", 128, "not a worktree"));
	await assert.rejects(
		inspectLocalMergeSafety(inspectInput(failed.exec)),
		/git rev-parse .* failed: not a worktree/,
	);
	assert.equal(failed.calls.length, 2);

	const malformed = mockExec([result()], result("/repo/.git/MERGE_HEAD\n"));
	await assert.rejects(
		inspectLocalMergeSafety(inspectInput(malformed.exec)),
		/Git operation state path resolution returned invalid output/,
	);
	assert.equal(malformed.calls.length, 2);
});

test("final merge rejects every in-progress Git operation in a linked worktree", async (t) => {
	const temporary = mkdtempSync(join(tmpdir(), "pi-pr-final-merge-state-"));
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const repository = join(temporary, "repository");
	const linked = join(temporary, "linked");

	git(temporary, "init", "--initial-branch=main", repository);
	git(repository, "config", "user.name", "Pi PR test");
	git(repository, "config", "user.email", "pi-pr@example.test");
	writeFileSync(join(repository, "tracked.txt"), "base\n");
	git(repository, "add", "tracked.txt");
	git(repository, "commit", "-m", "base");
	const base = git(repository, "rev-parse", "HEAD");

	git(repository, "switch", "-c", "operation-source");
	writeFileSync(join(repository, "tracked.txt"), "picked\n");
	git(repository, "commit", "-am", "pick one");
	const firstPick = git(repository, "rev-parse", "HEAD");
	writeFileSync(join(repository, "tracked.txt"), "picked again\n");
	git(repository, "commit", "-am", "pick two");
	const secondPick = git(repository, "rev-parse", "HEAD");

	git(repository, "switch", "main");
	writeFileSync(join(repository, "tracked.txt"), "target\n");
	git(repository, "commit", "-am", "target");
	git(repository, "branch", "merge-source", base);
	git(repository, "switch", "merge-source");
	git(repository, "commit", "--allow-empty", "-m", "merge source");
	const mergeSource = git(repository, "rev-parse", "HEAD");
	git(repository, "switch", "main");
	git(repository, "worktree", "add", "-b", "linked", linked, "main");

	let mergeMutations = 0;
	const exec: Exec = async (command, args) => {
		if (command === "git" && (args[0] === "status" || args.join("\0") === STATE_PATH_ARGS.join("\0"))) {
			return runGit(linked, args);
		}
		if (command === "git" && (args[0] === "fetch" || args[0] === "cat-file")) return result();
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") return result(`${expectedHead}\n`);
		if (command === "gh") {
			mergeMutations += 1;
			return result(JSON.stringify({ data: { mergePullRequest: { pullRequest: { id: pullRequestId, state: "MERGED" } } } }));
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	};
	const assertUnsafe = async (operation: string) => {
		assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "", operation);
		await assert.rejects(
			executeGitHubMerge({ ...inspectInput(exec), cwd: linked, pullRequestId, hostname, allowedMergeMethods: ["squash"] }),
			/Local merge safety check failed: worktree is dirty/,
			operation,
		);
		assert.equal(mergeMutations, 0, operation);
	};

	git(linked, "merge", "--no-ff", "--no-commit", mergeSource);
	await assertUnsafe("merge");
	git(linked, "merge", "--abort");

	assert.notEqual(runGit(linked, ["rebase", "--force-rebase", "--exec", "false", base]).code, 0);
	await assertUnsafe("rebase");
	git(linked, "rebase", "--abort");

	assert.notEqual(runGit(linked, ["cherry-pick", firstPick, secondPick]).code, 0);
	git(linked, "checkout", "--ours", "tracked.txt");
	git(linked, "add", "tracked.txt");
	await assertUnsafe("cherry-pick");
	const cherryPickHead = git(linked, "rev-parse", "--git-path", "CHERRY_PICK_HEAD");
	const cherryPickState = readFileSync(cherryPickHead);
	rmSync(cherryPickHead);
	await assertUnsafe("sequencer");
	writeFileSync(cherryPickHead, cherryPickState);
	git(linked, "cherry-pick", "--abort");

	assert.notEqual(runGit(linked, ["revert", "--no-edit", secondPick, firstPick]).code, 0);
	git(linked, "checkout", "--ours", "tracked.txt");
	git(linked, "add", "tracked.txt");
	await assertUnsafe("revert");
	git(linked, "revert", "--abort");
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
			responses: [result(), result(), result(`${expectedHead}\n`), result(`${localAhead}\n`), result("", 1), result("", 0)],
			error: /Local merge safety check failed: worktree is clean, HEAD is ahead/,
		},
		{
			name: "diverged",
			responses: [result(), result(), result(`${expectedHead}\n`), result(`${localDiverged}\n`), result("", 1), result("", 1)],
			error: /Local merge safety check failed: worktree is clean, HEAD is diverged/,
		},
		{
			name: "malformed local HEAD",
			responses: [result(), result(), result(`${expectedHead}\n`), result("short\n")],
			error: /local HEAD must be a full Git OID/,
		},
		{
			name: "missing advertised object",
			responses: [result(), result(), result("", 1, "missing object")],
			error: new RegExp(`git cat-file -e ${expectedHead}\\^\\{commit\\} failed: missing object`),
		},
		{
			name: "fetch failure",
			responses: [result(), result("", 1, "remote unavailable")],
			error: new RegExp(`git fetch --no-write-fetch-head --no-tags --no-recurse-submodules git@github\\.com:acme/fork\\.git ${expectedHead} failed: remote unavailable`),
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
		{ name: "behind", localHead: localBehind, ancestry: [0] },
	];

	for (const candidate of cases) {
		const responses: ExecResult[] = [
			result(),
			result(),
			result(`${expectedHead}\n`),
			result(`${candidate.localHead}\n`),
		];
		for (const code of candidate.ancestry ?? []) responses.push(result("", code));
		responses.push(
			result(),
			result(`${candidate.localHead}\n`),
			result(JSON.stringify({ data: { mergePullRequest: { pullRequest: { id: pullRequestId, state: "MERGED" } } } })),
		);
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
		assert.equal(calls.filter(({ args }) => args.some((arg) => arg.includes("mergePullRequest"))).length, 1, candidate.name);
		assert.equal(calls.filter(({ command, args }) => command === "git" && args[0] === "fetch").length, 1, candidate.name);
		assert.deepEqual(calls.slice(-4, -1).map(command), [
			["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
			["git", STATE_PATH_ARGS],
			["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
		], candidate.name);
	}
});

test("blocks local changes made during readiness without a second fetch or mutation", async (t) => {
	const temporary = mkdtempSync(join(tmpdir(), "pi-pr-final-local-"));
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const operationPath = join(temporary, "MERGE_HEAD");
	const finalStateOutput = [operationPath, ...GIT_OPERATION_STATES.slice(1).map((state) => join(temporary, state))].join("\n") + "\n";
	const cases = [
		{ name: "tracked change", finalStatus: " M tracked.ts\n", error: /worktree is dirty/ },
		{ name: "untracked change", finalStatus: "?? untracked.ts\n", error: /worktree is dirty/ },
		{ name: "HEAD change", finalStatus: "", finalHead: changedHead, error: /HEAD changed/ },
		{ name: "Git operation", finalStatus: "", operation: true, error: /worktree is dirty/ },
	];

	for (const candidate of cases) {
		rmSync(operationPath, { force: true });
		const responses = [
			result(),
			result(),
			result(`${expectedHead}\n`),
			result(`${expectedHead}\n`),
			result(candidate.finalStatus),
		];
		if (!candidate.finalStatus && !candidate.operation) responses.push(result(`${candidate.finalHead!}\n`));
		const { exec, calls } = mockExec(responses, result(finalStateOutput));
		let readinessCalls = 0;
		await assert.rejects(executeGitHubMerge({
			...inspectInput(exec),
			pullRequestId,
			hostname,
			allowedMergeMethods: ["squash"],
			revalidateReadiness: async (local) => {
				readinessCalls += 1;
				assert.deepEqual(local, { worktree: "clean", head: "equal", headOid: expectedHead });
				if (candidate.operation) writeFileSync(operationPath, expectedHead);
			},
		}), candidate.error, candidate.name);
		assert.equal(readinessCalls, 1, candidate.name);
		assert.equal(calls.filter(({ command, args }) => command === "git" && args[0] === "fetch").length, 1, candidate.name);
		assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes("mergePullRequest"))), false, candidate.name);
	}
});

test("runs one readiness evaluation after local inspection and stops on any read failure", async () => {
	for (const candidate of [
		{ name: "read error", error: new Error("readiness unavailable") },
		{ name: "malformed authority", error: new Error("invalid readiness authority") },
	]) {
		const { exec, calls } = mockExec([
			result(),
			result(),
			result(`${expectedHead}\n`),
			result(`${expectedHead}\n`),
		]);
		let readinessCalls = 0;
		await assert.rejects(
			executeGitHubMerge({
				...inspectInput(exec),
				pullRequestId,
				hostname,
				allowedMergeMethods: ["squash"],
				revalidateReadiness: async (local) => {
					readinessCalls += 1;
					assert.deepEqual(local, { worktree: "clean", head: "equal", headOid: expectedHead });
					throw candidate.error;
				},
			}),
			candidate.error,
			candidate.name,
		);
		assert.equal(readinessCalls, 1, candidate.name);
		assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes("mergePullRequest"))), false, candidate.name);
		assert.equal(calls.at(-1)?.args[0], "rev-parse", candidate.name);
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
			result(),
			result(`${expectedHead}\n`),
			result(candidate.output),
		]);
		await assert.rejects(
			executeGitHubMerge({ ...inspectInput(exec), pullRequestId, hostname, allowedMergeMethods: ["squash"] }),
			candidate.error,
			candidate.name,
		);
		assert.equal(calls.length, 9, candidate.name);
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
		result(),
		result(`${expectedHead}\n`),
		result("", 1, "merge blocked"),
	]);

	await assert.rejects(
		executeGitHubMerge({ ...inspectInput(exec), pullRequestId, hostname, allowedMergeMethods: ["squash"] }),
		/gh api graphql --hostname github\.com .* failed: merge blocked/,
	);
	assert.equal(calls.length, 9);
});

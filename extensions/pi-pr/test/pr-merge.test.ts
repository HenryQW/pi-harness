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
		headRepository: "https://github.com/acme/project.git",
		headRef: "feature/pr",
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
			["git", ["fetch", "--no-tags", "https://github.com/acme/project.git", "refs/heads/feature/pr"]],
			["git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]],
			["git", ["rev-parse", "--verify", "HEAD"]],
			...(candidate.ancestry?.map((_, index) => [
				"git",
				index === 0
					? ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]
					: ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"],
			] as [string, string[]]) ?? []),
		], candidate.name);
		assert.ok(calls.every(({ command: executable, args }) =>
			executable !== "git" || !["reset", "rebase", "stash"].includes(args[0] ?? "")
		), candidate.name);
		assert.ok(calls.every(({ args }) => !args.some((arg) => arg === "--force" || arg === "--force-with-lease")), candidate.name);
	}
});

test("fetches before accepting an equal head and rejects a moved head", async () => {
	const { exec, calls } = mockExec([result(), result(), result("moved-head\n")]);

	await assert.rejects(
		inspectLocalMergeSafety(inspectInput(exec)),
		/Fetched PR head moved-head does not match expected PR head expected-head/,
	);
	assert.equal(calls.length, 3);
	assert.deepEqual(command(calls[1]!), [
		"git",
		["fetch", "--no-tags", "https://github.com/acme/project.git", "refs/heads/feature/pr"],
	]);
});

test("surfaces fetch failures without attempting ancestry checks", async () => {
	const { exec, calls } = mockExec([result(), result("", 1, "remote unavailable")]);

	await assert.rejects(
		inspectLocalMergeSafety(inspectInput(exec)),
		/git fetch --no-tags https:\/\/github.com\/acme\/project\.git refs\/heads\/feature\/pr failed: remote unavailable/,
	);
	assert.equal(calls.length, 2);
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

test("does not issue a merge command when fresh local safety checks fail", async () => {
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
			name: "moved head",
			responses: [result(), result(), result("moved-head\n")],
			error: /Fetched PR head moved-head does not match expected PR head expected-head/,
		},
		{
			name: "fetch failure",
			responses: [result(), result("", 1, "remote unavailable")],
			error: /git fetch --no-tags https:\/\/github\.com\/acme\/project\.git refs\/heads\/feature\/pr failed: remote unavailable/,
		},
	];

	for (const candidate of cases) {
		const { exec, calls } = mockExec(candidate.responses);
		await assert.rejects(
			executeGitHubMerge({
				...inspectInput(exec),
				prNumber: 42,
				allowedMergeMethods: ["squash"],
			}),
			candidate.error,
		);
		assert.equal(
			calls.some(({ command: executable, args }) => executable === "gh" && args[0] === "pr" && args[1] === "merge"),
			false,
			candidate.name,
		);
	}
});

test("executes the selected GitHub merge only for equal or behind exact heads", async () => {
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
		responses.push(result());
		const { exec, calls } = mockExec(responses);

		await executeGitHubMerge({
			...inspectInput(exec),
			prNumber: 42,
			allowedMergeMethods: ["merge", "squash"],
			viewerDefaultMergeMethod: "merge",
		});

		assert.deepEqual(calls.at(-1), {
			command: "gh",
			args: ["pr", "merge", "42", "--squash", "--disable-auto"],
			cwd,
		}, candidate.name);
		assert.equal(calls.at(-1)!.args.includes("--auto"), false);
		assert.equal(calls.at(-1)!.args.includes("--delete-branch"), false);
	}
});

test("surfaces GitHub merge failures and does not retry", async () => {
	const { exec, calls } = mockExec([
		result(),
		result(),
		result(`${expectedHead}\n`),
		result(`${expectedHead}\n`),
		result("", 1, "merge blocked"),
	]);

	await assert.rejects(
		executeGitHubMerge({ ...inspectInput(exec), prNumber: 42, allowedMergeMethods: ["squash"] }),
		/gh pr merge 42 --squash --disable-auto failed: merge blocked/,
	);
	assert.equal(calls.length, 5);
});

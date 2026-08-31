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

export type InspectLocalMergeSafetyInput = {
	exec: Exec;
	cwd: string;
	expectedHead: string;
	headRepository: string;
	headRef: string;
};

export type MergeMethodSelectionInput = {
	allowedMergeMethods: readonly MergeMethod[];
	viewerDefaultMergeMethod?: MergeMethod | null;
};

export type ExecuteGitHubMergeInput = MergeMethodSelectionInput & {
	exec: Exec;
	cwd: string;
	prNumber: number;
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

function requiredText(value: string, label: string): string {
	if (!value) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function requiredOutput(result: ExecResult, label: string): string {
	const output = result.stdout.trim();
	if (!output) throw new Error(`${label} returned no output`);
	return output;
}

function validateInspectionInput(input: InspectLocalMergeSafetyInput): void {
	requiredText(input.cwd, "cwd");
	requiredText(input.expectedHead, "expected PR head");
	requiredText(input.headRepository, "PR head repository");
	requiredText(input.headRef, "PR head ref");
	if (typeof input.exec !== "function") throw new TypeError("exec must be a function");
}

/** Inspect local state without changing branches, the index, or the worktree. */
export async function inspectLocalMergeSafety(input: InspectLocalMergeSafetyInput): Promise<LocalMergeSafety> {
	validateInspectionInput(input);

	const status = await runCommand(input.exec, input.cwd, "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
	const worktree = status.stdout.length === 0 ? "clean" : "dirty";

	await runCommand(input.exec, input.cwd, "git", [
		"fetch",
		"--no-tags",
		input.headRepository,
		`refs/heads/${input.headRef}`,
	]);
	const fetchedHead = requiredOutput(
		await runCommand(input.exec, input.cwd, "git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]),
		"FETCH_HEAD",
	);
	if (fetchedHead !== input.expectedHead) {
		throw new Error(`Fetched PR head ${fetchedHead} does not match expected PR head ${input.expectedHead}`);
	}

	const localHead = requiredOutput(
		await runCommand(input.exec, input.cwd, "git", ["rev-parse", "--verify", "HEAD"]),
		"local HEAD",
	);
	if (localHead === fetchedHead) return { worktree, head: "equal" };

	const localAncestor = await runCommand(
		input.exec,
		input.cwd,
		"git",
		["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"],
		[0, 1],
	);
	if (localAncestor.code === 0) return { worktree, head: "behind" };

	const expectedAncestor = await runCommand(
		input.exec,
		input.cwd,
		"git",
		["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"],
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
	requiredText(input.cwd, "cwd");
	if (typeof input.exec !== "function") throw new TypeError("exec must be a function");
	if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) throw new TypeError("prNumber must be a positive safe integer");
}

export async function executeGitHubMerge(input: ExecuteGitHubMergeInput): Promise<void> {
	validateExecuteInput(input);
	const method = selectMergeMethod(input);
	await runCommand(input.exec, input.cwd, "gh", [
		"pr",
		"merge",
		String(input.prNumber),
		`--${method}`,
		"--disable-auto",
	]);
}

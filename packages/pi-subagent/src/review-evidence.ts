import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const REVIEW_MAX_PATHS = 1_000;
export const REVIEW_MAX_PATCH_BYTES = 512 * 1024;

export interface PreparedReviewEvidence {
	base: string;
	tip: string;
	worktree: string;
	changedPaths: string[];
	patchPath: string;
	cleanup: () => Promise<void>;
}

type GitResult = { code: number; stdout: string; stderr: string };

const STDERR_LIMIT = 200;
const git = (args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> =>
	new Promise((resolve) => {
		execFile("git", ["--no-pager", ...args], { cwd, signal }, (error, stdout, stderr) => {
			resolve({
				code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
				stdout: String(stdout),
				stderr: String(stderr).slice(0, STDERR_LIMIT),
			});
		});
	});

function failure(args: readonly string[], result: GitResult): Error {
	const detail = result.stderr.trim();
	return new Error(`git ${args.join(" ")} failed with exit ${result.code}${detail ? `: ${detail}` : ""}`);
}

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const result = await git(args, cwd, signal);
	signal?.throwIfAborted();
	if (result.code !== 0) throw failure(args, result);
	return result.stdout;
}

function line(value: string, field: string): string {
	const result = value.replace(/\r?\n$/, "");
	if (!result || /[\r\n\0]/.test(result)) throw new Error(`Git returned malformed ${field}.`);
	return result;
}

function oid(value: string, field: string): string {
	const result = line(value, field);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result)) throw new Error(`Git returned invalid ${field}.`);
	return result;
}

function requestText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError(`${field} must be non-empty text without NUL bytes.`);
	return value;
}

async function resolveCommit(reference: string, cwd: string, signal?: AbortSignal): Promise<string> {
	requestText(reference, "review ref");
	return oid(await runGit(["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`], cwd, signal), `commit for ${reference}`);
}

function validatePath(path: string): string {
	if (!path || path.includes("\0") || path.includes("�") || isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
		throw new Error(`Git returned malformed or unsupported path: ${JSON.stringify(path)}`);
	}
	return path;
}

function parsePaths(value: string): string[] {
	if (!value) return [];
	if (!value.endsWith("\0") || value.includes("�")) throw new Error("Git returned malformed changed paths.");
	const paths = value.slice(0, -1).split("\0");
	if (paths.length > REVIEW_MAX_PATHS) throw new Error(`Review evidence exceeds ${REVIEW_MAX_PATHS} paths; split the review.`);
	return paths.map(validatePath);
}

function assertSupportedChanges(value: string): void {
	if (!value) return;
	if (!value.endsWith("\0") || value.includes("�")) throw new Error("Git returned malformed raw diff.");
	const fields = value.slice(0, -1).split("\0");
	for (let index = 0; index < fields.length;) {
		const header = fields[index++]!;
		const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z][0-9]*)$/.exec(header);
		if (!match) throw new Error("Git returned malformed raw diff.");
		for (const mode of [match[1], match[2]]) {
			if (mode === "160000") throw new Error("Review evidence rejects changed gitlinks.");
			if (!new Set(["000000", "100644", "100755"]).has(mode!)) {
				throw new Error(`Review evidence rejects unsupported file mode: ${mode}.`);
			}
		}
		const paths = /^[RC]/.test(match[3]!) ? 2 : 1;
		for (let count = 0; count < paths; count++) {
			if (fields[index] === undefined) throw new Error("Git returned malformed raw diff paths.");
			validatePath(fields[index++]!);
		}
	}
}

interface RegisteredWorktree {
	path: string;
	head: string;
}

function registeredWorktrees(value: string): RegisteredWorktree[] {
	if (!value.endsWith("\0") || value.includes("�")) throw new Error("Git returned malformed worktree list.");
	const result: RegisteredWorktree[] = [];
	let record: Partial<RegisteredWorktree> = {};
	for (const field of [...value.slice(0, -1).split("\0"), ""]) {
		if (!field) {
			if (Object.keys(record).length) {
				if (!record.path || !record.head) throw new Error("Git returned malformed worktree registration.");
				result.push(record as RegisteredWorktree);
				record = {};
			}
		} else if (field.startsWith("worktree ")) record.path = field.slice("worktree ".length);
		else if (field.startsWith("HEAD ")) record.head = oid(`${field.slice("HEAD ".length)}\n`, "worktree HEAD");
	}
	return result;
}

async function assertCleanRegisteredWorktree(worktree: string, tip: string, signal?: AbortSignal): Promise<void> {
	const root = await realpath(line(await runGit(["rev-parse", "--show-toplevel"], worktree, signal), "worktree root"));
	if (root !== worktree) throw new Error("Review evidence requires a registered worktree root.");
	const registrations = registeredWorktrees(await runGit(["worktree", "list", "--porcelain", "-z"], worktree, signal));
	const registered = await Promise.all(registrations.map(async (entry) => ({ ...entry, path: await realpath(entry.path) })));
	if (!registered.some((entry) => entry.path === worktree && entry.head === tip)) {
		throw new Error("Review evidence worktree is not registered at the requested tip.");
	}
	if (oid(await runGit(["rev-parse", "HEAD"], worktree, signal), "worktree HEAD") !== tip) {
		throw new Error("Review evidence worktree moved from the requested tip.");
	}
	if (await runGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], worktree, signal)) {
		throw new Error("Review evidence worktree is not clean.");
	}
}

async function streamPatch(base: string, tip: string, worktree: string, path: string, signal?: AbortSignal): Promise<void> {
	const file = await open(path, "wx", 0o600);
	await chmod(path, 0o600);
	try {
		signal?.throwIfAborted();
		const args = ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--binary", base, tip];
		const child = spawn("git", args, { cwd: worktree, signal, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = Buffer.alloc(0);
		let childError: Error | undefined;
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < STDERR_LIMIT) stderr = Buffer.concat([stderr, chunk.subarray(0, STDERR_LIMIT - stderr.length)]);
		});
		child.once("error", (error) => { childError = error; });
		const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
		let bytes = 0;
		let overflow = false;
		let outputError: unknown;
		try {
			for await (const chunk of child.stdout) {
				const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				const available = REVIEW_MAX_PATCH_BYTES + 1 - bytes;
				if (data.length > available) {
					if (available > 0) await file.write(data.subarray(0, available));
					bytes += Math.max(available, 0);
					overflow = true;
					child.kill();
					break;
				}
				await file.write(data);
				bytes += data.length;
			}
		} catch (error) {
			outputError = error;
			child.kill();
		}
		const code = await closed;
		signal?.throwIfAborted();
		if (overflow) throw new Error(`Review evidence exceeds ${REVIEW_MAX_PATCH_BYTES} bytes; split the review.`);
		if (outputError) throw outputError;
		if (childError) throw childError;
		if (code !== 0) throw failure(args, { code: code ?? -1, stdout: "", stderr: stderr.toString() });
	} finally {
		await file.close();
	}
}

async function makeEvidenceDirectory(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-review-"));
	await chmod(directory, 0o700);
	let cleanup: Promise<void> | undefined;
	return {
		directory,
		cleanup: () => cleanup ??= rm(directory, { recursive: true, force: true }),
	};
}

/** Prepares the one exact private patch Flow supplies to its Reviewer. */
export async function prepareExactReviewEvidence(
	request: { base: string; tip: string; worktree: string },
	signal?: AbortSignal,
): Promise<PreparedReviewEvidence> {
	const requestedWorktree = requestText(request.worktree, "review worktree");
	const worktree = await realpath(requestedWorktree);
	const [base, tip] = await Promise.all([
		resolveCommit(request.base, worktree, signal),
		resolveCommit(request.tip, worktree, signal),
	]);
	await assertCleanRegisteredWorktree(worktree, tip, signal);
	const changedPaths = parsePaths(await runGit([
		"diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-only", "-z", base, tip,
	], worktree, signal));
	assertSupportedChanges(await runGit([
		"diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--raw", "-z", base, tip,
	], worktree, signal));
	const owned = await makeEvidenceDirectory();
	const patchPath = join(owned.directory, "review.patch");
	try {
		await streamPatch(base, tip, worktree, patchPath, signal);
		await assertCleanRegisteredWorktree(worktree, tip, signal);
		return { base, tip, worktree, changedPaths, patchPath, cleanup: owned.cleanup };
	} catch (error) {
		await owned.cleanup();
		throw error;
	}
}

import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import { spawnBounded, type Exec, type ExecOptions, type ExecResult } from "@henryqw/pi-process";
import { lock } from "proper-lockfile";

const MAX_CONFLICT_PATHS = 128;
const MAX_CONFLICT_PATH_BYTES = 1_024;
const MAX_CONFLICT_PATHS_BYTES = 32 * 1024;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_OPERATION_STATES = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];
const WORKTREE_LOCK_OPTIONS = { realpath: false, stale: 30_000, update: 5_000, retries: 0 } as const;

export type AttemptState = "none" | "attempting" | "applied" | "blocked" | "unknown";
export type GitWorktreeState = "clean" | "dirty" | "operation";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
	return value;
}

export function requiredOid(value: unknown, label: string): string {
	const parsed = requiredText(value, label).toLowerCase();
	if (!OID.test(parsed)) throw new TypeError(`${label} must be a full Git OID`);
	return parsed;
}

export function parseSingleOutputLine(output: string, label: string): string {
	const normalized = output.replace(/\r\n/g, "\n");
	const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
	if (lines.length !== 1 || !lines[0]) throw new Error(`${label} returned invalid output`);
	return lines[0];
}

export function extensionExecApi(exec: Exec, cwd: string, signal?: AbortSignal): Pick<ExtensionAPI, "exec"> {
	return {
		exec: (command, args, options) => exec(command, args, {
			cwd: options?.cwd ?? cwd,
			signal: options?.signal ?? signal,
			timeoutMs: options?.timeout,
		}),
	} as Pick<ExtensionAPI, "exec">;
}

export async function runChecked(
	exec: Exec,
	command: string,
	args: string[],
	options: ExecOptions,
	allowedCodes: readonly number[] = [0],
): Promise<ExecResult> {
	const result = await exec(command, args, options);
	if (result.killed || !allowedCodes.includes(result.code)) {
		const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "command was killed" : `exit code ${result.code}`);
		throw new Error(`${[command, ...args].join(" ")} failed: ${detail}`);
	}
	return result;
}

/** Return the active Git operation marker without mutating the repository. */
export async function inspectGitOperation(exec: Exec, options: ExecOptions): Promise<string | null> {
	const stateOutput = await runChecked(exec, "git", [
		"rev-parse",
		...GIT_OPERATION_STATES.flatMap((state) => ["--git-path", state]),
	], options);
	const normalized = stateOutput.stdout.replace(/\r\n/g, "\n");
	const statePaths = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
	if (statePaths.length !== GIT_OPERATION_STATES.length || statePaths.some((path) => !path)) {
		throw new Error("Git operation state path resolution returned invalid output");
	}
	for (const [index, path] of statePaths.entries()) {
		try {
			await lstat(resolve(options.cwd, path));
			return GIT_OPERATION_STATES[index]!;
		} catch (error) {
			if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			const code = error && typeof error === "object" && typeof (error as NodeJS.ErrnoException).code === "string"
				? (error as NodeJS.ErrnoException).code
				: String(error);
			throw new Error(`Git operation state inspection failed for ${GIT_OPERATION_STATES[index]}: ${code}`);
		}
	}
	return null;
}

/** Distinguish ordinary pending work from an in-progress Git operation. */
export async function inspectWorktreeState(exec: Exec, options: ExecOptions): Promise<GitWorktreeState> {
	const status = await runChecked(exec, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options);
	if (await inspectGitOperation(exec, options) !== null) return "operation";
	return status.stdout === "" ? "clean" : "dirty";
}

/** Inspect both porcelain state and Git operation markers without mutating the repository. */
export async function inspectWorktree(exec: Exec, options: ExecOptions): Promise<"clean" | "dirty"> {
	return await inspectWorktreeState(exec, options) === "clean" ? "clean" : "dirty";
}

/** Exclude concurrent PR mutations for one canonical worktree and pi-pr namespace. */
export async function withWorktreeLock<T>(
	cwd: string,
	operation: () => Promise<T>,
	options: { agentDir?: string; signal?: AbortSignal } = {},
): Promise<T> {
	options.signal?.throwIfAborted();
	const rootResult = await runChecked(spawnBounded, "git", ["rev-parse", "--show-toplevel"], {
		cwd: requiredText(cwd, "cwd"),
		signal: options.signal,
	});
	const root = parseSingleOutputLine(rootResult.stdout, "Git worktree root resolution");
	const canonical = requiredText(await realpath(root), "canonical Git worktree root");
	const lockNamespace = resolve(extensionConfigDir("pi-pr", options.agentDir));
	const lockDirectory = join(lockNamespace, "worktree-locks");
	const identity = createHash("sha256").update(canonical).digest("hex");
	const lockPath = join(lockDirectory, identity);
	options.signal?.throwIfAborted();
	await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
	options.signal?.throwIfAborted();
	let release: () => Promise<void>;
	try {
		release = await lock(lockPath, {
			...WORKTREE_LOCK_OPTIONS,
			lockfilePath: `${lockPath}.lock`,
		});
	} catch (error) {
		if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ELOCKED") {
			throw new Error("Another pi-pr mutation is active", { cause: error });
		}
		throw error;
	}
	try {
		options.signal?.throwIfAborted();
		return await operation();
	} finally {
		await release();
	}
}

export function parseNulPaths(output: string, label: string): string[] {
	if (output === "") return [];
	if (!output.endsWith("\0")) throw new Error(`${label} returned malformed paths`);
	const paths = output.slice(0, -1).split("\0");
	let bytes = 0;
	if (paths.length > MAX_CONFLICT_PATHS) throw new Error(`${label} returned more than ${MAX_CONFLICT_PATHS} paths`);
	for (const path of paths) {
		if (!path || path.startsWith("/") || path === "." || path === ".." || path.split("/").includes("..")) {
			throw new Error(`${label} returned an unsafe path`);
		}
		const size = Buffer.byteLength(path, "utf8");
		if (size > MAX_CONFLICT_PATH_BYTES) throw new Error(`${label} returned an overlong path`);
		bytes += size;
	}
	if (bytes > MAX_CONFLICT_PATHS_BYTES) throw new Error(`${label} returned too much path data`);
	if (new Set(paths).size !== paths.length) throw new Error(`${label} returned duplicate paths`);
	return paths;
}

export function validateResolvedConflictPaths(paths: readonly string[], expected: readonly string[]): string[] {
	if (!Array.isArray(paths)) throw new TypeError("resolvedPaths must be an array");
	const parsed = parseNulPaths(`${paths.join("\0")}${paths.length ? "\0" : ""}`, "Resolved conflict paths");
	if (expected.some((path) => !parsed.includes(path))) {
		throw new Error("Resolved paths must include every original conflict path");
	}
	return parsed;
}

function statusPath(record: string): { path: string; rename: boolean } {
	if (record.startsWith("? ") || record.startsWith("! ")) return { path: record.slice(2), rename: false };
	const fields = record[0] === "1" ? 8 : record[0] === "2" ? 9 : record[0] === "u" ? 10 : 0;
	if (!fields) throw new Error("Git status returned an unsupported record");
	let separator = -1;
	for (let count = 0; count < fields; count += 1) {
		separator = record.indexOf(" ", separator + 1);
		if (separator < 0) throw new Error("Git status returned a malformed record");
	}
	return { path: record.slice(separator + 1), rename: record[0] === "2" };
}

/** Parse porcelain v2 -z into exact per-path records for conflict-baseline comparison. */
export function parseStatusSnapshot(output: string): Map<string, string> {
	const snapshot = new Map<string, string>();
	if (output === "") return snapshot;
	if (!output.endsWith("\0")) throw new Error("Git status returned a malformed snapshot");
	const records = output.slice(0, -1).split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]!;
		const parsed = statusPath(record);
		if (!parsed.path || snapshot.has(parsed.path)) throw new Error("Git status returned duplicate or empty paths");
		let raw = `${record}\0`;
		const paths = [parsed.path];
		if (parsed.rename) {
			const original = records[++index];
			if (original === undefined || !original || original === parsed.path || snapshot.has(original)) {
				throw new Error("Git status returned a malformed or duplicate rename record");
			}
			raw += `${original}\0`;
			paths.push(original);
		}
		for (const path of paths) snapshot.set(path, raw);
	}
	return snapshot;
}

export function assertOnlyDeclaredStatusChanged(
	baseline: string,
	current: string,
	declaredPaths: readonly string[],
): void {
	const before = parseStatusSnapshot(baseline);
	const after = parseStatusSnapshot(current);
	const declared = new Set(declaredPaths);
	for (const path of new Set([...before.keys(), ...after.keys()])) {
		if (!declared.has(path) && before.get(path) !== after.get(path)) {
			throw new Error(`Worktree changed outside declared conflict paths: ${path}`);
		}
	}
}

export async function readHead(exec: Exec, options: ExecOptions): Promise<string> {
	const result = await runChecked(exec, "git", ["rev-parse", "--verify", "HEAD^{commit}"], options);
	return requiredOid(result.stdout.trim(), "local HEAD");
}

export async function readRemoteOid(
	exec: Exec,
	options: ExecOptions,
	fetchSource: string,
	ref: string,
): Promise<string | null> {
	const result = await runChecked(exec, "git", [
		"ls-remote", "--exit-code", "--refs", fetchSource, `refs/heads/${ref}`,
	], options, [0, 2]);
	if (result.code === 2) {
		if (result.stdout !== "") throw new Error("git ls-remote returned an invalid absent-ref response");
		return null;
	}
	const line = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
	const parts = line.split("\t");
	if (line.includes("\n") || parts.length !== 2 || parts[1] !== `refs/heads/${ref}`) {
		throw new Error("git ls-remote returned an unexpected ref");
	}
	return requiredOid(parts[0], "remote OID");
}

export async function isAncestor(exec: Exec, options: ExecOptions, ancestor: string, descendant: string): Promise<boolean> {
	const result = await runChecked(exec, "git", ["merge-base", "--is-ancestor", ancestor, descendant], options, [0, 1]);
	return result.code === 0;
}

export async function resolveRepositoryFetchSource(
	exec: Exec,
	options: ExecOptions,
	authority: { host: string; repository: string },
): Promise<string> {
	const host = requiredText(authority.host, "repository host").toLowerCase();
	const repository = requiredText(authority.repository, "repository");
	if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new TypeError("repository must be OWNER/REPOSITORY");
	const protocol = (await runChecked(exec, "gh", ["config", "get", "git_protocol", "--host", host], options)).stdout.trim();
	if (protocol !== "https" && protocol !== "ssh") throw new Error("GitHub CLI git protocol must be https or ssh");
	return protocol === "https"
		? `https://${host}/${repository}.git`
		: `git@${host}:${repository}.git`;
}

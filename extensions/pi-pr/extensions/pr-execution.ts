import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { extensionConfigDir } from "@henryqw/pi-config-store";

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const MAX_CONFLICT_PATHS = 128;
export const MAX_CONFLICT_PATH_BYTES = 1_024;
export const MAX_CONFLICT_PATHS_BYTES = 32 * 1024;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_OPERATION_STATES = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];

export type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

export type ExecOptions = {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	stdoutLimitBytes?: number;
	stderrLimitBytes?: number;
	stdin?: string;
};

export type Exec = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export type AttemptState = "none" | "attempting" | "applied" | "blocked" | "unknown";

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
	return value;
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

function validatedArguments(args: string[]): string[] {
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
		throw new TypeError("command arguments must be an array of strings without NUL bytes");
	}
	return args;
}

function decode(chunks: Buffer[], bytes: number, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
	} catch {
		throw new Error(`${label} was not valid UTF-8`);
	}
}

/** Run one argv-only child process with bounded streaming output, cancellation, and a deadline. */
export const spawnBounded: Exec = async (command, args, options) => {
	requiredText(command, "command");
	validatedArguments(args);
	requiredText(options.cwd, "cwd");
	options.signal?.throwIfAborted();
	const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, "timeoutMs");
	const stdoutLimit = positiveInteger(options.stdoutLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES, "stdoutLimitBytes");
	const stderrLimit = positiveInteger(options.stderrLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES, "stderrLimitBytes");
	if (options.stdin !== undefined && typeof options.stdin !== "string") throw new TypeError("stdin must be a string");

	return await new Promise<ExecResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let failure: Error | undefined;
		let killed = false;
		let settled = false;

		const stop = (error: Error): void => {
			if (failure) return;
			failure = error;
			killed = child.kill("SIGTERM") || killed;
		};
		const timer = setTimeout(() => stop(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
		const abort = (): void => stop(options.signal?.reason instanceof Error
			? options.signal.reason
			: new DOMException("The operation was aborted", "AbortError"));
		options.signal?.addEventListener("abort", abort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > stdoutLimit) {
				stop(new Error(`${command} stdout exceeded ${stdoutLimit} bytes`));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > stderrLimit) {
				stop(new Error(`${command} stderr exceeded ${stderrLimit} bytes`));
				return;
			}
			stderr.push(chunk);
		});
		child.once("error", (error) => {
			failure ??= error;
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (failure) {
				reject(failure);
				return;
			}
			try {
				resolve({
					stdout: decode(stdout, stdoutBytes, `${command} stdout`),
					stderr: decode(stderr, stderrBytes, `${command} stderr`),
					code: code ?? 1,
					killed: killed || signal !== null,
				});
			} catch (error) {
				reject(error);
			}
		});
		if (options.stdin === undefined) child.stdin.end();
		else child.stdin.end(options.stdin, "utf8");
	});
};

export function commandText(command: string, args: readonly string[]): string {
	return [command, ...args].join(" ");
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
		throw new Error(`${commandText(command, args)} failed: ${detail}`);
	}
	return result;
}

/** Inspect both porcelain state and Git operation markers without mutating the repository. */
export async function inspectWorktree(exec: Exec, options: ExecOptions): Promise<"clean" | "dirty"> {
	const status = await runChecked(exec, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options);
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
			return "dirty";
		} catch (error) {
			if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			const code = error && typeof error === "object" && typeof (error as NodeJS.ErrnoException).code === "string"
				? (error as NodeJS.ErrnoException).code
				: String(error);
			throw new Error(`Git operation state inspection failed for ${GIT_OPERATION_STATES[index]}: ${code}`);
		}
	}
	return status.stdout === "" ? "clean" : "dirty";
}

/** Exclude concurrent PR mutations for one canonical worktree without a third-party lock. */
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
	const normalizedRoot = rootResult.stdout.replace(/\r\n/g, "\n");
	const rootLines = (normalizedRoot.endsWith("\n") ? normalizedRoot.slice(0, -1) : normalizedRoot).split("\n");
	if (rootLines.length !== 1 || !rootLines[0]) throw new Error("Git worktree root resolution returned invalid output");
	const canonical = await realpath(rootLines[0]);
	const lockDirectory = join(extensionConfigDir("pi-pr", options.agentDir), "locks");
	await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
	const identity = createHash("sha256").update(canonical).digest("hex");
	const lockPath = join(lockDirectory, `${identity}.lock`);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(
			lockPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
	} catch (error) {
		if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Another pi-pr mutation is active for ${canonical}`);
		}
		throw error;
	}
	try {
		options.signal?.throwIfAborted();
		await handle.writeFile(`${process.pid}\n`, "utf8");
		return await operation();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
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
		if (parsed.rename) {
			const original = records[++index];
			if (original === undefined || !original) throw new Error("Git status returned a malformed rename record");
			raw += `${original}\0`;
		}
		snapshot.set(parsed.path, raw);
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
	const response = await runChecked(exec, "gh", [
		"api", "--hostname", host,
		"-H", "Accept: application/vnd.github+json",
		"-H", "X-GitHub-Api-Version: 2022-11-28",
		`repos/${repository}`,
	], options);
	let value: unknown;
	try {
		value = JSON.parse(response.stdout);
	} catch {
		throw new Error("Read repository URLs returned invalid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Read repository URLs returned invalid JSON");
	const record = value as Record<string, unknown>;
	const expectedHttps = `https://${host}/${repository}.git`;
	const expectedSsh = `git@${host}:${repository}.git`;
	if (record.clone_url !== expectedHttps || record.ssh_url !== expectedSsh) {
		throw new Error("Read repository URLs did not match frozen repository authority");
	}
	return protocol === "https" ? expectedHttps : expectedSsh;
}

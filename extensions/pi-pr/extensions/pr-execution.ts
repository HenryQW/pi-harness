import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const MAX_CONFLICT_PATHS = 128;
export const MAX_CONFLICT_PATH_BYTES = 1_024;
export const MAX_CONFLICT_PATHS_BYTES = 32 * 1024;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_OPERATION_STATES = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];
const PROCESS_TERMINATION_GRACE_MS = 250;
const LOCK_OWNER_MAX_BYTES = 128;
const LOCK_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCK_OWNER_PAYLOAD = /^pid=([1-9][0-9]*)\nnonce=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n$/;
const LOCK_REF_PREFIX = "refs/pi-pr/worktree-locks";

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
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes));
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
			detached: process.platform !== "win32",
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const childPid = child.pid;
		const processGroup = process.platform !== "win32" && typeof childPid === "number" &&
			Number.isSafeInteger(childPid) && childPid > 0 ? childPid : null;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let failure: Error | undefined;
		let killed = false;
		let settled = false;

		const signalChild = (signal: NodeJS.Signals): void => {
			if (processGroup !== null) {
				try {
					process.kill(-processGroup, signal);
					killed = true;
					return;
				} catch (error) {
					if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ESRCH") return;
				}
			}
			killed = child.kill(signal) || killed;
		};
		const stop = (error: Error): void => {
			if (failure) return;
			failure = error;
			signalChild("SIGTERM");
			setTimeout(() => signalChild("SIGKILL"), PROCESS_TERMINATION_GRACE_MS);
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

type WorktreeLockOwner = {
	oid: string;
	pid: number;
};

function gitFailure(args: string[], result: ExecResult): Error {
	const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "command was killed" : `exit code ${result.code}`);
	return new Error(`${commandText("git", args)} failed: ${detail}`);
}

function oidLine(output: string, label: string): string {
	const normalized = output.replace(/\r\n/g, "\n");
	if (!normalized.endsWith("\n") || normalized.slice(0, -1).includes("\n")) {
		throw new Error(`${label} returned invalid output`);
	}
	return requiredOid(normalized.slice(0, -1), label);
}

function lockOwnerPid(payload: string): number {
	const match = LOCK_OWNER_PAYLOAD.exec(payload);
	if (!match) throw new Error("Git worktree lock owner object is invalid");
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== match[1]) {
		throw new Error("Git worktree lock owner PID is invalid");
	}
	return pid;
}

function ownerIsDead(pid: number): boolean {
	positiveInteger(pid, "Git worktree lock owner PID");
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function zeroOid(oid: string): string {
	return requiredOid(oid, "Git worktree lock owner OID").replace(/[0-9a-f]/g, "0");
}

async function readWorktreeLock(cwd: string, lockRef: string, signal?: AbortSignal): Promise<WorktreeLockOwner | null> {
	const symbolicArgs = ["symbolic-ref", "-q", lockRef];
	const symbolic = await spawnBounded("git", symbolicArgs, { cwd, signal });
	if (symbolic.killed || (symbolic.code !== 0 && symbolic.code !== 1)) throw gitFailure(symbolicArgs, symbolic);
	if (symbolic.code === 0) throw new Error("Git worktree lock ref is symbolic");
	if (symbolic.stdout !== "" || symbolic.stderr !== "") throw new Error("Git worktree lock symbolic-ref check returned invalid output");

	const refArgs = ["rev-parse", "--verify", "--quiet", lockRef];
	const ref = await spawnBounded("git", refArgs, { cwd, signal });
	if (ref.killed || (ref.code !== 0 && ref.code !== 1)) throw gitFailure(refArgs, ref);
	if (ref.code === 1) {
		if (ref.stdout !== "" || ref.stderr !== "") throw new Error("Git worktree lock ref lookup returned invalid output");
		return null;
	}
	if (ref.stderr !== "") throw new Error("Git worktree lock ref lookup returned invalid output");
	const oid = oidLine(ref.stdout, "Git worktree lock ref");

	const objectArgs = ["cat-file", "blob", oid];
	const object = await runChecked(spawnBounded, "git", objectArgs, {
		cwd,
		signal,
		stdoutLimitBytes: LOCK_OWNER_MAX_BYTES,
		stderrLimitBytes: LOCK_OWNER_MAX_BYTES,
	});
	if (object.stderr !== "") throw new Error("Git worktree lock owner object returned invalid output");
	return { oid, pid: lockOwnerPid(object.stdout) };
}

async function updateWorktreeLock(cwd: string, args: string[]): Promise<boolean> {
	const result = await spawnBounded("git", args, { cwd });
	if (result.killed) throw gitFailure(args, result);
	return result.code === 0;
}

async function createWorktreeLock(cwd: string, lockRef: string, ownerOid: string): Promise<boolean> {
	return await updateWorktreeLock(cwd, ["update-ref", "--no-deref", lockRef, ownerOid, zeroOid(ownerOid)]);
}

async function deleteWorktreeLock(cwd: string, lockRef: string, ownerOid: string): Promise<boolean> {
	return await updateWorktreeLock(cwd, ["update-ref", "--no-deref", "-d", lockRef, ownerOid]);
}

async function releaseWorktreeLock(cwd: string, lockRef: string, ownerOid: string): Promise<void> {
	const args = ["update-ref", "--no-deref", "-d", lockRef, ownerOid];
	const result = await spawnBounded("git", args, { cwd });
	if (result.killed || result.code !== 0) throw gitFailure(args, result);
}

async function acquireWorktreeLock(
	cwd: string,
	canonical: string,
	lockRef: string,
	ownerOid: string,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	if (await createWorktreeLock(cwd, lockRef, ownerOid)) return;
	signal?.throwIfAborted();
	const observed = await readWorktreeLock(cwd, lockRef, signal);
	if (!observed) throw new Error("Git worktree lock acquisition failed without a competing owner");
	if (!ownerIsDead(observed.pid)) throw new Error(`Another pi-pr mutation is active for ${canonical}`);
	signal?.throwIfAborted();
	const reclaimed = await deleteWorktreeLock(cwd, lockRef, observed.oid);
	signal?.throwIfAborted();
	if (await createWorktreeLock(cwd, lockRef, ownerOid)) return;
	const replacement = await readWorktreeLock(cwd, lockRef, signal);
	if (!replacement) throw new Error("Git worktree lock disappeared during stale owner recovery");
	if (!ownerIsDead(replacement.pid)) throw new Error(`Another pi-pr mutation is active for ${canonical}`);
	if (replacement.oid !== observed.oid) throw new Error("Git worktree lock changed during stale owner recovery");
	if (!reclaimed) throw new Error("Git worktree stale lock owner could not be reclaimed");
	throw new Error("Git worktree stale lock owner remained after reclamation");
}

async function writeWorktreeLockOwner(cwd: string, signal?: AbortSignal): Promise<string> {
	const pid = positiveInteger(process.pid, "process PID");
	const nonce = randomUUID();
	if (!LOCK_NONCE.test(nonce)) throw new Error("Generated Git worktree lock nonce is invalid");
	const result = await runChecked(spawnBounded, "git", ["hash-object", "-w", "--stdin", "--no-filters"], {
		cwd,
		signal,
		stdin: `pid=${pid}\nnonce=${nonce}\n`,
	});
	if (result.stderr !== "") throw new Error("Git worktree lock owner creation returned invalid output");
	return oidLine(result.stdout, "Git worktree lock owner");
}

/** Exclude concurrent PR mutations for one canonical worktree with a Git-ref lease. */
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
	const canonical = requiredText(await realpath(rootLines[0]), "canonical Git worktree root");
	const identity = createHash("sha256").update(canonical).digest("hex");
	const lockRef = `${LOCK_REF_PREFIX}/${identity}`;
	const ownerOid = await writeWorktreeLockOwner(canonical, options.signal);
	let acquired = false;
	try {
		await acquireWorktreeLock(canonical, canonical, lockRef, ownerOid, options.signal);
		acquired = true;
		options.signal?.throwIfAborted();
		return await operation();
	} finally {
		if (acquired) await releaseWorktreeLock(canonical, lockRef, ownerOid);
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

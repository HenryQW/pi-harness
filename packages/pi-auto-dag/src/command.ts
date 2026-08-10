import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import type { GateOutputEvidence, RequiredGateEvidence } from "./model.ts";
import { runDirectory } from "./state.ts";

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	outputFiles?: GateOutputFiles;
}

export interface GateOutputFiles {
	stdout: string;
	stderr: string;
}

export interface RequiredGateExecution {
	command: string;
	commit: string;
	exit_code: number;
	output: {
		stdout: string;
		stderr: string;
	};
	output_files?: GateOutputFiles;
}

export interface RecordedGateEvidence {
	review_command?: string;
	review_commit?: string;
	review_exit_code?: number;
	review_stdout?: GateOutputEvidence;
	review_stderr?: GateOutputEvidence;
}

interface CommandOptions {
	cwd: string;
	maxOutputBytes?: number;
	timeoutMs?: number;
	gateProcess?: {
		path: string;
		command: string;
		commit: string;
		ignoredSnapshotPath?: string;
	};
}

/** One small command seam covers installed Git, Herdr, and gh CLIs in tests. */
export type CommandRunner = (
	command: string,
	arguments_: readonly string[],
	options: CommandOptions,
) => Promise<CommandResult>;

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const OUTPUT_OVERFLOW_EXIT_CODE = 125;
const execFile = promisify(execFileCallback);

export const runCommand: CommandRunner = async (command, arguments_, options) => {
	const timed = options.timeoutMs !== undefined;
	const grouped = timed && process.platform !== "win32";
	const outputFiles = options.gateProcess ? gateOutputFiles(options.gateProcess.path) : undefined;
	if (outputFiles) await mkdir(dirname(outputFiles.stdout), { recursive: true });
	const outputStreams = outputFiles ? {
		stdout: createWriteStream(outputFiles.stdout, { mode: 0o600 }),
		stderr: createWriteStream(outputFiles.stderr, { mode: 0o600 }),
	} : undefined;
	const child = spawn(command, arguments_, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: grouped,
	});
	const outputCompletion = outputStreams
		? Promise.all([finished(outputStreams.stdout), finished(outputStreams.stderr)])
		: Promise.resolve();
	void outputCompletion.catch(() => undefined);
	if (outputStreams) {
		child.stdout.pipe(outputStreams.stdout);
		child.stderr.pipe(outputStreams.stderr);
	}
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	let outputBytes = 0;
	let settled = false;
	let closing = false;
	let timedOut = false;
	let overflowed = false;
	let forceKill: NodeJS.Timeout | undefined;
	const kill = (signal: NodeJS.Signals): boolean => child.pid !== undefined && signalProcess(child.pid, grouped, signal);
	const completion = new Promise<CommandResult>((resolve, reject) => {
		const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			forceKill = setTimeout(() => kill("SIGKILL"), 1_000);
		}, options.timeoutMs);
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (forceKill) clearTimeout(forceKill);
			reject(error);
		};
		const collect = (chunks: Buffer[], chunk: Buffer): void => {
			if (settled) return;
			outputBytes += chunk.length;
			if (outputBytes > maxOutputBytes && !overflowed) {
				overflowed = true;
				kill("SIGKILL");
				if (!outputFiles) {
					fail(new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
					return;
				}
			}
			if (!outputFiles) chunks.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.on("error", fail);
		child.on("close", (code) => {
			if (settled || closing) return;
			closing = true;
			if (timeout) clearTimeout(timeout);
			void (async () => {
				if (grouped && child.pid !== undefined) await terminateProcess(child.pid, true);
				if (forceKill) clearTimeout(forceKill);
				await outputCompletion;
				settled = true;
				resolve({
					code: timedOut ? 124 : overflowed ? OUTPUT_OVERFLOW_EXIT_CODE : code ?? 1,
					stdout: outputFiles ? "" : Buffer.concat(stdout).toString("utf8"),
					stderr: outputFiles ? "" : Buffer.concat(stderr).toString("utf8"),
					...(outputFiles ? { outputFiles } : {}),
				});
			})().catch(fail);
		});
	});
	void completion.catch(() => undefined);
	const pid = child.pid;
	try {
		if (options.gateProcess) {
			if (pid === undefined) throw new Error("Required gate process has no PID");
			const identity = await processIdentity(pid);
			if (identity && child.exitCode === null && child.signalCode === null) {
				await writeGateProcess(options.gateProcess.path, {
					version: 1,
					pid,
					grouped,
					identity,
					cwd: options.cwd,
					command: options.gateProcess.command,
					commit: options.gateProcess.commit,
					ignored_snapshot: options.gateProcess.ignoredSnapshotPath,
					output_files: outputFiles,
				});
			}
		}
		return await completion;
	} catch (error) {
		kill("SIGKILL");
		await completion.catch(() => undefined);
		if (outputFiles) await removeGateOutputFiles(outputFiles);
		throw error;
	}
};

interface GateProcessRecord {
	version: 1;
	pid: number;
	grouped: boolean;
	identity?: string;
	cwd: string;
	command: string;
	commit: string;
	ignored_snapshot?: string;
	output_files?: GateOutputFiles;
}

export function requiredGateProcessPath(mainWorktree: string, runId: string): string {
	return join(runDirectory(mainWorktree, runId), "required-gate-process.json");
}

export async function reconcileRequiredGateProcess(
	runner: CommandRunner,
	path: string,
	delay: (milliseconds: number) => Promise<void> = async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
	const record = await readGateProcess(path);
	if (!record) return;
	if (!record.identity) throw new Error("Required gate process record lacks a safe process identity");
	if (await processIdentity(record.pid) === record.identity) {
		if (signalProcess(record.pid, record.grouped, "SIGTERM")) {
			await delay(100);
			signalProcess(record.pid, record.grouped, "SIGKILL");
			await delay(100);
		}
	}
	const ignoredBefore = record.ignored_snapshot ? await readIgnoredSnapshot(record.ignored_snapshot) : undefined;
	await restoreCleanCommit(runner, record.commit, record.cwd, ignoredBefore);
	if (record.output_files) await removeGateOutputFiles(record.output_files);
	if (record.ignored_snapshot) await removeFile(record.ignored_snapshot);
	await removeFile(path);
}

export async function runRequiredGate(
	runner: CommandRunner,
	command: string,
	commit: string,
	cwd: string,
	timeoutMs?: number,
	processPath?: string,
): Promise<RequiredGateExecution> {
	if (processPath) await reconcileRequiredGateProcess(runner, processPath);
	const ignoredBefore = await ignoredWorktreeFiles(runner, cwd);
	const ignoredSnapshotPath = processPath ? `${processPath}.ignored` : undefined;
	if (ignoredSnapshotPath) await writeIgnoredSnapshot(ignoredSnapshotPath, ignoredBefore);
	try {
		const result = await runner("sh", ["-c", command], {
			cwd,
			timeoutMs,
			...(processPath ? { gateProcess: { path: processPath, command, commit, ignoredSnapshotPath } } : {}),
		});
		return {
			command,
			commit,
			exit_code: result.code,
			output: { stdout: result.stdout, stderr: result.stderr },
			...(result.outputFiles ? { output_files: result.outputFiles } : {}),
		};
	} finally {
		await restoreCleanCommit(runner, commit, cwd, ignoredBefore);
		if (processPath) await removeGateProcess(processPath);
		if (ignoredSnapshotPath) await removeFile(ignoredSnapshotPath);
	}
}

export async function restoreCleanCommit(
	runner: CommandRunner,
	commit: string,
	cwd: string,
	ignoredBefore?: readonly string[],
): Promise<void> {
	await commandOutput(runner, "git", ["reset", "--hard", commit], cwd);
	const status = await commandOutput(runner, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
	for (const entry of status.split("\0").filter(Boolean)) {
		if (!entry.startsWith("?? ")) throw new Error(`Required gate left tracked worktree changes after reset: ${entry.slice(0, 2)}`);
		await rm(safeWorktreePath(cwd, entry.slice(3)), { recursive: true, force: true });
	}
	if (ignoredBefore) {
		const baseline = new Set(ignoredBefore);
		for (const path of await ignoredWorktreeFiles(runner, cwd)) {
			if (!baseline.has(path)) await rm(safeWorktreePath(cwd, path), { recursive: true, force: true });
		}
	}
	if (await commandOutput(runner, "git", ["status", "--porcelain"], cwd)) {
		throw new Error("Required gate worktree cleanup failed");
	}
}

/** Copy checkout-local ignored tools into a disposable gate worktree without sharing mutable files. */
export async function copyIgnoredResources(runner: CommandRunner, source: string, target: string): Promise<void> {
	for (const path of await ignoredWorktreeRoots(runner, source)) {
		const destination = safeWorktreePath(target, path);
		await mkdir(dirname(destination), { recursive: true });
		await cp(safeWorktreePath(source, path), destination, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true });
	}
}

async function writeGateProcess(path: string, record: GateProcessRecord): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

async function removeGateProcess(path: string): Promise<void> {
	await removeFile(path);
}

async function readGateProcess(path: string): Promise<GateProcessRecord | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Required gate process record must be an object");
	const input = value as Record<string, unknown>;
	if (input.version !== 1) throw new Error("Unsupported required gate process record version");
	if (!Number.isSafeInteger(input.pid) || (input.pid as number) <= 0) throw new Error("Required gate process PID must be a positive integer");
	if (typeof input.grouped !== "boolean") throw new Error("Required gate process grouped must be boolean");
	for (const key of ["cwd", "command", "commit"] as const) {
		if (typeof input[key] !== "string" || !input[key]) throw new Error(`Required gate process ${key} must be a non-empty string`);
	}
	if (input.identity !== undefined && (typeof input.identity !== "string" || !input.identity)) throw new Error("Required gate process identity must be a non-empty string");
	if (input.ignored_snapshot !== undefined && (typeof input.ignored_snapshot !== "string" || !input.ignored_snapshot)) throw new Error("Required gate ignored snapshot must be a non-empty string");
	if (input.output_files !== undefined) {
		if (!input.output_files || typeof input.output_files !== "object" || Array.isArray(input.output_files)) throw new Error("Required gate output files must be an object");
		const files = input.output_files as Record<string, unknown>;
		for (const stream of ["stdout", "stderr"] as const) {
			if (typeof files[stream] !== "string" || !files[stream]) throw new Error(`Required gate ${stream} output file must be a non-empty string`);
		}
	}
	return input as unknown as GateProcessRecord;
}

function signalProcess(pid: number, grouped: boolean, signal: NodeJS.Signals): boolean {
	try {
		process.kill(grouped ? -pid : pid, signal);
		return true;
	} catch (error) {
		if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

async function terminateProcess(pid: number, grouped: boolean): Promise<void> {
	if (!signalProcess(pid, grouped, "SIGTERM")) return;
	await new Promise((resolve) => setTimeout(resolve, 100));
	signalProcess(pid, grouped, "SIGKILL");
}

async function processIdentity(pid: number): Promise<string | undefined> {
	if (process.platform === "linux") {
		try {
			const [bootId, stat] = await Promise.all([
				readFile("/proc/sys/kernel/random/boot_id", "utf8"),
				readFile(`/proc/${pid}/stat`, "utf8"),
			]);
			const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
			const started = fields[19];
			if (!started) throw new Error("Linux process stat lacks start time");
			return `linux:${bootId.trim()}:${started}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	try {
		const { stdout } = await execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
		const started = stdout.trim();
		return started ? `${process.platform}:${started}` : undefined;
	} catch (error) {
		if (String((error as NodeJS.ErrnoException).code) === "1") return undefined;
		throw error;
	}
}

function gateOutputFiles(processPath: string): GateOutputFiles {
	const id = randomUUID();
	return {
		stdout: `${processPath}.${id}.stdout`,
		stderr: `${processPath}.${id}.stderr`,
	};
}

async function removeGateOutputFiles(files: GateOutputFiles): Promise<void> {
	await Promise.all([removeFile(files.stdout), removeFile(files.stderr)]);
}

async function removeFile(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

async function writeIgnoredSnapshot(path: string, entries: readonly string[]): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(entries)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

async function readIgnoredSnapshot(path: string): Promise<string[]> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) throw new Error("Required gate ignored snapshot must be a string array");
	return value;
}

async function ignoredWorktreeFiles(runner: CommandRunner, cwd: string): Promise<string[]> {
	const output = await commandOutput(runner, "git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], cwd);
	return output.split("\0").filter((path) => path && !isOrchestrationContext(path));
}

async function ignoredWorktreeRoots(runner: CommandRunner, cwd: string): Promise<string[]> {
	const output = await commandOutput(runner, "git", ["status", "--ignored=matching", "--porcelain=v1", "-z", "--untracked-files=normal"], cwd);
	return output.split("\0")
		.filter((entry) => entry.startsWith("!! "))
		.map((entry) => entry.slice(3).replace(/\/$/, ""))
		.filter((path) => path && !isOrchestrationContext(path));
}

function isOrchestrationContext(path: string): boolean {
	return path === ".context" || path.startsWith(".context/");
}

function safeWorktreePath(cwd: string, path: string): string {
	const root = resolve(cwd);
	const absolute = resolve(root, path);
	const fromRoot = relative(root, absolute);
	if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Required gate produced an unsafe worktree path");
	return absolute;
}

export function recordedGateEvidence(
	record: RecordedGateEvidence,
	commit: string,
): RequiredGateEvidence | undefined {
	if (
		record.review_command === undefined
		|| record.review_commit !== commit
		|| record.review_exit_code === undefined
		|| record.review_stdout === undefined
		|| record.review_stderr === undefined
	) return undefined;
	return {
		command: record.review_command,
		commit,
		exit_code: record.review_exit_code,
		output: { stdout: record.review_stdout, stderr: record.review_stderr },
	};
}

export function gateEvidenceRecord(evidence: RequiredGateEvidence): Required<RecordedGateEvidence> {
	return {
		review_command: evidence.command,
		review_commit: evidence.commit,
		review_exit_code: evidence.exit_code,
		review_stdout: evidence.output.stdout,
		review_stderr: evidence.output.stderr,
	};
}

export async function commandOutput(
	runner: CommandRunner,
	command: string,
	arguments_: readonly string[],
	cwd: string,
): Promise<string> {
	const result = await runner(command, arguments_, { cwd });
	if (result.code !== 0) throw new Error(commandFailure(command, arguments_, result));
	return result.stdout.trim();
}

export function commandFailure(command: string, args: readonly string[], result: CommandResult): string {
	return `${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

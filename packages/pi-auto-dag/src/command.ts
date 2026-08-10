import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
		headRef?: string | null;
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
const GATE_HOST_PATH = fileURLToPath(new URL("./gate-host.ts", import.meta.url));
const execFile = promisify(execFileCallback);

export const runCommand: CommandRunner = async (command, arguments_, options) => {
	const timed = options.timeoutMs !== undefined;
	const grouped = timed && process.platform !== "win32";
	const outputFiles = options.gateProcess ? gateOutputFiles(options.gateProcess.path) : undefined;
	if (outputFiles) await mkdir(dirname(outputFiles.stdout), { recursive: true });
	const launchId = options.gateProcess ? randomUUID() : undefined;
	const releasePath = options.gateProcess ? `${options.gateProcess.path}.${launchId}.release` : undefined;
	if (options.gateProcess && launchId && releasePath) {
		await writeGateProcess(options.gateProcess.path, {
			version: 2,
			phase: "launching",
			launch_id: launchId,
			grouped,
			release: releasePath,
			cwd: options.cwd,
			command: options.gateProcess.command,
			commit: options.gateProcess.commit,
			head_ref: options.gateProcess.headRef,
			ignored_snapshot: options.gateProcess.ignoredSnapshotPath,
			output_files: outputFiles,
		});
	}
	const outputStreams = outputFiles ? {
		stdout: createWriteStream(outputFiles.stdout, { mode: 0o600 }),
		stderr: createWriteStream(outputFiles.stderr, { mode: 0o600 }),
	} : undefined;
	const child = spawn(
		options.gateProcess ? process.execPath : command,
		options.gateProcess ? [GATE_HOST_PATH, options.gateProcess.path, launchId!, command, ...arguments_] : arguments_,
		{
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: grouped,
		},
	);
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
	try {
		if (options.gateProcess) {
			if (child.pid === undefined) throw new Error("Required gate process has no PID");
			await waitForGateHost(options.gateProcess.path, launchId!, child.pid, child);
			await writeFile(releasePath!, "run\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
		}
		return await completion;
	} catch (error) {
		kill("SIGKILL");
		await completion.catch(() => undefined);
		if (outputFiles) await removeGateOutputFiles(outputFiles);
		throw error;
	}
};

interface GateProcessRecordBase {
	version: 2;
	launch_id: string;
	grouped: boolean;
	release: string;
	cwd: string;
	command: string;
	commit: string;
	head_ref?: string | null;
	ignored_snapshot?: string;
	output_files?: GateOutputFiles;
}

interface LaunchingGateProcessRecord extends GateProcessRecordBase {
	phase: "launching";
}

interface ReadyGateProcessRecord extends GateProcessRecordBase {
	phase: "ready";
	pid: number;
	identity: string;
}

type GateProcessRecord = LaunchingGateProcessRecord | ReadyGateProcessRecord;

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
	if (record.phase === "ready" && await processIdentity(record.pid) === record.identity) {
		if (signalProcess(record.pid, record.grouped, "SIGTERM")) {
			await delay(100);
			signalProcess(record.pid, record.grouped, "SIGKILL");
			await delay(100);
		}
	}
	await restoreCleanCommit(runner, record.commit, record.cwd, record.ignored_snapshot, record.head_ref);
	if (record.output_files) await removeGateOutputFiles(record.output_files);
	if (record.ignored_snapshot) await rm(record.ignored_snapshot, { recursive: true, force: true });
	await removeFile(record.release);
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
	const temporarySnapshotRoot = processPath ? undefined : await mkdtemp(join(tmpdir(), "pi-auto-dag-gate-"));
	const ignoredSnapshotPath = processPath ? `${processPath}.ignored` : join(temporarySnapshotRoot!, "ignored");
	await rm(ignoredSnapshotPath, { recursive: true, force: true });
	await writeIgnoredSnapshot(ignoredSnapshotPath, cwd, runner);
	const headRef = await currentHeadRef(runner, cwd);
	try {
		const result = await runner("sh", ["-c", command], {
			cwd,
			timeoutMs,
			...(processPath ? { gateProcess: { path: processPath, command, commit, ignoredSnapshotPath, headRef } } : {}),
		});
		return {
			command,
			commit,
			exit_code: result.code,
			output: { stdout: result.stdout, stderr: result.stderr },
			...(result.outputFiles ? { output_files: result.outputFiles } : {}),
		};
	} finally {
		await restoreCleanCommit(runner, commit, cwd, ignoredSnapshotPath, headRef);
		if (processPath) await removeGateProcess(processPath);
		await rm(ignoredSnapshotPath, { recursive: true, force: true });
		if (temporarySnapshotRoot) await rm(temporarySnapshotRoot, { recursive: true, force: true });
	}
}

export async function restoreCleanCommit(
	runner: CommandRunner,
	commit: string,
	cwd: string,
	ignoredSnapshotPath?: string,
	headRef?: string | null,
): Promise<void> {
	if (headRef === null) await commandOutput(runner, "git", ["checkout", "--detach", "--force", commit], cwd);
	else if (headRef !== undefined) await commandOutput(runner, "git", ["symbolic-ref", "HEAD", headRef], cwd);
	await commandOutput(runner, "git", ["reset", "--hard", commit], cwd);
	const status = await commandOutput(runner, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
	for (const entry of status.split("\0").filter(Boolean)) {
		if (!entry.startsWith("?? ")) throw new Error(`Required gate left tracked worktree changes after reset: ${entry.slice(0, 2)}`);
		await rm(safeWorktreePath(cwd, entry.slice(3)), { recursive: true, force: true });
	}
	if (ignoredSnapshotPath) await restoreIgnoredSnapshot(ignoredSnapshotPath, cwd, runner);
	if (await commandOutput(runner, "git", ["status", "--porcelain"], cwd)) {
		throw new Error("Required gate worktree cleanup failed");
	}
}

/** Copy checkout-local ignored tools into a disposable gate worktree without sharing mutable files. */
export async function copyIgnoredResources(runner: CommandRunner, source: string, target: string): Promise<void> {
	for (const path of await ignoredWorktreeRoots(runner, source)) {
		await copyResource(safeWorktreePath(source, path), safeWorktreePath(target, path));
	}
}

async function writeGateProcess(path: string, record: GateProcessRecord): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

async function removeGateProcess(path: string): Promise<void> {
	const record = await readGateProcess(path);
	if (record) await removeFile(record.release);
	await removeFile(path);
}

export async function markGateHostReady(path: string, launchId: string): Promise<string> {
	const record = await readGateProcess(path);
	if (!record || record.phase !== "launching" || record.launch_id !== launchId) {
		throw new Error("Required gate launch intent does not match gate host");
	}
	const identity = await processIdentity(process.pid);
	if (!identity) throw new Error("Required gate host lacks a safe process identity");
	await writeGateProcess(path, { ...record, phase: "ready", pid: process.pid, identity });
	return record.release;
}

async function waitForGateHost(
	path: string,
	launchId: string,
	pid: number,
	child: { exitCode: number | null; signalCode: NodeJS.Signals | null },
): Promise<boolean> {
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		const record = await readGateProcess(path);
		if (record?.phase === "ready") {
			if (record.launch_id !== launchId || record.pid !== pid) throw new Error("Required gate host identity does not match launch intent");
			return true;
		}
		if (child.exitCode !== null || child.signalCode !== null) return false;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Required gate host did not acknowledge launch intent");
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
	if (input.version !== 2) throw new Error("Unsupported required gate process record version");
	if (!["launching", "ready"].includes(String(input.phase))) throw new Error("Required gate process phase is invalid");
	if (typeof input.grouped !== "boolean") throw new Error("Required gate process grouped must be boolean");
	for (const key of ["launch_id", "release", "cwd", "command", "commit"] as const) {
		if (typeof input[key] !== "string" || !input[key]) throw new Error(`Required gate process ${key} must be a non-empty string`);
	}
	if (input.phase === "ready") {
		if (!Number.isSafeInteger(input.pid) || (input.pid as number) <= 0) throw new Error("Required gate process PID must be a positive integer");
		if (typeof input.identity !== "string" || !input.identity) throw new Error("Required gate process identity must be a non-empty string");
	}
	if (input.head_ref !== undefined && input.head_ref !== null && (typeof input.head_ref !== "string" || !input.head_ref)) throw new Error("Required gate head ref must be a non-empty string or null");
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
			if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
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

async function writeIgnoredSnapshot(path: string, cwd: string, runner: CommandRunner): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const roots = await ignoredWorktreeRoots(runner, cwd);
	try {
		await mkdir(join(temporary, "contents"), { recursive: true });
		for (const root of roots) {
			await copyResource(safeWorktreePath(cwd, root), safeWorktreePath(join(temporary, "contents"), root));
		}
		await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(roots)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
}

async function restoreIgnoredSnapshot(path: string, cwd: string, runner: CommandRunner): Promise<void> {
	const roots = await readIgnoredSnapshot(path);
	for (const root of await ignoredWorktreeRoots(runner, cwd)) {
		await rm(safeWorktreePath(cwd, root), { recursive: true, force: true });
	}
	for (const root of roots) {
		await copyResource(safeWorktreePath(join(path, "contents"), root), safeWorktreePath(cwd, root));
	}
}

async function readIgnoredSnapshot(path: string): Promise<string[]> {
	const value: unknown = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) throw new Error("Required gate ignored snapshot manifest must be a string array");
	return value;
}

async function copyResource(source: string, target: string): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	await cp(source, target, {
		recursive: true,
		preserveTimestamps: true,
		force: false,
		errorOnExist: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
	});
}

async function currentHeadRef(runner: CommandRunner, cwd: string): Promise<string | null> {
	const args = ["symbolic-ref", "--quiet", "HEAD"];
	const result = await runner("git", args, { cwd });
	if (result.code === 1) return null;
	if (result.code !== 0) throw new Error(commandFailure("git", args, result));
	const ref = result.stdout.trim();
	if (!ref) throw new Error("Git reported an empty required gate head ref");
	return ref;
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

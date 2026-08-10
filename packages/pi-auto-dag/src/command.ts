import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

export type GateEvidenceTarget =
	| { kind: "task"; issue_id: string }
	| { kind: "health"; issue_id: string };

export interface RequiredGateExecution {
	command: string;
	commit: string;
	exit_code: number;
	output: {
		stdout: string;
		stderr: string;
	};
	output_files?: GateOutputFiles;
	handoff?: {
		launch_id: string;
		target: GateEvidenceTarget;
		cwd: string;
	};
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
		target: GateEvidenceTarget;
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
const GATE_HOST_PATH = fileURLToPath(new URL("./gate-host.mjs", import.meta.url));
const execFile = promisify(execFileCallback);

export const runCommand: CommandRunner = async (command, arguments_, options) => {
	const timed = options.timeoutMs !== undefined;
	const grouped = (timed || options.gateProcess !== undefined) && process.platform !== "win32";
	const outputFiles = options.gateProcess ? gateOutputFiles(options.gateProcess.path) : undefined;
	if (outputFiles) await mkdir(dirname(outputFiles.stdout), { recursive: true });
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const launchId = options.gateProcess ? randomUUID() : undefined;
	const releasePath = options.gateProcess ? `${options.gateProcess.path}.${launchId}.release` : undefined;
	if (options.gateProcess && launchId && releasePath) {
		await writeGateProcess(options.gateProcess.path, {
			version: 4,
			phase: "launching",
			launch_id: launchId,
			grouped,
			release: releasePath,
			cwd: options.cwd,
			command: options.gateProcess.command,
			commit: options.gateProcess.commit,
			target: options.gateProcess.target,
			head_ref: options.gateProcess.headRef,
			ignored_snapshot: options.gateProcess.ignoredSnapshotPath,
			output_files: outputFiles,
			max_output_bytes: maxOutputBytes,
			timeout_ms: options.timeoutMs,
		});
	}
	const child = spawn(
		options.gateProcess ? process.execPath : command,
		options.gateProcess ? [GATE_HOST_PATH, options.gateProcess.path, launchId!, command, ...arguments_] : arguments_,
		{
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: grouped,
		},
	);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let outputBytes = 0;
	let settled = false;
	let closing = false;
	let timedOut = false;
	let overflowed = false;
	let timeout: NodeJS.Timeout | undefined;
	let forceKill: NodeJS.Timeout | undefined;
	const kill = (signal: NodeJS.Signals): boolean => child.pid !== undefined && signalProcess(child.pid, grouped, signal);
	const armTimeout = (): void => {
		if (options.timeoutMs === undefined || settled) return;
		timeout = setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			forceKill = setTimeout(() => kill("SIGKILL"), 1_000);
		}, options.timeoutMs);
	};
	const completion = new Promise<CommandResult>((resolve, reject) => {
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
				let exitCode = timedOut ? 124 : overflowed ? OUTPUT_OVERFLOW_EXIT_CODE : code ?? 1;
				if (options.gateProcess) exitCode = await gateHostExitCode(options.gateProcess.path, launchId!, exitCode, timedOut);
				const result = {
					code: exitCode,
					stdout: outputFiles ? "" : Buffer.concat(stdout).toString("utf8"),
					stderr: outputFiles ? "" : Buffer.concat(stderr).toString("utf8"),
					...(outputFiles ? { outputFiles } : {}),
				};
				settled = true;
				resolve(result);
			})().catch(fail);
		});
	});
	void completion.catch(() => undefined);
	if (!options.gateProcess) armTimeout();
	try {
		if (options.gateProcess) {
			if (child.pid === undefined) throw new Error("Required gate process has no PID");
			await waitForGateHost(options.gateProcess.path, launchId!, child.pid, child);
			await writeFile(releasePath!, "run\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
			armTimeout();
		}
		return await completion;
	} catch (error) {
		if (child.pid !== undefined) await terminateProcess(child.pid, grouped);
		await completion.catch(() => undefined);
		if (outputFiles) await removeGateOutputFiles(outputFiles);
		throw error;
	}
};

interface GateProcessRecord {
	version: 3 | 4;
	phase: "launching" | "completed";
	launch_id: string;
	grouped: boolean;
	release: string;
	cwd: string;
	command: string;
	commit: string;
	target?: GateEvidenceTarget;
	head_ref?: string | null;
	ignored_snapshot?: string;
	output_files?: GateOutputFiles;
	max_output_bytes?: number;
	timeout_ms?: number;
	exit_code?: number;
	cleanup_complete?: boolean;
}

interface GateHostRecord {
	version: 1;
	launch_id: string;
	pid: number;
	identity: string;
}

export interface GateHostControl {
	release: string;
	cancel: string;
	ready: string;
	output_files: GateOutputFiles;
	max_output_bytes: number;
	timeout_ms?: number;
}

export function requiredGateProcessPath(mainWorktree: string, runId: string): string {
	return join(runDirectory(mainWorktree, runId), "required-gate-process.json");
}

export async function reconcileRequiredGateProcess(
	runner: CommandRunner,
	path: string,
	delay: (milliseconds: number) => Promise<void> = async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<RequiredGateExecution | undefined> {
	const record = await readGateProcess(path);
	if (!record) return undefined;
	if (record.phase === "completed") return await recoverCompletedGate(runner, path, record);
	const cancelPath = gateHostCancelPath(path, record.launch_id);
	await writeGateCancellation(cancelPath);
	const host = await readGateHost(gateHostReadyPath(path, record.launch_id));
	if (host && await processIdentity(host.pid) === host.identity) {
		if (signalProcess(host.pid, record.grouped, "SIGTERM")) {
			await delay(100);
			signalProcess(host.pid, record.grouped, "SIGKILL");
			await delay(100);
		}
	}
	const latest = await readGateProcess(path);
	if (latest?.phase === "completed") {
		await removeGateControlFiles(path, latest);
		return await recoverCompletedGate(runner, path, latest);
	}
	if (latest && latest.launch_id !== record.launch_id) throw new Error("Required gate launch changed during reconciliation");
	await restoreCleanCommit(runner, record.commit, record.cwd, record.ignored_snapshot, record.head_ref);
	if (record.output_files) await removeGateOutputFiles(record.output_files);
	if (record.ignored_snapshot) await rm(record.ignored_snapshot, { recursive: true, force: true });
	await removeFile(record.release);
	await removeFile(gateHostReadyPath(path, record.launch_id));
	if (host) await removeFile(cancelPath);
	await removeFile(path);
	return undefined;
}

async function recoverCompletedGate(runner: CommandRunner, path: string, record: GateProcessRecord): Promise<RequiredGateExecution> {
	if (!record.cleanup_complete) {
		await restoreCleanCommit(runner, record.commit, record.cwd, record.ignored_snapshot, record.head_ref);
		await markGateCleanupComplete(path, record.launch_id);
	}
	return completedGateExecution(record);
}

export async function runRequiredGate(
	runner: CommandRunner,
	command: string,
	commit: string,
	cwd: string,
	timeoutMs?: number,
	processPath?: string,
	target?: GateEvidenceTarget,
): Promise<RequiredGateExecution> {
	if (process.platform === "win32") throw new Error("Required gates support only POSIX hosts");
	if (processPath && !target) throw new Error("Durable required gate needs an evidence target");
	if (processPath) {
		const recovered = await reconcileRequiredGateProcess(runner, processPath);
		if (recovered) {
			if (
				recovered.command !== command
				|| recovered.commit !== commit
				|| resolve(recovered.handoff!.cwd) !== resolve(cwd)
				|| !sameGateTarget(recovered.handoff!.target, target!)
			) throw new Error("Completed required gate handoff does not match requested gate");
			return recovered;
		}
	}
	const temporarySnapshotRoot = processPath ? undefined : await mkdtemp(join(tmpdir(), "pi-auto-dag-gate-"));
	const ignoredSnapshotPath = processPath ? `${processPath}.ignored` : join(temporarySnapshotRoot!, "ignored");
	await rm(ignoredSnapshotPath, { recursive: true, force: true });
	await writeIgnoredSnapshot(ignoredSnapshotPath, cwd, runner);
	const headRef = await currentHeadRef(runner, cwd);
	let handoff: RequiredGateExecution["handoff"];
	try {
		const result = await runner("sh", ["-c", command], {
			cwd,
			timeoutMs,
			...(processPath ? { gateProcess: { path: processPath, command, commit, target: target!, ignoredSnapshotPath, headRef } } : {}),
		});
		const record = processPath ? await readGateProcess(processPath) : undefined;
		if (record?.phase === "completed") handoff = completedGateExecution(record).handoff;
		return {
			command,
			commit,
			exit_code: result.code,
			output: { stdout: result.stdout, stderr: result.stderr },
			...(result.outputFiles ? { output_files: result.outputFiles } : {}),
			...(handoff ? { handoff } : {}),
		};
	} finally {
		await restoreCleanCommit(runner, commit, cwd, ignoredSnapshotPath, headRef);
		if (processPath && handoff) await markGateCleanupComplete(processPath, handoff.launch_id);
		else {
			if (processPath) await discardGateProcess(processPath);
			await rm(ignoredSnapshotPath, { recursive: true, force: true });
		}
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
	const paths = await ignoredWorktreeRoots(runner, source);
	const copiedSymlinks: string[] = [];
	await commandOutput(runner, "git", ["clean", "-ffdx"], target);
	for (const path of paths) {
		await copyResource(safeWorktreePath(source, path), safeWorktreePath(target, path), source, copiedSymlinks);
	}
	await assertCopiedSymlinks(copiedSymlinks, target);
}

async function writeGateProcess(path: string, record: GateProcessRecord): Promise<void> {
	await writeJson(path, record);
}

async function gateHostExitCode(path: string, launchId: string, observedExitCode: number, timedOut: boolean): Promise<number> {
	if (await fileExists(gateHostCancelPath(path, launchId))) return observedExitCode;
	const record = await readGateProcess(path);
	if (record?.phase === "completed" && record.launch_id === launchId && record.exit_code !== undefined) return record.exit_code;
	if (timedOut && record?.phase === "launching") {
		await markGateHostCompleted(path, launchId, 124);
		return 124;
	}
	throw new Error("Required gate host exited without matching completed handoff");
}

export async function markGateHostCompleted(path: string, launchId: string, exitCode: number): Promise<void> {
	const record = await readGateProcess(path);
	if (await fileExists(gateHostCancelPath(path, launchId))) return;
	if (!record) throw new Error("Required gate completion is missing launch intent");
	if (record.version !== 4 || record.launch_id !== launchId) {
		throw new Error("Required gate completion does not match launch intent");
	}
	if (record.phase === "completed") {
		if (record.exit_code !== exitCode) throw new Error("Required gate completion exit code changed");
		return;
	}
	await writeGateProcess(path, { ...record, phase: "completed", exit_code: exitCode, cleanup_complete: false });
}

async function markGateCleanupComplete(path: string, launchId: string): Promise<void> {
	const record = await readGateProcess(path);
	if (!record || record.phase !== "completed" || record.launch_id !== launchId) {
		throw new Error("Required gate cleanup does not match completed handoff");
	}
	if (!record.cleanup_complete) await writeGateProcess(path, { ...record, cleanup_complete: true });
}

function completedGateExecution(record: GateProcessRecord): RequiredGateExecution {
	if (record.phase !== "completed" || !record.target || !record.output_files || record.exit_code === undefined) {
		throw new Error("Completed required gate handoff is incomplete");
	}
	return {
		command: record.command,
		commit: record.commit,
		exit_code: record.exit_code,
		output: { stdout: "", stderr: "" },
		output_files: record.output_files,
		handoff: { launch_id: record.launch_id, target: record.target, cwd: record.cwd },
	};
}

export async function acknowledgeRequiredGate(path: string, execution: RequiredGateExecution): Promise<void> {
	if (!execution.handoff) return;
	const record = await readGateProcess(path);
	if (!record) return;
	if (
		record.phase !== "completed"
		|| record.launch_id !== execution.handoff.launch_id
		|| !record.target
		|| !sameGateTarget(record.target, execution.handoff.target)
	) throw new Error("Required gate acknowledgment does not match completed handoff");
	if (record.output_files) await removeGateOutputFiles(record.output_files);
	if (record.ignored_snapshot) await rm(record.ignored_snapshot, { recursive: true, force: true });
	await removeGateControlFiles(path, record);
	await removeFile(path);
}

async function discardGateProcess(path: string): Promise<void> {
	const record = await readGateProcess(path);
	if (!record) return;
	if (record.output_files) await removeGateOutputFiles(record.output_files);
	if (record.ignored_snapshot) await rm(record.ignored_snapshot, { recursive: true, force: true });
	await removeGateControlFiles(path, record);
	await removeFile(path);
}

async function removeGateControlFiles(path: string, record: GateProcessRecord): Promise<void> {
	await removeFile(record.release);
	await removeFile(gateHostReadyPath(path, record.launch_id));
	await removeFile(gateHostCancelPath(path, record.launch_id));
}

function sameGateTarget(left: GateEvidenceTarget, right: GateEvidenceTarget): boolean {
	return left.kind === right.kind && left.issue_id === right.issue_id;
}

export async function markGateHostReady(path: string, launchId: string): Promise<GateHostControl> {
	const record = await readGateProcess(path);
	if (!record || record.phase !== "launching" || record.launch_id !== launchId) {
		throw new Error("Required gate launch intent does not match gate host");
	}
	const cancel = gateHostCancelPath(path, launchId);
	if (await fileExists(cancel)) throw new Error("Required gate launch was cancelled");
	if (record.version !== 4 || !record.output_files || record.max_output_bytes === undefined) {
		throw new Error("Required gate launch intent lacks host output settings");
	}
	const control = {
		release: record.release,
		cancel,
		ready: gateHostReadyPath(path, launchId),
		output_files: record.output_files,
		max_output_bytes: record.max_output_bytes,
		...(record.timeout_ms === undefined ? {} : { timeout_ms: record.timeout_ms }),
	};
	const identity = await processIdentity(process.pid);
	if (!identity) throw new Error("Required gate host lacks a safe process identity");
	if (await fileExists(control.cancel)) throw new Error("Required gate launch was cancelled");
	await writeJson(control.ready, { version: 1, launch_id: launchId, pid: process.pid, identity } satisfies GateHostRecord);
	if (await fileExists(control.cancel)) {
		await removeFile(control.ready);
		throw new Error("Required gate launch was cancelled");
	}
	return control;
}

async function waitForGateHost(
	path: string,
	launchId: string,
	pid: number,
	child: { exitCode: number | null; signalCode: NodeJS.Signals | null },
): Promise<void> {
	const readyPath = gateHostReadyPath(path, launchId);
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		const host = await readGateHost(readyPath);
		if (host) {
			if (host.launch_id !== launchId || host.pid !== pid) throw new Error("Required gate host identity does not match launch intent");
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) throw new Error("Required gate host exited before acknowledging launch intent");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Required gate host did not acknowledge launch intent");
}

async function readGateHost(path: string): Promise<GateHostRecord | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Required gate host record must be an object");
	const input = value as Record<string, unknown>;
	if (input.version !== 1) throw new Error("Unsupported required gate host record version");
	if (typeof input.launch_id !== "string" || !input.launch_id) throw new Error("Required gate host launch ID must be a non-empty string");
	if (!Number.isSafeInteger(input.pid) || (input.pid as number) <= 0) throw new Error("Required gate host PID must be a positive integer");
	if (typeof input.identity !== "string" || !input.identity) throw new Error("Required gate host identity must be a non-empty string");
	return input as unknown as GateHostRecord;
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
	if (input.version !== 3 && input.version !== 4) throw new Error("Unsupported required gate process record version");
	if (input.phase !== "launching" && !(input.version === 4 && input.phase === "completed")) throw new Error("Required gate process phase is invalid");
	if (typeof input.grouped !== "boolean") throw new Error("Required gate process grouped must be boolean");
	for (const key of ["launch_id", "release", "cwd", "command", "commit"] as const) {
		if (typeof input[key] !== "string" || !input[key]) throw new Error(`Required gate process ${key} must be a non-empty string`);
	}
	if (input.version === 4) {
		input.target = readGateTarget(input.target);
		if (!Number.isSafeInteger(input.max_output_bytes) || (input.max_output_bytes as number) <= 0) throw new Error("Required gate maximum output bytes must be a positive integer");
		if (input.timeout_ms !== undefined && (!Number.isSafeInteger(input.timeout_ms) || (input.timeout_ms as number) <= 0)) throw new Error("Required gate timeout must be a positive integer");
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
	if (input.phase === "completed") {
		if (!Number.isSafeInteger(input.exit_code) || (input.exit_code as number) < 0) throw new Error("Completed required gate exit code must be a non-negative integer");
		if (typeof input.cleanup_complete !== "boolean") throw new Error("Completed required gate cleanup status must be boolean");
		if (input.output_files === undefined) throw new Error("Completed required gate output files are missing");
	}
	return input as unknown as GateProcessRecord;
}

function readGateTarget(value: unknown): GateEvidenceTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Required gate evidence target must be an object");
	const input = value as Record<string, unknown>;
	if (!["task", "health"].includes(String(input.kind))) throw new Error("Required gate evidence target kind is invalid");
	if (typeof input.issue_id !== "string" || !input.issue_id) throw new Error("Required gate evidence target issue ID must be a non-empty string");
	if (Object.keys(input).some((key) => key !== "kind" && key !== "issue_id")) throw new Error("Required gate evidence target has unknown fields");
	return input as unknown as GateEvidenceTarget;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

function gateHostReadyPath(path: string, launchId: string): string {
	return `${path}.${launchId}.host`;
}

function gateHostCancelPath(path: string, launchId: string): string {
	return `${path}.${launchId}.cancel`;
}

async function writeGateCancellation(path: string): Promise<void> {
	await writeFile(path, "cancel\n", { encoding: "utf8", mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
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
	const temporary = `${path}.tmp`;
	await rm(temporary, { recursive: true, force: true });
	try {
		const roots = await ignoredWorktreeRoots(runner, cwd);
		await mkdir(join(temporary, "contents"), { recursive: true });
		for (const root of roots) {
			await copyResource(safeWorktreePath(cwd, root), safeWorktreePath(join(temporary, "contents"), root), cwd);
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

async function copyResource(source: string, target: string, worktreeRoot?: string, copiedSymlinks?: string[]): Promise<void> {
	const root = worktreeRoot ? await realpath(worktreeRoot) : undefined;
	await mkdir(dirname(target), { recursive: true });
	await cp(source, target, {
		recursive: true,
		preserveTimestamps: true,
		force: false,
		errorOnExist: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
		...(root ? { filter: async (path: string) => {
			if (!(await lstat(path)).isSymbolicLink()) return true;
			const link = await readlink(path);
			if (isAbsolute(link)) throw new Error(`Absolute ignored resource symlink escapes required gate worktree: ${path}`);
			let resolvedTarget: string;
			try {
				resolvedTarget = await realpath(resolve(dirname(path), link));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Dangling ignored resource symlink cannot be isolated: ${path}`);
				throw error;
			}
			const fromRoot = relative(root, resolvedTarget);
			if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
				throw new Error(`Ignored resource symlink escapes required gate worktree: ${path}`);
			}
			if (isOrchestrationContext(fromRoot) || fromRoot === ".git" || fromRoot.startsWith(".git/")) {
				throw new Error(`Ignored resource symlink targets protected worktree state: ${path}`);
			}
			if (copiedSymlinks) {
				const copiedPath = relative(source, path);
				copiedSymlinks.push(copiedPath ? resolve(target, copiedPath) : target);
			}
			return true;
		} } : {}),
	});
}

async function assertCopiedSymlinks(paths: string[], worktreeRoot: string): Promise<void> {
	const root = await realpath(worktreeRoot);
	for (const path of paths) {
		let target: string;
		try {
			target = await realpath(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Copied ignored resource symlink is dangling: ${path}`);
			throw error;
		}
		const fromRoot = relative(root, target);
		if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`Copied ignored resource symlink escapes required gate worktree: ${path}`);
	}
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

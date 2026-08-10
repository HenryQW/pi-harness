import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GateOutputEvidence, RequiredGateEvidence } from "./model.ts";
import { runDirectory } from "./state.ts";

interface CommandResult {
	code: number;
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
	};
}

/** One small command seam covers installed Git, Herdr, and gh CLIs in tests. */
export type CommandRunner = (
	command: string,
	arguments_: readonly string[],
	options: CommandOptions,
) => Promise<CommandResult>;

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const runCommand: CommandRunner = async (command, arguments_, options) => {
	const timed = options.timeoutMs !== undefined;
	const grouped = timed && process.platform !== "win32";
	const child = spawn(command, arguments_, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: grouped,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	let outputBytes = 0;
	let settled = false;
	let timedOut = false;
	let forceKill: NodeJS.Timeout | undefined;
	const kill = (signal: NodeJS.Signals): void => {
		if (child.pid === undefined) return;
		signalProcess(child.pid, grouped, signal);
	};
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
			if (outputBytes > maxOutputBytes) {
				kill("SIGKILL");
				fail(new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
				return;
			}
			chunks.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.on("error", fail);
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (timedOut) kill("SIGKILL");
			if (forceKill) clearTimeout(forceKill);
			resolve({
				code: timedOut ? 124 : code ?? 1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});
	void completion.catch(() => undefined);
	const pid = child.pid;
	try {
		if (options.gateProcess) {
			if (pid === undefined) throw new Error("Required gate process has no PID");
			await writeGateProcess(options.gateProcess.path, {
				version: 1,
				pid,
				grouped,
				cwd: options.cwd,
				command: options.gateProcess.command,
				commit: options.gateProcess.commit,
			});
		}
		return await completion;
	} catch (error) {
		kill("SIGKILL");
		await completion.catch(() => undefined);
		throw error;
	}
};

interface GateProcessRecord {
	version: 1;
	pid: number;
	grouped: boolean;
	cwd: string;
	command: string;
	commit: string;
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
	if (signalProcess(record.pid, record.grouped, "SIGTERM")) {
		await delay(100);
		signalProcess(record.pid, record.grouped, "SIGKILL");
		await delay(100);
	}
	await restoreCleanCommit(runner, record.commit, record.cwd);
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
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
	try {
		const result = await runner("sh", ["-c", command], {
			cwd,
			timeoutMs,
			...(processPath ? { gateProcess: { path: processPath, command, commit } } : {}),
		});
		return {
			command,
			commit,
			exit_code: result.code,
			output: { stdout: result.stdout, stderr: result.stderr },
		};
	} finally {
		await restoreCleanCommit(runner, commit, cwd);
		if (processPath) await removeGateProcess(processPath);
	}
}

export async function restoreCleanCommit(runner: CommandRunner, commit: string, cwd: string): Promise<void> {
	await commandOutput(runner, "git", ["reset", "--hard", commit], cwd);
	const status = await commandOutput(runner, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
	const root = resolve(cwd);
	for (const entry of status.split("\0").filter(Boolean)) {
		if (!entry.startsWith("?? ")) throw new Error(`Required gate left tracked worktree changes after reset: ${entry.slice(0, 2)}`);
		const path = resolve(root, entry.slice(3));
		const fromRoot = relative(root, path);
		if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Required gate produced an unsafe untracked path");
		await rm(path, { recursive: true, force: true });
	}
	if (await commandOutput(runner, "git", ["status", "--porcelain"], cwd)) {
		throw new Error("Required gate worktree cleanup failed");
	}
}

async function writeGateProcess(path: string, record: GateProcessRecord): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

async function removeGateProcess(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
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
	return input as unknown as GateProcessRecord;
}

function signalProcess(pid: number, grouped: boolean, signal: NodeJS.Signals): boolean {
	try {
		process.kill(grouped ? -pid : pid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
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

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GateOutputEvidence, RequiredGateEvidence } from "./model.ts";

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
}

/** One small command seam covers installed Git, Herdr, and gh CLIs in tests. */
export type CommandRunner = (
	command: string,
	arguments_: readonly string[],
	options: CommandOptions,
) => Promise<CommandResult>;

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const runCommand: CommandRunner = async (command, arguments_, options) => await new Promise((resolve, reject) => {
	const timed = options.timeoutMs !== undefined;
	const child = spawn(command, arguments_, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: timed && process.platform !== "win32",
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
		try {
			if (timed && process.platform !== "win32") process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
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

export async function runRequiredGate(
	runner: CommandRunner,
	command: string,
	commit: string,
	cwd: string,
	timeoutMs?: number,
): Promise<RequiredGateExecution> {
	try {
		const result = await runner("sh", ["-c", command], { cwd, timeoutMs });
		return {
			command,
			commit,
			exit_code: result.code,
			output: { stdout: result.stdout, stderr: result.stderr },
		};
	} finally {
		await restoreCleanCommit(runner, commit, cwd);
	}
}

async function restoreCleanCommit(runner: CommandRunner, commit: string, cwd: string): Promise<void> {
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

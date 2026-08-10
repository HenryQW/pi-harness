import { spawn } from "node:child_process";

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RequiredGateEvidence {
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
	review_stdout?: string;
	review_stderr?: string;
}

interface CommandOptions {
	cwd: string;
	maxOutputBytes?: number;
}

/** One small command seam covers installed Git, Herdr, and gh CLIs in tests. */
export type CommandRunner = (
	command: string,
	arguments_: readonly string[],
	options: CommandOptions,
) => Promise<CommandResult>;

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const runCommand: CommandRunner = async (command, arguments_, options) => await new Promise((resolve, reject) => {
	const child = spawn(command, arguments_, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	let outputBytes = 0;
	let overflowed = false;
	const collect = (chunks: Buffer[], chunk: Buffer): void => {
		if (overflowed) return;
		outputBytes += chunk.length;
		if (outputBytes > maxOutputBytes) {
			overflowed = true;
			child.kill();
			reject(new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
			return;
		}
		chunks.push(chunk);
	};
	child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
	child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
	child.on("error", reject);
	child.on("close", (code) => {
		if (overflowed) return;
		resolve({
			code: code ?? 1,
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
): Promise<RequiredGateEvidence> {
	const result = await runner("sh", ["-c", command], { cwd });
	return {
		command,
		commit,
		exit_code: result.code,
		output: { stdout: result.stdout, stderr: result.stderr },
	};
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

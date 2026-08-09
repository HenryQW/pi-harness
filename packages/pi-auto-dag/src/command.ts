import { spawn } from "node:child_process";

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
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

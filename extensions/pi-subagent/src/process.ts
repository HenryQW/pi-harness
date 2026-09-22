import { spawnBounded } from "@henryqw/pi-process";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;

type ProcessOptions = {
	cwd: string;
	signal: AbortSignal;
	timeoutMs: number;
	stdin?: string;
};

/** Infrastructure errors reject; only ordinary command exits return a result. */
export const runProcess = async (command: string, args: string[], options: ProcessOptions) => await spawnBounded(command, args, {
	cwd: options.cwd,
	signal: options.signal,
	timeoutMs: options.timeoutMs,
	...(options.stdin === undefined ? {} : { stdin: options.stdin }),
	stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
	stderrLimitBytes: OUTPUT_LIMIT_BYTES,
});

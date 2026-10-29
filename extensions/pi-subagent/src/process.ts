import { spawnBounded } from "@henryqw/pi-process";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;

type ProcessOptions = {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	stdin?: string;
	env?: Readonly<Record<string, string>>;
};

/** Infrastructure errors reject; only ordinary command exits return a result. */
export const runProcess = async (command: string, args: string[], options: ProcessOptions) => await spawnBounded(
	options.env ? "/usr/bin/env" : command,
	options.env ? [...Object.entries(options.env).map(([key, value]) => `${key}=${value}`), command, ...args] : args, {
	cwd: options.cwd,
	signal: options.signal,
	timeoutMs: options.timeoutMs ?? null,
	...(options.stdin === undefined ? {} : { stdin: options.stdin }),
	stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
	stderrLimitBytes: OUTPUT_LIMIT_BYTES,
});

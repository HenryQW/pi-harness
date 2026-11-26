import { spawn } from "node:child_process";

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 250;

export type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
};

export type ExecOptions = {
	cwd: string;
	signal?: AbortSignal;
	/** Omit for the default timeout; null disables elapsed-time expiry. */
	timeoutMs?: number | null;
	stdoutLimitBytes?: number;
	stdoutTailBytes?: number;
	stderrLimitBytes?: number;
	stderrTailBytes?: number;
	stdin?: string;
};

export type Exec = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
	return value;
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
	return value;
}

function requiredCwd(value: unknown): string {
	if (typeof value !== "string" || !value || value.includes("\0")) {
		throw new TypeError("cwd must be a non-empty string");
	}
	return value;
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

type Capture = { data(chunk: Buffer): void; flush(): void; text(): string; truncated(): boolean | undefined };

/** Collect one stream: fail beyond `limit`, or with `tailLimit` keep only the end as complete UTF-8 characters. */
function capture(label: string, limit: number, tailLimit: number | undefined, stop: (error: Error) => void): Capture {
	const chunks: Buffer[] = [];
	const decoder = tailLimit === undefined ? undefined : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let bytes = 0;
	let truncated = false;
	const appendTail = (text: string): void => {
		if (!text || tailLimit === undefined) return;
		const chunk = Buffer.from(text, "utf8");
		chunks.push(chunk);
		bytes += chunk.length;
		if (bytes <= tailLimit) return;
		truncated = true;
		let remove = bytes - tailLimit;
		while (remove > 0) {
			const first = chunks[0]!;
			if (first.length <= remove) {
				chunks.shift();
				bytes -= first.length;
				remove -= first.length;
				continue;
			}
			let start = remove;
			while (start < first.length && (first[start]! & 0xc0) === 0x80) start += 1;
			chunks[0] = Buffer.from(first.subarray(start));
			bytes -= start;
			remove = 0;
		}
	};
	const decodeTail = (chunk?: Buffer): void => {
		if (!decoder) return;
		try {
			appendTail(chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true }));
		} catch {
			stop(new Error(`${label} was not valid UTF-8`));
		}
	};
	return {
		data(chunk) {
			if (decoder) {
				decodeTail(chunk);
				return;
			}
			bytes += chunk.length;
			if (bytes > limit) {
				stop(new Error(`${label} exceeded ${limit} bytes`));
				return;
			}
			chunks.push(chunk);
		},
		flush: () => decodeTail(),
		text: () => decoder ? Buffer.concat(chunks, bytes).toString("utf8") : decode(chunks, bytes, label),
		truncated: () => decoder ? truncated : undefined,
	};
}

/** Run one argv-only child process with bounded streaming output and cancellation. */
export const spawnBounded: Exec = async (command, args, options) => {
	requiredText(command, "command");
	validatedArguments(args);
	requiredCwd(options.cwd);
	options.signal?.throwIfAborted();
	const timeoutMs = options.timeoutMs === null ? undefined : positiveInteger(options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, "timeoutMs");
	const stdoutLimit = positiveInteger(options.stdoutLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES, "stdoutLimitBytes");
	const stdoutTailLimit = options.stdoutTailBytes === undefined
		? undefined
		: positiveInteger(options.stdoutTailBytes, "stdoutTailBytes");
	const stderrLimit = positiveInteger(options.stderrLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES, "stderrLimitBytes");
	const stderrTailLimit = options.stderrTailBytes === undefined
		? undefined
		: positiveInteger(options.stderrTailBytes, "stderrTailBytes");
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
		let failure: Error | undefined;
		let killed = false;
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

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
			killTimer = setTimeout(() => signalChild("SIGKILL"), PROCESS_TERMINATION_GRACE_MS);
		};
		const stdout = capture(`${command} stdout`, stdoutLimit, stdoutTailLimit, stop);
		const stderr = capture(`${command} stderr`, stderrLimit, stderrTailLimit, stop);
		const timer = timeoutMs === undefined ? undefined
			: setTimeout(() => stop(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
		const abort = (): void => stop(options.signal?.reason instanceof Error
			? options.signal.reason
			: new DOMException("The operation was aborted", "AbortError"));
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();

		child.stdout.on("data", (chunk: Buffer) => { if (!failure) stdout.data(chunk); });
		child.stderr.on("data", (chunk: Buffer) => { if (!failure) stderr.data(chunk); });
		child.once("error", stop);
		child.stdin.once("error", stop);
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer !== undefined && processGroup === null) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			if (!failure) stdout.flush();
			if (!failure) stderr.flush();
			if (failure) {
				reject(failure);
				return;
			}
			try {
				const stdoutTruncated = stdout.truncated();
				const stderrTruncated = stderr.truncated();
				resolve({
					stdout: stdout.text(),
					stderr: stderr.text(),
					code: code ?? 1,
					killed: killed || signal !== null,
					...(stdoutTruncated === undefined ? {} : { stdoutTruncated }),
					...(stderrTruncated === undefined ? {} : { stderrTruncated }),
				});
			} catch (error) {
				reject(error);
			}
		});
		if (options.stdin === undefined) child.stdin.end();
		else child.stdin.end(options.stdin, "utf8");
	});
};

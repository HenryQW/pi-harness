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
};

export type ExecOptions = {
	cwd: string;
	signal?: AbortSignal;
	/** Omit for the default timeout; null disables elapsed-time expiry. */
	timeoutMs?: number | null;
	stdoutLimitBytes?: number;
	stdoutTailBytes?: number;
	stderrLimitBytes?: number;
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
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const stdoutDecoder = stdoutTailLimit === undefined
			? undefined
			: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		let stdoutBytes = 0;
		let stdoutTruncated = false;
		let stderrBytes = 0;
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
		const appendTail = (text: string): void => {
			if (!text || stdoutTailLimit === undefined) return;
			const chunk = Buffer.from(text, "utf8");
			stdout.push(chunk);
			stdoutBytes += chunk.length;
			if (stdoutBytes <= stdoutTailLimit) return;
			stdoutTruncated = true;
			let remove = stdoutBytes - stdoutTailLimit;
			while (remove > 0) {
				const first = stdout[0]!;
				if (first.length <= remove) {
					stdout.shift();
					stdoutBytes -= first.length;
					remove -= first.length;
					continue;
				}
				let start = remove;
				while (start < first.length && (first[start]! & 0xc0) === 0x80) start += 1;
				stdout[0] = Buffer.from(first.subarray(start));
				stdoutBytes -= start;
				remove = 0;
			}
		};
		const decodeTail = (chunk?: Buffer): void => {
			if (!stdoutDecoder) return;
			try {
				appendTail(chunk === undefined ? stdoutDecoder.decode() : stdoutDecoder.decode(chunk, { stream: true }));
			} catch {
				stop(new Error(`${command} stdout was not valid UTF-8`));
			}
		};
		const timer = timeoutMs === undefined ? undefined
			: setTimeout(() => stop(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
		const abort = (): void => stop(options.signal?.reason instanceof Error
			? options.signal.reason
			: new DOMException("The operation was aborted", "AbortError"));
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();

		child.stdout.on("data", (chunk: Buffer) => {
			if (failure) return;
			if (stdoutDecoder) {
				decodeTail(chunk);
				return;
			}
			stdoutBytes += chunk.length;
			if (stdoutBytes > stdoutLimit) {
				stop(new Error(`${command} stdout exceeded ${stdoutLimit} bytes`));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (failure) return;
			stderrBytes += chunk.length;
			if (stderrBytes > stderrLimit) {
				stop(new Error(`${command} stderr exceeded ${stderrLimit} bytes`));
				return;
			}
			stderr.push(chunk);
		});
		child.once("error", stop);
		child.stdin.once("error", stop);
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer !== undefined && processGroup === null) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			if (!failure && stdoutDecoder) decodeTail();
			if (failure) {
				reject(failure);
				return;
			}
			try {
				resolve({
					stdout: stdoutDecoder
						? Buffer.concat(stdout, stdoutBytes).toString("utf8")
						: decode(stdout, stdoutBytes, `${command} stdout`),
					stderr: decode(stderr, stderrBytes, `${command} stderr`),
					code: code ?? 1,
					killed: killed || signal !== null,
					...(stdoutDecoder ? { stdoutTruncated } : {}),
				});
			} catch (error) {
				reject(error);
			}
		});
		if (options.stdin === undefined) child.stdin.end();
		else child.stdin.end(options.stdin, "utf8");
	});
};

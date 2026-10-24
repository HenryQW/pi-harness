import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export class HerdrRequestError extends Error {
	readonly code: string;
	readonly dispatched: boolean;
	constructor(code: string, message: string, dispatched: boolean) {
		super(message);
		this.code = code;
		this.dispatched = dispatched;
		this.name = "HerdrRequestError";
	}
}

/** One newline-delimited request. A dispatched failure is uncertain; never retry mutations automatically. */
export function requestHerdr(method: string, params: Record<string, unknown>, options: {
	socketPath?: string; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<Record<string, unknown>> {
	const socketPath = options.socketPath ?? process.env.HERDR_SOCKET_PATH;
	const timeoutMs = options.timeoutMs ?? 10_000;
	if (!socketPath || !socketPath.startsWith("/") || socketPath.includes("\0")) throw new HerdrRequestError("socket_path", "HERDR_SOCKET_PATH must be an absolute Unix socket path.", false);
	if (!method.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError("Invalid Herdr request method or timeout.");
	const id = randomUUID();
	const request = JSON.stringify({ id, method, params }) + "\n";
	if (Buffer.byteLength(request) > 256 * 1024) throw new HerdrRequestError("request_limit", "Herdr request exceeds 256 KiB.", false);
	return new Promise((resolve, reject) => {
		let dispatched = false;
		let settled = false;
		let data = Buffer.alloc(0);
		const socket = createConnection(socketPath);
		const finish = (error?: HerdrRequestError, value?: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			socket.destroy();
			if (error) reject(error); else resolve(value!);
		};
		const fail = (code: string, message: string) => finish(new HerdrRequestError(code, message, dispatched));
		const abort = () => fail("aborted", "Herdr request aborted; dispatched mutations can still run.");
		const timer = setTimeout(() => fail("timeout", "Herdr request timed out; dispatched mutations can still run."), timeoutMs);
		socket.on("error", (error: NodeJS.ErrnoException) => fail(error.code ?? "transport", "Herdr socket transport failed."));
		socket.on("end", () => fail("closed", "Herdr socket closed before a complete response."));
		socket.on("connect", () => { dispatched = true; socket.write(request); });
		socket.on("data", (chunk: Buffer) => {
			if (data.length + chunk.length > 1024 * 1024) return fail("response_limit", "Herdr response exceeds 1 MiB.");
			data = Buffer.concat([data, chunk]);
			const newline = data.indexOf(10);
			if (newline < 0) return;
			let value: unknown;
			try { value = JSON.parse(data.subarray(0, newline).toString("utf8")); }
			catch { return fail("response_invalid", "Herdr returned invalid JSON."); }
			if (!value || typeof value !== "object" || Array.isArray(value)) return fail("response_invalid", "Herdr returned a malformed response.");
			const response = value as Record<string, unknown>;
			if (response.id !== id) return fail("identity", "Herdr response identity does not match the request.");
			if (response.error && typeof response.error === "object") {
				const error = response.error as Record<string, unknown>;
				if (typeof error.code === "string" && typeof error.message === "string") return fail(error.code, error.message);
			}
			if (!response.result || typeof response.result !== "object" || Array.isArray(response.result) || response.error !== undefined) return fail("response_invalid", "Herdr response has no valid result.");
			finish(undefined, response.result as Record<string, unknown>);
		});
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}

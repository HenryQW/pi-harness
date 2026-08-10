import { Buffer } from "node:buffer";

export const PROTOCOL_VERSION = 1;
export const NOTICE_PREFIX = "PI_HERDR_SUBAGENT_COMPLETION_V1 ";
export const MAX_EXCERPT_CHARS = 1_000;

export type PendingResult = {
	version: 1;
	taskId: string;
	state: "pending";
	task: string;
	createdAt: string;
};

export type TerminalResult = {
	version: 1;
	taskId: string;
	state: "finished";
	task: string;
	result: string;
	error: null;
	createdAt: string;
	finishedAt: string;
} | {
	version: 1;
	taskId: string;
	state: "failed";
	task: string;
	result: null;
	error: { stopReason: "error" | "aborted"; message: string };
	createdAt: string;
	finishedAt: string;
};

export type CompletionNotice = {
	version: 1;
	taskId: string;
	resultPath: string;
	excerpt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasExactly = (value: Record<string, unknown>, keys: string[]) =>
	Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const timestamp = (value: unknown): value is string =>
	typeof value === "string"
	&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
	&& !Number.isNaN(Date.parse(value))
	&& new Date(value).toISOString() === value;

export const isTaskId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export const sanitizeExcerpt = (value: string) =>
	value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, MAX_EXCERPT_CHARS);

export function parsePendingResult(value: unknown): PendingResult | undefined {
	if (!isObject(value) || !hasExactly(value, ["version", "taskId", "state", "task", "createdAt"])) return;
	if (value.version !== PROTOCOL_VERSION || value.state !== "pending" || !isTaskId(value.taskId)) return;
	if (typeof value.task !== "string" || !value.task.trim() || !timestamp(value.createdAt)) return;
	return value as PendingResult;
}

export function parseTerminalResult(value: unknown): TerminalResult | undefined {
	if (!isObject(value) || !hasExactly(value, ["version", "taskId", "state", "task", "result", "error", "createdAt", "finishedAt"])) return;
	if (value.version !== PROTOCOL_VERSION || !isTaskId(value.taskId) || typeof value.task !== "string" || !value.task.trim()) return;
	if (!timestamp(value.createdAt) || !timestamp(value.finishedAt)) return;
	if (value.state === "finished" && typeof value.result === "string" && value.result.trim() && value.error === null) {
		return value as TerminalResult;
	}
	if (
		value.state === "failed"
		&& value.result === null
		&& isObject(value.error)
		&& hasExactly(value.error, ["stopReason", "message"])
		&& (value.error.stopReason === "error" || value.error.stopReason === "aborted")
		&& typeof value.error.message === "string"
		&& value.error.message.trim()
	) {
		return value as TerminalResult;
	}
}

export const resultExcerpt = (result: TerminalResult) =>
	sanitizeExcerpt(result.state === "finished" ? result.result : result.error.message);

export function completionNotice(resultPath: string, result: TerminalResult): string {
	const notice: CompletionNotice = {
		version: PROTOCOL_VERSION,
		taskId: result.taskId,
		resultPath,
		excerpt: resultExcerpt(result),
	};
	return `${NOTICE_PREFIX}${Buffer.from(JSON.stringify(notice), "utf8").toString("base64url")}`;
}

export function parseCompletionNotice(text: string): CompletionNotice | undefined {
	if (!text.startsWith(NOTICE_PREFIX) || /[\u0000-\u001f\u007f-\u009f]/.test(text)) return;
	const encoded = text.slice(NOTICE_PREFIX.length);
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return;
	let value: unknown;
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) return;
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		return;
	}
	if (!isObject(value) || !hasExactly(value, ["version", "taskId", "resultPath", "excerpt"])) return;
	if (value.version !== PROTOCOL_VERSION || !isTaskId(value.taskId)) return;
	if (typeof value.resultPath !== "string" || !value.resultPath || typeof value.excerpt !== "string") return;
	if (value.excerpt !== sanitizeExcerpt(value.excerpt)) return;
	return value as CompletionNotice;
}

export function parseCompletionNotices(text: string): CompletionNotice[] | undefined {
	if (!text.startsWith(NOTICE_PREFIX)) return;
	const notices: CompletionNotice[] = [];
	let offset = 0;
	while (offset < text.length) {
		if (!text.startsWith(NOTICE_PREFIX, offset)) return;
		const next = text.indexOf(NOTICE_PREFIX, offset + NOTICE_PREFIX.length);
		const notice = parseCompletionNotice(text.slice(offset, next === -1 ? undefined : next));
		if (!notice) return;
		notices.push(notice);
		if (next === -1) break;
		offset = next;
	}
	return notices;
}

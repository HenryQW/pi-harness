import { Buffer } from "node:buffer";

export const PROTOCOL_VERSION = 2;
export const NOTICE_PREFIX = "PI_HERDR_SUBAGENT_COMPLETION_V2 ";

export type PendingResult = {
	version: 2;
	taskId: string;
	state: "pending";
	task: string;
	createdAt: string;
};

export type TerminalResult = {
	version: 2;
	taskId: string;
	state: "finished";
	task: string;
	result: string;
	error: null;
	createdAt: string;
	finishedAt: string;
} | {
	version: 2;
	taskId: string;
	state: "failed";
	task: string;
	result: null;
	error: { stopReason: "error" | "aborted"; message: string };
	createdAt: string;
	finishedAt: string;
};

export type CompletionNotice = {
	version: 2;
	taskId: string;
	resultPath: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

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

export function completionNotice(resultPath: string, taskId: string): string {
	const notice: CompletionNotice = { version: PROTOCOL_VERSION, taskId, resultPath };
	return `${NOTICE_PREFIX}${Buffer.from(JSON.stringify(notice), "utf8").toString("base64url")}`;
}

export function parseCompletionNotice(text: string): CompletionNotice | undefined {
	if (!text.startsWith(NOTICE_PREFIX) || CONTROL.test(text)) return;
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
	if (!isObject(value) || !hasExactly(value, ["version", "taskId", "resultPath"])) return;
	if (value.version !== PROTOCOL_VERSION || !isTaskId(value.taskId)) return;
	if (typeof value.resultPath !== "string" || !value.resultPath || CONTROL.test(value.resultPath)) return;
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

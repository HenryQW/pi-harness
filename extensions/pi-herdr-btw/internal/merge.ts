import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BtwPayload } from "./core.ts";

export const MERGE_PROTOCOL_VERSION = 2 as const;
export const MERGE_REQUEST_FILE = "merge-request.json";
export const MERGE_CUSTOM_TYPE = "pi-herdr-btw.merge";
export const MAX_SUMMARY_BYTES = 64 * 1024;
export const MAX_PROMPT_BYTES = 16 * 1024;
/** Transcript budget stays well under MAX_SUMMARY_BYTES for JSON overhead. */
export const MERGE_TRANSCRIPT_BUDGET_BYTES = 48 * 1024;
export const TRANSCRIPT_TRUNCATION_NOTE =
	"[earlier side-thread turns omitted to fit the merge budget]";

export type MergeRequest = {
	protocolVersion: typeof MERGE_PROTOCOL_VERSION;
	requestId: string;
	launchId: string;
	parentSessionId: string;
	capability: string;
	createdAt: string;
	/** Trimmed, 1..64 KiB packaged side-thread transcript. */
	summary: string;
	/** Trimmed, 1..16 KiB user prompt the parent auto-submits after the merge. */
	prompt: string;
};

export function isMergeRequest(value: unknown): value is MergeRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<MergeRequest>;
	return (
		request.protocolVersion === MERGE_PROTOCOL_VERSION &&
		typeof request.requestId === "string" &&
		request.requestId.length > 0 &&
		typeof request.launchId === "string" &&
		request.launchId.length > 0 &&
		typeof request.parentSessionId === "string" &&
		request.parentSessionId.length > 0 &&
		typeof request.capability === "string" &&
		request.capability.length >= 32 &&
		typeof request.createdAt === "string" &&
		typeof request.summary === "string" &&
		isSummaryWithinBounds(request.summary) &&
		typeof request.prompt === "string" &&
		isPromptWithinBounds(request.prompt)
	);
}

export function isSummaryWithinBounds(summary: string): boolean {
	const trimmed = summary.trim();
	return trimmed.length > 0 && Buffer.byteLength(trimmed, "utf8") <= MAX_SUMMARY_BYTES;
}

export function isPromptWithinBounds(prompt: string): boolean {
	const trimmed = prompt.trim();
	return trimmed.length > 0 && Buffer.byteLength(trimmed, "utf8") <= MAX_PROMPT_BYTES;
}

/**
 * A merge request is trusted only when it echoes the exact launch identity,
 * capability token, and parent session binding of its own launch payload.
 */
export function validateRequestAgainstPayload(
	request: MergeRequest,
	payload: BtwPayload,
): string | undefined {
	if (request.launchId !== payload.launchId) return "launch ID mismatch";
	if (request.capability !== payload.capability) return "capability mismatch";
	if (request.parentSessionId !== payload.parentSessionId) return "parent session mismatch";
	return undefined;
}

export function buildMergeMessageContent(summary: string): string {
	return `Merged from /btw (side-thread transcript)\n\n<btw-merge>\n${summary.trim()}\n</btw-merge>`;
}

type EntryLike = {
	type: string;
	customType?: string;
	details?: unknown;
	message?: { role?: unknown; content?: unknown };
};

/** Deduplicate against an already-persisted merge custom message by requestId. */
export function hasMergedRequestId(entries: EntryLike[], requestId: string): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === MERGE_CUSTOM_TYPE &&
			!!entry.details &&
			typeof entry.details === "object" &&
			(entry.details as { requestId?: unknown }).requestId === requestId,
	);
}

/** Detect durable evidence that this merge's user prompt was persisted. */
export function hasSubmittedPromptRequestId(
	entries: EntryLike[],
	requestId: string,
	prompt: string,
): boolean {
	const mergeIndex = entries.findIndex(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === MERGE_CUSTOM_TYPE &&
			!!entry.details &&
			typeof entry.details === "object" &&
			(entry.details as { requestId?: unknown; prompt?: unknown }).requestId === requestId &&
			(entry.details as { requestId?: unknown; prompt?: unknown }).prompt === prompt,
	);
	return mergeIndex >= 0 && entries.slice(mergeIndex + 1).some(
		(entry) => entry.type === "message" && entry.message?.role === "user" && textOfTurn(entry.message.content) === prompt.trim(),
	);
}

function textOfTurn(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block && typeof block === "object" && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** Keep at most maxBytes of UTF-8 from the tail of the text. */
function tailBytes(text: string, maxBytes: number): string {
	let sliced = text.slice(-maxBytes);
	while (Buffer.byteLength(sliced, "utf8") > maxBytes) {
		const excess = Buffer.byteLength(sliced, "utf8") - maxBytes;
		sliced = sliced.slice(Math.max(1, Math.ceil(excess / 4)));
	}
	return sliced;
}

/**
 * Package the child's own conversation (user/assistant text turns only, no
 * tool payloads) as the merge transcript. When over budget, whole turns are
 * dropped from the head so the most recent findings survive.
 */
export function buildMergeTranscript(
	messages: AgentMessage[],
	budgetBytes = MERGE_TRANSCRIPT_BUDGET_BYTES,
): string | undefined {
	const turns: string[] = [];
	for (const message of messages) {
		const { role, content } = message as { role?: string; content?: unknown };
		if (role !== "user" && role !== "assistant") continue;
		const text = textOfTurn(content);
		if (text) turns.push(`${role === "user" ? "User" : "Assistant"}:\n${text}`);
	}
	if (turns.length === 0) return undefined;

	const kept: string[] = [];
	let used = 0;
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index] as string;
		const bytes = Buffer.byteLength(turn, "utf8") + 2;
		if (used + bytes > budgetBytes) {
			if (kept.length === 0) {
				// A single oversized turn keeps its tail (the latest content).
				kept.unshift(`${TRANSCRIPT_TRUNCATION_NOTE}\n${tailBytes(turn, budgetBytes)}`);
			} else {
				kept.unshift(TRANSCRIPT_TRUNCATION_NOTE);
			}
			break;
		}
		kept.unshift(turn);
		used += bytes;
	}
	return kept.join("\n\n");
}

export type MergeStorePort = {
	listLaunchPayloadPaths(): Promise<string[]>;
	read(payloadPath: string): Promise<BtwPayload>;
	readMergeRequest(payloadPath: string): Promise<unknown>;
	remove(payloadPath: string): Promise<void>;
};

export type ParentSessionPort = {
	getSessionId(): string;
	isIdle(): boolean;
	getBranch(): EntryLike[];
	/** Check model and authentication before consuming a merge request. */
	canSubmitPrompt(): Promise<boolean>;
	sendMergeMessage(content: string, details: { requestId: string; launchId: string; prompt: string }): void;
	/** Submit the merge prompt as a user message that triggers a model turn. */
	submitPrompt(prompt: string): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
};

export type ScanResult = {
	delivered: number;
	deferred: number;
	rejected: number;
};

/**
 * Parent-side merge coordinator. Scans the private launch store for pending
 * merge requests bound to the current parent session and consumes each after
 * delivery or rejection.
 */
export class MergeCoordinator {
	private readonly store: MergeStorePort;
	private readonly session: ParentSessionPort;
	private scanning = false;

	constructor(store: MergeStorePort, session: ParentSessionPort) {
		this.store = store;
		this.session = session;
	}

	async scan(): Promise<ScanResult> {
		if (this.scanning) return { delivered: 0, deferred: 0, rejected: 0 };
		this.scanning = true;
		try {
			return await this.scanOnce();
		} finally {
			this.scanning = false;
		}
	}

	private async scanOnce(): Promise<ScanResult> {
		const result: ScanResult = { delivered: 0, deferred: 0, rejected: 0 };
		let payloadPaths: string[];
		try {
			payloadPaths = await this.store.listLaunchPayloadPaths();
		} catch {
			return result;
		}

		for (const payloadPath of payloadPaths) {
			if (result.delivered > 0) break;
			try {
				await this.processLaunch(payloadPath, result);
			} catch {
				// Unsafe or unreadable launch directories are skipped, never trusted.
			}
		}
		return result;
	}

	private async processLaunch(payloadPath: string, result: ScanResult): Promise<void> {
		const rawRequest = await this.store.readMergeRequest(payloadPath);
		if (rawRequest === undefined) return;

		const payload = await this.store.read(payloadPath);
		// Only the session a launch is bound to may consume its merge requests.
		if (payload.parentSessionId !== this.session.getSessionId()) return;

		if (!isMergeRequest(rawRequest)) {
			await this.reject(payloadPath, "malformed merge request");
			result.rejected += 1;
			return;
		}
		const validationError = validateRequestAgainstPayload(rawRequest, payload);
		if (validationError) {
			await this.reject(payloadPath, validationError);
			result.rejected += 1;
			return;
		}

		const entries = this.session.getBranch();
		if (hasSubmittedPromptRequestId(entries, rawRequest.requestId, rawRequest.prompt)) {
			await this.store.remove(payloadPath);
			return;
		}

		// pi.sendUserMessage() is fire-and-forget. Keep the request pending when
		// current model/auth state would reject its prompt.
		try {
			if (!(await this.session.canSubmitPrompt())) {
				result.deferred += 1;
				return;
			}
		} catch {
			result.deferred += 1;
			return;
		}

		if (!this.session.isIdle()) {
			// Never steer or queue a model turn mid-stream; retry on agent_settled.
			result.deferred += 1;
			return;
		}

		// Refresh branch evidence after authentication; branch can change while the
		// asynchronous model check is pending.
		const currentEntries = this.session.getBranch();
		if (hasSubmittedPromptRequestId(currentEntries, rawRequest.requestId, rawRequest.prompt)) {
			await this.store.remove(payloadPath);
			return;
		}

		// Re-check the session binding immediately before appending.
		if (payload.parentSessionId !== this.session.getSessionId()) return;
		if (!hasMergedRequestId(currentEntries, rawRequest.requestId)) {
			this.session.sendMergeMessage(buildMergeMessageContent(rawRequest.summary), {
				requestId: rawRequest.requestId,
				launchId: rawRequest.launchId,
				prompt: rawRequest.prompt,
			});
		}
		this.session.submitPrompt(rawRequest.prompt);
		result.delivered += 1;
		await this.store.remove(payloadPath);
		this.session.notify("Merged a /btw side thread into this session; continuing with its prompt.", "info");
	}

	private async reject(payloadPath: string, reason: string): Promise<void> {
		await this.store.remove(payloadPath);
		this.session.notify(`Rejected a /btw merge request: ${reason}`, "warning");
	}
}

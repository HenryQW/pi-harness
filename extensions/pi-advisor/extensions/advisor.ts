import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	executeTaskRoutes, registerModelTask, registerTaskModelsConfigReporting, resolveConfiguredTaskRoutes,
	type ModelTask, type ResolvedTaskRoute,
} from "@henryqw/pi-task-models";

export const ADVISOR_ENTRY = "pi-advisor";
export const BLOCKER_MESSAGE = "pi-advisor-blocker";
export const REVIEW_TIMEOUT_MS = 90_000;
export const PROMPT_CAP = 8_000;
export const ITEM_CAP = 4_000;
export const RUN_CAP = 48_000;
export const REVIEW_TASK = {
	id: "pi-advisor/review",
	label: "Advisor review",
	purpose: "Review the tool calls and results of a settled agent run and grade the problems it finds.",
	defaultProfile: "balanced",
} as const satisfies ModelTask;

const SYSTEM_PROMPT = `You are an advisor. Another coding agent finished a run. You get the user's prompt and a record of the run: assistant text, tool calls, and tool results. Find real problems in what the agent did: wrong or unverified results, missed parts of the prompt, failed commands that the agent ignored, unsafe or destructive actions, and claims that the tool results do not support.

Reply in exactly one of two formats, with no other text, markdown, or preamble.
1. When you find no problem, reply with the single word PASS.
2. Otherwise, reply with one line for each finding, in this format:
<grade>: <finding> Evidence: <evidence>
<grade> is nit, concern, or blocker, in lowercase. <finding> states the problem. <evidence> cites the tool call, result, or text that shows it.
Use blocker only when the agent must do more work before the user can accept the run. Use concern for a real risk that does not block. Use nit for a small improvement.`;

export type Grade = "nit" | "concern" | "blocker";
export interface Note {
	grade: Grade;
	finding: string;
	evidence: string;
}

const NOTE = /^(nit|concern|blocker): (\S.*?) Evidence: (\S.*)$/;

/** `[]` means PASS; `undefined` means the reply does not follow the output contract. */
export function parseReview(reply: string): Note[] | undefined {
	const text = reply.trim();
	if (text === "PASS") return [];
	const notes: Note[] = [];
	for (const line of text.split("\n").map((value) => value.trim()).filter(Boolean)) {
		const match = NOTE.exec(line);
		if (!match) return undefined;
		notes.push({ grade: match[1] as Grade, finding: match[2]!, evidence: match[3]! });
	}
	return notes.length ? notes : undefined;
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)} [truncated ${text.length - max} chars]` : text;
const plain = (content: string | Array<{ type: string; text?: string }>) =>
	typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text : `[${part.type}]`).join("\n");

/** Branch entries after the run start, or undefined when the start is not on this branch. A null start is an empty session. */
export function runEntries(branch: SessionEntry[], start: string | null): SessionEntry[] | undefined {
	if (start === null) return branch;
	const index = branch.findIndex((entry) => entry.id === start);
	return index < 0 ? undefined : branch.slice(index + 1);
}

/** The latest user prompt and the newest material of the run, or undefined when the run made no tool call. */
export function reviewInput(branch: SessionEntry[], run: SessionEntry[]): string | undefined {
	const prompt = branch.findLast((entry) => entry.type === "message" && entry.message.role === "user");
	const items: string[] = [];
	let toolCalls = false;
	for (const entry of run) {
		// A custom message can start or steer the run, for example a scheduled follow-up; it carries the actual task.
		if (entry.type === "custom_message") items.push(`Message ${entry.customType}: ${clip(plain(entry.content), ITEM_CAP)}`);
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) items.push(`Assistant: ${clip(block.text, ITEM_CAP)}`);
				if (block.type !== "toolCall") continue;
				toolCalls = true;
				items.push(`Tool call ${block.name}: ${clip(JSON.stringify(block.arguments), ITEM_CAP)}`);
			}
		} else if (message.role === "toolResult") {
			items.push(`Tool result ${message.toolName}${message.isError ? " (error)" : ""}: ${clip(plain(message.content), ITEM_CAP)}`);
		}
	}
	if (!toolCalls) return undefined;
	let size = 0;
	let start = items.length;
	while (start > 0 && size + items[start - 1]!.length <= RUN_CAP) size += items[--start]!.length;
	const omitted = start ? [`[${start} earlier run items omitted.]`] : [];
	const request = prompt?.type === "message" && prompt.message.role === "user" ? clip(plain(prompt.message.content), PROMPT_CAP) : "";
	return `Latest user prompt:\n${request}\n\nThe run, oldest first:\n\n${[...omitted, ...items.slice(start)].join("\n\n")}`;
}

export function advisorEnabled(branch: SessionEntry[]): boolean {
	const entry = branch.findLast((item) => item.type === "custom" && item.customType === ADVISOR_ENTRY);
	return entry?.type === "custom" && (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
}

function formatNotes(notes: Note[]): string {
	return notes.map((note) => `${note.grade}: ${note.finding} Evidence: ${note.evidence}`).join("\n");
}

export default function advisorExtension(pi: ExtensionAPI): void {
	registerModelTask(pi, REVIEW_TASK);
	const reportTaskModels = registerTaskModelsConfigReporting(pi);
	// Transient state only; on/off state is always derived from the branch.
	let malformedShown = false;
	let runStart: { session: string; leaf: string | null } | undefined;
	let active: AbortController | undefined;

	/** Pi routes only: when no Task Profile route resolves, the review does not use the session model. */
	const routes = (ctx: ExtensionContext): ResolvedTaskRoute[] | undefined => {
		reportTaskModels(ctx);
		try {
			return resolveConfiguredTaskRoutes(ctx, REVIEW_TASK);
		} catch (error) {
			ctx.ui.notify(`Advisor review skipped: ${(error as Error).message}`, "warning");
			return undefined;
		}
	};

	const review = (ctx: ExtensionContext, resolved: ResolvedTaskRoute[], input: string, signal: AbortSignal) => executeTaskRoutes(resolved, async (route) => {
		const response = await ctx.modelRegistry.streamSimple(route.model, {
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: input, timestamp: Date.now() }],
		}, {
			signal,
			maxRetries: 0,
			...(route.thinkingLevel === "off" ? {} : { reasoning: route.thinkingLevel }),
		}).result();
		if (response.stopReason !== "stop") throw new Error(response.errorMessage || `the model stopped with ${response.stopReason}.`);
		return response.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
	}, { signal, shouldFallback: () => true });

	const cancel = (ctx: ExtensionContext) => {
		if (!active) return;
		active.abort();
		active = undefined;
		ctx.ui.setStatus(ADVISOR_ENTRY, undefined);
	};

	const deliver = (ctx: ExtensionContext, reply: string, branch: SessionEntry[]) => {
		const notes = parseReview(reply);
		if (!notes) {
			if (!malformedShown) ctx.ui.notify("Advisor reply did not follow the output contract and was ignored.", "warning");
			malformedShown = true;
			return;
		}
		if (!notes.length) {
			ctx.ui.notify("Advisor: PASS", "info");
			return;
		}
		const blockers = notes.filter((note) => note.grade === "blocker");
		const userIndex = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
		const continued = branch.slice(userIndex + 1).some((entry) => entry.type === "custom_message" && entry.customType === BLOCKER_MESSAGE);
		const capped = blockers.length > 0 && continued;
		ctx.ui.notify(`Advisor:\n${formatNotes(notes)}${capped ? "\nThe advisor already continued once for this prompt. Send a prompt to address the blockers." : ""}`,
			notes.some((note) => note.grade !== "nit") ? "warning" : "info");
		if (!blockers.length || capped) return;
		pi.sendMessage({
			customType: BLOCKER_MESSAGE, display: true, details: { notes },
			content: `The advisor reviewed this run and found blockers. Address each blocker, verify the fix with tools, then report the result.\n\n${formatNotes(blockers)}`,
		}, { triggerTurn: true, deliverAs: "followUp" });
	};

	pi.registerCommand("advisor", {
		description: "Turn the advisor review on or off, or show its status: /advisor on|off|status",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "status") {
				ctx.ui.notify(`Advisor is ${advisorEnabled(ctx.sessionManager.getBranch()) ? "on" : "off"} on this branch.`, "info");
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /advisor on|off|status", "error");
				return;
			}
			pi.appendEntry(ADVISOR_ENTRY, { enabled: action === "on" });
			ctx.ui.notify(`Advisor is ${action} on this branch.`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		cancel(ctx);
		malformedShown = false;
		runStart = undefined;
	});
	// Fires once for each run that a user message or an idle triggerTurn message starts, before the message is appended.
	pi.on("before_agent_start", (_event, ctx) => {
		runStart = { session: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId() };
	});
	pi.on("input", (_event, ctx) => {
		cancel(ctx);
		return { action: "continue" };
	});
	pi.on("agent_start", (_event, ctx) => cancel(ctx));
	pi.on("session_tree", (_event, ctx) => cancel(ctx));
	pi.on("session_shutdown", (_event, ctx) => cancel(ctx));

	// Pi emits agent_settled only when no retry, compaction, or queued continuation will run, so the review never races another handler.
	pi.on("agent_settled", (event, ctx) => {
		cancel(ctx);
		if (event.aborted || !ctx.hasUI || runStart?.session !== ctx.sessionManager.getSessionId()) return;
		const branch = ctx.sessionManager.getBranch();
		if (!advisorEnabled(branch)) return;
		const run = runEntries(branch, runStart.leaf);
		const last = run?.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (last?.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "stop") return;
		const input = reviewInput(branch, run!);
		if (!input) return;
		const resolved = routes(ctx);
		if (!resolved) return;

		const leaf = ctx.sessionManager.getLeafId();
		const controller = new AbortController();
		const timeout = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
		active = controller;
		ctx.ui.setStatus(ADVISOR_ENTRY, "Advisor reviewing…");
		// Not awaited: Pi waits for agent_settled handlers before the session counts as idle.
		void review(ctx, resolved, input, AbortSignal.any([controller.signal, timeout])).then((reply) => {
			if (active !== controller || controller.signal.aborted || !ctx.isIdle() || ctx.sessionManager.getLeafId() !== leaf) return;
			active = undefined;
			ctx.ui.setStatus(ADVISOR_ENTRY, undefined);
			deliver(ctx, reply, branch);
		}, (error) => {
			if (active !== controller || controller.signal.aborted) return;
			ctx.ui.notify(timeout.aborted
				? `Advisor review timed out after ${REVIEW_TIMEOUT_MS / 1000} seconds.`
				: `Advisor review failed: ${(error as Error).message}`, "warning");
		}).finally(() => {
			if (active !== controller) return;
			active = undefined;
			ctx.ui.setStatus(ADVISOR_ENTRY, undefined);
		});
	});
}

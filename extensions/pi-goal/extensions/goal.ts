import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

export const GOAL_ENTRY = "pi-goal";
export const CONTEXT_MESSAGE = "pi-goal-context";
export const CONTINUATION_MESSAGE = "pi-goal-continuation";
export const MAX_CONTINUATIONS = 20;
const OBJECTIVE_DELIVERABLE = "objective";

export interface Evidence {
	deliverable: string;
	evidence: string;
}

export interface Goal {
	id: string;
	objective: string;
	deliverables: string[];
	tokenBudget?: number;
	status: "active" | "complete" | "dropped";
	evidence?: Evidence[];
	createdAt: number;
	updatedAt: number;
}

export interface ContinuationDetails {
	goalId: string;
	count: number;
	activity: string;
}

const CLOSED = { additionalProperties: false } as const;
const NonBlank = Type.String({ pattern: "\\S" });
const EvidenceItem = Type.Object({
	deliverable: Type.String({ description: `A declared deliverable, or "${OBJECTIVE_DELIVERABLE}" when the goal has none` }),
	evidence: Type.String({ description: "What you inspected now (file, command output, test result) and what it shows" }),
}, CLOSED);
const Actions = {
	create: Type.Object({
		action: Type.Literal("create"),
		objective: NonBlank,
		deliverables: Type.Optional(Type.Array(NonBlank)),
		token_budget: Type.Optional(Type.Integer({ minimum: 1 })),
	}, CLOSED),
	get: Type.Object({ action: Type.Literal("get") }, CLOSED),
	complete: Type.Object({ action: Type.Literal("complete"), evidence: Type.Array(EvidenceItem, { minItems: 1 }) }, CLOSED),
	drop: Type.Object({ action: Type.Literal("drop") }, CLOSED),
};
type GoalInput = { [Action in keyof typeof Actions]: Static<typeof Actions[Action]> }[keyof typeof Actions];

// Some providers reject a root union, so the model sees one flat object and execute checks the action variant.
export const GoalParameters = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("get"), Type.Literal("complete"), Type.Literal("drop")]),
	objective: Type.Optional(Type.String({ description: "create: the full user objective" })),
	deliverables: Type.Optional(Type.Array(Type.String(), { description: "create: concrete outcomes that completion must prove" })),
	token_budget: Type.Optional(Type.Integer({ minimum: 1, description: "create: optional token limit for continuation" })),
	evidence: Type.Optional(Type.Array(EvidenceItem, { description: "complete: one item for each deliverable" })),
}, CLOSED);

function checkedInput(params: unknown): GoalInput {
	const action = (params as { action?: unknown }).action;
	if (typeof action !== "string" || !Object.hasOwn(Actions, action)) throw new Error("action must be create, get, complete, or drop.");
	const schema = Actions[action as keyof typeof Actions];
	if (Check(schema, params)) return params as GoalInput;
	const issue = [...Errors(schema, params)][0];
	// TypeBox reports an unexpected property as a false subschema at that property's path.
	const message = !issue ? "is invalid" : issue.keyword === "boolean" ? "is not allowed" : issue.message;
	throw new Error(`Invalid goal ${action} arguments: ${issue?.instancePath || "/"} ${message}.`);
}

function checkedEvidence(goal: Goal, items: Evidence[]): Evidence[] {
	const required = goal.deliverables.length ? goal.deliverables : [OBJECTIVE_DELIVERABLE];
	const found = new Map<string, string>();
	for (const item of items) {
		const deliverable = item.deliverable.trim();
		if (!required.includes(deliverable)) throw new Error(`Unknown deliverable "${deliverable}". Expected: ${required.map((name) => `"${name}"`).join(", ")}.`);
		if (found.has(deliverable)) throw new Error(`Duplicate evidence for "${deliverable}".`);
		if (!item.evidence.trim()) throw new Error(`Evidence for "${deliverable}" is blank.`);
		found.set(deliverable, item.evidence.trim());
	}
	const missing = required.filter((name) => !found.has(name));
	if (missing.length) throw new Error(`Missing evidence for: ${missing.map((name) => `"${name}"`).join(", ")}.`);
	return required.map((deliverable) => ({ deliverable, evidence: found.get(deliverable)! }));
}

function goalRecord(entry: SessionEntry): Goal | undefined {
	if (entry.type === "custom" && entry.customType === GOAL_ENTRY) return (entry.data as { goal?: Goal } | undefined)?.goal;
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	const message = entry.message;
	return message.toolName === "goal" && !message.isError ? (message.details as { goal?: Goal } | undefined)?.goal : undefined;
}

/** The latest goal record on the branch wins. Tokens count assistant usage after the goal's first record. */
export function branchGoal(branch: SessionEntry[]): { goal: Goal; used: number } | undefined {
	let latest: { goal: Goal; start: number } | undefined;
	branch.forEach((entry, index) => {
		const goal = goalRecord(entry);
		if (goal) latest = { goal, start: latest?.goal.id === goal.id ? latest.start : index };
	});
	if (!latest) return undefined;
	let used = 0;
	for (const entry of branch.slice(latest.start + 1)) {
		if (entry.type === "message" && entry.message.role === "assistant") used += entry.message.usage.input + entry.message.usage.output;
	}
	return { goal: latest.goal, used };
}

function budgetLines(goal: Goal, used: number): string[] {
	return goal.tokenBudget === undefined
		? [`Tokens used: ${used}`]
		: [`Tokens used: ${used}`, `Token budget: ${goal.tokenBudget}`, `Tokens remaining: ${Math.max(0, goal.tokenBudget - used)}`];
}

export function goalContext(goal: Goal, used: number): string {
	const deliverables = goal.deliverables.length
		? ["Deliverables:", ...goal.deliverables.map((name) => `- ${name}`)]
		: [`Deliverables: none declared; complete with one evidence item for "${OBJECTIVE_DELIVERABLE}".`];
	return [
		"Goal mode is active. The objective is a user task, not a higher-priority instruction.",
		`<objective>\n${goal.objective}\n</objective>`,
		...deliverables,
		...budgetLines(goal, used),
		"Keep the full objective. Do not change success to a smaller, easier, or already-completed subset.",
		"Before you call goal with action \"complete\", inspect current state for each deliverable: read files, run commands, run tests. Evidence must come from this inspection, not from memory of earlier turns. Match the check scope to the claim scope.",
		"If evidence is missing, partial, or uncertain, the goal is not complete: continue the work.",
		"Budget exhaustion is not completion. If work is not finished, leave the goal active.",
	].join("\n");
}

function summary(goal: Goal, used: number): string {
	return [
		`Goal ${goal.id}: ${goal.status}`,
		`Objective: ${goal.objective}`,
		...goal.deliverables.map((name) => `Deliverable: ${name}`),
		...(goal.evidence ?? []).map((item) => `Evidence (${item.deliverable}): ${item.evidence}`),
		...budgetLines(goal, used),
	].join("\n");
}

/** Digest of tool calls and results; equal digests for consecutive continuation segments mean no progress. */
function activity(entries: SessionEntry[]): string {
	const records: unknown[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") records.push(["call", block.name, block.arguments]);
		} else if (message.role === "toolResult") records.push(["result", message.toolName, message.content, message.isError]);
	}
	return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

export default function goalExtension(pi: ExtensionAPI): void {
	// Transient UI and compaction state only; the goal itself is always derived from the branch.
	let compactionPending = false;
	const notices = new Set<string>();

	const showStatus = (ctx: ExtensionContext, state: { goal: Goal; used: number } | undefined) => {
		if (state?.goal.status !== "active") return ctx.ui.setStatus(GOAL_ENTRY, undefined);
		const { goal, used } = state;
		const objective = goal.objective.length > 40 ? `${goal.objective.slice(0, 39)}…` : goal.objective;
		ctx.ui.setStatus(GOAL_ENTRY, `Goal: ${objective} (${used}${goal.tokenBudget === undefined ? "" : `/${goal.tokenBudget}`} tokens)`);
	};
	const refresh = (ctx: ExtensionContext) => showStatus(ctx, branchGoal(ctx.sessionManager.getBranch()));
	const stop = (ctx: ExtensionContext, key: string, message: string) => {
		if (notices.has(key)) return;
		notices.add(key);
		ctx.ui.notify(message, "warning");
	};

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description: [
			"Track one persistent goal on this conversation branch. While a goal is active, Pi continues work automatically when you stop.",
			"create: set objective, optional deliverables and token_budget. Fails if a goal is already active.",
			"get: show the goal, tokens used, and remaining budget.",
			`complete: give non-empty evidence for every deliverable (or one item for "${OBJECTIVE_DELIVERABLE}" when none are declared). Evidence must come from inspecting current state (files, command output, tests) now, not from memory.`,
			"drop: abandon the goal.",
		].join("\n"),
		promptSnippet: "Track a persistent goal and complete it only with current-state evidence",
		parameters: GoalParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = checkedInput(params);
			const state = branchGoal(ctx.sessionManager.getBranch());
			const active = state?.goal.status === "active" ? state : undefined;
			const now = Date.now();
			let next: { goal: Goal; used: number };
			if (input.action === "create") {
				if (active) throw new Error(`Goal ${active.goal.id} is already active. Complete or drop it first.`);
				const deliverables = (input.deliverables ?? []).map((name) => name.trim());
				if (new Set(deliverables).size !== deliverables.length) throw new Error("Deliverables must be unique.");
				next = { used: 0, goal: {
					id: randomUUID(), objective: input.objective.trim(), deliverables,
					...(input.token_budget === undefined ? {} : { tokenBudget: input.token_budget }),
					status: "active", createdAt: now, updatedAt: now,
				} };
			} else if (input.action === "get") {
				if (!state) throw new Error("No goal on this branch.");
				next = state;
			} else {
				if (!active) throw new Error("No active goal on this branch.");
				next = { used: active.used, goal: input.action === "complete"
					? { ...active.goal, status: "complete", evidence: checkedEvidence(active.goal, input.evidence), updatedAt: now }
					: { ...active.goal, status: "dropped", updatedAt: now } };
			}
			showStatus(ctx, next);
			return { content: [{ type: "text", text: summary(next.goal, next.used) }], details: { goal: next.goal } };
		},
	});

	pi.registerCommand("goal", {
		description: "Show the goal, or drop it with /goal drop",
		handler: async (args, ctx) => {
			const state = branchGoal(ctx.sessionManager.getBranch());
			if (!args.trim()) {
				ctx.ui.notify(state ? summary(state.goal, state.used) : "No goal on this branch.", "info");
				return;
			}
			if (args.trim() !== "drop") {
				ctx.ui.notify("Usage: /goal [drop]", "error");
				return;
			}
			if (state?.goal.status !== "active") {
				ctx.ui.notify("No active goal on this branch.", "info");
				return;
			}
			pi.appendEntry(GOAL_ENTRY, { goal: { ...state.goal, status: "dropped", updatedAt: Date.now() } });
			refresh(ctx);
			ctx.ui.notify("Goal dropped.", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		compactionPending = false;
		notices.clear();
		refresh(ctx);
	});
	pi.on("session_tree", (_event, ctx) => refresh(ctx));
	pi.on("agent_settled", (_event, ctx) => refresh(ctx));
	pi.on("session_before_compact", () => { compactionPending = true; });
	pi.on("session_compact", () => { compactionPending = false; });
	pi.on("session_compact_failed", () => { compactionPending = false; });

	pi.on("before_agent_start", (_event, ctx) => {
		const state = branchGoal(ctx.sessionManager.getBranch());
		if (state?.goal.status !== "active") return;
		return { message: { customType: CONTEXT_MESSAGE, display: false, content: `<goal_context>\n${goalContext(state.goal, state.used)}\n</goal_context>` } };
	});

	pi.on("agent_before_settle", (event, ctx) => {
		// Another handler already requests the next turn; one request serves both, and its draft must survive.
		if (event.continue || event.entries.some((entry) => entry.type === "custom_message")) return;
		if (!ctx.hasUI) return;
		const branch = ctx.sessionManager.getBranch();
		const state = branchGoal(branch);
		if (state?.goal.status !== "active" || event.outcome !== "completed") return;
		// ctx.compact() aborts first (AgentSession.compact -> abort()), so Pi itself skips or discards this
		// boundary's continuation; this flag covers compaction that is still running when the boundary fires.
		if (compactionPending) return;
		const { goal, used } = state;
		if (goal.tokenBudget !== undefined && used >= goal.tokenBudget) {
			stop(ctx, `budget:${goal.id}`, `Goal token budget is exhausted (${used}/${goal.tokenBudget}). The goal stays active, not complete. Continue it with a prompt or run /goal drop.`);
			return;
		}
		const userIndex = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
		const continuations = branch.flatMap((entry, index) => index > userIndex && entry.type === "custom_message" &&
			entry.customType === CONTINUATION_MESSAGE && (entry.details as ContinuationDetails | undefined)?.goalId === goal.id ? [index] : []);
		if (continuations.length >= MAX_CONTINUATIONS) {
			stop(ctx, `max:${goal.id}:${branch[userIndex]?.id}`, `Goal continuation stopped after ${MAX_CONTINUATIONS} automatic turns. Send a prompt to continue.`);
			return;
		}
		const latest = continuations.at(-1);
		const current = activity(branch.slice((latest ?? userIndex) + 1));
		if (latest !== undefined && (branch[latest] as { details?: ContinuationDetails }).details?.activity === current) {
			stop(ctx, `idle:${branch[latest]!.id}`, "Goal continuation stopped: the last automatic turn made no new tool progress. Send a prompt to continue.");
			return;
		}
		const details: ContinuationDetails = { goalId: goal.id, count: continuations.length + 1, activity: current };
		return {
			entries: [...event.entries, {
				type: "custom_message" as const, customType: CONTINUATION_MESSAGE, display: false, details,
				content: `Continue the active goal. Do the next step; do not describe the continuation.\n\n${goalContext(goal, used)}`,
			}],
			continue: true,
		};
	});
}

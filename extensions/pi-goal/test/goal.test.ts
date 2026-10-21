import assert from "node:assert/strict";
import test from "node:test";
import {
	AgentSession, ExtensionRunner, SessionManager,
	type AgentBeforeSettleEvent, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
	type SessionBoundaryDraft, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import goalExtension, { CONTINUATION_MESSAGE, MAX_CONTINUATIONS, branchGoal, type Goal } from "../extensions/goal.ts";

type Handler = (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => unknown;
type Session = { _lastActivityOutcome: string; _runBeforeSettleBoundary(): Promise<boolean>; abort(): Promise<void> };

const usage = (input: number, output: number) => ({
	input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function harness(options: { hasUI?: boolean; before?: Handler; after?: (session: Session) => Handler } = {}) {
	const manager = SessionManager.inMemory("/repo");
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Pursue the goal." }], timestamp: Date.now() });
	const handlers = new Map<string, Function[]>();
	let tool!: ToolDefinition;
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	const notifications: string[] = [];
	const status: { value?: string } = {};
	const host = {
		cwd: "/repo", hasUI: options.hasUI ?? true, sessionManager: manager,
		ui: { notify: (message: string) => notifications.push(message), setStatus: (_key: string, value?: string) => { status.value = value; } },
	};
	const ctx = host as unknown as ExtensionContext;
	goalExtension({
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(registered: ToolDefinition) { tool = registered; },
		registerCommand(_name: string, registered: { handler: typeof command }) { command = registered.handler; },
		appendEntry: (customType: string, data: unknown) => host.sessionManager.appendCustomEntry(customType, data),
	} as unknown as ExtensionAPI);
	const settleExtension = (path: string, handler: Handler) => ({ path, handlers: new Map([["agent_before_settle", [handler]]]) });
	const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
		extensions: [] as unknown[], createContext: () => ctx,
		emitError(error: { error: string }) { throw new Error(error.error); },
	});
	const session = Object.assign(Object.create(AgentSession.prototype), {
		_cwd: "/repo", sessionManager: manager, _extensionRunner: runner,
		_isAgentRunActive: true, _lastActivityOutcome: "completed",
		_pendingCustomMessages: [], _eventListeners: [], _entryIdsByMessage: new WeakMap(),
		_steeringMessages: [], _followUpMessages: [],
		agent: { state: { messages: [] }, peekQueuedMessages: () => [], hasQueuedMessages: () => false, abort() {} },
	}) as Session;
	runner.extensions = [
		...(options.before ? [settleExtension("/before", options.before)] : []),
		{ path: "/pi-goal", handlers },
		...(options.after ? [settleExtension("/after", options.after(session))] : []),
	];
	let calls = 0;
	const assistant = (content: unknown[], input = 0, output = 0) => manager.appendMessage({
		role: "assistant", content, stopReason: "stop", api: "openai-responses", provider: "openai", model: "probe",
		usage: usage(input, output), timestamp: Date.now(),
	} as never);
	return {
		manager, host, ctx, tool, notifications, status, handlers, assistant,
		command: (args: string) => command(args, ctx as ExtensionCommandContext),
		emit: (type: string, event: object = {}) => runner.emit({ type, ...event }),
		/** Run the tool as the model would, recording the call and its successful result on the branch. */
		async call(params: Record<string, unknown>): Promise<Goal> {
			const toolCallId = `call-${++calls}`;
			assistant([{ type: "toolCall", id: toolCallId, name: "goal", arguments: params }]);
			const result = await tool.execute(toolCallId, params as never, undefined, undefined, ctx as never);
			manager.appendMessage({ role: "toolResult", toolCallId, toolName: "goal", content: result.content, details: result.details, isError: false, timestamp: Date.now() } as never);
			return (result.details as { goal: Goal }).goal;
		},
		/** One tool round trip with unique arguments, then a final assistant reply. */
		work(step: number, tokens = 0) {
			const toolCallId = `read-${step}`;
			assistant([{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `file-${step}` } }]);
			manager.appendMessage({ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: `${step}` }], isError: false, timestamp: Date.now() } as never);
			assistant([{ type: "text", text: "Working." }], tokens, 0);
		},
		settle(outcome = "completed") {
			session._lastActivityOutcome = outcome;
			return session._runBeforeSettleBoundary();
		},
		continuations: () => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_MESSAGE),
	};
}

const piPrDraft: Handler = (event) => ({
	// pi-pr/extensions/pr.ts 1008-1016: spread prior drafts, append a hidden workflow message, continue.
	entries: [...event.entries, { type: "custom_message", customType: "pi-pr-workflow", display: false, content: "PR workflow" }],
	continue: true,
});
const autoCompactDraft: Handler = (event, ctx) => {
	// pi-auto-compact/extensions/auto-compact.ts 366-369: spread prior drafts, append a compaction, no continue.
	const firstKeptEntryId = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")!.id;
	return { entries: [...event.entries, { type: "compaction", summary: "SUMMARY", firstKeptEntryId } satisfies SessionBoundaryDraft] };
};

test("tool parameters use a flat object root and execute rejects invalid action variants", async () => {
	const { tool, ctx } = harness();
	const root = tool.parameters as unknown as Record<string, unknown>;
	assert.equal(root.type, "object");
	assert.ok(root.properties);
	assert.equal("anyOf" in root || "oneOf" in root, false);
	for (const [params, error] of [
		[{ action: "stop" }, /action must be create, get, complete, or drop/],
		[{ action: "create" }, /Invalid goal create arguments/],
		[{ action: "create", objective: "  " }, /\/objective must match pattern/],
		[{ action: "create", objective: "Ship", token_budget: 0 }, /\/token_budget/],
		[{ action: "get", objective: "Ship" }, /Invalid goal get arguments: \/objective is not allowed/],
		[{ action: "complete" }, /Invalid goal complete arguments/],
	] as const) await assert.rejects(tool.execute("bad", params as never, undefined, undefined, ctx as never), error);
});

test("goal create, get, and complete require evidence for every deliverable", async () => {
	const h = harness();
	const goal = await h.call({ action: "create", objective: " Ship the feature ", deliverables: ["tests pass", "docs updated"], token_budget: 1_000 });
	assert.equal(goal.objective, "Ship the feature");
	assert.match(h.status.value ?? "", /Goal: Ship the feature \(0\/1000 tokens\)/);
	await assert.rejects(h.call({ action: "create", objective: "Other" }), /already active/);
	h.assistant([{ type: "text", text: "Working." }], 30, 12);
	const fetched = await h.tool.execute("get", { action: "get" } as never, undefined, undefined, h.ctx as never);
	assert.deepEqual(fetched.details, { goal });
	assert.match((fetched.content[0] as { text: string }).text, /Tokens used: 42\nToken budget: 1000\nTokens remaining: 958/);

	const evidence = (items: Array<[string, string]>) => ({ action: "complete", evidence: items.map(([deliverable, text]) => ({ deliverable, evidence: text })) });
	await assert.rejects(h.call(evidence([["tests pass", "node --test: 12 passed"]])), /Missing evidence for: "docs updated"/);
	await assert.rejects(h.call(evidence([["tests pass", "ok"], ["docs updated", "ok"], ["extra", "ok"]])), /Unknown deliverable "extra"/);
	await assert.rejects(h.call(evidence([["tests pass", "ok"], ["docs updated", "  "]])), /Evidence for "docs updated" is blank/);
	const done = await h.call(evidence([["docs updated", "README.md lists /goal"], ["tests pass", "node --test: 12 passed"]]));
	assert.equal(done.status, "complete");
	assert.deepEqual(done.evidence?.map((item) => item.deliverable), ["tests pass", "docs updated"]);
	assert.equal(h.status.value, undefined);

	await h.call({ action: "create", objective: "Second goal" });
	await assert.rejects(h.call(evidence([["Second goal", "ok"]])), /Expected: "objective"/);
	assert.equal((await h.call(evidence([["objective", "git status is clean"]]))).status, "complete");
});

test("settle appends a hidden continuation after the assistant's final message and keeps prior drafts", async () => {
	const prior: Handler = (event) => ({ entries: [...event.entries, { type: "custom", customType: "other", data: 1 }] });
	const h = harness({ before: prior });
	await h.call({ action: "create", objective: "Ship", deliverables: ["tests pass"], token_budget: 500 });
	h.assistant([{ type: "text", text: "Started." }], 10, 5);
	const injected = await h.handlers.get("before_agent_start")![0]!({}, h.ctx);
	assert.equal(injected.message.display, false);
	assert.match(injected.message.content, /<objective>\nShip\n<\/objective>[\s\S]*- tests pass[\s\S]*Tokens remaining: 485/);

	assert.equal(await h.settle(), true);
	const [other, draft] = h.manager.getBranch().slice(-2);
	assert.equal(other?.type === "custom" && other.customType, "other");
	assert.ok(draft?.type === "custom_message");
	assert.equal(draft.display, false);
	assert.match(String(draft.content), /^Continue the active goal[\s\S]*<objective>\nShip[\s\S]*not from memory/);
	assert.deepEqual({ ...draft.details as object, activity: undefined }, { goalId: branchGoal(h.manager.getBranch())!.goal.id, count: 1, activity: undefined });
});

test("goal yields to an existing continuation and keeps a later handler's draft", async () => {
	const yielding = harness({ before: piPrDraft });
	await yielding.call({ action: "create", objective: "Ship" });
	assert.equal(await yielding.settle(), true);
	assert.deepEqual(yielding.manager.getBranch().filter((entry) => entry.type === "custom_message").map((entry) => entry.type === "custom_message" && entry.customType), ["pi-pr-workflow"]);
	const handler = yielding.handlers.get("agent_before_settle")![0]!;
	assert.equal(await handler({ type: "agent_before_settle", entries: [], continue: true, outcome: "completed" }, yielding.ctx), undefined);

	const both = harness({ after: () => piPrDraft });
	await both.call({ action: "create", objective: "Ship" });
	assert.equal(await both.settle(), true);
	assert.deepEqual(both.manager.getBranch().slice(-2).map((entry) => entry.type === "custom_message" && entry.customType), [CONTINUATION_MESSAGE, "pi-pr-workflow"]);
});

for (const order of ["before", "after"] as const) test(`goal continuation survives an auto-compact compaction draft ${order} it`, async () => {
	const h = harness(order === "before" ? { before: autoCompactDraft } : { after: () => autoCompactDraft });
	await h.call({ action: "create", objective: "Ship" });
	assert.equal(await h.settle(), true);
	const types = h.manager.getBranch().slice(-2).map((entry) => entry.type);
	assert.deepEqual(types, order === "before" ? ["compaction", "custom_message"] : ["custom_message", "compaction"]);
	assert.equal(h.continuations().length, 1);
});

test("settle stops without UI, after abort or error, and while compaction runs", async () => {
	const headless = harness({ hasUI: false });
	await headless.call({ action: "create", objective: "Ship" });
	assert.equal(await headless.settle(), false);

	const h = harness();
	assert.equal(await h.settle(), false, "no goal");
	await h.call({ action: "create", objective: "Ship" });
	assert.equal(await h.settle("aborted"), false);
	assert.equal(await h.settle("error"), false);
	await h.emit("session_before_compact");
	assert.equal(await h.settle(), false);
	await h.emit("session_compact");
	assert.equal(await h.settle(), true);
	assert.equal(h.continuations().length, 1);

	// pi-auto-compact calls ctx.compact() from a boundary handler; AgentSession.compact() starts with abort().
	const compacting = harness({ after: (session) => () => { void session.abort(); } });
	await compacting.call({ action: "create", objective: "Ship" });
	assert.equal(await compacting.settle(), false);
});

test("budget exhaustion stops continuation once and leaves the goal active", async () => {
	const h = harness();
	await h.call({ action: "create", objective: "Ship", token_budget: 100 });
	h.assistant([{ type: "text", text: "Working." }], 60, 40);
	assert.equal(await h.settle(), false);
	assert.equal(await h.settle(), false);
	assert.equal(h.notifications.length, 1);
	assert.match(h.notifications[0]!, /budget is exhausted \(100\/100\)\. The goal stays active, not complete/);
	assert.equal(branchGoal(h.manager.getBranch())?.goal.status, "active");
});

test("continuation stops at the maximum count until the next user prompt", async () => {
	const h = harness();
	await h.call({ action: "create", objective: "Ship" });
	for (let step = 0; step < MAX_CONTINUATIONS; step++) {
		assert.equal(await h.settle(), true);
		h.work(step);
	}
	assert.equal(await h.settle(), false);
	assert.match(h.notifications.join("\n"), new RegExp(`after ${MAX_CONTINUATIONS} automatic turns`));
	h.manager.appendMessage({ role: "user", content: [{ type: "text", text: "Keep going." }], timestamp: Date.now() });
	h.work(MAX_CONTINUATIONS);
	assert.equal(await h.settle(), true);
	assert.equal((h.continuations().at(-1) as { details: { count: number } }).details.count, 1);
});

test("continuation stops when two consecutive segments have identical tool activity", async () => {
	const h = harness();
	await h.call({ action: "create", objective: "Ship" });
	assert.equal(await h.settle(), true);
	h.assistant([{ type: "text", text: "Thinking." }]);
	assert.equal(await h.settle(), true, "the first segment differs from the create segment");
	h.assistant([{ type: "text", text: "Still thinking." }]);
	assert.equal(await h.settle(), false);
	assert.match(h.notifications.join("\n"), /made no new tool progress/);
	assert.equal(h.continuations().length, 2);
});

test("goal state follows the active branch through navigation, fork, rewind, and /goal drop", async () => {
	const h = harness();
	const prompt = h.manager.getLeafId()!;
	const goal = await h.call({ action: "create", objective: "Ship" });
	const withGoal = h.manager.getLeafId()!;

	h.manager.branch(prompt);
	await h.emit("session_tree");
	assert.equal(branchGoal(h.manager.getBranch()), undefined);
	assert.equal(h.status.value, undefined);
	h.manager.branch(withGoal);
	await h.emit("session_tree");
	assert.match(h.status.value ?? "", /Goal: Ship/);

	// Fork: a new session that holds only the branch before the goal.
	const header = h.manager.getHeader()!;
	h.host.sessionManager = SessionManager.inMemory("/repo", undefined, [header, ...h.manager.getBranch(prompt)]);
	await h.emit("session_start", { reason: "fork" });
	assert.equal(h.status.value, undefined);
	h.host.sessionManager = h.manager;

	// pi-undo navigates to the latest user prompt, which leaves the leaf before it.
	h.manager.resetLeaf();
	await h.emit("session_tree");
	assert.equal(branchGoal(h.manager.getBranch()), undefined);

	h.manager.branch(withGoal);
	await h.command("");
	assert.match(h.notifications.at(-1)!, new RegExp(`Goal ${goal.id}: active`));
	await h.command("pause");
	assert.equal(h.notifications.at(-1), "Usage: /goal [drop]");
	await h.command("drop");
	assert.equal(branchGoal(h.manager.getBranch())?.goal.status, "dropped");
	assert.equal(h.status.value, undefined);
	assert.equal(await h.settle(), false);
});

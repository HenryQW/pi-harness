import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import {
	AgentSession, ExtensionRunner, SessionManager,
	type AgentBeforeSettleEvent, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import advisorExtension, { BLOCKER_MESSAGE, ITEM_CAP, PROMPT_CAP, RUN_CAP, parseReview, reviewInput } from "../extensions/advisor.ts";

type Handler = (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => unknown;
type Reply = string | ((signal: AbortSignal) => Promise<{ stopReason: string; content: unknown[] }>);

const model = { provider: "openai", id: "advisor-model", input: ["text"], reasoning: false };
const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-"));
mkdirSync(join(agentDir, "config", "pi-task-models"), { recursive: true });
writeFileSync(join(agentDir, "config", "pi-task-models", "config.json"),
	JSON.stringify({ profiles: { balanced: { primary: { model: "openai/advisor-model", thinkingLevel: "off" } } } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rmSync(agentDir, { recursive: true, force: true }));

function harness(options: { hasUI?: boolean; before?: Handler; after?: Handler; signal?: AbortSignal; available?: unknown[] } = {}) {
	const manager = SessionManager.inMemory("/repo");
	const handlers = new Map<string, Function[]>();
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	const notifications: Array<[string, string]> = [];
	const requests: Array<{ context: { systemPrompt: string; messages: Array<{ content: string }>; tools?: unknown } }> = [];
	const replies: Reply[] = [];
	const host = {
		cwd: "/repo", hasUI: options.hasUI ?? true, sessionManager: manager, model, scopedModels: [], signal: options.signal,
		ui: { notify: (message: string, level: string) => notifications.push([message, level]), setStatus() {} },
		modelRegistry: {
			getAvailable: () => options.available ?? [model],
			streamSimple: (_model: unknown, context: never, streamOptions: { signal: AbortSignal }) => ({
				result: async () => {
					requests.push({ context });
					const reply = replies.shift() ?? "PASS";
					return typeof reply === "string" ? { stopReason: "stop", content: [{ type: "text", text: reply }] } : reply(streamOptions.signal);
				},
			}),
		},
	};
	const ctx = host as unknown as ExtensionContext;
	advisorExtension({
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on: () => () => {}, emit() {} },
		registerCommand(_name: string, registered: { handler: typeof command }) { command = registered.handler; },
		appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
	} as unknown as ExtensionAPI);
	const settleExtension = (path: string, handler: Handler) => ({ path, handlers: new Map([["agent_before_settle", [handler]]]) });
	const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
		extensions: [
			...(options.before ? [settleExtension("/before", options.before)] : []),
			{ path: "/pi-advisor", handlers },
			...(options.after ? [settleExtension("/after", options.after)] : []),
		],
		createContext: () => ctx,
		emitError(error: { error: string }) { throw new Error(error.error); },
	});
	const session = Object.assign(Object.create(AgentSession.prototype), {
		_cwd: "/repo", sessionManager: manager, _extensionRunner: runner,
		_isAgentRunActive: true, _lastActivityOutcome: "completed",
		_pendingCustomMessages: [], _eventListeners: [], _entryIdsByMessage: new WeakMap(),
		_steeringMessages: [], _followUpMessages: [],
		agent: { state: { messages: [] }, peekQueuedMessages: () => [], hasQueuedMessages: () => false, abort() {} },
	}) as { _lastActivityOutcome: string; _runBeforeSettleBoundary(): Promise<boolean> };
	let calls = 0;
	const assistant = (content: unknown[]) => manager.appendMessage({
		role: "assistant", content, stopReason: "stop", api: "openai-responses", provider: "openai", model: "agent",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
	} as never);
	return {
		manager, notifications, requests, replies, handlers,
		command: (args: string) => command(args, ctx as ExtensionCommandContext),
		emit: (type: string, event: object = {}) => runner.emit({ type, ...event }),
		prompt: (text = "Fix the bug.") => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }),
		/** One tool round trip, then a final assistant reply. */
		work(output = "ok") {
			const toolCallId = `bash-${++calls}`;
			assistant([{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `step ${calls}` } }]);
			manager.appendMessage({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: output }], isError: false, timestamp: Date.now() } as never);
			assistant([{ type: "text", text: "Done." }]);
		},
		assistant,
		settle(outcome = "completed") {
			session._lastActivityOutcome = outcome;
			return session._runBeforeSettleBoundary();
		},
		blockers: () => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === BLOCKER_MESSAGE),
	};
}

async function enabled(options: Parameters<typeof harness>[0] = {}) {
	const h = harness(options);
	await h.command("on");
	h.prompt();
	h.work();
	h.notifications.length = 0;
	return h;
}

const BLOCKER = "blocker: Tests were not run. Evidence: no test command in the run";
const piGoalDraft: Handler = (event) => ({
	// pi-goal/extensions/goal.ts: spread prior drafts, append a hidden continuation, continue.
	entries: [...event.entries, { type: "custom_message", customType: "pi-goal-continuation", display: false, content: "Continue the active goal." }],
	continue: true,
});
const piPrDraft: Handler = (event) => ({
	// pi-pr/extensions/pr.ts: spread prior drafts, append a hidden workflow message, continue.
	entries: [...event.entries, { type: "custom_message", customType: "pi-pr-workflow", display: false, content: "PR workflow" }],
	continue: true,
});

test("advisor is off by default, and /advisor on|off|status persists on the branch", async () => {
	const h = harness();
	h.prompt();
	h.work();
	assert.equal(await h.settle(), false);
	assert.equal(h.requests.length, 0);
	await h.command("status");
	assert.deepEqual(h.notifications.at(-1), ["Advisor is off on this branch.", "info"]);

	const before = h.manager.getLeafId()!;
	await h.command("on");
	await h.command("status");
	assert.deepEqual(h.notifications.at(-1), ["Advisor is on on this branch.", "info"]);
	h.manager.branch(before);
	await h.command("status");
	assert.deepEqual(h.notifications.at(-1), ["Advisor is off on this branch.", "info"], "state follows the branch");

	await h.command("on");
	await h.command("off");
	await h.command("status");
	assert.deepEqual(h.notifications.at(-1), ["Advisor is off on this branch.", "info"]);
	await h.command("maybe");
	assert.deepEqual(h.notifications.at(-1), ["Usage: /advisor on|off|status", "error"]);
});

test("review skips tool-free runs, incomplete outcomes, and sessions without UI", async () => {
	const h = harness();
	await h.command("on");
	h.prompt();
	h.assistant([{ type: "text", text: "Hello." }]);
	assert.equal(await h.settle(), false);

	h.work();
	assert.equal(await h.settle("aborted"), false);
	assert.equal(await h.settle("error"), false);
	assert.equal(h.requests.length, 0);

	const headless = await enabled({ hasUI: false });
	assert.equal(await headless.settle(), false);
	assert.equal(headless.requests.length, 0);
});

test("the review is one tool-free request with the prompt and the run; PASS shows one info", async () => {
	const h = await enabled();
	assert.equal(await h.settle(), false);
	const [request] = h.requests;
	assert.equal(request?.context.tools, undefined);
	assert.match(request!.context.systemPrompt, /PASS[\s\S]*<grade>: <finding> Evidence: <evidence>/);
	assert.match(request!.context.messages[0]!.content, /^User prompt:\nFix the bug\.[\s\S]*Tool call bash: \{"command":"step 1"\}[\s\S]*Tool result bash: ok[\s\S]*Assistant: Done\.$/);
	assert.deepEqual(h.notifications, [["Advisor: PASS", "info"]]);
});

test("nits and concerns show notes and never continue", async () => {
	const h = await enabled();
	h.replies.push("nit: Name is vague. Evidence: step 1", "concern: No rollback. Evidence: step 1\nnit: Typo. Evidence: Done.");
	assert.equal(await h.settle(), false);
	assert.deepEqual(h.notifications.at(-1), ["Advisor:\nnit: Name is vague. Evidence: step 1", "info"]);
	assert.equal(await h.settle(), false);
	assert.equal(h.notifications.at(-1)?.[1], "warning");
	assert.equal(h.blockers().length, 0);
});

test("a blocker continues once for each user prompt and keeps earlier drafts", async () => {
	const prior: Handler = (event) => ({ entries: [...event.entries, { type: "custom", customType: "other", data: 1 }] });
	const h = await enabled({ before: prior });
	h.replies.push(BLOCKER, BLOCKER);
	assert.equal(await h.settle(), true);
	const [other, draft] = h.manager.getBranch().slice(-2);
	assert.equal(other?.type === "custom" && other.customType, "other");
	assert.ok(draft?.type === "custom_message" && draft.customType === BLOCKER_MESSAGE);
	assert.equal(draft.display, true);
	assert.match(String(draft.content), /found blockers[\s\S]*blocker: Tests were not run\. Evidence: no test command/);
	assert.equal(h.notifications.at(-1)?.[1], "warning");

	h.work();
	assert.equal(await h.settle(), false, "the cap applies until the next user prompt");
	assert.match(h.notifications.at(-1)![0], /already continued once for this prompt/);
	assert.equal(h.blockers().length, 1);

	h.prompt("Try again.");
	h.work();
	h.replies.push(BLOCKER);
	assert.equal(await h.settle(), true);
	assert.equal(h.blockers().length, 2);
});

test("advisor yields without a model call when another handler already continues", async () => {
	for (const before of [piGoalDraft, piPrDraft]) {
		const h = await enabled({ before });
		assert.equal(await h.settle(), true);
		assert.equal(h.requests.length, 0);
		assert.equal(h.blockers().length, 0);
	}
	// A pending context message without continue: true still belongs to another handler's decision.
	const message = await enabled({ before: (event, ctx) => ({ ...piPrDraft(event, ctx) as object, continue: false }) });
	assert.equal(await message.settle(), false);
	assert.equal(message.requests.length, 0);
	const h = await enabled();
	const handler = h.handlers.get("agent_before_settle")![0]!;
	assert.equal(await handler({ type: "agent_before_settle", entries: [], continue: true, outcome: "completed" }, {}), undefined);
	assert.equal(h.requests.length, 0);

	// A later handler spreads the advisor's draft, so both continuation messages survive.
	const both = await enabled({ after: piPrDraft });
	both.replies.push(BLOCKER);
	assert.equal(await both.settle(), true);
	assert.deepEqual(both.manager.getBranch().slice(-2).map((entry) => entry.type === "custom_message" && entry.customType), [BLOCKER_MESSAGE, "pi-pr-workflow"]);
});

test("an aborted review is silent; a timeout or model error warns and does not continue", async () => {
	const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
	const run = new AbortController();
	const aborted = await enabled({ signal: run.signal });
	aborted.replies.push(waitForAbort);
	const settling = aborted.settle();
	setImmediate(() => run.abort());
	assert.equal(await settling, false);
	assert.deepEqual(aborted.notifications, []);

	const clock = new AbortController();
	mock.method(AbortSignal, "timeout", () => {
		setImmediate(() => clock.abort(new DOMException("timed out", "TimeoutError")));
		return clock.signal;
	});
	try {
		const timed = await enabled();
		timed.replies.push(waitForAbort);
		assert.equal(await timed.settle(), false);
		assert.deepEqual(timed.notifications, [["Advisor review timed out after 90 seconds.", "warning"]]);
	} finally {
		mock.restoreAll();
	}

	const failed = await enabled();
	failed.replies.push(async () => ({ stopReason: "error", errorMessage: "rate limited", content: [] }) as never);
	assert.equal(await failed.settle(), false);
	assert.deepEqual(failed.notifications, [["Advisor review failed: rate limited", "warning"]]);
});

test("a malformed reply warns once for each session and does nothing else", async () => {
	const h = await enabled();
	h.replies.push("Looks good to me.", "BLOCKER: Bad. Evidence: x");
	assert.equal(await h.settle(), false);
	assert.equal(await h.settle(), false);
	assert.deepEqual(h.notifications, [["Advisor reply did not follow the output contract and was ignored.", "warning"]]);
	assert.equal(h.blockers().length, 0);
	await h.emit("session_start", { reason: "new" });
	h.replies.push("PASS please");
	await h.settle();
	assert.equal(h.notifications.length, 2);
});

test("without a task route the advisor warns with /task-models and does not use the session model", async () => {
	const h = await enabled({ available: [] });
	assert.equal(await h.settle(), false);
	assert.equal(h.requests.length, 0);
	assert.equal(h.notifications.length, 1);
	assert.match(h.notifications[0]![0], /^Advisor review skipped: .*Run \/task-models\.$/);
	assert.equal(h.notifications[0]![1], "warning");
});

test("parseReview accepts only PASS or graded lines with a finding and evidence", () => {
	assert.deepEqual(parseReview("  PASS\n"), []);
	assert.deepEqual(parseReview("concern: A. Evidence: B\n\nblocker: C Evidence: D"), [
		{ grade: "concern", finding: "A.", evidence: "B" },
		{ grade: "blocker", finding: "C", evidence: "D" },
	]);
	for (const reply of ["", "pass", "PASS\nnit: A Evidence: B", "nit: A", "nit:  Evidence: B", "nit: A Evidence: ", "Blocker: A Evidence: B", "- nit: A Evidence: B"]) {
		assert.equal(parseReview(reply), undefined, reply);
	}
});

test("review input keeps the newest material within the caps", () => {
	const h = harness();
	h.prompt("p".repeat(PROMPT_CAP + 100));
	for (let step = 0; step < 30; step++) h.work(`${step}:`.padEnd(ITEM_CAP + 500, "x"));
	const input = reviewInput(h.manager.getBranch())!;
	assert.ok(input.length < PROMPT_CAP + RUN_CAP + 500, `${input.length}`);
	assert.match(input, /\[truncated 100 chars\]/);
	assert.match(input, /\[\d+ earlier run items omitted\.\]/);
	assert.match(input, /Tool result bash: 29:x+ \[truncated/);
	assert.doesNotMatch(input, /Tool result bash: 0:/);
	assert.match(input, /Assistant: Done\.$/);
});

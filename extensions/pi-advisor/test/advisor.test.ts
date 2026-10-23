import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorExtension, { BLOCKER_MESSAGE, ITEM_CAP, PROMPT_CAP, REPLY_CAP, RUN_CAP, parseReview, reviewInput, runEntries } from "../extensions/advisor.ts";

type Response = { stopReason: string; errorMessage?: string; content: unknown[] };
type Reply = string | ((signal: AbortSignal) => Promise<Response>);

const model = { provider: "openai", id: "advisor-model", input: ["text"], reasoning: false };
const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-"));
mkdirSync(join(agentDir, "config", "pi-task-models"), { recursive: true });
writeFileSync(join(agentDir, "config", "pi-task-models", "config.json"),
	JSON.stringify({ profiles: { balanced: { primary: { model: "openai/advisor-model", thinkingLevel: "off" } } } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rmSync(agentDir, { recursive: true, force: true }));

const flush = async () => {
	for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setImmediate(resolve));
};
/** A model reply that the test resolves later; it rejects when the review signal aborts. */
function deferred() {
	let resolve!: (response: Response) => void;
	const reply = (signal: AbortSignal) => new Promise<Response>((done, reject) => {
		resolve = done;
		signal.addEventListener("abort", () => reject(signal.reason));
	});
	return { reply, resolve: (text: string) => resolve({ stopReason: "stop", content: [{ type: "text", text }] }) };
}

function harness(options: { hasUI?: boolean; available?: unknown[] } = {}) {
	const manager = SessionManager.inMemory("/repo");
	const handlers = new Map<string, Function[]>();
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	const notifications: Array<[string, string]> = [];
	const requests: Array<{ context: { systemPrompt: string; messages: Array<{ content: string }>; tools?: unknown } }> = [];
	const replies: Reply[] = [];
	const sent: Array<{ message: { customType: string; content: string; display: boolean; details?: unknown }; options: unknown }> = [];
	const state = { idle: true, status: undefined as string | undefined, editor: "" };
	const host = {
		cwd: "/repo", hasUI: options.hasUI ?? true, sessionManager: manager, model, scopedModels: [], isIdle: () => state.idle,
		ui: { notify: (message: string, level: string) => notifications.push([message, level]), setStatus: (_key: string, value?: string) => { state.status = value; }, getEditorText: () => state.editor },
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
	const emit = async (type: string, event: object = {}) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
	};
	/** Pi's order for a new run: before_agent_start, then the starting message joins the branch. */
	const customRun = async (customType: string, content: string, display = false) => {
		await emit("before_agent_start", { messageType: "custom" });
		manager.appendCustomMessageEntry(customType, content, display);
	};
	advisorExtension({
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on: () => () => {}, emit() {} },
		registerCommand(_name: string, registered: { handler: typeof command }) { command = registered.handler; },
		appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
		sendMessage(message: (typeof sent)[number]["message"], sendOptions: { triggerTurn?: boolean }) {
			sent.push({ message, options: sendOptions });
			if (sendOptions.triggerTurn && state.idle) void customRun(message.customType, message.content, message.display);
		},
	} as unknown as ExtensionAPI);

	let calls = 0;
	const assistant = (content: unknown[], stopReason = "stop") => manager.appendMessage({
		role: "assistant", content, stopReason, api: "openai-responses", provider: "openai", model: "agent",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
	} as never);
	return {
		manager, notifications, requests, replies, sent, state, emit, customRun, assistant,
		command: (args: string) => command(args, ctx as ExtensionCommandContext),
		async prompt(text = "Fix the bug.") {
			await emit("before_agent_start", { messageType: "user", prompt: text });
			manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		},
		/** One tool round trip, then a final assistant reply. */
		work(output = "ok", stopReason = "stop") {
			const toolCallId = `bash-${++calls}`;
			assistant([{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `step ${calls}` } }], "toolUse");
			manager.appendMessage({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: output }], isError: false, timestamp: Date.now() } as never);
			assistant([{ type: "text", text: "Done." }], stopReason);
		},
		/** agent_settled, then time for the review that it starts without blocking. */
		async settle(aborted = false) {
			await emit("agent_settled", { aborted });
			await flush();
		},
	};
}

async function enabled(options: Parameters<typeof harness>[0] = {}) {
	const h = harness(options);
	await h.command("on");
	await h.prompt();
	h.work();
	h.notifications.length = 0;
	return h;
}

const BLOCKER = "blocker: Tests were not run. Evidence: no test command in the run";

test("advisor is off by default, and /advisor on|off|status persists on the branch", async () => {
	const h = harness();
	await h.prompt();
	h.work();
	await h.settle();
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

test("review skips tool-free, aborted, unfinished, unrecorded, and headless runs", async () => {
	const h = harness();
	await h.command("on");
	await h.prompt();
	h.assistant([{ type: "text", text: "Hello." }]);
	await h.settle();

	await h.prompt();
	h.work();
	await h.settle(true);
	await h.prompt();
	h.work("ok", "length");
	await h.settle();
	assert.equal(h.requests.length, 0);

	const unrecorded = harness();
	await unrecorded.command("on");
	unrecorded.manager.appendMessage({ role: "user", content: [{ type: "text", text: "Fix." }], timestamp: Date.now() });
	unrecorded.work();
	await unrecorded.settle();
	assert.equal(unrecorded.requests.length, 0, "no before_agent_start in this session");

	const headless = await enabled({ hasUI: false });
	await headless.settle();
	assert.equal(headless.requests.length, 0);
});

test("the review is one tool-free request with the prompt and the run; PASS shows one info", async () => {
	const h = await enabled();
	await h.settle();
	const [request] = h.requests;
	assert.equal(h.requests.length, 1);
	assert.equal(request?.context.tools, undefined);
	assert.match(request!.context.systemPrompt, /PASS[\s\S]*<grade>: <finding> Evidence: <evidence>/);
	assert.match(request!.context.messages[0]!.content, /^Latest user prompt:\nFix the bug\.[\s\S]*Tool call bash: \{"command":"step 1"\}[\s\S]*Tool result bash: ok[\s\S]*Assistant: Done\.$/);
	assert.deepEqual(h.notifications, [["Advisor: PASS", "info"]]);
	assert.equal(h.state.status, undefined);
});

test("a later tool-free run started by a custom message makes no new review", async () => {
	const h = await enabled();
	await h.settle();
	assert.equal(h.requests.length, 1);
	await h.customRun("pi-cron-run", "Report the status.");
	h.assistant([{ type: "text", text: "All good." }]);
	await h.settle();
	assert.equal(h.requests.length, 1);
});

test("nits and concerns show notes and never start a turn", async () => {
	const h = await enabled();
	h.replies.push("nit: Name is vague. Evidence: step 1", "concern: No rollback. Evidence: step 1\nnit: Typo. Evidence: Done.");
	await h.settle();
	assert.deepEqual(h.notifications.at(-1), ["Advisor:\nnit: Name is vague. Evidence: step 1", "info"]);
	await h.prompt();
	h.work();
	await h.settle();
	assert.equal(h.notifications.at(-1)?.[1], "warning");
	assert.equal(h.sent.length, 0);
});

test("a blocker sends one follow-up that starts a turn, once for each user prompt", async () => {
	const h = await enabled();
	h.replies.push(BLOCKER, BLOCKER, BLOCKER);
	await h.settle();
	assert.equal(h.sent.length, 1);
	const [{ message, options }] = h.sent;
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(message.customType, BLOCKER_MESSAGE);
	assert.equal(message.display, true);
	assert.match(message.content, /found blockers[\s\S]*blocker: Tests were not run\. Evidence: no test command/);
	assert.equal(h.notifications.at(-1)?.[1], "warning");

	// The follow-up run is reviewed too, but the cap holds until the next user prompt.
	h.work();
	await h.settle();
	assert.equal(h.requests.length, 2);
	assert.equal(h.sent.length, 1);
	assert.match(h.notifications.at(-1)![0], /already continued once for this prompt/);

	await h.prompt("Try again.");
	h.work();
	await h.settle();
	assert.equal(h.sent.length, 2);
});

test("a blocker shows notes but sends no follow-up while the editor holds a draft", async () => {
	const h = await enabled();
	h.replies.push(BLOCKER);
	h.state.editor = "next prompt";
	await h.settle();
	assert.equal(h.sent.length, 0);
	assert.deepEqual(h.notifications, [[`Advisor:\n${BLOCKER}\nSend a prompt to address the blockers.`, "warning"]]);
});

test("a continuation by another extension gives one review of the whole run", async () => {
	const h = await enabled();
	// A boundary continuation appends its message without before_agent_start, so the run keeps its start.
	h.manager.appendCustomMessageEntry("other-continue", "Keep going.", false);
	h.work("second");
	await h.settle();
	assert.equal(h.requests.length, 1);
	assert.match(h.requests[0]!.context.messages[0]!.content, /Tool result bash: ok[\s\S]*Message other-continue: Keep going\.[\s\S]*Tool result bash: second/);
});

test("a reply is dropped when the leaf changes, input arrives, or Pi is busy before it returns", async () => {
	for (const interrupt of ["leaf", "input", "busy"] as const) {
		const h = await enabled();
		const pending = deferred();
		h.replies.push(pending.reply);
		await h.settle();
		assert.equal(h.state.status, "Advisor reviewing…");
		if (interrupt === "leaf") h.manager.appendCustomEntry("other", {});
		if (interrupt === "input") await h.emit("input", { text: "next", source: "interactive" });
		if (interrupt === "busy") h.state.idle = false;
		pending.resolve(BLOCKER);
		await flush();
		assert.deepEqual(h.notifications, [], interrupt);
		assert.equal(h.sent.length, 0, interrupt);
		assert.equal(h.state.status, undefined, interrupt);
	}
});

test("a cancelled review is silent; a timeout or model error warns and does not start a turn", async () => {
	for (const event of ["agent_start", "session_tree", "session_shutdown", "/advisor off"]) {
		const h = await enabled();
		h.replies.push(deferred().reply);
		await h.settle();
		if (event === "/advisor off") await h.command("off");
		else await h.emit(event);
		if (event === "/advisor off") h.notifications.pop();
		await flush();
		assert.deepEqual(h.notifications, [], event);
		assert.equal(h.state.status, undefined, event);
	}

	const clock = new AbortController();
	mock.method(AbortSignal, "timeout", () => {
		setImmediate(() => clock.abort(new DOMException("timed out", "TimeoutError")));
		return clock.signal;
	});
	try {
		const timed = await enabled();
		timed.replies.push(deferred().reply);
		await timed.settle();
		assert.deepEqual(timed.notifications, [["Advisor review timed out after 90 seconds.", "warning"]]);
		assert.equal(timed.state.status, undefined);
	} finally {
		mock.restoreAll();
	}

	const failed = await enabled();
	failed.replies.push(async () => ({ stopReason: "error", errorMessage: "rate limited", content: [] }));
	await failed.settle();
	assert.deepEqual(failed.notifications, [["Advisor review failed: rate limited", "warning"]]);
	assert.equal(failed.sent.length, 0);
});

test("a malformed reply warns once and does nothing else", async () => {
	const h = await enabled();
	h.replies.push("Looks good to me.", "BLOCKER: Bad. Evidence: x");
	await h.settle();
	await h.prompt();
	h.work();
	await h.settle();
	assert.deepEqual(h.notifications, [["Advisor reply did not follow the output contract and was ignored.", "warning"]]);
	assert.equal(h.sent.length, 0);
});

test("without a task route the advisor warns with /task-models and does not use the session model", async () => {
	const h = await enabled({ available: [] });
	await h.settle();
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
	for (const reply of ["", "pass", "PASS\nnit: A Evidence: B", "nit: A", "nit:  Evidence: B", "nit: A Evidence: ", "Blocker: A Evidence: B", "- nit: A Evidence: B", `blocker: ${"x".repeat(REPLY_CAP)} Evidence: B`]) {
		assert.equal(parseReview(reply), undefined, reply);
	}
});

test("review input keeps the newest material of the current run within the caps", async () => {
	const h = harness();
	h.work("previous-run");
	const start = h.manager.getLeafId();
	h.manager.appendMessage({ role: "user", content: [{ type: "text", text: "p".repeat(PROMPT_CAP + 100) }], timestamp: Date.now() });
	// A custom message that steers the run is part of the run record.
	h.manager.appendCustomMessageEntry("pi-cron-run", [{ type: "text", text: "Run the nightly report." }], false);
	for (let step = 0; step < 30; step++) h.work(`${step}:`.padEnd(ITEM_CAP + 500, "x"));
	const branch = h.manager.getBranch();
	const input = reviewInput(branch, runEntries(branch, start)!)!;
	assert.ok(input.length < PROMPT_CAP + RUN_CAP + 500, `${input.length}`);
	assert.match(input, /\[truncated 100 chars\]/);
	assert.match(input, /\[\d+ earlier run items omitted\.\]/);
	assert.match(input, /Tool result bash: 29:x+ \[truncated/);
	assert.doesNotMatch(input, /Tool result bash: 0:|previous-run/);
	assert.match(input, /Assistant: Done\.$/);

	const short = harness();
	const shortStart = short.manager.getLeafId();
	short.manager.appendMessage({ role: "user", content: [{ type: "text", text: "Go." }], timestamp: Date.now() });
	short.manager.appendCustomMessageEntry("pi-cron-run", [{ type: "text", text: "Run the nightly report." }], false);
	short.work();
	const shortBranch = short.manager.getBranch();
	assert.match(reviewInput(shortBranch, runEntries(shortBranch, shortStart)!)!, /Message pi-cron-run: Run the nightly report\.\n\nTool call bash/);
	assert.equal(runEntries(shortBranch, "missing"), undefined);
});

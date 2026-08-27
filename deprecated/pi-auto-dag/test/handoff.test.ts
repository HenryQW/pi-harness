import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RUN_STATE_VERSION } from "../src/model.ts";
import { ORCHESTRATOR_TOOLS } from "../src/orchestrator.ts";
import { createWorkerExtension, WORKER_TOOLS, workerEnvironment } from "../src/worker.ts";
import { ensureActionTicket, readActionTicket, type ActionTicket, writeWorkerReceipt } from "../src/review-ticket.ts";

const RUN_ID = "55555555-5555-4555-8555-555555555555";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function ticket(root: string, input: Partial<ActionTicket> = {}): Promise<{ path: string; value: ActionTicket }> {
	const path = join(root, "action-ticket.json");
	const value: ActionTicket = {
		version: 1,
		event_id: "66666666-6666-4666-8666-666666666666",
		attempt: 1,
		review_round: 3,
		role: "implementer",
		receipt_path: join(root, "receipt.json"),
		...input,
	};
	await writeFile(path, `${JSON.stringify(value)}\n`);
	return { path, value };
}

function environment(actionTicket: string): NodeJS.ProcessEnv {
	return {
		PI_AUTO_DAG_WORKER_ROLE: "implementer",
		PI_AUTO_DAG_WORKER_EVENTS: "request_review,block_task",
		PI_AUTO_DAG_RUN_ID: RUN_ID,
		PI_AUTO_DAG_ISSUE_ID: "core",
		PI_AUTO_DAG_MAIN_PANE: "main-pane",
		PI_AUTO_DAG_ACTION_TICKET: actionTicket,
	};
}

test("worker tools accept intent only and adapter owns protocol metadata", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	const calls: string[][] = [];
	const tools: Array<{ name: string; execute: Function }> = [];
	createWorkerExtension({
		environment: environment(action.path),
		deliveryAttempts: 1,
		delay: async () => {},
		runner: async (command, args) => {
			calls.push([command, ...args]);
			if (command === "git") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
			const envelope = JSON.parse(args[3]);
			assert.equal(envelope.attempt, 1);
			assert.equal(envelope.review_round, 3);
			assert.equal(envelope.event_id, action.value.event_id);
			assert.equal(envelope.commit, HEAD);
			assert.deepEqual(envelope.payload, { summary: "finished" });
			await writeWorkerReceipt(action.value.receipt_path, { event_id: action.value.event_id, status: "accepted" });
			return { code: 0, stdout: "", stderr: "" };
		},
	})({
		on() {},
		registerTool(tool: { name: string; execute: Function }) { tools.push(tool); },
	} as never);

	const result = await tools.find((tool) => tool.name === WORKER_TOOLS.request_review)!.execute("call", {
		summary: "finished",
		attempt: 999,
		review_round: 999,
		commit: "wrong",
		run_id: "wrong",
		issue_id: "wrong",
	});
	assert.equal(result.terminate, true);
	assert.equal(result.content[0].text, "Accepted request_review for core.");
	assert.equal("attempt" in result.details, false);
	assert.deepEqual(calls[0], ["git", "rev-parse", "HEAD"]);
	const prompt = calls.find((call) => call[0] === "herdr")!;
	assert.deepEqual(prompt.slice(1, 4), ["agent", "prompt", "main-pane"]);
	assert.equal(prompt[5], "--wait");
	assert.equal(prompt[6], "--timeout");
	assert.equal(prompt[7], "1860000");
});

test("worker binds action ticket to the prompted turn", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	const replacement: ActionTicket = {
		...action.value,
		event_id: "77777777-7777-4777-8777-777777777777",
		receipt_path: join(root, "replacement-receipt.json"),
	};
	const tools: Array<{ name: string; execute: Function }> = [];
	let input: ((event: unknown, ctx: unknown) => unknown) | undefined;
	createWorkerExtension({
		environment: environment(action.path),
		deliveryAttempts: 1,
		delay: async () => {},
		runner: async (command, args) => {
			if (command === "git") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
			const envelope = JSON.parse(args[3]);
			assert.equal(envelope.event_id, action.value.event_id);
			await writeWorkerReceipt(action.value.receipt_path, { event_id: action.value.event_id, status: "accepted" });
			return { code: 0, stdout: "", stderr: "" };
		},
	})({
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (event === "input") input = handler;
		},
		registerTool(tool: { name: string; execute: Function }) { tools.push(tool); },
	} as never);

	await input!({ type: "input", text: "work", source: "rpc" }, {});
	await writeFile(action.path, `${JSON.stringify(replacement)}\n`);
	await tools.find((tool) => tool.name === WORKER_TOOLS.request_review)!.execute("call", { summary: "finished" });
	await assert.rejects(readFile(replacement.receipt_path), /ENOENT/);
});

test("concurrent worker tools allow only one terminal report per prompted turn", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	const tools: Array<{ name: string; execute: Function }> = [];
	let input: ((event: unknown, ctx: unknown) => unknown) | undefined;
	let deliveries = 0;
	createWorkerExtension({
		environment: environment(action.path),
		deliveryAttempts: 1,
		delay: async () => {},
		runner: async (command, args) => {
			if (command === "git") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
			deliveries += 1;
			await writeWorkerReceipt(action.value.receipt_path, { event_id: action.value.event_id, status: "accepted" });
			return { code: 0, stdout: "", stderr: "" };
		},
	})({
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (event === "input") input = handler;
		},
		registerTool(tool: { name: string; execute: Function }) { tools.push(tool); },
	} as never);
	await input!({ type: "input", text: "finish", source: "rpc" }, {});
	const request = tools.find((tool) => tool.name === WORKER_TOOLS.request_review)!;
	const block = tools.find((tool) => tool.name === WORKER_TOOLS.block_task)!;

	const [first, second] = await Promise.allSettled([
		request.execute("request", { summary: "finished" }),
		block.execute("block", { reason: "late duplicate" }),
	]);

	assert.equal(first.status, "fulfilled");
	assert.equal(second.status, "rejected");
	assert.match(String((second as PromiseRejectedResult).reason), /already submitted a terminal report/);
	await assert.rejects(request.execute("third", { summary: "duplicate after acceptance" }), /already submitted a terminal report/);
	assert.equal(deliveries, 1);
});

test("failed terminal delivery releases the prompted-turn latch for retry", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	const tools: Array<{ name: string; execute: Function }> = [];
	let deliveries = 0;
	createWorkerExtension({
		environment: environment(action.path),
		deliveryAttempts: 1,
		delay: async () => {},
		runner: async (command) => {
			if (command === "git") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
			deliveries += 1;
			if (deliveries === 2) await writeWorkerReceipt(action.value.receipt_path, { event_id: action.value.event_id, status: "accepted" });
			return { code: 0, stdout: "", stderr: "" };
		},
	})({ on() {}, registerTool(tool: { name: string; execute: Function }) { tools.push(tool); } } as never);
	const tool = tools.find((candidate) => candidate.name === WORKER_TOOLS.request_review)!;

	await assert.rejects(tool.execute("first", { summary: "finished" }), /acceptance receipt/);
	await assert.rejects(readFile(action.value.receipt_path), /ENOENT/);
	const result = await tool.execute("retry", { summary: "finished" });

	assert.equal(result.details.status, "accepted");
	assert.equal(deliveries, 2);
});

test("an old-turn failure cannot clear the newer turn terminal latch", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	const replacement: ActionTicket = {
		...action.value,
		event_id: "77777777-7777-4777-8777-777777777777",
		receipt_path: join(root, "replacement-receipt.json"),
	};
	const tools: Array<{ name: string; execute: Function }> = [];
	let input: ((event: unknown, ctx: unknown) => unknown) | undefined;
	let oldStarted!: () => void;
	let newStarted!: () => void;
	let releaseOld!: () => void;
	let releaseNew!: () => void;
	const oldDeliveryStarted = new Promise<void>((done) => { oldStarted = done; });
	const newDeliveryStarted = new Promise<void>((done) => { newStarted = done; });
	const oldDeliveryRelease = new Promise<void>((done) => { releaseOld = done; });
	const newDeliveryRelease = new Promise<void>((done) => { releaseNew = done; });
	let deliveries = 0;
	createWorkerExtension({
		environment: environment(action.path),
		deliveryAttempts: 1,
		delay: async () => {},
		runner: async (command, args) => {
			if (command === "git") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
			const delivery = ++deliveries;
			const envelope = JSON.parse(args[3]);
			if (delivery === 1) {
				oldStarted();
				await oldDeliveryRelease;
			} else if (delivery === 2) {
				newStarted();
				await newDeliveryRelease;
				await writeWorkerReceipt(replacement.receipt_path, { event_id: replacement.event_id, status: "accepted" });
			}
			assert.equal(envelope.event_id, delivery === 1 ? action.value.event_id : replacement.event_id);
			return { code: 0, stdout: "", stderr: "" };
		},
	})({
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (event === "input") input = handler;
		},
		registerTool(tool: { name: string; execute: Function }) { tools.push(tool); },
	} as never);
	const request = tools.find((tool) => tool.name === WORKER_TOOLS.request_review)!;
	const block = tools.find((tool) => tool.name === WORKER_TOOLS.block_task)!;
	await input!({ type: "input", text: "old turn", source: "rpc" }, {});
	const oldReport = request.execute("old", { summary: "old" });
	await oldDeliveryStarted;
	await writeFile(action.path, `${JSON.stringify(replacement)}\n`);
	await input!({ type: "input", text: "new turn", source: "rpc" }, {});
	const newReport = request.execute("new", { summary: "new" });
	await newDeliveryStarted;

	releaseOld();
	await assert.rejects(oldReport, /acceptance receipt/);
	await assert.rejects(block.execute("duplicate", { reason: "duplicate" }), /already submitted a terminal report/);
	releaseNew();
	assert.equal((await newReport).details.status, "accepted");
	assert.equal(deliveries, 2);
});

test("failed delivery still accepts a durable lifecycle receipt", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	const tools: Array<{ name: string; execute: Function }> = [];
	let deliveries = 0;
	createWorkerExtension({
		environment: environment(action.path),
		deliveryAttempts: 1,
		delay: async () => {},
		runner: async (command) => {
			if (command === "git") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
			deliveries += 1;
			await writeWorkerReceipt(action.value.receipt_path, { event_id: action.value.event_id, status: "accepted" });
			return { code: 1, stdout: "", stderr: "response lost" };
		},
	})({ on() {}, registerTool(tool: { name: string; execute: Function }) { tools.push(tool); } } as never);

	const result = await tools.find((tool) => tool.name === WORKER_TOOLS.request_review)!.execute("call", { summary: "finished" });
	assert.equal(result.details.status, "accepted");
	assert.equal(deliveries, 1);
});

test("stale action ticket returns worker-visible rejection", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	const tools: Array<{ name: string; execute: Function }> = [];
	createWorkerExtension({
		environment: environment(action.path),
		deliveryAttempts: 1,
		delay: async () => {},
		runner: async (command, args) => {
			if (command === "git") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
			await writeWorkerReceipt(action.value.receipt_path, {
				event_id: action.value.event_id,
				status: "rejected",
				reason: "stale action ticket",
			});
			return { code: 0, stdout: "", stderr: "" };
		},
	})({ on() {}, registerTool(tool: { name: string; execute: Function }) { tools.push(tool); } } as never);

	await assert.rejects(
		tools.find((tool) => tool.name === WORKER_TOOLS.request_review)!.execute("call", { summary: "finished" }),
		/stale action ticket/,
	);
});

test("worker redelivers an active rejected ticket for lifecycle recovery", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	const replacement: ActionTicket = {
		...action.value,
		event_id: "77777777-7777-4777-8777-777777777777",
		receipt_path: join(root, "replacement-receipt.json"),
	};
	const tools: Array<{ name: string; execute: Function }> = [];
	const deliveries: string[] = [];
	let input: ((event: unknown, ctx: unknown) => unknown) | undefined;
	createWorkerExtension({
		environment: environment(action.path),
		deliveryAttempts: 1,
		delay: async () => {},
		runner: async (command, args) => {
			if (command === "git") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
			const envelope = JSON.parse(args[3]);
			deliveries.push(envelope.event_id);
			if (envelope.event_id === action.value.event_id) await writeFile(action.path, `${JSON.stringify(replacement)}\n`);
			else await writeWorkerReceipt(replacement.receipt_path, { event_id: replacement.event_id, status: "accepted" });
			return { code: 0, stdout: "", stderr: "" };
		},
	})({
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (event === "input") input = handler;
		},
		registerTool(tool: { name: string; execute: Function }) { tools.push(tool); },
	} as never);
	await input!({ type: "input", text: "review correction", source: "rpc" }, {});
	await writeWorkerReceipt(action.value.receipt_path, { event_id: action.value.event_id, status: "rejected", reason: "bad review" });
	const tool = tools.find((candidate) => candidate.name === WORKER_TOOLS.request_review)!;

	await assert.rejects(tool.execute("first", { summary: "corrected" }), /bad review/);
	assert.deepEqual(deliveries, [action.value.event_id]);
	const result = await tool.execute("second", { summary: "corrected" });

	assert.equal(result.details.status, "accepted");
	assert.deepEqual(deliveries, [action.value.event_id, replacement.event_id]);
});

test("worker requests compaction before high-context submission", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const action = await ticket(root);
	let compacted = 0;
	const sent: unknown[] = [];
	let toolCall: ((event: unknown, ctx: any) => unknown) | undefined;
	createWorkerExtension({ environment: environment(action.path) })({
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			if (event === "tool_call") toolCall = handler;
		},
		registerTool() {},
		sendUserMessage(text: string, options: unknown) { sent.push({ text, options }); },
	} as never);
	assert.ok(toolCall);
	const result = await toolCall!({ toolName: WORKER_TOOLS.request_review }, {
		getContextUsage: () => ({ percent: 80, contextWindow: 100, tokens: 80 }),
		isIdle: () => true,
		compact: (options: { onComplete: () => void }) => {
			compacted += 1;
			options.onComplete();
		},
	});
	await new Promise<void>((done) => { setImmediate(done); });
	assert.deepEqual(result, { block: true, terminate: true, reason: "Auto-compact ran before worker event submission; retry event." });
	assert.equal(compacted, 1);
	assert.deepEqual(sent, [{ text: "Auto-compact completed. Retry worker event submission now.", options: { deliverAs: "followUp" } }]);
});

test("consumed action tickets are replaced on the same logical action", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-handoff-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	const path = join(root, "action-ticket.json");
	const first = await ensureActionTicket(path, { attempt: 1, review_round: 1, role: "reviewer", review_id: "review-1" }, root, RUN_ID, () => "write-1", () => "event-1");
	await writeWorkerReceipt(first.receipt_path, { event_id: first.event_id, status: "rejected", reason: "bad verdict" }, () => "receipt-1");

	const second = await ensureActionTicket(path, { attempt: 1, review_round: 1, role: "reviewer", review_id: "review-1" }, root, RUN_ID, () => "write-2", () => "event-2");
	await writeWorkerReceipt(second.receipt_path, { event_id: second.event_id, status: "accepted" }, () => "receipt-2");
	const third = await ensureActionTicket(path, { attempt: 1, review_round: 1, role: "reviewer", review_id: "review-1" }, root, RUN_ID, () => "write-3", () => "event-3");

	assert.equal(first.event_id, "event-1");
	assert.equal(second.event_id, "event-2");
	assert.equal(third.event_id, "event-3");
	assert.equal(third.receipt_path.endsWith("event-3.json"), true);
	assert.equal((await readActionTicket(path)).event_id, "event-3");
});

test("worker environment requires action ticket", () => {
	assert.throws(() => workerEnvironment(environment("")), /action ticket/);
});

test("tool surfaces match current v5 run-state contracts", () => {
	assert.equal(RUN_STATE_VERSION, 5);
	const workerTools = Object.values(WORKER_TOOLS);
	for (const forbidden of ["planning", "submit_health", "approve", "start", "health"]) {
		assert.equal(workerTools.some((name) => name.includes(forbidden)), false);
	}
	assert.deepEqual(Object.values(ORCHESTRATOR_TOOLS), [
		"auto_dag_execute",
		"auto_dag_status",
		"auto_dag_resume",
		"auto_dag_retry_gate",
		"auto_dag_resolve",
		"auto_dag_abort",
		"auto_dag_acknowledge",
	]);
});

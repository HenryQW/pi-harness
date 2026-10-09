import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSubagentCommand, type IsolatedInventory, type SubagentCommandAdapter } from "../extensions/subagent-command.ts";

type Dialog = { kind: "select" | "editor"; title: string; options?: string[]; prefill?: string };
function harness(options: { ui?: boolean; mode?: "tui" | "rpc"; inventory?: IsolatedInventory; isolatedError?: Error; direct?: ReturnType<SubagentCommandAdapter["direct"]> } = {}) {
	let handler!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const dialogs: Dialog[] = [];
	const responses: Array<string | undefined | ((dialog: Dialog) => string | undefined | Promise<string | undefined>)> = [];
	const notices: { message: string; level: string }[] = [];
	const queues = new Map<string, string[]>([["task", ["first", "first", "third"]], ["other", ["untouched"]]]);
	const sent: string[] = [];
	let epoch = 0;
	let session = "session";
	let file = "session.jsonl";
	let branch = ["root", "leaf"];
	const entries = ["root", "leaf", "existing-child", "sibling"];
	let active = true;
	let inspectCount = 0;
	const closed: string[] = [];
	let inventoryCount = 0;
	let recoverCount = 0;
	const messages: string[] = [];
	let recoverPause: (() => Promise<void>) | undefined;
	const inventory = options.inventory ?? { root: "/git", requests: [{ id: "request", name: "Same", status: "working", tasks: [{ id: "task", name: "Same", kind: "changeset", status: "working" }, { id: "other", name: "Same", kind: "changeset", status: "working" }] }], invalidIds: [] };
	const adapter: SubagentCommandAdapter = {
		direct: () => options.direct ?? [],
		closeDirect: async (task, current) => { assert.equal(current(), true); closed.push(task.id); return "Stopped"; },
		isolated: async (_cwd, current) => { inventoryCount++; assert.equal(current(), true); if (options.isolatedError) throw options.isolatedError; return inventory; },
		recover: async () => { recoverCount++; await recoverPause?.(); return "Recovery report for Main"; },
		inspectInTab: async (_root, id, _ctx, current) => {
			assert.equal(current(), true); inspectCount++;
			return { ref: "D9.1", tabId: `tab-${id}`, name: "status-scout", sessionFile: "/status/session.jsonl" };
		},
		canFollowup: () => active,
		epoch: () => epoch,
		drain: (root, id, task, current) => {
			assert.equal(root, "/git"); assert.equal(id, "request");
			if (!current() || !active) throw new Error("Task is not active here");
			return queues.get(task)!.splice(0);
		},
		enqueue: (root, id, task, text, current) => {
			assert.equal(root, "/git"); assert.equal(id, "request");
			if (!current() || !active) throw new Error("Task is not active here");
			if (!text.trim() || text.length > 32_000) throw new Error("Instruction exceeds limit");
			queues.get(task)!.push(text); sent.push(`${task}:${text}`);
			return "Queued follow-up";
		},
	};
	const ctx = {
		hasUI: options.ui ?? true, mode: options.mode ?? "tui", cwd: "/cwd",
		sessionManager: {
			getSessionId: () => session, getSessionFile: () => file,
			getLeafId: () => branch.at(-1), getBranch: () => branch.map((id) => ({ id })),
			getEntries: () => entries.map((id) => ({ id })),
		},
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			select: async (title: string, labels: string[]) => {
				const dialog: Dialog = { kind: "select", title, options: labels }; dialogs.push(dialog);
				const answer = responses.shift(); return typeof answer === "function" ? await answer(dialog) : answer;
			},
			editor: async (title: string, prefill: string) => {
				const dialog: Dialog = { kind: "editor", title, prefill }; dialogs.push(dialog);
				const answer = responses.shift(); return typeof answer === "function" ? await answer(dialog) : answer;
			},
		},
	} as unknown as ExtensionContext;
	registerSubagentCommand({ registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
		sendMessage: (message: { content: string }) => { messages.push(message.content); },
	} as unknown as ExtensionAPI, adapter);
	const pick = (contains: string) => (dialog: Dialog) => {
		const result = dialog.options?.find((label) => label.includes(contains));
		assert.ok(result, `Missing ${contains} in ${dialog.options}`); return result;
	};
	return { run: (args = "") => handler(args, ctx), responses, dialogs, notices, queues, sent, messages, pick, closed,
		setRecoverPause: (pause: () => Promise<void>) => { recoverPause = pause; },
		get recoverCount() { return recoverCount; },
		setActive: (value: boolean) => { active = value; },
		get inspectCount() { return inspectCount; },
		get inventoryCount() { return inventoryCount; },
		changeSession: () => { session = "next"; }, changeFile: () => { file = "next.jsonl"; },
		changeBranch: () => { branch = ["root", "sibling"]; }, navigateAncestor: () => { branch = ["root"]; },
		navigateDescendant: () => { branch.push("existing-child"); },
		emptyBranch: () => { branch = []; entries.length = 0; entries.push("existing-child"); },
		append: () => { branch.push("new-leaf"); entries.push("new-leaf"); },
		shutdown: () => { epoch++; },
	};
}

test("legacy direct recovery, history and duplicate labels retain exact records", async () => {
	const h = harness({ direct: [
		{ id: "direct-a", name: "Same", status: "recorded (not observed)", workers: [], tabs: [{ entryId: "entry-1", name: "worker", tabId: "tab-1", paneId: "pane-1", sessionFile: "/one" }, { entryId: "entry-2", name: "worker", tabId: "tab-2", paneId: "pane-2", sessionFile: "/two" }] },
		{ id: "direct-b", name: "Same", status: "completed", workers: [], tabs: [{ entryId: "entry-3", name: "worker", tabId: "tab-3", paneId: "pane-3", sessionFile: "/three" }] },
	] });
	h.responses.push(h.pick("Direct · Same · recorded"), h.pick("Completed / history"), h.pick("direct-b"), h.pick("Isolated · Same"), h.pick("Inspect"), h.pick("Back"), h.pick("Close"));
	await h.run();
	assert.match(h.notices[1]!.message, /tab-1/);
	assert.match(h.notices[2]!.message, /tab-2/);
	assert.match(h.notices[4]!.message, /tab-3/);
	assert.equal(h.inspectCount, 1);
	assert.ok(h.dialogs[0]!.options!.some((label) => label.includes("Isolated")));
	assert.ok(h.dialogs[0]!.options!.some((label) => label.includes("Direct")));
});

test("direct rows use saved references; multi-worker workflows group under one row with named details", async () => {
	const worker = (workflow: number, index: number, workers: number, title: string) => ({ workflow, worker: index, workers, title, role: "worker" });
	const tab = (n: number, display: ReturnType<typeof worker>) => ({ entryId: `entry-${n}`, name: `d-${n}`, tabId: `tab-${n}`, paneId: `pane-${n}`, sessionFile: `/s${n}`, display });
	const single = worker(1, 1, 1, "Same");
	const duplicate = worker(2, 1, 1, "Same");
	const multi = [worker(3, 1, 3, "Scan"), worker(3, 2, 3, "Fix")];
	const h = harness({ direct: [
		{ id: "direct-1-x", name: "direct-1-x", status: "observed locally", canClose: true, workers: [single], tabs: [tab(1, single)] },
		{ id: "direct-2-x", name: "direct-2-x", status: `admission retained ${"e".repeat(300)}`, workers: [duplicate], tabs: [tab(2, duplicate)] },
		{ id: "direct-3-x", name: "direct-3-x", status: "allocation unverified; admission retained", recovery: "allocation evidence", workers: multi, tabs: [tab(3, multi[0]!)] },
	] });
	h.responses.push(h.pick("D3 · 3 workers"), h.pick("D1.1"), (dialog) => {
		assert.match(dialog.title, /^Direct · D1\.1 · worker · Same$/);
		assert.match(dialog.options![0]!, /^Close\/cancel-and-release ALL owned workers in this workflow/);
		return h.pick("Back")(dialog);
	}, h.pick("Close"));
	await h.run();
	const rows = h.dialogs[0]!.options!.filter((label) => label.startsWith("Direct"));
	assert.equal(rows.length, 3);
	for (const prefix of ["Direct · D1.1 · worker · Same · observed locally", "Direct · D2.1 · worker · Same · admission retained", "Direct · D3 · 3 workers · allocation unverified"]) {
		assert.ok(rows.some((label) => label.startsWith(prefix)), prefix);
	}
	assert.ok(rows.every((label) => !label.includes("direct-")), "opaque IDs stay in details");
	const notices = h.notices.map(({ message }) => message);
	assert.ok(notices.includes('Direct workflow D3 · 3 workers · allocation unverified; admission retained · ID "direct-3-x"'));
	assert.ok(notices.includes('D3.1 · worker · Scan · task "entry-3" · agent "d-3" · tab "tab-3" · pane "pane-3" · session "/s3"'));
	assert.ok(notices.includes("D3.2 · worker · Fix · no verified tab recorded"));
	assert.ok(notices.includes("1 other worker(s) in D3 have no recorded tab."));
	assert.deepEqual(h.closed, []);
});

test("Refresh reloads the isolated inventory for the widget as well as the picker", async () => {
	const h = harness();
	h.responses.push(h.pick("Refresh"), h.pick("Close"));
	await h.run();
	assert.equal(h.inventoryCount, 2);
});

test("inspection launches a Herdr tab without queuing a Main turn or changing work", async () => {
	const h = harness();
	h.responses.push(h.pick("Isolated"), h.pick("Inspect"), h.pick("Back"), h.pick("Close"));
	await h.run();
	assert.ok(h.notices.some(({ message }) => message.includes("Status inspection D9.1 started in Herdr tab tab-request · agent status-scout")));
	assert.equal(h.inspectCount, 1);
	assert.deepEqual(h.queues.get("task"), ["first", "first", "third"]);
	assert.deepEqual(h.sent, []);
});

test("inspection does not launch after the session changes in the menu", async () => {
	const h = harness();
	h.responses.push(h.pick("Isolated"), (dialog) => {
		h.changeSession();
		return dialog.options!.find((option) => option.includes("Inspect"));
	});
	await h.run();
	assert.equal(h.inspectCount, 0);
});

test("failed isolated discovery preserves direct branch recovery and invalid inventory does not suppress healthy requests", async () => {
	const direct = [{ id: "direct", name: "Rescue", status: "recorded", workers: [], tabs: [{ entryId: "task", name: "worker", tabId: "tab", paneId: "pane", sessionFile: "/recover" }] }];
	const failed = harness({ direct, isolatedError: new Error("outside Git") });
	failed.responses.push(failed.pick("Direct"), failed.pick("Close"));
	await failed.run();
	assert.ok(failed.notices.some((notice) => notice.message.includes("outside Git")));
	assert.ok(failed.notices.some((notice) => notice.message.includes("/recover")));
	const invalid = harness({ inventory: { root: "/git", requests: [{ id: "good", name: "Healthy", status: "working", tasks: [] }], invalidIds: ["broken-state-id"] } });
	invalid.responses.push(invalid.pick("Healthy"), invalid.pick("Inspect"), invalid.pick("Back"), invalid.pick("Close"));
	await invalid.run();
	assert.ok(invalid.notices.some((notice) => notice.message.includes("broken-state-id") && notice.message.includes("Preserve")));
	assert.equal(invalid.inspectCount, 1);
});

test("drain all selected FIFO instructions before native RPC editor; cancel keeps withdrawal", async () => {
	const h = harness({ mode: "rpc" });
	h.responses.push(h.pick("Isolated"), h.pick("Edit queued"), h.pick("· task ["), (dialog) => { assert.equal(dialog.kind, "editor"); assert.equal(dialog.prefill, "first\n\nfirst\n\nthird"); assert.deepEqual(h.queues.get("task"), []); return undefined; });
	await h.run();
	assert.deepEqual(h.queues.get("other"), ["untouched"]);
	assert.deepEqual(h.sent, []);
});

test("explicit replacement queues once, preserving newly appended work at the tail", async () => {
	const h = harness();
	h.responses.push(h.pick("Isolated"), h.pick("Edit queued"), h.pick("· task ["), (dialog) => { assert.equal(dialog.prefill, "first\n\nfirst\n\nthird"); h.queues.get("task")!.push("new work"); return "replacement"; }, h.pick("Back"), h.pick("Close"));
	await h.run();
	assert.deepEqual(h.queues.get("task"), ["new work", "replacement"]);
	assert.deepEqual(h.sent, ["task:replacement"]);
});

test("empty drain and cancellation before withdrawal are harmless", async () => {
	const h = harness(); h.queues.set("task", []);
	h.responses.push(h.pick("Isolated"), h.pick("Edit queued"), h.pick("· task ["), h.pick("Back"), h.pick("Close"));
	await h.run();
	assert.equal(h.dialogs.filter((dialog) => dialog.kind === "editor").length, 0);
	const next = harness(); next.responses.push(next.pick("Isolated"), next.pick("Edit queued"), undefined);
	await next.run(); assert.equal(next.queues.get("task")!.length, 3);
});

test("duplicate task labels select the intended task, and late admission refusal reopens text without retry", async () => {
	const h = harness();
	h.responses.push(h.pick("Isolated"), h.pick("Send follow-up"), h.pick("· other ["), () => { h.setActive(false); return "submitted"; }, (dialog) => { assert.equal(dialog.prefill, "submitted"); return undefined; });
	await h.run();
	assert.deepEqual(h.sent, []);
	assert.ok(h.notices.some((notice) => notice.message.includes("Not queued")));
});

test("overlong combined text remains intact in the editor after refusal", async () => {
	const h = harness(); const long = "x".repeat(20_000);
	h.queues.set("task", [long, long]);
	h.responses.push(h.pick("Isolated"), h.pick("Edit queued"), h.pick("· task ["),
		(dialog) => { assert.equal(dialog.prefill, `${long}\n\n${long}`); return dialog.prefill; },
		(dialog) => { assert.equal(dialog.prefill, `${long}\n\n${long}`); return undefined; });
	await h.run(); assert.deepEqual(h.sent, []);
});

test("changed branch, session, or shutdown across a dialog prevents drain and submission; appended entries do not", async () => {
	for (const change of ["changeBranch", "navigateAncestor", "navigateDescendant", "changeSession", "changeFile", "shutdown"] as const) {
		const h = harness(); h.responses.push(h.pick("Isolated"), h.pick("Edit queued"), () => { h[change](); return "task"; });
		await h.run(); assert.equal(h.queues.get("task")!.length, 3); assert.deepEqual(h.sent, []);
	}
	const h = harness(); h.responses.push(h.pick("Isolated"), h.pick("Send follow-up"), h.pick("· task ["), () => { h.append(); return "hello"; }, h.pick("Back"), h.pick("Close"));
	await h.run(); assert.deepEqual(h.sent, ["task:hello"]);
});

test("existing descendant of an empty branch cannot withdraw or enqueue from a stale dialog", async () => {
	for (const action of ["Edit queued", "Send follow-up"]) {
		const h = harness(); h.emptyBranch();
		h.responses.push(h.pick("Isolated"), h.pick(action), () => { h.navigateDescendant(); return "task"; });
		await h.run();
		assert.deepEqual(h.queues.get("task"), ["first", "first", "third"]);
		assert.deepEqual(h.sent, []);
	}
});

test("navigation after drain leaves withdrawn text unqueued", async () => {
	for (const change of ["navigateAncestor", "navigateDescendant"] as const) {
		const h = harness();
		h.responses.push(h.pick("Isolated"), h.pick("Edit queued"), h.pick("· task ["), () => { h[change](); return "submitted"; });
		await h.run();
		assert.deepEqual(h.queues.get("task"), []);
		assert.deepEqual(h.sent, []);
	}
});

test("durable-only or other-owner requests cannot offer follow-up; task sealing before drain refuses without withdrawing", async () => {
	const h = harness(); h.setActive(false);
	h.responses.push(h.pick("Isolated"), (dialog) => {
		assert.ok(!dialog.options!.some((option) => option.includes("Send follow-up") || option.includes("Edit queued")));
		return dialog.options!.find((option) => option.includes("Back"));
	}, h.pick("Close"));
	await h.run(); assert.equal(h.queues.get("task")!.length, 3);
	const race = harness();
	race.responses.push(race.pick("Isolated"), race.pick("Edit queued"), (dialog) => { race.setActive(false); return dialog.options!.find((option) => option.includes("· task [")); }, race.pick("Back"), race.pick("Close"));
	await race.run(); assert.equal(race.queues.get("task")!.length, 3);
	assert.ok(race.notices.some((notice) => notice.message.includes("Cannot withdraw")));
});

test("recover delivers one Main follow-up without interactive UI or menu actions", async () => {
	const h = harness({ ui: false });
	await h.run("recover");
	assert.deepEqual(h.messages, ["Recovery report for Main"]);
	assert.equal(h.recoverCount, 1);
	assert.deepEqual(h.dialogs, []);
	assert.deepEqual(h.sent, []);
});

test("recover does not deliver a stale follow-up after session replacement", async () => {
	const h = harness();
	h.setRecoverPause(async () => { h.changeSession(); });
	await h.run("recover");
	assert.deepEqual(h.messages, []);
});

test("no UI and unknown arguments fail before dialogs or mutations", async () => {
	const h = harness({ ui: false });
	await assert.rejects(h.run(), /interactive UI/);
	await assert.rejects(h.run("task-id"), /Usage/);
	assert.deepEqual(h.dialogs, []);
	assert.equal(h.queues.get("task")!.length, 3);
});


test("direct Close is exact and refuses stale branch/session/epoch dialogs", async () => {
	for (const change of ["changeBranch", "navigateAncestor", "navigateDescendant", "changeSession", "changeFile", "shutdown", "append"] as const) {
		const h = harness({ direct: [{ id: "owned", name: "Rescue", status: "admission retained", canClose: true, workers: [], tabs: [] }] });
		h.responses.push(h.pick("Direct"), (dialog) => { h[change](); return h.pick("Close/cancel")(dialog); }, h.pick("Close"));
		await h.run();
		assert.deepEqual(h.closed, change === "append" ? ["owned"] : []);
	}
});

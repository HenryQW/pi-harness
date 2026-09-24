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
	let active = true;
	let inspectCount = 0;
	const inventory = options.inventory ?? { root: "/git", requests: [{ id: "request", name: "Same", status: "working", tasks: [{ id: "task", name: "Same", kind: "changeset", status: "working" }, { id: "other", name: "Same", kind: "changeset", status: "working" }] }], invalidIds: [] };
	const adapter: SubagentCommandAdapter = {
		direct: () => options.direct ?? [],
		isolated: async () => { if (options.isolatedError) throw options.isolatedError; return inventory; },
		inspect: async (_root, id) => { inspectCount++; return `Status for ${id}: retained worktree /safe; continuation: ask Main`; },
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
	registerSubagentCommand({ registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; } } as ExtensionAPI, adapter);
	const pick = (contains: string) => (dialog: Dialog) => {
		const result = dialog.options?.find((label) => label.includes(contains));
		assert.ok(result, `Missing ${contains} in ${dialog.options}`); return result;
	};
	return { run: (args = "") => handler(args, ctx), responses, dialogs, notices, queues, sent, pick,
		setActive: (value: boolean) => { active = value; },
		get inspectCount() { return inspectCount; },
		changeSession: () => { session = "next"; }, changeFile: () => { file = "next.jsonl"; },
		changeBranch: () => { branch = ["root", "other-branch"]; }, navigateAncestor: () => { branch = ["root"]; }, append: () => { branch.push("new-leaf"); },
		shutdown: () => { epoch++; },
	};
}

test("direct recovery, history and duplicate labels retain exact records", async () => {
	const h = harness({ direct: [
		{ id: "direct-a", name: "Same", status: "recorded (not observed)", tabs: [{ entryId: "entry-1", name: "worker", tabId: "tab-1", paneId: "pane-1", sessionFile: "/one" }, { entryId: "entry-2", name: "worker", tabId: "tab-2", paneId: "pane-2", sessionFile: "/two" }] },
		{ id: "direct-b", name: "Same", status: "completed", tabs: [{ entryId: "entry-3", name: "worker", tabId: "tab-3", paneId: "pane-3", sessionFile: "/three" }] },
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

test("failed isolated discovery preserves direct branch recovery and invalid inventory does not suppress healthy requests", async () => {
	const direct = [{ id: "direct", name: "Rescue", status: "recorded", tabs: [{ entryId: "task", name: "worker", tabId: "tab", paneId: "pane", sessionFile: "/recover" }] }];
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
	for (const change of ["changeBranch", "navigateAncestor", "changeSession", "changeFile", "shutdown"] as const) {
		const h = harness(); h.responses.push(h.pick("Isolated"), h.pick("Edit queued"), () => { h[change](); return "task"; });
		await h.run(); assert.equal(h.queues.get("task")!.length, 3); assert.deepEqual(h.sent, []);
	}
	const h = harness(); h.responses.push(h.pick("Isolated"), h.pick("Send follow-up"), h.pick("· task ["), () => { h.append(); return "hello"; }, h.pick("Back"), h.pick("Close"));
	await h.run(); assert.deepEqual(h.sent, ["task:hello"]);
});

test("navigation after drain leaves withdrawn text unqueued", async () => {
	const h = harness();
	h.responses.push(h.pick("Isolated"), h.pick("Edit queued"), h.pick("· task ["), () => { h.navigateAncestor(); return "submitted"; });
	await h.run();
	assert.deepEqual(h.queues.get("task"), []);
	assert.deepEqual(h.sent, []);
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

test("no UI and unknown arguments fail before dialogs or mutations", async () => {
	const h = harness({ ui: false });
	await assert.rejects(h.run(), /interactive UI/);
	await assert.rejects(h.run("task-id"), /Usage/);
	assert.deepEqual(h.dialogs, []);
	assert.equal(h.queues.get("task")!.length, 3);
});

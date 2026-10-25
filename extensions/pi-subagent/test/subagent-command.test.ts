import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type KeybindingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, getKeybindings, Markdown, Spacer, stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { DiscardPlan } from "../src/discard.ts";
import { registerSubagentCommand, reportMarkdown, type IsolatedInventory, type PrunePlan, type Report, type SubagentCommandAdapter } from "../extensions/subagent-command.ts";

// The Markdown body uses Pi's global Markdown theme; the explicit theme below tags titles and backgrounds.
initTheme("dark");
const TAGGED = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<b>${text}</b>` };
const plainLines = (component: Box, width: number) => component.render(width).map((line) => line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

const WORKING = "Current subagent work";
type Dialog = { kind: "select" | "editor" | "confirm"; title: string; options?: string[]; prefill?: string };
type Picker = { component: Component; terminal: { rows: number }; render: (width?: number) => string[] };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function harness(options: { ui?: boolean; mode?: "tui" | "rpc" | "print"; inventory?: IsolatedInventory; isolatedError?: Error; direct?: ReturnType<SubagentCommandAdapter["direct"]>; prune?: PrunePlan; discard?: DiscardPlan; cleanup?: { failed: number; skipped: number } } = {}) {
	let handler!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const dialogs: Dialog[] = [];
	const responses: Array<string | undefined | ((dialog: Dialog) => string | undefined | Promise<string | undefined>)> = [];
	const pickers: Array<((picker: Picker) => void) | undefined> = [];
	const notices: { message: string; level: string }[] = [];
	const statuses: Array<string | undefined> = [];
	const events = new Map<string, () => void | Promise<void>>();
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
	const stopped: string[] = [];
	let inventoryCount = 0;
	let recoverCount = 0;
	const messages: string[] = [];
	const confirms: boolean[] = [];
	const discarded: string[] = [];
	const discardedKeys: string[] = [];
	const pruned: { branches: string[]; allowIgnored: boolean; force?: boolean }[] = [];
	let recoverPause: (() => Promise<void>) | undefined;
	const inventory = options.inventory ?? { root: "/git", leaseLive: true, requests: [{ id: "request", name: "Same", status: "working", tasks: [{ id: "task", name: "Same", kind: "changeset", status: "working" }, { id: "other", name: "Same", kind: "changeset", status: "working" }] }], invalidIds: [] };
	const adapter: SubagentCommandAdapter = {
		direct: () => options.direct ?? [],
		closeDirect: async (task, current) => { assert.equal(current(), true); closed.push(task.id); return "Stopped"; },
		stopDirect: async (task, entryId, current) => { if (!current()) throw new Error("stale"); stopped.push(`${task.id}:${entryId}`); return "Worker stopped"; },
		isolated: async (_cwd, current) => { inventoryCount++; assert.equal(current(), true); if (options.isolatedError) throw options.isolatedError; return inventory; },
		recover: async () => { recoverCount++; await recoverPause?.(); return "Recovery report for Main"; },
		roles: () => ({ roles: [{ name: "scout", source: "built-in", modelClass: "fast", route: { model: "test/fast", thinking: "low" },
			tools: ["read", "grep"], extensions: [], skills: [], mcps: [] }], errors: ["/roles/bad.md: unknown Role frontmatter key"] }),
		prunePlan: async () => options.prune ?? { root: "/git", items: [] },
		discardPlan: async (_cwd, request) => options.discard ?? ({ root: "/git", directory: "/state", requestId: request.id, items: [{
			key: "task/1", identity: "saved", path: "/owned", branch: "pi-subagent/subagent-000000000000000000000000", tip: "a".repeat(40),
			checkout: true, commits: 1, dirty: true, ignored: ["cache/"], hosts: ["tab worker-tab"], blockers: [],
		}] }),
		discard: async (_cwd, plan, current) => { assert.equal(current(), true); discarded.push(plan.requestId); discardedKeys.push(...plan.items.map((item) => item.key)); return { text: "removed: task/1", failed: 0, skipped: 0, ...options.cleanup }; },
		prune: async (_cwd, items, allowIgnored, force, current) => {
			assert.equal(current(), true);
			pruned.push({ branches: items.map(({ branch }) => branch), allowIgnored, ...force ? { force } : {} });
			return { text: "Pi Subagent prune in /git: removed", failed: 0, skipped: 0, ...options.cleanup };
		},
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
			setStatus: (key: string, value: string | undefined) => { assert.equal(key, "subagent-prune"); statuses.push(value); },
			custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
				const terminal = { rows: 10_000 };
				let result: unknown;
				let finished = false;
				const component = await factory({ terminal, requestRender() {} } as unknown as TUI,
					{ fg: (_color: string, text: string) => text } as ExtensionContext["ui"]["theme"], getKeybindings() as KeybindingsManager,
					(value) => { result = value; finished = true; });
				const render = (width = 200) => component.render(width).map(stripTerminalSequences);
				// Read all labels for the existing command-policy tests, then drive the real component with keys.
				const lines = render();
				const dialog: Dialog = { kind: "select", title: lines[0]!, options: lines.slice(1, -1).map((line) => line.slice(2)) };
				dialogs.push(dialog);
				const interact = pickers.shift();
				if (interact) interact({ component, terminal, render });
				else {
					const answer = responses.shift();
					const selected = typeof answer === "function" ? await answer(dialog) : answer;
					const index = dialog.options!.indexOf(selected ?? "");
					if (index < 0) component.handleInput!("\x1b");
					else {
						const current = lines.findIndex((line) => line.startsWith("→ ")) - 1;
						for (let n = 0; n < (index - current + dialog.options!.length) % dialog.options!.length; n++) component.handleInput!("\x1b[B");
						component.handleInput!("\r");
					}
				}
				assert.ok(finished, "The picker must finish or cancel");
				return result;
			},
			notify: (message: string, level: string) => notices.push({ message, level }),
			select: async (title: string, labels: string[]) => {
				const dialog: Dialog = { kind: "select", title, options: labels }; dialogs.push(dialog);
				const answer = responses.shift(); return typeof answer === "function" ? await answer(dialog) : answer;
			},
			confirm: async (title: string, message: string) => {
				dialogs.push({ kind: "confirm", title, options: [message] });
				return confirms.shift() ?? false;
			},
			editor: async (title: string, prefill: string) => {
				const dialog: Dialog = { kind: "editor", title, prefill }; dialogs.push(dialog);
				const answer = responses.shift(); return typeof answer === "function" ? await answer(dialog) : answer;
			},
		},
	} as unknown as ExtensionContext;
	const appended: { customType: string; data: unknown }[] = [];
	let renderEntry!: (entry: { data: unknown }, options: object, theme: typeof TAGGED) => Box | undefined;
	let renderMessage!: (message: { content: string }, options: object, theme: typeof TAGGED) => Box | undefined;
	const settlePrune = registerSubagentCommand({ on: (event: string, handler: () => void | Promise<void>) => { events.set(event, handler); }, registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
		sendMessage: (message: { content: string }) => { messages.push(message.content); },
		appendEntry: (customType: string, data: unknown) => { appended.push({ customType, data }); },
		registerEntryRenderer: (type: string, renderer: typeof renderEntry) => { assert.equal(type, "pi-subagent-report"); renderEntry = renderer; },
		registerMessageRenderer: (type: string, renderer: typeof renderMessage) => { assert.equal(type, "pi-subagent-recovery"); renderMessage = renderer; },
	} as unknown as ExtensionAPI, adapter);
	const pick = (contains: string) => (dialog: Dialog) => {
		const result = dialog.options?.find((label) => label.includes(contains));
		assert.ok(result, `Missing ${contains} in ${dialog.options}`); return result;
	};
	return { run: (args = "") => handler(args, ctx), appended, responses, pickers, adapter, statuses,
		event: (name: string) => {
			assert.ok(events.has(name));
			const result = events.get(name)!();
			return name === "session_shutdown" ? Promise.resolve(result).then(settlePrune) : result;
		},
		reviewPrune: async () => { await handler("prune", ctx); await settle(); await handler("prune", ctx); await settle(); },
		renderEntry: (data: unknown) => renderEntry({ data }, {}, TAGGED)!,
		renderMessage: (content: string) => renderMessage({ content }, { outputPad: 2 }, TAGGED)!,
		/** Every appended report except the working report, as the Markdown that RPC and no-UI modes receive. */
		get reports() { return appended.flatMap(({ customType, data }) => { assert.equal(customType, "pi-subagent-report"); return (data as Report).title === WORKING ? [] : [reportMarkdown(data as Report)]; }); },
		get working() { return appended.flatMap(({ data }) => (data as Report).title === WORKING ? [reportMarkdown(data as Report)] : []); }, dialogs, notices, queues, sent, messages, pick, closed, stopped, confirms, pruned, discarded, discardedKeys,
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

const down = (picker: Picker, count: number) => {
	for (let n = 0; n < count; n++) picker.component.handleInput!("\x1b[B");
};
const screen = (picker: Picker, height: number, width = 80) => {
	picker.terminal.rows = height;
	const lines = picker.render(width);
	assert.ok(lines.length <= height, `Picker exceeds ${height} rows`);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), `Picker exceeds ${width} columns`);
	return lines.join("\n");
};

test("long single-choice menus scroll to exact same-named records and retain selection across resize", async () => {
	const h = harness({ direct: Array.from({ length: 60 }, (_, index) => ({ id: `direct-${index}`, name: "Same", status: "working", workers: [], tabs: [] })) });
	h.pickers.push((picker) => {
		assert.match(screen(picker, 12), /up\/down scroll.*select.*cancel/);
		down(picker, 51); // One group header, then worker 50.
		for (const [height, width] of [[12, 80], [7, 40], [30, 110], [2, 80]]) {
			assert.match(screen(picker, height!, width), /→ .*direct-50/);
		}
		picker.component.handleInput!("\r");
	}, (picker) => { picker.component.handleInput!("\x1b"); });
	await h.run();
	assert.match(h.reports[0]!, /\*\*ID:\*\* `direct-50`/);
	assert.deepEqual(h.closed, []);
	assert.deepEqual(h.discarded, []);
});

test("long multiple-choice menus reach bottom actions and keep focus after each toggle", async () => {
	const h = harness({ direct: Array.from({ length: 60 }, (_, index) => ({ id: `direct-${index}`, name: `Worker ${index}`, status: "working", canClose: true, workers: [], tabs: [] })),
		inventory: { root: "/git", leaseLive: false, requests: [], invalidIds: [] } });
	h.pickers.push((picker) => {
		screen(picker, 12);
		down(picker, 61);
		assert.match(screen(picker, 12), /→ Select multiple/);
		picker.component.handleInput!("\r");
	}, (picker) => {
		screen(picker, 12);
		down(picker, 49);
		assert.match(screen(picker, 12), /→ \[ \].*Worker 49/);
		picker.component.handleInput!("\r");
	}, (picker) => {
		assert.match(screen(picker, 8), /→ \[x\].*Worker 49/);
		down(picker, 1);
		picker.component.handleInput!("\r");
	}, (picker) => {
		assert.match(screen(picker, 12), /→ \[x\].*Worker 50/);
		down(picker, 12);
		assert.match(screen(picker, 12), /→ Continue \(2 selected\)/);
		picker.component.handleInput!("\r");
	}, undefined, (picker) => { picker.component.handleInput!("\x1b"); });
	h.responses.push(h.pick("Close/cancel"));
	await h.run();
	assert.deepEqual(h.closed, ["direct-49", "direct-50"]);
});

test("long prune menus keep Select all and Clear reachable; cancellation removes nothing", async () => {
	const h = harness({ prune: { root: "/git", items: Array.from({ length: 40 }, (_, index) => ({
		branch: `pi-subagent/subagent-${index}`, tip: "a".repeat(40), prunable: true, reason: "merged", blockers: [], ignored: [],
	})) } });
	h.pickers.push((picker) => {
		screen(picker, 10);
		down(picker, 41);
		assert.match(screen(picker, 10), /→ Clear/);
		picker.component.handleInput!("\r");
	}, (picker) => {
		assert.match(screen(picker, 10), /→ Clear[\s\S]*Continue \(0 selected\)/);
		picker.component.handleInput!("\x1b[A");
		picker.component.handleInput!("\r");
	}, (picker) => {
		assert.match(screen(picker, 10), /→ Select all[\s\S]*Continue \(40 selected\)/);
		picker.component.handleInput!("\x1b");
	});
	await h.reviewPrune();
	assert.deepEqual(h.pruned, []);
	assert.ok(h.dialogs.every(({ kind }) => kind === "select"));
});

test("RPC uses standard selection dialogs for long lists", async () => {
	const h = harness({ mode: "rpc", direct: Array.from({ length: 60 }, (_, index) => ({ id: `direct-${index}`, name: `Worker ${index}`, status: "working", canClose: true, workers: [], tabs: [] })) });
	h.responses.push(h.pick("Worker 59"), h.pick("Close/cancel"), h.pick("Close"));
	await h.run();
	assert.deepEqual(h.closed, ["direct-59"]);
});

test("/subagent roles shows one labeled field per line; the TUI gets a themed entry outside model context", async () => {
	const expected = [
		"**● Roles (1)**", "",
		"### scout · built-in",
		"- **model class:** fast",
		"- **model:** `test/fast`",
		"- **thinking:** low",
		"- **tools:** read, grep",
		"- **skills:** none",
		"- **extensions:** none",
		"- **mcps:** none", "",
		"### ✗ Invalid Role files (1)",
		"- /roles/bad.md: unknown Role frontmatter key",
	].join("\n");
	const tui = harness();
	await tui.run("roles");
	assert.deepEqual([tui.reports, tui.notices, tui.messages], [[expected], [], []]);
	const rpc = harness({ mode: "rpc" });
	await rpc.run("roles");
	assert.deepEqual(rpc.notices, [{ message: expected, level: "info" }]);
	const print = harness({ ui: false, mode: "print" });
	await print.run("roles");
	assert.deepEqual(print.messages, [expected]);
});

test("TUI reports use Pi's custom-message box: a tone-colored title over a Markdown body", async () => {
	const h = harness({ direct: [{ id: "direct_1", name: "Fix *now*", status: "admission retained", recovery: "inspect tab", workers: [], tabs: [] }] });
	h.responses.push(h.pick("Fix *now* ·"), h.pick("Close"));
	await h.run();
	const box = h.renderEntry(h.appended.at(-1)!.data);
	assert.ok(box instanceof Box);
	const [title, spacer, body] = box.children;
	assert.ok(title instanceof Text && spacer instanceof Spacer && body instanceof Markdown);
	const lines = plainLines(box, 200);
	assert.match(lines[1]!, /^<customMessageBg> <b><warning>⚠ Direct workflow Fix \*now\* · admission retained<\/warning><\/b>/);
	assert.match(lines[3]!, /<customMessageText>ID:<\/customMessageText>/, "body text uses Pi's custom-message text color");
	assert.deepEqual(lines.slice(3, 5).map((line) => line.replace(/<\/?\w+>/g, "").trim()), ["- ID: direct_1", "- recovery: ⚠ inspect tab"]);
	const recovery = h.renderMessage("Pi Subagent recovery in /git: no work replayed.");
	assert.deepEqual(recovery.children.map((child) => child.constructor), [Text, Spacer, Markdown]);
	assert.match(plainLines(recovery, 200)[1]!, /^<customMessageBg> {2}<b><accent>● Recovery report<\/accent><\/b>/);
	assert.match(plainLines(recovery, 200)[3]!.replace(/<\/?\w+>/g, ""), /^ {2}- Pi Subagent recovery in \/git: no work replayed\./);
});

test("picker rows start with an uncolored status glyph; identity comes first", async () => {
	const task = (id: string, status: string) => ({ id, name: id, status, workers: [], tabs: [] });
	const h = harness({ direct: ["working", "admission retained", "failed", "completed", "recorded only; not proof of running or completion"].map((status) => task(`t-${status}`, status)) });
	h.responses.push(h.pick("Completed / history"), h.pick("Close"));
	await h.run();
	const rows = h.dialogs[1]!.options!.filter((label) => label.startsWith("  "));
	assert.deepEqual(rows, ["  ⚠ t-admission retained · admission retained", "  ✗ t-failed · failed", "  ● t-working · working", "  ⚠ t-recorded only; not proof of running or completion · recorded only; not proof of running or completion", "  ✓ t-completed · completed", "  ● request · working · Same"]);
});

test("legacy direct recovery, history and duplicate labels retain exact records", async () => {
	const h = harness({ direct: [
		{ id: "direct-a", name: "Same", status: "recorded (not observed)", workers: [], tabs: [{ entryId: "entry-1", name: "worker", tabId: "tab-1", paneId: "pane-1", sessionFile: "/one" }, { entryId: "entry-2", name: "worker", tabId: "tab-2", paneId: "pane-2", sessionFile: "/two" }] },
		{ id: "direct-b", name: "Same", status: "completed", workers: [], tabs: [{ entryId: "entry-3", name: "worker", tabId: "tab-3", paneId: "pane-3", sessionFile: "/three" }] },
	] });
	h.responses.push(h.pick("Same · recorded"), h.pick("Completed / history"), h.pick("direct-b"), h.pick("request ·"), h.pick("Inspect"), h.pick("Back"), h.pick("Close"));
	await h.run();
	const [first, second] = h.reports;
	assert.match(first!, /\*\*tab:\*\* `tab-1`[\s\S]*\*\*tab:\*\* `tab-2`/);
	assert.match(second!, /^\*\*✓ Direct workflow Same · completed\*\*/);
	assert.match(second!, /\*\*tab:\*\* `tab-3`/);
	assert.equal(h.inspectCount, 1);
	assert.ok(h.dialogs[0]!.options!.some((label) => label === "── Isolated (1) ──"));
	assert.ok(h.dialogs[0]!.options!.some((label) => label === "── Direct (1) ──"));
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
	const rows = h.dialogs[0]!.options!.filter((label) => /^  . D/.test(label));
	assert.equal(rows.length, 3);
	for (const prefix of ["  ● D1.1 · worker · Same · observed locally", "  ⚠ D2.1 · worker · Same · admission retained", "  ⚠ D3 · 3 workers · allocation unverified"]) {
		assert.ok(rows.some((label) => label.startsWith(prefix)), prefix);
	}
	assert.ok(rows.every((label) => !label.includes("direct-")), "opaque IDs stay in details");
	assert.deepEqual(h.notices, []);
	assert.equal(h.reports[0], [
		"**⚠ Direct workflow D3 · 3 workers · allocation unverified; admission retained**", "",
		"- **ID:** `direct-3-x`",
		"- **recovery:** ⚠ allocation evidence", "",
		"### D3.1 · worker · Scan",
		"- **task:** `entry-3`",
		"- **agent:** `d-3`",
		"- **tab:** `tab-3`",
		"- **pane:** `pane-3`",
		"- **session:** `/s3`", "",
		"* D3.2 · worker · Fix · no verified tab recorded",
		"* 1 other worker(s) in D3 have no recorded tab.",
	].join("\n"));
	assert.deepEqual(h.closed, []);
});

test("Refresh reloads the isolated inventory for the widget as well as the picker", async () => {
	const h = harness();
	h.responses.push(h.pick("Refresh"), h.pick("Completed / history"), h.pick("Close"));
	await h.run();
	assert.equal(h.inventoryCount, 3);
	assert.equal(h.working.length, 2, "open and Refresh show the working report; other loops do not");
});

test("the working report counts only live evidence before the menu opens", async () => {
	const display = { workflow: 1, worker: 1, workers: 1, title: "Scan", role: "scout" };
	const live = harness({ direct: [
		{ id: "reads", name: "reads", status: "observed locally", stoppable: ["entry-1"], workers: [display], tabs: [] },
		{ id: "old", name: "old", status: "recorded only; not proof of running or completion", workers: [{ ...display, workflow: 2 }], tabs: [] },
		{ id: "done", name: "done", status: "completed", workers: [{ ...display, workflow: 3 }], tabs: [] },
	], inventory: { root: "/git", leaseLive: true, invalidIds: [], requests: [{ id: "run", name: "Build", status: "running", tasks: [] }] } });
	live.responses.push((dialog) => { assert.equal(live.working.length, 1, "the report precedes the menu"); return live.pick("Close")(dialog); });
	await live.run();
	assert.deepEqual(live.working, [["**● Current subagent work**", "",
		"### ● Working (2)", "- D1.1 · scout · Scan · 1 running", "- run · running · Build", "",
		"### ⚠ Unverified (1) · not proof of running or completion", "- D2.1 · scout · Scan · recorded only; not proof of running or completion"].join("\n")]);
	const stale = harness({ inventory: { root: "/git", leaseLive: false, invalidIds: [], requests: [{ id: "run", name: "Build", status: "pending", tasks: [] },
		{ id: "kept", name: "Fix", status: "completed · retained", tasks: [] }] } });
	stale.responses.push(stale.pick("Close"));
	await stale.run();
	assert.deepEqual(stale.working, [["**⚠ Current subagent work**", "", "- No subagents are working.", "",
		"### ⚠ Needs attention (2)", "- run · pending · Build · interrupted; run /subagent recover", "- kept · completed · retained · Fix"].join("\n")]);
	const unknown = harness({ isolatedError: new Error("outside Git") });
	unknown.responses.push(unknown.pick("Close"));
	await unknown.run();
	assert.match(unknown.working[0]!, /- No direct subagents are working\. Isolated status is unavailable\./);
});

test("inspection launches a Herdr tab without queuing a Main turn or changing work", async () => {
	const h = harness();
	h.responses.push(h.pick("request ·"), h.pick("Inspect"), h.pick("Back"), h.pick("Close"));
	await h.run();
	assert.deepEqual(h.reports, ["**✓ Status inspection D9.1 started**\n\n- **tab:** `tab-request`\n- **agent:** `status-scout`\n- **session:** `/status/session.jsonl`"]);
	assert.equal(h.inspectCount, 1);
	assert.deepEqual(h.queues.get("task"), ["first", "first", "third"]);
	assert.deepEqual(h.sent, []);
});

test("inspection does not launch after the session changes in the menu", async () => {
	const h = harness();
	h.responses.push(h.pick("request ·"), (dialog) => {
		h.changeSession();
		return dialog.options!.find((option) => option.includes("Inspect"));
	});
	await h.run();
	assert.equal(h.inspectCount, 0);
});

test("failed isolated discovery preserves direct branch recovery and invalid inventory does not suppress healthy requests", async () => {
	const direct = [{ id: "direct", name: "Rescue", status: "recorded", workers: [], tabs: [{ entryId: "task", name: "worker", tabId: "tab", paneId: "pane", sessionFile: "/recover" }] }];
	const failed = harness({ direct, isolatedError: new Error("outside Git") });
	failed.responses.push(failed.pick("Rescue ·"), failed.pick("Close"));
	await failed.run();
	assert.ok(failed.notices.some((notice) => notice.message.includes("outside Git")));
	assert.match(failed.reports[0]!, /\*\*session:\*\* `\/recover`/);
	const invalid = harness({ inventory: { root: "/git", leaseLive: true, requests: [{ id: "good", name: "Healthy", status: "working", tasks: [] }], invalidIds: ["broken-state-id"] } });
	invalid.responses.push(invalid.pick("Healthy"), invalid.pick("Inspect"), invalid.pick("Back"), invalid.pick("Close"));
	await invalid.run();
	assert.ok(invalid.notices.some((notice) => notice.message.includes("broken-state-id") && notice.message.includes("Preserve")));
	assert.equal(invalid.inspectCount, 1);
});

test("drain all selected FIFO instructions before native RPC editor; cancel keeps withdrawal", async () => {
	const h = harness({ mode: "rpc" });
	h.responses.push(h.pick("request ·"), h.pick("Edit queued"), h.pick("task ·"), (dialog) => { assert.equal(dialog.kind, "editor"); assert.equal(dialog.prefill, "first\n\nfirst\n\nthird"); assert.deepEqual(h.queues.get("task"), []); return undefined; });
	await h.run();
	assert.deepEqual(h.queues.get("other"), ["untouched"]);
	assert.deepEqual(h.sent, []);
});

test("explicit replacement queues once, preserving newly appended work at the tail", async () => {
	const h = harness();
	h.responses.push(h.pick("request ·"), h.pick("Edit queued"), h.pick("task ·"), (dialog) => { assert.equal(dialog.prefill, "first\n\nfirst\n\nthird"); h.queues.get("task")!.push("new work"); return "replacement"; }, h.pick("Back"), h.pick("Close"));
	await h.run();
	assert.deepEqual(h.queues.get("task"), ["new work", "replacement"]);
	assert.deepEqual(h.sent, ["task:replacement"]);
});

test("empty drain and cancellation before withdrawal are harmless", async () => {
	const h = harness(); h.queues.set("task", []);
	h.responses.push(h.pick("request ·"), h.pick("Edit queued"), h.pick("task ·"), h.pick("Back"), h.pick("Close"));
	await h.run();
	assert.equal(h.dialogs.filter((dialog) => dialog.kind === "editor").length, 0);
	const next = harness(); next.responses.push(next.pick("request ·"), next.pick("Edit queued"), undefined);
	await next.run(); assert.equal(next.queues.get("task")!.length, 3);
});

test("duplicate task labels select the intended task, and late admission refusal reopens text without retry", async () => {
	const h = harness();
	h.responses.push(h.pick("request ·"), h.pick("Send follow-up"), h.pick("other ·"), () => { h.setActive(false); return "submitted"; }, (dialog) => { assert.equal(dialog.prefill, "submitted"); return undefined; });
	await h.run();
	assert.deepEqual(h.sent, []);
	assert.ok(h.notices.some((notice) => notice.message.includes("Not queued")));
});

test("overlong combined text remains intact in the editor after refusal", async () => {
	const h = harness(); const long = "x".repeat(20_000);
	h.queues.set("task", [long, long]);
	h.responses.push(h.pick("request ·"), h.pick("Edit queued"), h.pick("task ·"),
		(dialog) => { assert.equal(dialog.prefill, `${long}\n\n${long}`); return dialog.prefill; },
		(dialog) => { assert.equal(dialog.prefill, `${long}\n\n${long}`); return undefined; });
	await h.run(); assert.deepEqual(h.sent, []);
});

test("changed branch, session, or shutdown across a dialog prevents drain and submission; appended entries do not", async () => {
	for (const change of ["changeBranch", "navigateAncestor", "navigateDescendant", "changeSession", "changeFile", "shutdown"] as const) {
		const h = harness(); h.responses.push(h.pick("request ·"), h.pick("Edit queued"), () => { h[change](); return "task"; });
		await h.run(); assert.equal(h.queues.get("task")!.length, 3); assert.deepEqual(h.sent, []);
	}
	const h = harness(); h.responses.push(h.pick("request ·"), h.pick("Send follow-up"), h.pick("task ·"), () => { h.append(); return "hello"; }, h.pick("Back"), h.pick("Close"));
	await h.run(); assert.deepEqual(h.sent, ["task:hello"]);
});

test("existing descendant of an empty branch cannot withdraw or enqueue from a stale dialog", async () => {
	for (const action of ["Edit queued", "Send follow-up"]) {
		const h = harness(); h.emptyBranch();
		h.responses.push(h.pick("request ·"), h.pick(action), () => { h.navigateDescendant(); return "task"; });
		await h.run();
		assert.deepEqual(h.queues.get("task"), ["first", "first", "third"]);
		assert.deepEqual(h.sent, []);
	}
});

test("navigation after drain leaves withdrawn text unqueued", async () => {
	for (const change of ["navigateAncestor", "navigateDescendant"] as const) {
		const h = harness();
		h.responses.push(h.pick("request ·"), h.pick("Edit queued"), h.pick("task ·"), () => { h[change](); return "submitted"; });
		await h.run();
		assert.deepEqual(h.queues.get("task"), []);
		assert.deepEqual(h.sent, []);
	}
});

test("durable-only or other-owner requests cannot offer follow-up; task sealing before drain refuses without withdrawing", async () => {
	const h = harness(); h.setActive(false);
	h.responses.push(h.pick("request ·"), (dialog) => {
		assert.ok(!dialog.options!.some((option) => option.includes("Send follow-up") || option.includes("Edit queued")));
		return dialog.options!.find((option) => option.includes("Back"));
	}, h.pick("Close"));
	await h.run(); assert.equal(h.queues.get("task")!.length, 3);
	const race = harness();
	race.responses.push(race.pick("request ·"), race.pick("Edit queued"), (dialog) => { race.setActive(false); return dialog.options!.find((option) => option.startsWith("task ·")); }, race.pick("Back"), race.pick("Close"));
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

test("no UI reports requests without dialogs or mutations; unknown arguments fail", async () => {
	const h = harness({ ui: false });
	await h.run();
	assert.equal(h.messages[0]!, "**● Current subagent work**\n\n- No subagents are working.");
	assert.equal(h.messages[1]!, ["**● Isolated requests (report only)**", "", "- ● request · working · Same", "",
		"* Unreadable state files preserved: 0.", "* Removal requires interactive confirmation."].join("\n"));
	assert.deepEqual(h.discarded, []);
	await assert.rejects(h.run("task-id"), /Usage/);
	assert.deepEqual(h.dialogs, []);
	assert.equal(h.queues.get("task")!.length, 3);
});


test("direct Close is exact and refuses stale branch/session/epoch dialogs", async () => {
	for (const change of ["changeBranch", "navigateAncestor", "navigateDescendant", "changeSession", "changeFile", "shutdown", "append"] as const) {
		const h = harness({ direct: [{ id: "owned", name: "Rescue", status: "admission retained", canClose: true, workers: [], tabs: [] }] });
		h.responses.push(h.pick("Rescue ·"), (dialog) => { h[change](); return h.pick("Close/cancel")(dialog); }, h.pick("Close"));
		await h.run();
		assert.deepEqual(h.closed, change === "append" ? ["owned"] : []);
	}
});

test("Stop this worker targets one exact running worker and refuses stale dialogs", async () => {
	const display = (worker: number, title: string) => ({ workflow: 4, worker, workers: 2, title, role: "scout" });
	const tabs = [1, 2].map((n) => ({ entryId: `entry-${n}`, name: `d-${n}`, tabId: `tab-${n}`, paneId: `pane-${n}`, sessionFile: `/s${n}`, display: display(n, n === 1 ? "Scan" : "Trace") }));
	for (const change of [undefined, "changeBranch", "shutdown"] as const) {
		const h = harness({ direct: [{ id: "reads", name: "reads", status: "observed locally", canClose: true, stoppable: ["entry-2"], workers: tabs.map((tab) => tab.display), tabs }] });
		h.responses.push(h.pick("D4 · 2 workers"), (dialog) => {
			assert.deepEqual(dialog.options!.map((label) => label.replace(/ \[\d+\]$/, "")), [
				"Close/cancel-and-release ALL owned workers in this workflow (preserve files and commits)",
				"Stop this worker: D4.2 · scout · Trace (other workers continue)",
				"Back / refresh",
			]);
			if (change) h[change]();
			return h.pick("Stop this worker")(dialog);
		}, h.pick("Close"));
		await h.run();
		assert.deepEqual(h.stopped, change ? [] : ["reads:entry-2"]);
		assert.deepEqual(h.closed, []);
	}
});

const blocked = (kind: "unmerged" | "changes" | "hard", text: string) => ({ prunable: false, reason: text, blockers: [{ kind, text }], ...kind === "hard" ? {} : { override: "force" as const } });
const prunePlan: PrunePlan = { root: "/git", items: [
	{ branch: "pi-subagent/subagent-e", tip: "e".repeat(40), ...blocked("unmerged", "branch has commits not in Main HEAD"), ignored: [] },
	{ branch: "pi-subagent/subagent-a", tip: "a".repeat(40), path: "/git/.worktrees/subagent-a", prunable: true, reason: "merged into Main HEAD; clean checkout", blockers: [], ignored: [] },
	{ branch: "pi-subagent/subagent-c", tip: "c".repeat(40), path: "/git/.worktrees/subagent-c", ...blocked("changes", "checkout has tracked or untracked changes"), ignored: ["node_modules/"] },
	{ branch: "pi-subagent/subagent-b", tip: "b".repeat(40), path: "/git/.worktrees/subagent-b", prunable: true, reason: "merged into origin/main; clean checkout", blockers: [], ignored: ["node_modules/", "dist/"] },
	// A hard-blocked item: never offered for selection.
	{ branch: "pi-subagent/subagent-d", tip: "d".repeat(40), path: "/git/.worktrees/subagent-d", ...blocked("hard", "checkout has tracked or untracked changes"), ignored: [] },
] };

test("prune without UI reports readable names and legacy identity suffixes", async () => {
	const h = harness({ ui: false, prune: { ...prunePlan, items: prunePlan.items.map((item, index) => ({ ...item,
		branch: index === 0 ? `pi-subagent/subagent-${"e".repeat(24)}`
			: index === 1 ? `pi-subagent/subagent-request-task-${"a".repeat(24)}` : item.branch,
	})) } });
	await h.run("prune");
	assert.equal(h.messages.length, 1);
	// Prunable groups come first; each group names its exact reason once.
	assert.equal(h.messages[0]!, [
		"**● Subagent prune review**", "",
		"- **root:** `/git`",
		"- **prunable:** 2",
		"- **blocked:** 3",
		"- **IDs:** readable name, if present, and first 8 suffix characters", "",
		"### ✓ Prunable: merged into Main HEAD; clean checkout (1)",
		"- `request-task-aaaaaaaa`", "",
		"### ✓ Prunable: merged into origin/main; clean checkout (1)",
		"- `b`", "",
		"### ✗ Blocked: branch has commits not in Main HEAD; no checkout (1)",
		"- `eeeeeeee`", "",
		"### ✗ Blocked: checkout has tracked or untracked changes (2)",
		"- `c, d`", "",
		"* Report only: removal requires interactive confirmation.",
	].join("\n"));
	assert.deepEqual(h.dialogs, []);
	assert.deepEqual(h.pruned, []);
});

test("prune preselects prunable items; Continue removes them and ignored content needs a confirmation", async () => {
	const cancelled = harness({ prune: prunePlan });
	cancelled.responses.push(cancelled.pick("Cancel"));
	await cancelled.reviewPrune();
	assert.deepEqual(cancelled.pruned, []);

	const keepIgnored = harness({ prune: prunePlan });
	keepIgnored.responses.push(keepIgnored.pick("Continue (2 selected)"));
	keepIgnored.confirms.push(false);
	await keepIgnored.reviewPrune();
	assert.deepEqual(keepIgnored.dialogs.map(({ title }) => title), ["Prune subagent worktrees · prunable items are selected", "Delete ignored content"]);
	assert.deepEqual(keepIgnored.dialogs[0]!.options, [
		"[x] a · merged into Main HEAD; clean checkout", "[x] b · merged into origin/main; clean checkout",
		"[ ] e · force · branch has commits not in Main HEAD", "[ ] c · force · checkout has tracked or untracked changes",
		"Select all", "Clear", "Continue (2 selected)", "Cancel",
	]);
	assert.match(keepIgnored.dialogs[1]!.options![0]!, /permanently deletes[\s\S]*\/git\/\.worktrees\/subagent-b: node_modules\/, dist\/$/);
	assert.deepEqual(keepIgnored.pruned, [{ branches: ["pi-subagent/subagent-a"], allowIgnored: false }]);

	const all = harness({ prune: prunePlan });
	all.responses.push(all.pick("Continue"));
	all.confirms.push(true);
	await all.reviewPrune();
	assert.deepEqual(all.pruned, [{ branches: ["pi-subagent/subagent-a", "pi-subagent/subagent-b"], allowIgnored: true }]);
	assert.equal(all.reports.at(-1), "**✓ Pi Subagent prune in /git: removed**");
	// Retained resources never read as a normal completion.
	for (const [cleanup, glyph] of [[{ failed: 1, skipped: 1 }, "✗"], [{ failed: 0, skipped: 1 }, "⚠"]] as const) {
		const partial = harness({ prune: prunePlan, cleanup });
		partial.responses.push(partial.pick("Continue"));
		partial.confirms.push(true);
		await partial.reviewPrune();
		assert.equal(partial.reports.at(-1), `**${glyph} Pi Subagent prune in /git: removed**`);
	}
});

test("prune approval names every ignored entry and leaves out a checkout whose list does not fit", async () => {
	const many = Array.from({ length: 8 }, (_, index) => `generated-${index}/`);
	const plan: PrunePlan = { root: "/git", items: [
		{ branch: "pi-subagent/subagent-many", tip: "e".repeat(40), path: "/git/.worktrees/subagent-many", prunable: true, reason: "merged into Main HEAD; clean checkout", blockers: [], ignored: many },
		{ branch: "pi-subagent/subagent-huge", tip: "f".repeat(40), path: "/git/.worktrees/subagent-huge", prunable: true, reason: "merged into Main HEAD; clean checkout", blockers: [],
			ignored: Array.from({ length: 400 }, (_, index) => `huge-${index}/`) },
	] };
	const h = harness({ prune: plan });
	h.responses.push(h.pick("Continue"));
	h.confirms.push(true);
	await h.reviewPrune();
	const dialog = h.dialogs[1]!.options![0]!;
	assert.ok(many.every((entry) => dialog.includes(entry)), "every ignored entry is named");
	assert.doesNotMatch(dialog, /\+\d+ more\)/);
	assert.equal(dialog.includes("huge-399/"), false);
	assert.match(dialog, /\+1 more not shown; they are not removed/);
	assert.deepEqual(h.pruned, [{ branches: ["pi-subagent/subagent-many"], allowIgnored: true }]);
});

test("prune removes only items its dialogs showed, never items cut from a long list", async () => {
	const id = (index: number) => `${index.toString(16).padStart(8, "0")}${"0".repeat(16)}`;
	const item = (index: number, prunable: boolean) => ({ branch: `pi-subagent/subagent-${id(index)}`, tip: "d".repeat(40),
		path: `/git/.worktrees/subagent-${id(index)}`, prunable, reason: prunable ? "merged into Main HEAD; clean checkout" : "branch has commits not in Main HEAD",
		blockers: prunable ? [] : [{ kind: "hard" as const, text: "branch has commits not in Main HEAD" }], ignored: prunable ? ["node_modules/", "dist/", ".codegraph/"] : [] });
	// Blocked items sort first by branch; prunable ones must still be listed and selectable.
	const plan: PrunePlan = { root: "/git", items: [...Array.from({ length: 30 }, (_, index) => item(index, false)), ...Array.from({ length: 2_000 }, (_, index) => item(100 + index, true))] };
	const h = harness({ prune: plan });
	h.responses.push(h.pick("Continue"));
	h.confirms.push(true);
	await h.reviewPrune();
	const review = h.reports[0]!;
	const ids = new Set(review.split(/[\s,`]+/));
	const shown = plan.items.filter(({ branch }) => ids.has(branch.slice(-24, -16)));
	assert.ok(shown.length && shown.every(({ prunable }) => prunable), "prunable items are listed first");
	assert.match(review, new RegExp(`\\n\\* ⚠ \\+${plan.items.length - shown.length} more not shown; they are not removed`), "the review counts every omitted item");
	const ignoredDialog = h.dialogs[1]!.options![0]!;
	assert.match(ignoredDialog, /\+\d+ more not shown; they are not removed/);
	assert.ok([...ignoredDialog].length <= 4_000);
	const approved = shown.filter(({ path }) => ignoredDialog.includes(`${path}:`));
	assert.match(ignoredDialog, new RegExp(`^Also remove ${approved.length} checkout\\(s\\)`));
	assert.equal(h.pruned.length, 1);
	assert.deepEqual(h.pruned[0]!.branches, approved.map(({ branch }) => branch), "only items shown in both dialogs are removed");
});

test("prune toggles blocked items; force removal needs its own confirmation naming the lost data", async () => {
	const forced = harness({ prune: prunePlan });
	forced.responses.push(forced.pick("Select all"), forced.pick("Clear"), (dialog) => {
		assert.ok(dialog.options!.includes("Continue (0 selected)") && dialog.options!.every((label) => !label.startsWith("[x]")));
		return forced.pick("[ ] e ·")(dialog);
	}, (dialog) => {
		assert.ok(dialog.options!.includes("[x] e · force · branch has commits not in Main HEAD"));
		return forced.pick("Continue (1 selected)")(dialog);
	});
	forced.confirms.push(true);
	await forced.reviewPrune();
	assert.deepEqual(forced.dialogs.filter(({ kind }) => kind === "confirm").map(({ title }) => title), ["Force remove blocked worktrees"]);
	assert.match(forced.dialogs.at(-1)!.options![0]!, /^Force remove 1 blocked item\(s\)\? This permanently deletes their unique commits[\s\S]*\ne: branch has commits not in Main HEAD$/);
	assert.deepEqual(forced.pruned, [{ branches: ["pi-subagent/subagent-e"], allowIgnored: false, force: true }]);

	const declined = harness({ prune: prunePlan });
	declined.responses.push(declined.pick("[ ] e ·"), declined.pick("Continue (3 selected)"));
	declined.confirms.push(false, true);
	await declined.reviewPrune();
	assert.ok(declined.notices.some(({ message }) => message === "Kept 1 blocked item(s); force removal was not approved."));
	assert.deepEqual(declined.pruned, [{ branches: ["pi-subagent/subagent-a", "pi-subagent/subagent-b"], allowIgnored: true }]);
});

test("prune routes selected request-owned items to one discard of each whole owning request", async () => {
	const owner = { id: "orphan-req", name: "Lost goal", status: "needs_attention", directory: "/state", root: "/gone", orphaned: true };
	const owned = (id: string) => ({ branch: `pi-subagent/subagent-${id}`, tip: id.repeat(40), path: `/git/.worktrees/subagent-${id}`, prunable: false,
		reason: "owned by orphaned needs_attention request orphan-req; branch has commits not in Main HEAD", ignored: [], owner, override: "discard" as const,
		blockers: [{ kind: "owner" as const, text: "owned by orphaned needs_attention request orphan-req" }, { kind: "unmerged" as const, text: "branch has commits not in Main HEAD" }] });
	const h = harness({ prune: { root: "/git", items: [owned("f"), owned("g")] } });
	h.responses.push((dialog) => {
		assert.equal(dialog.options![0], "[ ] f · delete whole request orphan-req (needs_attention) · branch has commits not in Main HEAD");
		return h.pick("Select all")(dialog);
	}, h.pick("Continue (2 selected)"));
	h.confirms.push(true);
	await h.reviewPrune();
	assert.deepEqual([h.discarded, h.pruned], [["orphan-req"], []]);
	const confirms = h.dialogs.filter(({ kind }) => kind === "confirm");
	assert.equal(confirms.length, 1);
	assert.match(confirms[0]!.options![0]!, /^This closes and deletes each whole owning request \(orphan-req\), not only the selected worktrees\./);
	assert.match(h.reports[1]!, /^\*\*⚠ Close and delete request orphan-req\*\*/);
});

test("Select multiple batches discard of isolated requests and close of direct workflows, reporting skipped rows", async () => {
	const inventory: IsolatedInventory = { root: "/git", leaseLive: true, invalidIds: [], requests: [
		{ id: "one", name: "First", status: "working", tasks: [] },
		{ id: "lost", name: "Second", status: "needs_attention", orphaned: true, directory: "/state", root: "/gone", tasks: [] },
	] };
	const direct = [{ id: "owned", name: "Rescue", status: "admission retained", canClose: true, workers: [], tabs: [] }];
	const discard = harness({ inventory, direct });
	discard.responses.push(discard.pick("Select multiple…"), (dialog) => {
		assert.deepEqual(dialog.options!.slice(0, 3), ["[ ] ⚠ Rescue · admission retained · owned", "[ ] ● one · working · First", "[ ] ⚠ lost · needs_attention · Second"]);
		return discard.pick("Select all")(dialog);
	}, discard.pick("Continue (3 selected)"), (dialog) => {
		assert.deepEqual(dialog.options, ["Close and delete worktrees (discard work) of 2 isolated request(s)",
			"Close/cancel-and-release ALL owned workers in 1 direct workflow(s) (preserve files and commits)", "Back / refresh"]);
		return discard.pick("Close and delete")(dialog);
	}, discard.pick("Close"));
	discard.confirms.push(true);
	await discard.run();
	assert.deepEqual([discard.discarded, discard.closed], [["one", "lost"], []]);
	assert.equal(discard.dialogs.filter(({ kind }) => kind === "confirm").length, 1, "one confirmation covers every reviewed request");
	assert.match(discard.dialogs.find(({ kind }) => kind === "confirm")!.options![0]!, /delete the 2 unblocked resource group\(s\) shown above across 2 requests\?/);
	assert.ok(discard.notices.some(({ message }) => message === "Skipped 1 selected item(s) that this action does not apply to."));

	const close = harness({ inventory, direct });
	close.responses.push(close.pick("Select multiple…"), close.pick("Select all"), close.pick("Continue"), close.pick("Close/cancel"), close.pick("Close"));
	await close.run();
	assert.deepEqual([close.discarded, close.closed], [[], ["owned"]]);
	assert.ok(close.notices.some(({ message }) => message === "Skipped 2 selected item(s) that this action does not apply to."));

	const stale = harness({ inventory, direct });
	stale.responses.push(stale.pick("Select multiple…"), stale.pick("Select all"), (dialog) => { stale.changeSession(); return stale.pick("Continue")(dialog); });
	await stale.run();
	assert.equal(stale.dialogs.length, 3, "a changed session ends the selection");
});

test("isolated discard requires one explicit confirmation; cancel changes nothing", async () => {
	for (const confirmed of [false, true]) {
		const h = harness();
		h.confirms.push(confirmed);
		h.responses.push(h.pick("request ·"), h.pick("Close and delete"), h.pick("Close"));
		await h.run();
		assert.deepEqual(h.discarded, confirmed ? ["request"] : []);
		const dialogs = h.dialogs.filter((dialog) => dialog.kind === "confirm");
		assert.equal(dialogs.length, 1);
		assert.deepEqual(h.reports.slice(1), confirmed ? ["**✓ removed: task/1**"] : []);
		assert.match(dialogs[0]!.options![0]!, /Committed, uncommitted, and ignored content.*permanently deleted/);
		assert.match(h.reports[0]!, /^\*\*⚠ Close and delete request request\*\*\n\n### ⚠ task\/1 · can delete\n- \*\*path:\*\* `\/owned`\n[\s\S]*\*\*commits ahead of recorded base:\*\* 1\n- \*\*dirty:\*\* yes\n- \*\*ignored entries, deleted with all content inside them:\*\* `cache\/`/);
	}
});

test("isolated history filtering keeps unresolved and retained requests in both groups", async () => {
	const statuses = ["completed", "aborted", "final_failed", "superseded", "needs_attention", "completed · retained", "aborted · retained", "final_failed · retained", "superseded · retained", "saved running · unverified", "saved pending · unverified"];
	const requests = [false, true].flatMap((orphaned) => statuses.map((status, index) => ({
		id: `${orphaned ? "orphan" : "local"}-${index}`, name: "Goal", status: orphaned ? status : status.replace(/^saved (running|pending) · unverified$/, "$1"), orphaned, tasks: [],
	})));
	const h = harness({ inventory: { root: "/git", leaseLive: true, invalidIds: [], requests } });
	h.responses.push(h.pick("Completed / history"), h.pick("Active work"), h.pick("Close"));
	await h.run();
	const ids = (index: number) => h.dialogs[index]!.options!.filter((label) => label.startsWith("  ")).map((label) => label.split(" · ")[0]!.trim().slice(2)).sort();
	const visible = requests.filter((request) => !statuses.slice(0, 4).includes(request.status)).map(({ id }) => id).sort();
	assert.deepEqual(ids(0), visible);
	assert.deepEqual(ids(1), requests.map(({ id }) => id).sort());
	assert.deepEqual(ids(2), visible);
	assert.match(h.working[0]!, /orphan-9 · saved running · unverified/);
	assert.match(h.working[0]!, /orphan-10 · saved pending · unverified/);
	assert.match(h.working[0]!, /orphan-7 · final\\_failed · retained/);
	assert.deepEqual(h.discarded, []);
});

test("orphaned requests show the delete action without status or follow-up actions", async () => {
	const h = harness({ inventory: { root: "/git", leaseLive: true, invalidIds: [], requests: [{
		id: "orphan", name: `Lost\nparent ${"goal ".repeat(40)}`, status: "aborted", orphaned: true, directory: "/state", root: "/removed", tasks: [],
	}] } });
	h.confirms.push(true);
	h.responses.push(h.pick("Completed / history"), (dialog) => {
		assert.deepEqual(dialog.options!.slice(0, 2), ["── Orphaned · parent checkout removed (1) ──", `  ✗ orphan · aborted · Lost parent ${"goal ".repeat(9)}go…`]);
		return h.pick("orphan ·")(dialog);
	}, (dialog) => {
		assert.ok(!dialog.options!.some((label) => /Inspect|follow-up/.test(label)));
		return h.pick("Close and delete")(dialog);
	}, h.pick("Close"));
	await h.run();
	assert.deepEqual(h.discarded, ["orphan"]);
});

test("discard deletes only fully shown groups, including their full ignored-entry lists", async () => {
	const item = { key: "shown", identity: "owned", checkout: true, path: "/owned", branch: "owned", tip: "a".repeat(40), ignored: [], hosts: [], blockers: [] };
	const h = harness({ discard: { root: "/git", directory: "/state", requestId: "request", items: [
		item, { ...item, key: "hidden", ignored: ["x".repeat(16_001)] },
	] } });
	h.confirms.push(true);
	h.responses.push(h.pick("request ·"), h.pick("Close and delete"), h.pick("Close"));
	await h.run();
	assert.deepEqual(h.discardedKeys, ["shown"]);
	assert.match(h.reports[0]!, /\n\* ⚠ \+1 more not shown; they are not removed/);
});

test("prune returns during scan, repeats show progress, and only a later command opens review", async () => {
	const h = harness();
	const scan = deferred<PrunePlan>();
	let scans = 0;
	h.adapter.prunePlan = async (_cwd, current, progress) => {
		scans++;
		assert.equal(current!(), true);
		progress!(1, 2);
		return scan.promise;
	};
	await h.run("prune");
	assert.equal(h.dialogs.length, 0);
	assert.equal(h.statuses.at(-1), "● Prune scan 1/2");
	await h.run("prune");
	assert.equal(scans, 1);
	assert.match(h.notices.at(-1)!.message, /Prune scan 1\/2/);
	scan.resolve({ root: "/git", items: [prunePlan.items[1]!] });
	await settle();
	assert.equal(h.dialogs.length, 0, "completion must not open a delayed dialog");
	assert.match(h.notices.at(-1)!.message, /scan ready/);
	h.append(); // Normal session growth must not invalidate the scan.
	h.responses.push(h.pick("Continue"));
	await h.run("prune");
	await settle();
	assert.equal(scans, 1, "the ready plan is reviewed without another scan");
	assert.equal(h.pruned.length, 1);
	assert.equal(h.statuses.at(-1), undefined);
});

test("prune cancel stops pending scans, holds the slot until settlement, and clears ready plans", async () => {
	const h = harness();
	const scan = deferred<PrunePlan>();
	let scans = 0;
	let allowed!: () => boolean;
	h.adapter.prunePlan = async (_cwd, current) => { scans++; allowed = current!; return scan.promise; };
	await h.run("prune");
	await h.run("prune cancel");
	assert.equal(allowed(), false);
	assert.equal(h.statuses.at(-1), undefined);
	await h.run("prune");
	assert.equal(scans, 1);
	assert.match(h.notices.at(-1)!.message, /stopping/);
	scan.resolve(prunePlan);
	await settle();
	assert.equal(h.reports.length, 0);
	assert.equal(h.notices.some(({ message }) => message.includes("scan ready")), false);
	await h.run("prune");
	await settle();
	assert.equal(scans, 2);
	await h.run("prune cancel");
	await h.run("prune");
	await settle();
	assert.equal(scans, 3, "cancelling a ready plan requires a fresh scan");
	assert.equal(h.dialogs.length, 0);
});

test("confirmed prune returns during removal, cancellation keeps partial reports, and busy commands cannot overlap", async () => {
	const h = harness({ prune: { root: "/git", items: [prunePlan.items[1]!] } });
	const removal = deferred<{ text: string; failed: number; skipped: number }>();
	let allowed!: () => boolean, calls = 0;
	h.adapter.prune = async (_cwd, _items, _ignored, _force, current, progress) => {
		calls++; allowed = current;
		progress!(0, 1);
		return removal.promise;
	};
	await h.run("prune");
	h.responses.push(h.pick("Continue"));
	await h.run("prune");
	assert.equal(calls, 1, "command returns while cleanup is pending");
	assert.equal(allowed(), true);
	await h.run("prune");
	assert.equal(calls, 1);
	assert.match(h.notices.at(-1)!.message, /cleanup 0\/1/);
	await h.run("prune cancel");
	assert.equal(allowed(), false);
	assert.equal(h.statuses.at(-1), undefined);
	removal.resolve({ text: "checkout removed; branch kept", failed: 0, skipped: 1 });
	await settle();
	assert.match(h.reports.at(-1)!, /checkout removed; branch kept/);
	assert.match(h.notices.at(-1)!.message, /Prune stopped/);
	assert.equal(h.dialogs.length, 1);
});

test("prune binds scans, ready plans, and cleanup reports to the launching generation", async () => {
	for (const event of ["session_start", "session_shutdown", "session_tree"]) {
		for (const phase of ["scan", "ready", "cleanup"]) {
			const h = harness({ prune: { root: "/git", items: [prunePlan.items[1]!] } });
			const scan = deferred<PrunePlan>();
			const removal = deferred<{ text: string; failed: number; skipped: number }>();
			let allowed!: () => boolean;
			if (phase === "scan") h.adapter.prunePlan = async (_cwd, current) => { allowed = current!; return scan.promise; };
			h.adapter.prune = async (_cwd, _items, _ignored, _force, current) => { allowed = current; return removal.promise; };
			await h.run("prune");
			if (phase === "cleanup") { h.responses.push(h.pick("Continue")); await h.run("prune"); }
			let lifecycleSettled = false;
			const lifecycle = Promise.resolve(h.event(event)).then(() => { lifecycleSettled = true; });
			if (event === "session_shutdown" && phase !== "ready") {
				await settle();
				assert.equal(lifecycleSettled, false, "replacement must wait for the old runtime's active operation");
			}
			if (phase !== "ready") assert.equal(allowed(), false);
			assert.equal(h.statuses.at(-1), undefined);
			const reports = h.reports.length, notices = h.notices.length, dialogs = h.dialogs.length, statuses = h.statuses.length;
			scan.resolve(prunePlan);
			removal.resolve({ text: "stale result", failed: 0, skipped: 0 });
			await lifecycle;
			await settle();
			assert.deepEqual([h.reports.length, h.notices.length, h.dialogs.length, h.statuses.length], [reports, notices, dialogs, statuses], `${event}: stale ${phase} cannot change reports or clear a new runtime's status`);
			if (phase === "ready") { await h.run("prune"); assert.equal(h.dialogs.length, 0, "the old ready plan cannot be reviewed"); }
		}
	}
	for (const change of ["changeSession", "changeFile", "changeBranch", "navigateAncestor", "navigateDescendant", "shutdown"] as const) {
		const h = harness();
		const scan = deferred<PrunePlan>();
		h.adapter.prunePlan = () => scan.promise;
		await h.run("prune");
		h[change]();
		scan.resolve(prunePlan);
		await settle();
		assert.equal(h.statuses.at(-1), undefined);
		assert.equal(h.notices.some(({ message }) => message.includes("scan ready")), false, change);
	}
});

test("prune failures clear progress and leave the next command free to scan", async () => {
	for (const phase of ["scan", "cleanup"]) {
		const h = harness({ prune: { root: "/git", items: [prunePlan.items[1]!] } });
		let scans = 0;
		const original = h.adapter.prunePlan;
		h.adapter.prunePlan = async (...args) => { scans++; if (phase === "scan") throw new Error("inspection unavailable"); return original(...args); };
		h.adapter.prune = async () => { throw new Error("removal unavailable"); };
		await h.run("prune");
		await settle();
		if (phase === "cleanup") { h.responses.push(h.pick("Continue")); await h.run("prune"); }
		await settle();
		assert.match(h.reports.at(-1)!, /unavailable/);
		assert.equal(h.statuses.at(-1), undefined);
		await h.run("prune");
		assert.equal(scans, 2);
	}
});

test("prune reviews whole-request discard in the foreground before any background removal", async () => {
	const owner = { id: "owned", name: "Owned", status: "needs_attention", directory: "/state", root: "/git", orphaned: false };
	const h = harness({ prune: { root: "/git", items: [prunePlan.items[1]!, { ...prunePlan.items[1]!, branch: "pi-subagent/subagent-owned",
		prunable: false, override: "discard", owner, blockers: [{ kind: "owner", text: "owned" }] }] } });
	const plan = deferred<DiscardPlan>();
	const removal = deferred<void>();
	const discarded = deferred<void>();
	const originalPlan = h.adapter.discardPlan, originalPrune = h.adapter.prune, originalDiscard = h.adapter.discard;
	h.adapter.discardPlan = () => plan.promise;
	let started = false;
	h.adapter.prune = async (...args) => { started = true; await removal.promise; return originalPrune(...args); };
	h.adapter.discard = async (...args) => { await discarded.promise; return originalDiscard(...args); };
	await h.run("prune");
	h.responses.push(h.pick("Select all"), h.pick("Continue"));
	h.confirms.push(true);
	let returned = false;
	const review = h.run("prune").then(() => { returned = true; });
	await settle();
	assert.deepEqual([started, returned], [false, false], "discard review cannot be orphaned behind background cleanup");
	plan.resolve(await originalPlan("/cwd", { ...owner, tasks: [] }));
	await review;
	assert.equal(started, true);
	assert.match(h.dialogs.at(-1)!.options![0]!, /whole owning request/);
	const count = h.dialogs.length;
	removal.resolve();
	await settle();
	assert.equal(h.pruned.length, 1);
	assert.equal(h.discarded.length, 0);
	discarded.resolve();
	await settle();
	assert.deepEqual(h.discarded, ["owned"]);
	assert.equal(h.dialogs.length, count, "no dialog opens after the command returns");
	assert.equal(h.statuses.at(-1), undefined);
});

test("prune without a user interface awaits inspection and never removes items", async () => {
	const h = harness({ ui: false });
	const scan = deferred<PrunePlan>();
	h.adapter.prunePlan = () => scan.promise;
	let returned = false;
	const command = h.run("prune").then(() => { returned = true; });
	await settle();
	assert.equal(returned, false);
	scan.resolve(prunePlan);
	await command;
	assert.match(h.messages.at(-1)!, /Report only/);
	assert.deepEqual([h.pruned, h.discarded, h.dialogs, h.statuses], [[], [], [], []]);
});

test("prune cancellation during discard reports the active request and does not start the next request", async () => {
	const h = harness({ prune: { root: "/git", items: ["first", "second"].map((id) => ({ ...prunePlan.items[1]!,
		branch: `pi-subagent/subagent-${id}`, prunable: false, override: "discard",
		owner: { id, name: id, status: "needs_attention", directory: "/state", root: "/git", orphaned: false },
		blockers: [{ kind: "owner", text: id }],
	})) } });
	const finish = deferred<void>();
	const requests: string[] = [];
	let allowed!: () => boolean;
	h.adapter.discard = async (_cwd, plan, current) => {
		requests.push(plan.requestId); allowed = current;
		await finish.promise;
		return { text: "first: checkout removed; branch kept", failed: 0, skipped: 1 };
	};
	await h.run("prune");
	h.responses.push(h.pick("Select all"), h.pick("Continue"));
	h.confirms.push(true);
	await h.run("prune");
	assert.deepEqual(requests, ["first"]);
	await h.run("prune cancel");
	assert.equal(allowed(), false);
	finish.resolve();
	await settle();
	assert.deepEqual(requests, ["first"]);
	assert.match(h.reports.at(-1)!, /first: checkout removed; branch kept/);
	assert.equal(h.statuses.at(-1), undefined);
});

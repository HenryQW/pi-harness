import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { AgentSessionRuntime, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkoutAdmission } from "@henryqw/pi-herdr";
import subagentExtension from "../extensions/subagent.ts";
import { registerDirectAdmission } from "../extensions/admission.ts";

async function native(t: TestContext, journalOnly = false, older?: "no-capability" | "missing-method", conversation = true) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "subagent-native-reload-")));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const active = process.env.PI_CODING_AGENT, title = process.title;
	process.env.PI_CODING_AGENT = "true";
	process.title = "pi";
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		if (active === undefined) delete process.env.PI_CODING_AGENT;
		else process.env.PI_CODING_AGENT = active;
		process.title = title;
		await rm(root, { recursive: true, force: true });
	});
	const settingsManager = SettingsManager.inMemory();
	let api!: ExtensionAPI, ctx!: ExtensionContext, journal!: ReturnType<typeof registerDirectAdmission>;
	const secondary = join(root, "selected");
	await mkdir(secondary);
	let previousCoordinator: ((pi: ExtensionAPI) => any) | undefined;
	let registerJournal = registerDirectAdmission;
	if (older) {
		const copy = join(root, "older-admission.mjs");
		await writeFile(copy, await readFile(new URL("../../../packages/pi-herdr/dist/admission.js", import.meta.url), "utf8"));
		previousCoordinator = (await import(pathToFileURL(copy).href)).checkoutAdmission;
		await writeFile(join(root, "legacy-surface.mjs"), 'export { checkoutAdmission, registerCheckoutAdmission } from "./older-admission.mjs";');
		const journalCopy = join(root, "journal.ts");
		await writeFile(journalCopy, (await readFile(new URL("../extensions/admission.ts", import.meta.url), "utf8"))
			.replaceAll('"@henryqw/pi-herdr"', '"./legacy-surface.mjs"')
			.replaceAll('"../dist/process-lease.js"', JSON.stringify(new URL("../dist/process-lease.js", import.meta.url).href)));
		registerJournal = (await import(pathToFileURL(journalCopy).href)).registerDirectAdmission;
	}
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [...(previousCoordinator ? [(pi: ExtensionAPI) => {
			const old = previousCoordinator!(pi);
			if (older === "no-capability") delete old.supportsDirectJournal;
			else delete old.restoreSet;
			old.install(pi);
		}] : []), (pi) => {
			api = pi;
			if (journalOnly) journal = registerJournal(pi, (input: any) => input.access !== "read", async () => [secondary]);
			else subagentExtension(pi);
			pi.on("session_start", (_event, context) => { ctx = context; });
		}] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = SessionManager.create(root, join(root, "sessions"));
	if (conversation) manager.appendMessage({ role: "user", content: "Synthetic admission test; do not launch a worker.", timestamp: Date.now() });
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	let { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
		settingsManager, sessionManager: manager, modelRuntime, tools: [] });
	const errors: string[] = [];
	await session.bindExtensions({ onError: (error) => errors.push(error.error) });
	t.after(() => session.dispose());
	return { root, secondary, get manager() { return session.sessionManager; }, get session() { return session; }, errors,
		get ctx() { return ctx; }, get api() { return api; }, get journal() { return journal; },
		hold: (id = "writer", taskId = "direct-test") => journal.hold(id, taskId, ctx),
		call: (id: string, toolName = "edit", input: any = {}) => session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: id, toolName, input }),
		replacement: (allowed = false) => new AgentSessionRuntime(session, { cwd: root, agentDir: root } as never, async ({ sessionManager }) => {
			if (!allowed) throw new Error("replacement must be vetoed");
			await loader.reload();
			const result = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager, sessionManager, modelRuntime, tools: [] });
			session = result.session;
			await session.bindExtensions({ onError: (error) => errors.push(error.error) });
			return { ...result, services: { cwd: root, agentDir: root } as never, diagnostics: [] };
		}),
	};
}

async function reviewRecovery(h: Awaited<ReturnType<typeof native>>, id: string, options: {
	confirm?: () => Promise<boolean>; input?: (identity: string) => Promise<string | undefined>; override?: boolean;
} = {}) {
	const runner = h.session.extensionRunner;
	const reports: string[] = [], dialogs: string[] = [];
	let selection = 0;
	runner.setUIContext({ ...runner.getUIContext(),
		notify: (message: string) => { reports.push(message); },
		select: async (title: string, choices: string[]) => {
			dialogs.push(title);
			if (++selection === 1) return choices.find((choice) => choice.startsWith("  ") && choice.includes(id));
			if (selection === 2) return choices.find((choice) => choice.startsWith("Review recovered"));
			if (selection === 3 && options.override) return choices.find((choice) => choice.startsWith("Release protection despite"));
		},
		confirm: async (title: string, message: string) => { dialogs.push(`${title}\n${message}`); return options.confirm ? await options.confirm() : true; },
		input: async (title: string) => { dialogs.push(title); const identity = title.split(": ").at(-1)!; return options.input ? await options.input(identity) : identity; },
	} as never, "rpc");
	await runner.getCommand("subagent")!.handler("", runner.createCommandContext());
	return { reports, dialogs };
}

const savedHold = (h: Awaited<ReturnType<typeof native>>, taskId = "direct-recovery") => ({ version: 1, sessionId: h.manager.getSessionId(),
	taskId, token: `${taskId}-token`, checkouts: [h.root, h.secondary].sort(), state: "held", proof: "not-dispatched", resources: [] });

test("native reload cannot lose an unresolved direct writer", async (t) => {
	const h = await native(t);
	assert.equal(await h.call("writer", "delegate_task", { mode: "direct", role: "worker", name: "test", task: "test", access: "write" }), undefined);
	checkoutAdmission(h.api).hold("writer");
	h.api.appendEntry("subagent-direct-tab", { taskId: "direct-test", entryId: "writer:0", name: "test", tabId: "w:t", paneId: "w:p", sessionFile: "/test/session", leasePath: "/test/lease", cwd: h.root });
	assert.equal((await h.call("before"))?.block, true);
	const old = h.session.extensionRunner;
	await h.session.reload();
	assert.notEqual(h.session.extensionRunner, old);
	assert.equal((await h.call("after"))?.block, true, "native reload must preserve writer exclusion");
	assert.equal(await h.call("read", "read"), undefined);
});

test("native reload replays the full held set off branch and vetoes session replacement without worker authority", async (t) => {
	const h = await native(t, true);
	const branch = h.manager.getLeafId()!;
	assert.equal(await h.call("writer", "delegate_task", { access: "write" }), undefined);
	h.hold();
	const held = h.manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "subagent-direct-admission")!;
	assert.deepEqual((held as any).data.checkouts, [h.root, h.secondary].sort());
	const file = await readFile(h.manager.getSessionFile()!, "utf8");
	assert.ok(file.includes('"state":"held"'), "hold must reach the native session file before allocation");
	assert.equal((await h.session.navigateTree(branch, { summarize: false })).cancelled, false);
	assert.ok(!h.manager.getBranch().some(({ id }) => id === held.id));
	await h.session.reload();
	assert.equal((await h.call("edit"))?.block, true);
	await assert.rejects(checkoutAdmission(h.api).reserve("secondary-writer", h.secondary), /active writer/);
	assert.equal(await h.call("read", "read"), undefined);
	assert.equal(await h.call("reader", "delegate_task", { access: "read" }), undefined);
	assert.deepEqual(await h.replacement().newSession(), { cancelled: true });
	assert.deepEqual(await h.replacement().fork(branch), { cancelled: true });
	assert.deepEqual(h.errors, []);
});

test("native release off branch survives reload and rejects stale held replay", async (t) => {
	const h = await native(t, true);
	const branch = h.manager.getLeafId()!;
	await h.call("writer", "delegate_task", { access: "write" });
	const release = h.hold();
	const held = h.manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "subagent-direct-admission") as any;
	release();
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent-direct-admission")
		.map((entry: any) => [entry.data.state, entry.data.proof]), [["held", "not-dispatched"], ["released", "not-dispatched"]]);
	assert.ok((await readFile(h.manager.getSessionFile()!, "utf8")).includes('"state":"released"'));
	await h.session.navigateTree(branch, { summarize: false });
	h.api.appendEntry("subagent-direct-admission", held.data);
	await h.session.reload();
	assert.equal(await h.call("edit"), undefined);
	(await checkoutAdmission(h.api).reserve("secondary-writer", h.secondary))();
	assert.equal(await h.session.extensionRunner.emit({ type: "session_before_fork", entryId: branch, position: "before" }), undefined);
	assert.deepEqual(h.errors, []);
});

test("failed native journal writes cannot start a worker or release its admission", async (t) => {
	const h = await native(t, true);
	const path = h.manager.getSessionFile()!, backup = `${path}.saved`;
	const breakStorage = async () => { await rename(path, backup); await mkdir(path); };
	const repairStorage = async () => { await rm(path, { recursive: true }); await rename(backup, path); };
	await breakStorage();
	await h.call("writer", "delegate_task", { access: "write" });
	assert.throws(() => h.hold(), /EISDIR/);
	assert.equal(await h.call("writer-again", "delegate_task", { access: "write" }), undefined, "failed hold allocated nothing");
	await repairStorage();
	const release = h.hold("writer-again");
	await breakStorage();
	assert.throws(release, /EISDIR/);
	assert.equal((await h.call("edit"))?.block, true);
	await repairStorage();
	await h.session.reload();
	assert.equal((await h.call("edit-after-reload"))?.block, true, "failed release must replay the persisted hold");
	assert.throws(release, /stale|reload/i, "the old extension must not release through its invalidated API");
});

test("a swallowed session_start failure remains a write and replacement veto, but reads work", async (t) => {
	const h = await native(t, true);
	h.api.appendEntry("subagent-direct-admission", { version: 99 });
	await h.session.reload(); // Pi reports the error and resolves reload.
	assert.ok(h.errors.some((message) => message.includes("Malformed direct admission journal")));
	assert.match((await h.call("edit"))!.reason!, /Malformed direct admission journal/);
	assert.equal(await h.call("read", "read"), undefined);
	assert.equal(await h.call("reader", "delegate_task", { access: "read" }), undefined);
	assert.deepEqual(await h.replacement().newSession(), { cancelled: true });
	assert.deepEqual(await h.replacement().fork(h.manager.getLeafId()!), { cancelled: true });
});

test("independently loaded older coordinators fail closed on missing capability or methods", async (t) => {
	for (const kind of ["no-capability", "missing-method"] as const) await t.test(kind, async (t) => {
		const h = await native(t, true, kind);
		assert.match((await h.call("edit"))!.reason!, /active checkout coordinator cannot replay/);
		await h.session.extensionRunner.emit({ type: "tool_execution_end", toolCallId: "edit" } as never);
		for (const tool of ["read", "grep", "find", "ffgrep", "fffind", "ls", "codegraph_explore", "subagent_status", "codemode"]) assert.equal(await h.call(tool, tool), undefined);
		assert.match((await h.call("writer", "delegate_task", { access: "write" }))!.reason!, /active checkout coordinator cannot replay/);
		assert.equal(await h.call("reader", "delegate_task", { access: "read" }), undefined);
		assert.deepEqual(await h.replacement().newSession(), { cancelled: true });
	});
});

test("setup-only native sessions cannot allocate a writer without durable conversation storage", async (t) => {
	const h = await native(t, true, undefined, false);
	await h.call("writer", "delegate_task", { access: "write" });
	assert.throws(() => h.hold(), /setup-only or in-memory sessions cannot persist admission/);
	await assert.rejects(readFile(h.manager.getSessionFile()!), { code: "ENOENT" });
});

test("a release cannot substitute a different checkout set or an unrelated identity", async (t) => {
	for (const mismatch of ["set", "token", "resources"]) await t.test(mismatch, async (t) => {
		const h = await native(t, true);
		await h.call("writer", "delegate_task", { access: "write" });
		const release = h.hold();
		if (mismatch === "resources") release.effect({ kind: "unknown" });
		const held = h.manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "subagent-direct-admission") as any;
		h.api.appendEntry("subagent-direct-admission", { ...held.data, state: "released", release: "proved",
			...(mismatch === "set" ? { checkouts: [h.root] } : mismatch === "token" ? { token: "different-owner" } : {}) });
		await h.session.reload();
		assert.match((await h.call("edit"))!.reason!, /changed its checkout set|conflicting reservation identities|changed its effect evidence/);
	});
});

test("native reload refuses missing, forged or changed release evidence", async (t) => {
	for (const kind of ["no-kind", "empty-stopped", "incomplete-proof", "no-stopped-checkpoint", "missing-waiver", "wrong-identity", "changed-waiver-evidence", "changed-resource-record", "changed-source-record", "changed-checkpoint", "changed-terminal-release", "new-effect-after-release"] as const) await t.test(kind, async (t) => {
		const h = await native(t, true);
		const held: any = savedHold(h);
		if (kind === "empty-stopped" || kind === "incomplete-proof") held.proof = "stopped";
		if (kind === "incomplete-proof") held.resources = [{ kind: "allocation-intent", leaseIdentity: { device: "1", inode: "2", birth: "3", parentDevice: "1", parentInode: "4", parentBirth: "5" } }];
		if (kind === "no-stopped-checkpoint" || kind.includes("waiver") || kind === "wrong-identity" || kind === "changed-resource-record" || kind === "changed-source-record" || kind === "changed-checkpoint") held.proof = "unproved";
		if (kind === "changed-source-record") {
			held.resources = [{ kind: "continuation-sources", sources: [{ taskId: "source", entryId: "source:0" }] }];
			h.api.appendEntry("subagent-direct-tab", { taskId: "source", entryId: "source:0", access: "read", paneId: "original" });
		}
		h.api.appendEntry("subagent-direct-admission", held);
		const receipt: any = { ...held, state: "released", release: "proved" };
		if (kind === "no-kind") delete receipt.release;
		if (kind === "no-stopped-checkpoint") receipt.proof = "stopped";
		if (held.proof === "unproved" && kind !== "no-stopped-checkpoint") {
			receipt.release = "user-unproved";
			receipt.waiver = { identity: `${held.sessionId}/${held.taskId}/${held.token}`, evidence: h.journal.evidence(held, h.ctx) };
			if (kind === "missing-waiver") delete receipt.waiver;
			if (kind === "wrong-identity") receipt.waiver.identity += "-wrong";
			if (kind === "changed-waiver-evidence") receipt.waiver.evidence = "{}";
			if (kind === "changed-checkpoint") receipt.proof = "stopped";
		}
		h.api.appendEntry("subagent-direct-admission", receipt);
		if (kind === "changed-resource-record") h.api.appendEntry("subagent-direct-tab", { taskId: held.taskId, name: "not reviewed" });
		if (kind === "changed-source-record") h.api.appendEntry("subagent-direct-tab", { taskId: "source", entryId: "source:0", access: "read", paneId: "changed" });
		if (kind === "changed-terminal-release") h.api.appendEntry("subagent-direct-admission", { ...receipt, proof: "stopped" });
		if (kind === "new-effect-after-release") h.api.appendEntry("subagent-direct-admission", { ...held, resources: [{ kind: "unknown" }] });
		await h.session.reload();
		assert.match((await h.call("edit"))!.reason!, /Malformed direct admission|incomplete or changed proof or user consent|evidence changed after release/);
		assert.equal(await h.call("read", "read"), undefined);
		await assert.rejects(checkoutAdmission(h.api).reserve("secondary", h.secondary), /recovery|consent|evidence|Malformed/);
		assert.deepEqual(await h.replacement().newSession(), { cancelled: true });
	});
});

test("native local release retries only its own failed verified-tab evidence and replays offline", async (t) => {
	for (const scope of ["unchanged", "changed"] as const) await t.test(scope, async (t) => {
		const h = await native(t, true);
		await h.call("writer", "delegate_task", { access: "write" });
		const release = h.hold();
		const tab = { taskId: "direct-test", entryId: "entry", name: "worker", tabId: "tab", paneId: "pane", workspaceId: "workspace", cwd: h.root,
			sessionFile: `${h.root}/absent/session.jsonl`, leasePath: `${h.root}/absent/process.lease`, turn: "turn",
			leaseIdentity: { device: "1", inode: "2", birth: "3", parentDevice: "1", parentInode: "4", parentBirth: "5" } };
		const { taskId: _task, tabId: _tab, paneId: _pane, ...allocation } = tab;
		release.effect({ kind: "allocation-intent", label: "worker", ...allocation });
		assert.throws(release, /Complete saved termination evidence/);
		assert.equal((await h.call("incomplete"))?.block, true);
		const append = h.api.appendEntry;
		let failure: "verified-tab" | "released" | undefined = "verified-tab";
		h.api.appendEntry = (type, data: any) => {
			if (type === "subagent-direct-admission" && (failure === "verified-tab" && data.resources?.at(-1)?.kind === "verified-tab"
				|| failure === "released" && data.state === "released")) throw new Error(`journal ${failure} failed`);
			append(type, data);
		};
		assert.throws(() => release.effect({ kind: "verified-tab", ...tab }), /journal verified-tab failed/);
		assert.throws(release, /journal verified-tab failed/);
		const held = h.journal.inventory(h.ctx).records[0]!;
		assert.equal(held.proof, "unproved");
		assert.equal(held.resources!.length, 1, "failed writes save neither verified-tab nor stopped evidence");
		if (scope === "changed") {
			append("subagent-direct-admission", { ...held, resources: [...held.resources!, { kind: "unknown" }] });
			failure = undefined;
			assert.throws(release, /reservation changed before local evidence retry/);
			assert.equal((await h.call("changed"))?.block, true);
			return;
		}
		failure = "released";
		assert.throws(release, /journal released failed/);
		assert.equal((await h.call("release-failed"))?.block, true);
		failure = undefined;
		release();
		const receipt = (h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent-direct-admission").at(-1) as any).data;
		assert.deepEqual(receipt.resources, [{ kind: "allocation-intent", label: "worker", ...allocation }, { kind: "verified-tab", ...tab }]);
		assert.equal(h.journal.hasProof(receipt, h.ctx), true);
		await h.session.reload();
		assert.equal(await h.call("released"), undefined);
		(await checkoutAdmission(h.api).reserve("secondary", h.secondary))();
		assert.deepEqual(h.errors, []);
	});
});

test("native replacement refuses admitted preflight and seals the gap before later handlers", async (t) => {
	for (const kind of ["switch", "fork"] as const) await t.test(kind, async (t) => {
		const h = await native(t, true);
		await h.call("writer", "delegate_task", { access: "write" });
		let later = false;
		const laterHandler = async () => {
			later = true;
			await Promise.resolve();
			assert.equal((await h.call("late-writer", "delegate_task", { access: "write" }))?.block, true);
			return { cancel: true as const };
		};
		if (kind === "switch") h.api.on("session_before_switch", laterHandler);
		else h.api.on("session_before_fork", laterHandler);
		const replace = () => kind === "switch" ? h.replacement().newSession() : h.replacement().fork(h.manager.getLeafId()!);
		assert.deepEqual(await replace(), { cancelled: true });
		assert.equal(later, false, "an admitted preflight must veto before the later handler");
		await h.session.extensionRunner.emit({ type: "tool_execution_end", toolCallId: "writer" } as never);
		assert.deepEqual(await replace(), { cancelled: true });
		assert.equal(later, true);
		await h.session.reload();
		assert.equal(await h.call("after-cancel-reload", "delegate_task", { access: "write" }), undefined);
	});
});

test("native fork refuses partial journal paths but opens a complete path successfully", async (t) => {
	const h = await native(t, true);
	const root = h.manager.getLeafId()!;
	await h.call("writer", "delegate_task", { access: "write" });
	const release = h.hold();
	const middle = h.manager.appendMessage({ role: "user", content: "Fork before release", timestamp: Date.now() });
	release();
	assert.deepEqual(await h.replacement().fork(middle), { cancelled: true });
	const complete = h.manager.getLeafId()!;
	await h.session.navigateTree(root, { summarize: false });
	const released = h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent-direct-admission").at(-1) as any;
	h.api.appendEntry("subagent-direct-admission", released.data);
	assert.deepEqual(await h.replacement().fork(h.manager.getLeafId()!, { position: "at" }), { cancelled: true });
	assert.equal((await h.replacement(true).fork(complete, { position: "at" })).cancelled, false);
	await h.session.reload();
	assert.equal(await h.call("fork-edit"), undefined);
	assert.deepEqual(h.errors, []);
});

test("native all-entry inventory recovers a no-tab complete set from non-dispatch proof and persists release", async (t) => {
	const h = await native(t);
	const root = h.manager.getLeafId()!;
	const record = savedHold(h);
	h.api.appendEntry("subagent-direct-admission", record);
	await h.session.navigateTree(root, { summarize: false });
	await h.session.reload();
	assert.equal((await h.call("before"))?.block, true);
	const cancelled = await reviewRecovery(h, record.taskId, { confirm: async () => false });
	assert.ok(cancelled.dialogs.some((text) => record.checkouts.every((path) => text.includes(path))));
	assert.equal((await h.call("cancelled"))?.block, true);
	await reviewRecovery(h, record.taskId);
	await h.session.reload();
	assert.equal(await h.call("after"), undefined);
	(await checkoutAdmission(h.api).reserve("secondary", h.secondary))();
	assert.ok((await readFile(h.manager.getSessionFile()!, "utf8")).includes('"release":"proved"'));
});

test("native release failure, stale scope, and overlapping reservations keep the other protection", async (t) => {
	const h = await native(t);
	const root = h.manager.getLeafId()!;
	const first = savedHold(h), other = savedHold(h, "other");
	h.api.appendEntry("subagent-direct-admission", first);
	h.api.appendEntry("subagent-direct-admission", other);
	await h.session.reload();
	const path = h.manager.getSessionFile()!, backup = `${path}.saved`;
	await reviewRecovery(h, first.taskId, { confirm: async () => { await rename(path, backup); await mkdir(path); return true; } });
	await rm(path, { recursive: true }); await rename(backup, path);
	assert.equal((await h.call("failed-save"))?.block, true);
	await reviewRecovery(h, first.taskId, { confirm: async () => { await h.session.navigateTree(root, { summarize: false }); return true; } });
	assert.equal(h.manager.getEntries().filter((entry) => entry.type === "custom" && (entry.data as any)?.state === "released").length, 0);
	await reviewRecovery(h, first.taskId);
	await h.session.reload();
	assert.equal((await h.call("other-owner"))?.block, true);
	await assert.rejects(checkoutAdmission(h.api).reserve("secondary", h.secondary), /active writer/);
	await reviewRecovery(h, other.taskId);
	assert.equal(await h.call("both-released"), undefined);
});

test("native uncertain recovery requires typed human waiver and retains the warning after reload", async (t) => {
	const h = await native(t);
	const record = { ...savedHold(h), proof: "unproved", resources: [{ kind: "allocation-intent", name: "unknown" }] };
	h.api.appendEntry("subagent-direct-admission", record);
	h.manager.appendLabelChange(h.manager.getLeafId()!, "reviewed reservation");
	h.api.appendEntry("subagent-direct-tab", { taskId: record.taskId, name: "unknown allocation" });
	await h.session.reload();
	await reviewRecovery(h, record.taskId, { override: true, input: async () => "wrong-token" });
	assert.equal((await h.call("wrong-confirmation"))?.block, true);
	const report = await reviewRecovery(h, record.taskId, { override: true });
	assert.ok(report.reports.some((text) => text.includes("worker termination remains unproved")));
	await h.session.reload();
	assert.equal(await h.call("waived"), undefined);
	const after = await reviewRecovery(h, record.taskId);
	assert.ok(after.reports.some((text) => text.includes("protection released by user; termination unproved")));
	const saved = (h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent-direct-admission").at(-1) as any).data;
	assert.equal(saved.waiver.identity, `${record.sessionId}/${record.taskId}/${record.token}`);
	assert.deepEqual(JSON.parse(saved.waiver.evidence).admission, record);
	assert.ok((await readFile(h.manager.getSessionFile()!, "utf8")).includes('"waiver":'));
	assert.equal((await h.replacement(true).fork(h.manager.getLeafId()!, { position: "at" })).cancelled, false);
	await h.session.reload();
	assert.equal(await h.call("fork-waived"), undefined);
	assert.deepEqual(h.errors, []);
});

test("native failed release retains saved non-dispatch proof for recovery", async (t) => {
	const h = await native(t, true);
	await h.call("writer", "delegate_task", { access: "write" });
	const release = h.hold();
	const append = h.api.appendEntry;
	h.api.appendEntry = (type, data: any) => { if (type === "subagent-direct-admission" && data.state === "released") throw new Error("release failed"); append(type, data); };
	assert.throws(release, /release failed/);
	await h.session.reload();
	const record = h.journal.inventory(h.ctx).records[0]!;
	assert.equal(record.proof, "not-dispatched");
	const claim = h.journal.claim(record, h.ctx, () => true);
	claim.release("proved"); claim.close();
	await h.session.reload();
	assert.equal(await h.call("recovered"), undefined);
});

test("native old or incomplete resource evidence never gets proof release", async (t) => {
	for (const kind of ["old", "unrecorded-effect", "empty-stopped", "missing-lease-baseline"] as const) await t.test(kind, async (t) => {
		const h = await native(t, true);
		const record: any = savedHold(h);
		if (kind === "old") { delete record.proof; delete record.resources; }
		if (kind === "empty-stopped") record.proof = "stopped";
		if (kind === "missing-lease-baseline") { record.proof = "stopped"; record.resources = [{ kind: "allocation-intent", name: "worker" }]; }
		h.api.appendEntry("subagent-direct-admission", record);
		if (kind === "unrecorded-effect") h.api.appendEntry("subagent-direct-tab", { taskId: record.taskId, name: "unexpected" });
		await h.session.reload();
		const claim = h.journal.claim(h.journal.inventory(h.ctx).records[0]!, h.ctx, () => true);
		assert.throws(() => claim.release("proved"), /termination is unproved/);
		claim.close();
		assert.equal((await h.call("blocked"))?.block, true);
	});
});

test("native proof requires complete allocation, verified tab and original lease binding", async (t) => {
	for (const kind of ["valid", "incomplete", "intent-only", "missing-pane", "changed-pane", "changed-workspace", "changed-session", "changed-lease", "changed-baseline", "source-baseline"] as const) await t.test(kind, async (t) => {
		const h = await native(t, true);
		const held = savedHold(h);
		const baseline = { device: "1", inode: "2", birth: "3", parentDevice: "1", parentInode: "4", parentBirth: "5" };
		const tab: any = { taskId: held.taskId, entryId: "worker-entry", name: "worker", tabId: "tab", paneId: "pane", workspaceId: "workspace",
			cwd: h.root, sessionFile: `${h.root}/session.jsonl`, leasePath: `${h.root}/process.lease`, turn: "turn", leaseIdentity: baseline };
		const { tabId: _tab, paneId: _pane, taskId: _task, ...allocation } = tab;
		let resources: any[] = [{ kind: "allocation-intent", label: "worker", ...allocation }, { kind: "verified-tab", ...tab }];
		if (kind === "incomplete") { resources = [{ kind: "allocation-intent", leaseIdentity: baseline }]; for (const key of Object.keys(tab)) if (key !== "taskId") delete tab[key]; }
		if (kind === "intent-only") resources.pop();
		if (kind === "missing-pane") delete tab.paneId;
		for (const [scenario, field] of [["changed-pane", "paneId"], ["changed-workspace", "workspaceId"], ["changed-session", "sessionFile"], ["changed-lease", "leasePath"]]) {
			if (kind === scenario) tab[field!] += "-different";
		}
		if (kind === "changed-baseline") tab.leaseIdentity = { ...baseline, inode: "99" };
		if (kind === "source-baseline") {
			tab.taskId = "previous-read"; tab.access = "read";
			resources = [{ kind: "continuation-sources", sources: [{ ...tab, leaseIdentity: { ...baseline, inode: "99" } }] }];
		}
		h.api.appendEntry("subagent-direct-tab", tab);
		h.api.appendEntry("subagent-direct-admission", { ...held, proof: "stopped", resources });
		await h.session.reload();
		const record = h.journal.inventory(h.ctx).records[0]!;
		assert.equal(h.journal.hasProof(record, h.ctx), kind === "valid");
		const claim = h.journal.claim(record, h.ctx, () => true);
		if (kind === "valid") claim.release("proved");
		else {
			assert.throws(() => claim.release("proved"), /termination is unproved/);
			assert.equal((await h.call("blocked"))?.block, true);
			await assert.rejects(checkoutAdmission(h.api).reserve("secondary", h.secondary), /active writer/);
		}
		claim.close();
		if (kind === "valid") { await h.session.reload(); assert.equal(await h.call("released"), undefined); }
	});
});

test("native recovered release requires unchanged evidence and a single claim", async (t) => {
	const h = await native(t, true);
	await h.call("writer", "delegate_task", { access: "write" });
	h.hold();
	await h.session.reload();
	const record = h.journal.inventory(h.ctx).records[0]!;
	const claim = h.journal.claim(record, h.ctx, () => true);
	assert.throws(() => h.journal.claim(record, h.ctx, () => true), /already active/);
	h.api.appendEntry("subagent-direct-admission", { ...record, proof: "unproved", resources: [{ kind: "unknown" }] });
	assert.throws(() => claim.release("proved"), /evidence changed/);
	claim.close();
	const changed = h.journal.inventory(h.ctx).records[0]!;
	const retry = h.journal.claim(changed, h.ctx, () => true);
	assert.throws(() => retry.release("proved"), /termination is unproved/);
	assert.throws(() => retry.release("user-unproved"), /Exact typed reservation identity/);
	assert.throws(() => retry.release("user-unproved", "different-reservation"), /Exact typed reservation identity/);
	assert.equal((await h.call("unconfirmed"))?.block, true);
	retry.close();
});

const legacyTab = (cwd: string, taskId: string) => ({ taskId, entryId: `${taskId}:0`, name: taskId,
	tabId: `${taskId}:tab`, paneId: `${taskId}:pane`, sessionFile: `/test/${taskId}/session`, leasePath: `/test/${taskId}/lease`, cwd });

test("exact completed legacy read and write results do not blanket-block historical sessions", async (t) => {
	const h = await native(t);
	const branch = h.manager.getLeafId()!;
	for (const [taskId, status, outcome] of [["read", "succeeded", "completed"], ["write", "rejected", "failed"]]) {
		const tab = legacyTab(h.root, taskId!);
		h.api.appendEntry("subagent-direct-tab", tab);
		h.manager.appendCustomMessageEntry("subagent-direct-result", "synthetic completed result", false,
			{ taskId, outcome, tabs: [tab], entries: [{ id: tab.entryId, status }] });
	}
	await h.session.navigateTree(branch, { summarize: false });
	await h.session.reload();
	assert.equal(await h.call("edit"), undefined);
	assert.deepEqual(h.errors, []);
});

test("legacy partial, mismatched, recovered and allocation evidence has no invented release proof", async (t) => {
	for (const kind of ["mismatched", "recovery", "allocation", "missing"]) await t.test(kind, async (t) => {
		const h = await native(t);
		const tab = legacyTab(h.root, kind);
		h.api.appendEntry(kind === "allocation" ? "subagent-direct-allocation" : "subagent-direct-tab", tab);
		if (kind !== "missing") h.manager.appendCustomMessageEntry("subagent-direct-result", "synthetic result", false,
			{ taskId: kind, outcome: "completed", ...(kind === "recovery" ? { recovery: true } : {}),
				tabs: [{ ...tab, ...(kind === "mismatched" ? { paneId: "wrong-pane" } : {}) }], entries: [{ id: tab.entryId, status: "succeeded" }] });
		await h.session.reload();
		assert.match((await h.call("edit"))!.reason!, /access and full checkout set cannot be proved/);
		assert.equal(await h.call("read", "read"), undefined);
	});
});

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
	AgentSession, ExtensionRunner, InteractiveMode, SessionManager,
	type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import pullRequestExtension from "../extensions/pr.ts";
import { StaleCiCollect } from "../extensions/pr-ci.ts";
import { StaleSweepStart } from "../extensions/pr-comment-sweep.ts";

// Exercise native prompt expansion, boundary dispatch/projection, and editor queue restoration;
// no provider or GitHub requests are made.
for (const staleRoute of [undefined, "sweep", "fix-ci"] as const) test(staleRoute
	? `stale ${staleRoute} publication hands off a fresh live route before native settlement`
	: "publication continues through hidden native context, never editable user queues", async () => {
	const handlers = new Map<string, Function[]>();
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
	let busy = false;
	let published = false;
	let localAhead = false;
	let run = 0;
	const notifications: string[] = [];
	const dispatches: Promise<void>[] = [];
	const skills = ["pi-pr-publish-work", "pi-pr-comment-sweep", "pi-pr-fix-ci"].map((name) => {
		const filePath = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
		return { name, filePath, baseDir: dirname(filePath), sourceInfo: { origin: "package", path: filePath } };
	});
	const manager = SessionManager.inMemory("/repo");
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "/pr" }], timestamp: Date.now() });
	const ctx = {
		cwd: "/repo", hasUI: true, mode: "rpc", signal: new AbortController().signal,
		isIdle: () => !busy, sessionManager: manager,
		ui: { setWidget() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text },
			notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	const nativeQueue: unknown[] = [];
	const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
		extensions: [{ path: "/pi-pr", handlers }], createContext: () => ctx,
		getCommand: () => undefined,
		emitError(error: { error: string }) { throw new Error(error.error); },
	});
	const session = Object.assign(Object.create(AgentSession.prototype), {
		_cwd: "/repo", sessionManager: manager, _extensionRunner: runner,
		_isAgentRunActive: true, _lastActivityOutcome: "completed",
		_pendingCustomMessages: [], _eventListeners: [], _entryIdsByMessage: new WeakMap(),
		_steeringMessages: [], _followUpMessages: [],
		_resourceLoader: { getSkills: () => ({ skills }), getPrompts: () => ({ prompts: [] }) },
		agent: { state: { messages: [] }, followUp: (message: unknown) => nativeQueue.push(message),
			peekQueuedMessages: () => nativeQueue, hasQueuedMessages: () => nativeQueue.length > 0,
			clearAllQueues: () => { nativeQueue.length = 0; } },
	}) as Pick<AgentSession, "sendUserMessage" | "getFollowUpMessages" | "getSteeringMessages" | "clearQueue"> & {
		_runBeforeSettleBoundary(): Promise<boolean>;
	};
	pullRequestExtension({
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(_name: string, registered: typeof command) { command = registered; },
		registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) { tools.set(tool.name, tool); },
		getCommands: () => skills.map((skill) => ({ name: `skill:${skill.name}`, source: "skill", sourceInfo: skill.sourceInfo })),
		sendUserMessage(content: string, options: Parameters<ExtensionAPI["sendUserMessage"]>[1]) {
			if (busy) dispatches.push(session.sendUserMessage(content, options));
		},
		appendEntry() {},
		async exec() { throw new Error("Unexpected external command"); },
	} as unknown as ExtensionAPI, {
		async loadCurrentPullRequest() { return { kind: "current", pullRequest: {
			id: "PR_kwDOExample", approved: false, lifecycle: "open",
			url: new URL("https://github.com/acme/project/pull/42"), number: 42, host: "github.com",
			target: { provenance: "configured", repository: "acme/project", branch: "feature", remote: "origin", ref: "feature",
				host: "github.com", fetchSource: "git@github.com:acme/project.git", remoteOid: "b".repeat(40) },
			base: { repository: "acme/project", ref: "main", oid: "a".repeat(40) },
			head: { repository: "acme/project", ref: "feature", oid: "b".repeat(40) },
			headFetchSource: "git@github.com:acme/project.git",
			local: { worktree: published || staleRoute ? "clean" : "dirty", head: localAhead && !published ? "ahead" : "equal" },
			conditions: { draft: false, baseUpdateRequired: false, conflict: false, changesRequested: published || staleRoute === "sweep", unresolvedThreads: published || staleRoute === "sweep" ? 1 : 0,
				ci: !published && staleRoute === "fix-ci" ? "failure" : "success", review: "ready", policy: "ready" },
		} }; },
		async canonicalWorktree() { return "/repo"; },
		newRunId: () => `${String(++run).repeat(8)}-1111-4111-8111-111111111111`,
		inspectBranchRecovery: async () => false, inspectSweepRecovery: async () => false,
		createWorkPublisher: () => ({ async publish() { published = true; return { kind: "published" }; } }) as never,
		createCiFixer: () => ({ async collect() { throw new StaleCiCollect("Clean HEAD advanced before CI evidence"); } }) as never,
		createCommentSweep: () => ({
			async recoveryLaunchAction() { return "start"; },
			async start() {
				if (!published) throw new StaleSweepStart("Clean HEAD advanced before sweep recovery");
				return { phase: "triage" };
			},
		}) as never,
	});
	await runner.emit({ type: "session_start" });
	await new Promise((resolve) => setImmediate(resolve));
	try {
		await command.handler("", ctx as ExtensionCommandContext);
		if (staleRoute) {
			localAhead = true;
			const cancelled = await tools.get(staleRoute === "fix-ci" ? "pi_pr_fix_ci" : "pi_pr_sweep")!.execute("cancelled-start", {
				runId: "11111111-1111-4111-8111-111111111111", action: staleRoute === "fix-ci" ? "collect" : "start",
			}, ctx.signal, undefined, ctx as never);
			assert.deepEqual(cancelled.details, { kind: "stale", reason: staleRoute === "fix-ci" ? "Clean HEAD advanced before CI evidence" : "Clean HEAD advanced before sweep recovery" });
			busy = true;
			assert.equal(await session._runBeforeSettleBoundary(), true, "safe cancellation must not expire at final settlement");
			assert.match(String((manager.getBranch().at(-1) as { content: unknown }).content), /pi-pr-publish-work/);
		}
		await tools.get("pi_pr_publish_work")!.execute("publish", {
			runId: staleRoute ? "22222222-1111-4111-8111-111111111111" : "11111111-1111-4111-8111-111111111111", action: "publish",
		}, ctx.signal, undefined, ctx as never);
		busy = true;
		manager.appendMessage({
			role: "assistant", content: [{ type: "text", text: "Published." }], stopReason: "stop",
			api: "openai-responses", provider: "openai", model: "probe", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		assert.equal(await session._runBeforeSettleBoundary(), true);
		await Promise.all(dispatches);
		assert.equal(session.getFollowUpMessages().length, 0, "expanded internal skill must not appear in editable follow-up queue");
		assert.deepEqual(session.getSteeringMessages(), []);
		const pendingUI: unknown[] = [];
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session }, compactionQueuedMessages: [],
			pendingMessagesContainer: { clear: () => { pendingUI.length = 0; }, addChild: (child: unknown) => pendingUI.push(child) },
		});
		mode.updatePendingMessagesDisplay();
		assert.deepEqual(pendingUI, [], "native TUI must not show workflow instructions or the dequeue/edit hint");
		assert.deepEqual(mode.clearAllQueues(), { steering: [], followUp: [] }, "abort must not restore an internal skill to the editor");
		const entry = manager.getBranch().at(-1)!;
		assert.equal(entry.type, "custom_message");
		if (entry.type !== "custom_message") throw new Error("Missing hidden workflow entry");
		assert.equal(entry.display, false);
		assert.match(String(entry.content), /<skill name="pi-pr-comment-sweep"/);
		const sweepRunId = staleRoute ? "33333333-1111-4111-8111-111111111111" : "22222222-1111-4111-8111-111111111111";
		assert.ok(String(entry.content).includes(`runId=${sweepRunId} action=start`));
		assert.match(String(entry.content), /pi_pr_sweep/);
		if (staleRoute) {
			await assert.rejects(tools.get(staleRoute === "fix-ci" ? "pi_pr_fix_ci" : "pi_pr_sweep")!.execute("expired-start", {
				runId: "11111111-1111-4111-8111-111111111111", action: staleRoute === "fix-ci" ? "collect" : "start",
			}, ctx.signal, undefined, ctx as never), /wrong or stale/);
			const resumed = await tools.get("pi_pr_sweep")!.execute("fresh-start", {
				runId: sweepRunId, action: "start",
			}, ctx.signal, undefined, ctx as never);
			assert.deepEqual(resumed.details, { phase: "triage" }, "new sweep authority must remain live through publication handoff");
		}
		// Native boundary continuation does not emit before_agent_start. An unused launch
		// must still be consumed and cleaned at final settlement, not stranded forever.
		assert.equal(await session._runBeforeSettleBoundary(), false);
		busy = false;
		await runner.emit({ type: "agent_settled" });
		await assert.rejects(tools.get("pi_pr_sweep")!.execute("unused", {
			runId: sweepRunId, action: "start",
		}, ctx.signal, undefined, ctx as never), /No PR workflow is active/);
		if (staleRoute) assert.match(notifications[0]!, /PR (sweep|fix-ci) cancelled:.*rediscovering \(1\/2\)/);
		else assert.deepEqual(notifications, []);
	} finally { await runner.emit({ type: "session_shutdown" }); }
});

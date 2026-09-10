import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import type { PrCommandHandler } from "../extensions/pr-command.ts";
import {
	pullRequestObservation,
	type CurrentPullRequest,
	type CurrentPullRequestDiscovery,
	type PullRequestLoadContext,
} from "../extensions/pr-github.ts";
import pullRequestExtension from "../extensions/pr.ts";

type Loader = (
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	inspectedLocal?: unknown,
	observation?: unknown,
) => Promise<CurrentPullRequest | CurrentPullRequestDiscovery | null>;
type EventHandler = (event: unknown, context: ExtensionContext) => Promise<void> | void;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type ExtensionDependencies = NonNullable<Parameters<typeof pullRequestExtension>[1]>;
type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
};
type Exec = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult> | ExecResult;

const plain = (text: string) => text.replace(/\x1b\]8;;.*?\x1b\\/g, "");
const widgetLine = (text: string): string[] => [text];
const routeRunId = "11111111-1111-4111-8111-111111111111";
const routingWidgetLine = widgetLine("⠋ Checking pull request…");
const inheritedHerdrEnvironment = {
	HERDR_ENV: process.env.HERDR_ENV,
	HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
};

before(() => {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
});

after(() => {
	for (const [key, value] of Object.entries(inheritedHerdrEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function currentPullRequest(overrides: {
	conditions?: Partial<CurrentPullRequest["conditions"]>;
	lifecycle?: CurrentPullRequest["lifecycle"];
	approved?: boolean;
	provenance?: CurrentPullRequest["target"]["provenance"];
} = {}): CurrentPullRequest {
	return {
		id: "PR_kwDOExample",
		number: 42,
		url: new URL("https://github.com/acme/project/pull/42"),
		host: "github.com",
		approved: overrides.approved ?? false,
		lifecycle: overrides.lifecycle ?? "open",
		conditions: {
			draft: false,
			baseUpdateRequired: false,
			conflict: false,
			changesRequested: false,
			unresolvedThreads: 0,
			ci: "none",
			review: "ready",
			policy: "ready",
			...overrides.conditions,
		},
		local: { worktree: "clean", head: "equal" },
		base: { repository: "acme/project", ref: "main", oid: "a".repeat(40) },
		head: { repository: "acme/project", ref: "feature/pr", oid: "b".repeat(40) },
		headFetchSource: "git@github.com:acme/project.git",
		target: {
			provenance: overrides.provenance ?? "configured",
			branch: "feature/pr",
			remote: "origin",
			ref: "feature/pr",
			repository: "acme/project",
			host: "github.com",
			fetchSource: "git@github.com:acme/project.git",
			remoteOid: "b".repeat(40),
		},
		merge: { allowedMergeMethods: ["squash"], viewerDefaultMergeMethod: "squash" },
	};
}

function noPullRequest(ahead = 0): CurrentPullRequestDiscovery {
	return {
		kind: "none",
		creationTarget: {
			provenance: "inferred",
			branch: "feature/pr",
			remote: "origin",
			ref: "feature/pr",
			repository: "acme/project",
			host: "github.com",
			fetchSource: "git@github.com:acme/project.git",
			remoteOid: null,
		},
		branch: { ahead },
	};
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function execResult(stdout = "", code = 0, stderr = "", killed = false): ExecResult {
	return { stdout, stderr, code, killed };
}

async function withHerdrEnvironment(
	herdrEnv: string | undefined,
	workspaceId: string | undefined,
	run: () => Promise<void>,
): Promise<void> {
	const previous = {
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
	};
	if (herdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = herdrEnv;
	if (workspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
	else process.env.HERDR_WORKSPACE_ID = workspaceId;
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function harness(options: {
	load: Loader;
	commandHandler?: PrCommandHandler;
	useDefaultCommandHandler?: boolean;
	theme?: (color: string, text: string) => string;
	exec?: Exec;
	sessionEntries?: unknown[];
	canonicalWorktree?: ExtensionDependencies["canonicalWorktree"];
	newRunId?: ExtensionDependencies["newRunId"];
	createBranchUpdater?: ExtensionDependencies["createBranchUpdater"];
	createPullRequestCreator?: ExtensionDependencies["createPullRequestCreator"];
	createCommentSweep?: ExtensionDependencies["createCommentSweep"];
	createCiFixer?: ExtensionDependencies["createCiFixer"];
	isIdle?: () => boolean;
}) {
	let beforeAgentStart: EventHandler | undefined;
	let sessionStart: EventHandler | undefined;
	let sessionShutdown: EventHandler | undefined;
	let agentSettled: EventHandler | undefined;
	let toolResult: EventHandler | undefined;
	let command: Command | undefined;
	const tools: Tool[] = [];
	const messages: string[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: unknown[] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const execCalls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const ui = {
		setStatus(_key: string, value: string | undefined) { statuses.push(value); },
		setWidget(_key: string, value: unknown) { widgets.push(value); },
		notify(message: string, type?: string) { notifications.push({ message, type }); },
		theme: {
			fg(color: string, text: string) { return options.theme?.(color, text) ?? text; },
		},
	};

	const extensionDependencies: ExtensionDependencies = {
		loadCurrentPullRequest: async (pi, context, inspectedLocal, observation) => {
			const loaded = await options.load(pi, context, inspectedLocal, observation);
			if (loaded && "kind" in loaded) return loaded;
			if (loaded) return { kind: "current", pullRequest: loaded };
			return noPullRequest();
		},
		canonicalWorktree: options.canonicalWorktree,
		newRunId: options.newRunId,
		createBranchUpdater: options.createBranchUpdater,
		createPullRequestCreator: options.createPullRequestCreator,
		createCommentSweep: options.createCommentSweep,
		createCiFixer: options.createCiFixer,
	};
	if (!options.useDefaultCommandHandler) {
		extensionDependencies.createPrCommandHandler = () => options.commandHandler ?? (async () => "none");
	}

	pullRequestExtension({
		on(event: string, handler: unknown) {
			if (event === "before_agent_start") beforeAgentStart = handler as EventHandler;
			if (event === "session_start") sessionStart = handler as EventHandler;
			if (event === "session_shutdown") sessionShutdown = handler as EventHandler;
			if (event === "agent_settled") agentSettled = handler as EventHandler;
			if (event === "tool_result") toolResult = handler as EventHandler;
		},
		registerCommand(name: string, registered: Command) {
			if (name === "pr") command = registered;
		},
		registerTool(tool: Tool) {
			tools.push(tool);
		},
		getCommands() {
			return [
				"skill:pi-pr-create",
				"skill:pi-pr-update-branch",
				"skill:pi-pr-comment-sweep",
				"skill:pi-pr-fix-ci",
			].map((name) => ({ name, source: "skill", sourceInfo: { origin: "package" } }));
		},
		sendUserMessage(content: string) {
			messages.push(content);
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
		async exec(command: string, args: string[], execOptions?: ExecOptions) {
			execCalls.push({ command, args: [...args], options: execOptions });
			if (!options.exec) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
			return options.exec(command, args, execOptions);
		},
	} as unknown as ExtensionAPI, extensionDependencies);

	const handler = <T>(value: T | undefined, name: string): T => {
		if (value === undefined) throw new Error(`Missing ${name} handler`);
		return value;
	};
	const context = (
		mode: "tui" | "rpc" = "rpc",
		sessionEntries: unknown[] = options.sessionEntries ?? [],
	): ExtensionContext => ({
		hasUI: true,
		mode,
		cwd: "/repo",
		signal: new AbortController().signal,
		isIdle: options.isIdle ?? (() => true),
		sessionManager: { getBranch: () => sessionEntries },
		ui,
	} as unknown as ExtensionContext);
	const callbackContext = (ctx: ExtensionContext): ExtensionContext => ({ ...ctx });

	return {
		tools,
		messages,
		statuses,
		widgets,
		notifications,
		execCalls,
		appended,
		context,
		async start(ctx: ExtensionContext): Promise<void> {
			await handler(sessionStart, "session_start")({} as never, callbackContext(ctx));
		},
		async shutdown(ctx: ExtensionContext): Promise<void> {
			await handler(sessionShutdown, "session_shutdown")({} as never, callbackContext(ctx));
		},
		async beforeStart(prompt: string, ctx: ExtensionContext): Promise<void> {
			await handler(beforeAgentStart, "before_agent_start")({ prompt } as never, callbackContext(ctx));
		},
		async settle(ctx: ExtensionContext): Promise<void> {
			await handler(agentSettled, "agent_settled")({} as never, callbackContext(ctx));
		},
		async tool(event: unknown, ctx: ExtensionContext): Promise<void> {
			await handler(toolResult, "tool_result")(event, callbackContext(ctx));
		},
		async callTool(
			name: string,
			params: unknown,
			ctx: ExtensionContext,
			signal = new AbortController().signal,
		) {
			const registered = tools.find((tool) => tool.name === name);
			if (!registered) throw new Error(`Missing ${name} tool`);
			return await registered.execute(
				"tool-call",
				params as never,
				signal,
				undefined,
				callbackContext(ctx),
			);
		},
		command(): Command {
			const registered = handler(command, "pr command");
			return {
				...registered,
				handler: (args, ctx) => registered.handler(args, callbackContext(ctx) as ExtensionCommandContext),
			};
		},
	};
}

test("registers exactly four sequential tools with closed action schemas", () => {
	const app = harness({ async load() { return { kind: "inactive" }; } });
	const expected = new Map([
		["pi_pr_update_branch", ["merge", "continue", "publish"]],
		["pi_pr_create", ["prepare", "merge", "continue", "push", "publish"]],
		["pi_pr_sweep", ["start", "resume", "show", "record", "publish", "refresh", "resolve", "finalize"]],
		["pi_pr_fix_ci", ["collect", "publish"]],
	]);

	assert.deepEqual(app.tools.map(({ name }) => name), [...expected.keys()]);
	for (const tool of app.tools) {
		assert.equal(tool.executionMode, "sequential", tool.name);
		const alternatives = (tool.parameters as unknown as {
			anyOf: Array<{ additionalProperties?: boolean; properties: { action: { const: string } }; required?: string[] }>;
		}).anyOf;
		assert.deepEqual(alternatives.map(({ properties }) => properties.action.const), expected.get(tool.name), tool.name);
		assert.ok(alternatives.every(({ additionalProperties }) => additionalProperties === false), tool.name);
	}
	const sweepAlternatives = (app.tools.find(({ name }) => name === "pi_pr_sweep")!.parameters as unknown as {
		anyOf: Array<{ properties: Record<string, unknown> & { action: { const: string } }; required?: string[] }>;
	}).anyOf;
	const record = sweepAlternatives.find(({ properties }) => properties.action.const === "record")!;
	const refresh = sweepAlternatives.find(({ properties }) => properties.action.const === "refresh")!;
	assert.ok(!record.required?.includes("ownedPaths"));
	assert.deepEqual(Object.keys(refresh.properties).sort(), ["action", "guard", "runId"]);
});

test("binds one update run to its session, worktree, route, and fresh authority", async () => {
	const authority = currentPullRequest({ conditions: { conflict: true } });
	const calls: string[] = [];
	const state = {
		phase: "ready",
		attempts: { fetchBase: "none", merge: "none", stage: "none", continueMerge: "none", push: "none" },
	};
	const app = harness({
		async load() { return authority; },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree(cwd) { return cwd === "/repo" ? "/canonical/repo" : "/canonical/other"; },
		createBranchUpdater(options) {
			assert.equal(options.cwd, "/canonical/repo");
			assert.equal(options.authority, authority);
			return {
				state,
				async merge() { calls.push("merge"); state.phase = "verified"; return { kind: "verified", head: authority.head.oid, fastForward: false }; },
				async continue() { calls.push("continue"); return { kind: "verified", head: authority.head.oid, fastForward: false }; },
				async publish() { calls.push("publish"); return { kind: "published", head: authority.head.oid }; },
			} as never;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.messages, [`/skill:pi-pr-update-branch runId=${routeRunId} action=merge`]);

		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: "22222222-2222-4222-8222-222222222222", action: "merge" }, ctx),
			/wrong or stale/,
		);
		await assert.rejects(
			app.callTool("pi_pr_create", { runId: routeRunId, action: "prepare" }, ctx),
			/route is update-branch, not create/,
		);
		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "merge" }, { ...ctx, cwd: "/other" }),
			/worktree is wrong or stale/,
		);
		await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "merge" }, ctx);
		await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "publish" }, ctx);
		assert.deepEqual(calls, ["merge", "publish"]);

		await assert.rejects(app.command().handler("", ctx as ExtensionCommandContext), /still active/);
		await app.settle(ctx);
		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "publish" }, ctx),
			/No PR workflow is active/,
		);
	} finally {
		await app.shutdown(ctx);
	}
});

test("rejects session replacement while workflow discovery is pending", async () => {
	const authority = currentPullRequest({ conditions: { conflict: true } });
	const staleDiscovery = deferred<CurrentPullRequest>();
	let loads = 0;
	let canonicalCalls = 0;
	const app = harness({
		async load() {
			loads += 1;
			if (loads === 1) return authority;
			if (loads === 2) return staleDiscovery.promise;
			return { kind: "inactive" };
		},
		useDefaultCommandHandler: true,
		async canonicalWorktree() { canonicalCalls += 1; return "/canonical/repo"; },
	});
	const first = app.context();
	const replacement = app.context();

	try {
		await app.start(first);
		const staleCommand = app.command().handler("", first as ExtensionCommandContext);
		await flush();
		await app.start(replacement);
		staleDiscovery.resolve(authority);

		await assert.rejects(staleCommand, /session changed during dispatch/);
		assert.equal(canonicalCalls, 0);
		assert.deepEqual(app.messages, []);
		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "merge" }, replacement),
			/No PR workflow is active/,
		);
	} finally {
		await app.shutdown(replacement);
	}
});

test("rejects session replacement while canonical workflow authority is pending", async () => {
	const authority = currentPullRequest({ conditions: { conflict: true } });
	const canonical = deferred<string>();
	let reservations = 0;
	const app = harness({
		async load() { return authority; },
		useDefaultCommandHandler: true,
		async canonicalWorktree() { return canonical.promise; },
		createBranchUpdater() { reservations += 1; return {} as never; },
	});
	const first = app.context();
	const replacement = app.context();

	try {
		await app.start(first);
		const staleCommand = app.command().handler("", first as ExtensionCommandContext);
		await flush();
		await app.start(replacement);
		canonical.resolve("/canonical/repo");

		await assert.rejects(staleCommand, /session changed during dispatch/);
		assert.equal(reservations, 0);
		assert.deepEqual(app.messages, []);
		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "merge" }, replacement),
			/No PR workflow is active/,
		);
	} finally {
		await app.shutdown(replacement);
	}
});

test("releases a stale reservation when replacement wins before dispatch resumes", async () => {
	const authority = currentPullRequest({ conditions: { conflict: true } });
	let app!: ReturnType<typeof harness>;
	let replacement!: ExtensionContext;
	let replacementStart: Promise<void> | undefined;
	let reservations = 0;
	app = harness({
		async load() { return authority; },
		useDefaultCommandHandler: true,
		async canonicalWorktree() { return "/canonical/repo"; },
		newRunId() {
			replacementStart = app.start(replacement);
			return routeRunId;
		},
		createBranchUpdater() { reservations += 1; return {} as never; },
	});
	const first = app.context();
	replacement = app.context();

	try {
		await app.start(first);
		await assert.rejects(
			app.command().handler("", first as ExtensionCommandContext),
			/session changed during dispatch/,
		);
		await replacementStart;
		assert.equal(reservations, 1);
		assert.deepEqual(app.messages, []);
		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "merge" }, replacement),
			/No PR workflow is active/,
		);
	} finally {
		await app.shutdown(replacement);
	}
});

test("session replacement aborts an in-flight workflow helper", async () => {
	const authority = currentPullRequest({ conditions: { conflict: true } });
	const actionStarted = deferred<void>();
	let helperSignal: AbortSignal | undefined;
	const state = {
		phase: "ready",
		attempts: { fetchBase: "none", merge: "none", stage: "none", continueMerge: "none", push: "none" },
	};
	const app = harness({
		async load() { return authority; },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createBranchUpdater(options) {
			const signal = options.signal;
			assert.ok(signal);
			helperSignal = signal;
			return {
				state,
				async merge() {
					actionStarted.resolve();
					return await waitForAbort(signal);
				},
			} as never;
		},
	});
	const first = app.context();
	const replacement = app.context();

	try {
		await app.start(first);
		await app.command().handler("", first as ExtensionCommandContext);
		const action = app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "merge" }, first);
		const cancelled = assert.rejects(action, (error) => {
			assert.equal(error, helperSignal?.reason);
			return true;
		});
		await actionStarted.promise;
		await app.start(replacement);
		await cancelled;
		assert.equal(helperSignal?.aborted, true);
	} finally {
		await app.shutdown(replacement);
	}
});

test("tool cancellation reaches only its active workflow action", async () => {
	const authority = currentPullRequest({ conditions: { conflict: true } });
	const publishStarted = deferred<void>();
	let helperSignal: AbortSignal | undefined;
	const state = {
		phase: "ready",
		attempts: { fetchBase: "none", merge: "none", stage: "none", continueMerge: "none", push: "none" },
	};
	const app = harness({
		async load() { return authority; },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createBranchUpdater(options) {
			const signal = options.signal;
			assert.ok(signal);
			helperSignal = signal;
			return {
				state,
				async merge() {
					return { kind: "verified", head: authority.head.oid, fastForward: false };
				},
				async publish() {
					publishStarted.resolve();
					return await waitForAbort(signal);
				},
			} as never;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		const completedAction = new AbortController();
		await app.callTool(
			"pi_pr_update_branch",
			{ runId: routeRunId, action: "merge" },
			ctx,
			completedAction.signal,
		);
		completedAction.abort();
		assert.equal(helperSignal?.aborted, false, "a completed tool must no longer abort its run");

		const activeAction = new AbortController();
		const reason = new Error("tool cancelled");
		const action = app.callTool(
			"pi_pr_update_branch",
			{ runId: routeRunId, action: "publish" },
			ctx,
			activeAction.signal,
		);
		const cancelled = assert.rejects(action, (error) => {
			assert.equal(error, reason);
			return true;
		});
		await publishStarted.promise;
		activeAction.abort(reason);
		await cancelled;
		assert.equal(helperSignal?.reason, reason);
	} finally {
		await app.shutdown(ctx);
	}
});

test("keeps a queued follow-up until its exact prompt starts, then clears an unused run", async () => {
	const authority = currentPullRequest({ conditions: { ci: "failure" } });
	let idle = false;
	let loads = 0;
	const calls: string[] = [];
	const app = harness({
		async load() { loads += 1; return authority; },
		useDefaultCommandHandler: true,
		isIdle: () => idle,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createCiFixer() {
			return {
				async collect() { calls.push("collect"); return { fingerprint: "f".repeat(64), failures: [] }; },
				async publish() { return { kind: "published", head: authority.head.oid, attempt: "applied" }; },
			} as never;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		idle = true;
		await app.settle(ctx);
		for (const prompt of [
			`<skill name="pi-pr-fix-ci" location="/skills/fix-ci/SKILL.md">\n\nunrelated runId=prefix-${routeRunId}-suffix action=collect`,
			`<skill name="pi-pr-comment-sweep" location="/skills/sweep/SKILL.md">\n\nrunId=${routeRunId} action=collect`,
			`<skill name="pi-pr-fix-ci" location="/skills/fix-ci/SKILL.md">\n\nrunId=${routeRunId} action=publish`,
		]) {
			await app.beforeStart(prompt, ctx);
			await app.settle(ctx);
		}
		assert.equal(loads, 2, "a substring or wrong helper identity must not finish the queued workflow");

		await app.beforeStart(`<skill name="pi-pr-fix-ci" location="/skills/fix-ci/SKILL.md">\n\nrunId=${routeRunId} action=collect`, ctx);
		await app.settle(ctx);
		assert.equal(loads, 3);
		assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));
		assert.deepEqual(calls, []);
		await assert.rejects(
			app.callTool("pi_pr_fix_ci", { runId: routeRunId, action: "collect" }, ctx),
			/No PR workflow is active/,
		);
	} finally {
		await app.shutdown(ctx);
	}
});

test("keeps an exact conflict context for continuation, then clears it on settlement", async () => {
	const authority = currentPullRequest({ conditions: { conflict: true } });
	const calls: string[] = [];
	const state = {
		phase: "ready",
		attempts: { fetchBase: "none", merge: "none", stage: "none", continueMerge: "none", push: "none" },
	};
	const app = harness({
		async load() { return authority; },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createBranchUpdater() {
			return {
				state,
				async merge() {
					calls.push("merge");
					state.phase = "conflict-awaiting-user";
					return { kind: "conflict", paths: ["conflicted.ts"] };
				},
				async continue(paths: string[]) {
					calls.push(`continue:${paths.join(",")}`);
					state.phase = "verified";
					return { kind: "verified", head: authority.head.oid, fastForward: false };
				},
				async publish() { calls.push("publish"); return { kind: "published", head: authority.head.oid }; },
			} as never;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "merge" }, ctx);
		await app.settle(ctx);
		await app.callTool("pi_pr_update_branch", {
			runId: routeRunId,
			action: "continue",
			resolvedPaths: ["conflicted.ts"],
		}, ctx);
		await app.settle(ctx);
		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "publish" }, ctx),
			/No PR workflow is active/,
		);
		assert.deepEqual(calls, ["merge", "continue:conflicted.ts"]);
		assert.equal(state.phase, "verified");
	} finally {
		await app.shutdown(ctx);
	}
});

test("clears a conflict run after one user turn without a valid continuation", async () => {
	const authority = currentPullRequest({ conditions: { conflict: true } });
	const state = {
		phase: "ready",
		attempts: { fetchBase: "none", merge: "none", stage: "none", continueMerge: "none", push: "none" },
	};
	const app = harness({
		async load() { return authority; },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createBranchUpdater() {
			return {
				state,
				async merge() {
					state.phase = "conflict-awaiting-user";
					return { kind: "conflict", paths: ["conflicted.ts"] };
				},
			} as never;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "merge" }, ctx);
		await app.settle(ctx);
		await app.settle(ctx);

		await assert.rejects(
			app.callTool("pi_pr_update_branch", {
				runId: routeRunId,
				action: "continue",
				resolvedPaths: ["conflicted.ts"],
			}, ctx),
			/No PR workflow is active/,
		);
	} finally {
		await app.shutdown(ctx);
	}
});

test("routes create, sweep, and CI tool actions directly to their bound helpers", async () => {
	const createCalls: unknown[][] = [];
	const creatorState = {
		phase: "unprepared",
		attempts: {
			fetchBase: "none", merge: "none", stage: "none", continueMerge: "none", push: "none",
			fetchTracking: "none", setUpstream: "none", pullRequest: "none",
		},
	};
	const create = harness({
		async load() { return noPullRequest(1); },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createPullRequestCreator() {
			return {
				state: creatorState,
				async prepare(base?: string) { createCalls.push(["prepare", base]); creatorState.phase = "prepared"; return { kind: "prepared" }; },
				async merge() { createCalls.push(["merge"]); return { kind: "verified" }; },
				async continue(paths: string[]) { createCalls.push(["continue", paths]); return { kind: "verified" }; },
				async push() { createCalls.push(["push"]); return { kind: "pushed" }; },
				async publish(title: string, body: string) { createCalls.push(["publish", title, body]); return { kind: "published", url: "https://github.com/acme/project/pull/42" }; },
			} as never;
		},
	});
	const createContext = create.context();
	try {
		await create.start(createContext);
		await create.command().handler("--base=github.com/acme/project:main", createContext as ExtensionCommandContext);
		await create.callTool("pi_pr_create", { runId: routeRunId, action: "prepare" }, createContext);
		assert.deepEqual(createCalls, [["prepare", "github.com/acme/project:main"]]);
		assert.deepEqual(create.messages, [`/skill:pi-pr-create runId=${routeRunId} action=prepare`]);
	} finally {
		await create.shutdown(createContext);
	}

	const sweepCalls: string[] = [];
	const sweep = harness({
		async load() { return currentPullRequest({ conditions: { unresolvedThreads: 1 } }); },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createCommentSweep() {
			return {
				async start() { sweepCalls.push("start"); return { phase: "triage" }; },
			} as never;
		},
	});
	const sweepContext = sweep.context();
	try {
		await sweep.start(sweepContext);
		await sweep.command().handler("", sweepContext as ExtensionCommandContext);
		await sweep.callTool("pi_pr_sweep", { runId: routeRunId, action: "start" }, sweepContext);
		assert.deepEqual(sweepCalls, ["start"]);
	} finally {
		await sweep.shutdown(sweepContext);
	}

	const ciCalls: string[] = [];
	const ci = harness({
		async load() { return currentPullRequest({ conditions: { ci: "failure" } }); },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createCiFixer() {
			return {
				async collect() { ciCalls.push("collect"); return { fingerprint: "f".repeat(64), failures: [] }; },
				async publish() { ciCalls.push("publish"); return { kind: "published", head: "b".repeat(40), attempt: "applied" }; },
			} as never;
		},
	});
	const ciContext = ci.context();
	try {
		await ci.start(ciContext);
		await ci.command().handler("", ciContext as ExtensionCommandContext);
		await ci.callTool("pi_pr_fix_ci", { runId: routeRunId, action: "collect" }, ciContext);
		await ci.callTool("pi_pr_fix_ci", { runId: routeRunId, action: "publish" }, ciContext);
		assert.deepEqual(ciCalls, ["collect", "publish"]);
	} finally {
		await ci.shutdown(ciContext);
	}
});

test("stays silent and does not poll outside a Git worktree", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			return { kind: "inactive" };
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	assert.deepEqual(app.statuses, [undefined]);
	assert.deepEqual(app.widgets, [undefined]);
	assert.deepEqual(app.notifications, []);
	t.mock.timers.tick(60_000);
	await flush();
	assert.equal(loads, 1);

	await app.shutdown(ctx);
});

test("records one configured PR observation without polling duplicates", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const pullRequest = currentPullRequest();
	const expected = pullRequestObservation(pullRequest);
	assert.ok(expected);
	const app = harness({ async load() { return pullRequest; } });
	const ctx = app.context();

	await app.start(ctx);
	assert.deepEqual(app.appended, [{ customType: "pi-pr-observation", data: expected }]);

	t.mock.timers.tick(60_000);
	await flush();
	assert.equal(app.appended.length, 1);
	await app.shutdown(ctx);
});

test("restores the newest valid observation and resets it on session replacement", async () => {
	const older = pullRequestObservation(currentPullRequest());
	assert.ok(older);
	const latest = {
		...older,
		pullRequest: {
			...older.pullRequest,
			number: 43,
			url: "https://github.com/acme/project/pull/43",
		},
	};
	const seen: unknown[] = [];
	const app = harness({
		async load(_pi, _context, _inspectedLocal, observation) {
			seen.push(observation);
			return { kind: "inactive" };
		},
	});
	const first = app.context("rpc", [
		{ type: "custom", customType: "pi-pr-observation", data: older },
		{ type: "custom", customType: "pi-pr-observation", data: { pullRequest: "malformed" } },
		{ type: "custom", customType: "pi-pr-observation", data: latest },
		{ type: "custom", customType: "pi-pr-observation", data: null },
	]);
	const replacement = app.context("rpc", []);

	await app.start(first);
	await app.start(replacement);
	assert.deepEqual(seen, [latest, undefined]);
	await app.shutdown(replacement);
});

test("does not persist a stale observation after session replacement", async () => {
	const stale = deferred<CurrentPullRequest>();
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			return loads === 1 ? stale.promise : { kind: "inactive" };
		},
	});
	const first = app.context();
	const replacement = app.context();

	const staleStart = app.start(first);
	await flush();
	await app.start(replacement);
	stale.resolve(currentPullRequest());
	await staleStart;
	assert.deepEqual(app.appended, []);
	await app.shutdown(replacement);
});

test("stops polling when an active worktree becomes inactive", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const results: Array<CurrentPullRequest | CurrentPullRequestDiscovery> = [
		currentPullRequest(),
		{ kind: "inactive" },
	];
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			const result = results.shift();
			if (!result) throw new Error("Unexpected pull request refresh");
			return result;
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	t.mock.timers.tick(30_000);
	await flush();
	assert.deepEqual(app.statuses.at(-1), undefined);
	t.mock.timers.tick(60_000);
	await flush();
	assert.equal(loads, 2);

	await app.shutdown(ctx);
});

test("refreshes a configured PR after successful delegated work settles", async () => {
	const results = [
		currentPullRequest(),
		currentPullRequest({ conditions: { ci: "failure" } }),
	];
	const app = harness({
		async load() {
			const result = results.shift();
			if (!result) throw new Error("Unexpected pull request refresh");
			return result;
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	await app.tool({ toolName: "delegate_task", isError: false, input: {} }, ctx);
	await app.settle(ctx);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");

	await app.shutdown(ctx);
});

test("warns once for one blocked issue and warns again after recovery", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const blocked: CurrentPullRequestDiscovery = {
		kind: "blocked",
		issue: {
			kind: "candidate-prs-ambiguous",
			urls: [
				new URL("https://github.com/acme/project/pull/43"),
				new URL("https://github.com/acme/project/pull/42"),
			],
		},
	};
	const results: Array<CurrentPullRequestDiscovery | CurrentPullRequest> = [
		blocked,
		blocked,
		currentPullRequest(),
		blocked,
	];
	const app = harness({
		async load() {
			const result = results.shift();
			if (!result) throw new Error("Unexpected pull request refresh");
			return result;
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(app.notifications.length, 1);
	assert.equal(app.notifications[0]?.type, "warning");
	assert.match(app.notifications[0]?.message ?? "", /pull\/42, https:\/\/github\.com\/acme\/project\/pull\/43/);

	t.mock.timers.tick(30_000);
	await flush();
	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(app.notifications.length, 2);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR · target ambiguous");

	await app.shutdown(ctx);
});

test("renders the shared projection and refreshes after successful create or push", async () => {
	const results: Array<CurrentPullRequest | CurrentPullRequestDiscovery> = [
		currentPullRequest({ conditions: { ci: "failure" } }),
		currentPullRequest({ conditions: { ci: "running" } }),
		noPullRequest(1),
	];
	const signals: Array<AbortSignal | undefined> = [];
	const app = harness({
		async load(_pi, context) {
			signals.push(context.signal);
			const result = results.shift();
			if (result === undefined) throw new Error("Unexpected pull request refresh");
			return result;
		},
	});
	const noUi = { hasUI: false, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
	const ctx = app.context();

	await app.start(noUi);
	await app.tool({ toolName: "bash", input: { command: "gh pr create --fill" }, isError: false }, noUi);
	assert.equal(signals.length, 0);

	await app.start(ctx);
	assert.equal(signals.length, 1);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");
	assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));

	await app.tool({
		toolName: "bash",
		input: { command: "git status && gh pr create --fill" },
		isError: false,
	}, ctx);
	assert.equal(signals.length, 2);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI running");
	assert.equal(app.widgets.at(-1), undefined);

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(signals.length, 3);
	assert.equal(app.statuses.at(-1), undefined);
	assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));

	await app.shutdown(ctx);
});

test("failed CI replaces review feedback in the footer on refresh", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const results = [
		currentPullRequest({ conditions: { unresolvedThreads: 1 } }),
		currentPullRequest({ conditions: { unresolvedThreads: 1, ci: "failure" } }),
	];
	const app = harness({
		async load() {
			const result = results.shift();
			if (result === undefined) throw new Error("Unexpected pull request refresh");
			return result;
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · 1 unresolved");
	assert.deepEqual(app.widgets.at(-1), widgetLine("! Run /pr to address review feedback"));

	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");
	assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));

	await app.shutdown(ctx);
});

test("shows plain immediate RPC routing feedback while fresh discovery is deferred", async () => {
	const discovery = deferred<"fix-ci">();
	const app = harness({
		async load() {
			return currentPullRequest({ conditions: { ci: "failure" } });
		},
		async commandHandler() {
			return discovery.promise;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		const statusWrites = app.statuses.length;
		const command = app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.widgets.at(-1), routingWidgetLine);
		assert.doesNotMatch((app.widgets.at(-1) as string[])[0] ?? "", /\x1b/);
		assert.equal(app.statuses.length, statusWrites, "routing must preserve the footer");

		discovery.resolve("fix-ci");
		await command;
		assert.equal(app.widgets.at(-1), undefined);
	} finally {
		await app.shutdown(ctx);
	}
});

test("keeps the RPC widget as a plain icon-prefixed action despite a terminal theme", async () => {
	const app = harness({
		async load() {
			return currentPullRequest({ conditions: { ci: "failure" } });
		},
		theme(color, text) {
			return `<${color}>${text}</${color}>`;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		assert.notEqual(typeof app.widgets.at(-1), "function");
		assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));
		assert.doesNotMatch((app.widgets.at(-1) as string[])[0] ?? "", /\x1b/);
	} finally {
		await app.shutdown(ctx);
	}
});

test("animates and clears a width-aware TUI routing component at route resolution", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const discovery = deferred<void>();
	const interaction = deferred<void>();
	const app = harness({
		async load() {
			return currentPullRequest({ conditions: { ci: "failure" } });
		},
		async commandHandler(_args, _ctx, onRouteResolved) {
			await discovery.promise;
			onRouteResolved?.("none");
			await interaction.promise;
			return "none";
		},
	});
	const ctx = app.context("tui");

	try {
		await app.start(ctx);
		const statusWrites = app.statuses.length;
		const command = app.command().handler("", ctx as ExtensionCommandContext);
		const widget = app.widgets.at(-1);
		assert.equal(typeof widget, "function");
		let renders = 0;
		const component = (widget as (tui: { requestRender(): void }, theme: {
			fg(color: string, text: string): string;
		}) => { dispose(): void; render(width: number): string[] })({
			requestRender() { renders += 1; },
		}, {
			fg(_color, text) { return `\x1b[36m${text}\x1b[0m`; },
		});
		assert.deepEqual(component.render(0), []);
		assert.match(component.render(80)[0] ?? "", /⠋.*Checking pull request…/);
		assert.ok(component.render(8).every((line) => visibleWidth(line) <= 8));

		t.mock.timers.tick(80);
		assert.equal(renders, 1);
		assert.match(component.render(80)[0] ?? "", /⠙.*Checking pull request…/);

		discovery.resolve();
		await flush();
		assert.equal(app.widgets.at(-1), undefined, "routing feedback clears before route interaction");
		assert.equal(app.statuses.length, statusWrites, "routing must preserve the footer");
		t.mock.timers.tick(160);
		assert.equal(renders, 1, "route resolution must stop animation");
		component.dispose();

		interaction.resolve();
		await command;
	} finally {
		await app.shutdown(ctx);
	}
});

test("uses a width-aware single-line widget component in TUI", async () => {
	const app = harness({
		async load() {
			return currentPullRequest({ conditions: { unresolvedThreads: 123_456_789 } });
		},
	});
	const ctx = app.context("tui");

	try {
		await app.start(ctx);
		const widget = app.widgets.at(-1);
		assert.equal(typeof widget, "function");
		const component = (widget as (tui: unknown, theme: {
			fg(color: string, text: string): string;
		}) => { render(width: number): string[] })({} as never, {
			fg(_color, text) { return `\x1b[36m${text}\x1b[0m`; },
		});
		assert.deepEqual(component.render(0), []);
		const lines = component.render(8);
		assert.equal(lines.length, 1);
		assert.ok(lines.every((line) => visibleWidth(line) <= 8));
	} finally {
		await app.shutdown(ctx);
	}
});

test("shows the create widget only after preflight reports an ahead commit", async () => {
	let ahead = 0;
	const app = harness({
		async load() {
			return noPullRequest(ahead);
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		assert.equal(app.widgets.at(-1), undefined);

		ahead = 1;
		await app.tool({ toolName: "bash", input: { command: "git commit -m change" }, isError: false }, ctx);
		assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("propagates render failures before mutating UI", async () => {
	const app = harness({
		async load() {
			return currentPullRequest();
		},
		theme() {
			throw new Error("theme failed");
		},
	});
	const ctx = app.context();

	await assert.rejects(app.start(ctx), /theme failed/);
	assert.deepEqual(app.statuses, []);
	assert.deepEqual(app.widgets, []);
	await app.shutdown(ctx);
});

test("reports detached render failures once and resumes after recovery", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let failure: string | undefined;
	const app = harness({
		async load() {
			return currentPullRequest();
		},
		theme(_color, text) {
			if (failure) throw new Error(failure);
			return text;
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	const statusWritesBeforeFailure = app.statuses.length;
	const widgetWritesBeforeFailure = app.widgets.length;
	failure = "timer render failed";
	t.mock.timers.tick(30_000);
	await flush();
	assert.deepEqual(app.notifications, [{
		message: "PR status refresh failed: status unavailable",
		type: "error",
	}]);
	assert.equal(app.statuses.length, statusWritesBeforeFailure);
	assert.equal(app.widgets.length, widgetWritesBeforeFailure);

	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(app.notifications.length, 1, "persistent poll failures must not spam notifications");

	failure = undefined;
	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	failure = "tool render failed";
	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.deepEqual(app.notifications.at(-1), {
		message: "PR status refresh failed: status unavailable",
		type: "error",
	});

	failure = undefined;
	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	failure = "command refresh failed";
	await app.command().handler("", ctx as ExtensionCommandContext);
	await flush();
	assert.deepEqual(app.notifications.at(-1), {
		message: "PR status refresh failed: status unavailable",
		type: "error",
	});
	assert.equal(app.notifications.length, 3);

	await app.shutdown(ctx);
});

test("reports lookup failures once, clears stale actions, and resets after recovery", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const results: Array<CurrentPullRequest | Error> = [
		new Error("initial lookup failed"),
		new Error("initial lookup failed again"),
		currentPullRequest({ conditions: { ci: "failure" } }),
		new Error("later lookup failed"),
	];
	const app = harness({
		async load() {
			const result = results.shift();
			if (result === undefined) throw new Error("Unexpected pull request refresh");
			if (result instanceof Error) throw result;
			return result;
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	assert.deepEqual(app.notifications, [{
		message: "PR status refresh failed: status unavailable",
		type: "error",
	}]);
	assert.deepEqual(app.statuses.map((status) => plain(status ?? "")), ["PR · status unavailable"]);
	assert.deepEqual(app.widgets, [undefined]);

	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(app.notifications.length, 1, "repeated lookup failures must not spam notifications");

	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");
	assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));
	const statusWrites = app.statuses.length;
	const widgetWrites = app.widgets.length;

	t.mock.timers.tick(30_000);
	await flush();
	assert.deepEqual(app.notifications.at(-1), {
		message: "PR status refresh failed: status unavailable",
		type: "error",
	});
	assert.equal(app.notifications.length, 2);
	assert.equal(app.statuses.length, statusWrites);
	assert.equal(app.widgets.length, widgetWrites + 1);
	assert.equal(app.widgets.at(-1), undefined);

	await app.shutdown(ctx);
});

test("polls one request at a time, retains loader errors, and stops cleanly", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const pending = deferred<CurrentPullRequest | null>();
	const duringShutdown = deferred<CurrentPullRequest | null>();
	const signals: Array<AbortSignal | undefined> = [];
	let calls = 0;
	const app = harness({
		async load(_pi, context) {
			signals.push(context.signal);
			calls += 1;
			if (calls === 1) return currentPullRequest({ conditions: { ci: "failure" } });
			if (calls === 2) return pending.promise;
			if (calls === 3) throw new Error("temporary GitHub failure");
			if (calls === 4) return duringShutdown.promise;
			throw new Error("Unexpected pull request refresh");
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	assert.equal(calls, 1);
	t.mock.timers.tick(30_000);
	assert.equal(calls, 2);
	assert.equal(signals[1]?.aborted, false);

	await app.tool({ toolName: "bash", input: { command: "gh pr create --fill" }, isError: false }, ctx);
	assert.equal(calls, 2, "matching tool result queues behind the active refresh");

	pending.resolve(currentPullRequest({ conditions: { ci: "running" } }));
	await flush();
	assert.equal(calls, 3, "queued refresh runs after the active request");
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI running");
	assert.equal(app.widgets.at(-1), undefined);
	assert.deepEqual(app.notifications, [{
		message: "PR status refresh failed: status unavailable",
		type: "error",
	}]);

	t.mock.timers.tick(30_000);
	assert.equal(calls, 4);
	assert.equal(signals[3]?.aborted, false);
	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(calls, 4, "matching tool result queues behind the signal-ignoring request");

	const statusWritesBeforeShutdown = app.statuses.length;
	const widgetWritesBeforeShutdown = app.widgets.length;
	await app.shutdown(ctx);
	assert.equal(signals[3]?.aborted, true);
	const callsAfterShutdown = calls;

	duringShutdown.resolve(currentPullRequest());
	await flush();
	assert.equal(calls, callsAfterShutdown, "shutdown must not restart queued refreshes");
	assert.equal(app.statuses.length, statusWritesBeforeShutdown, "shutdown request must not render a status");
	assert.equal(app.widgets.length, widgetWritesBeforeShutdown, "shutdown request must not render a widget");

	t.mock.timers.tick(60_000);
	assert.equal(calls, callsAfterShutdown, "shutdown must stop later polling");
});

test("session replacement disposes routing animation before stale /pr completion", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const workflow = deferred<"create">();
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			return loads === 1 ? noPullRequest(1) : currentPullRequest({ conditions: { ci: "failure" } });
		},
		async commandHandler() {
			return workflow.promise;
		},
	});
	const firstSession = app.context("tui");
	const secondSession = app.context();

	await app.start(firstSession);
	const staleCommand = app.command().handler("", firstSession as ExtensionCommandContext);
	const routingWidget = app.widgets.at(-1);
	assert.equal(typeof routingWidget, "function");
	let renders = 0;
	(routingWidget as (tui: { requestRender(): void }, theme: {
		fg(color: string, text: string): string;
	}) => unknown)({ requestRender() { renders += 1; } }, { fg(_color, text) { return text; } });
	t.mock.timers.tick(80);
	assert.equal(renders, 1);

	await app.shutdown(firstSession);
	t.mock.timers.tick(160);
	assert.equal(renders, 1, "shutdown must stop the stale spinner timer");
	await app.start(secondSession);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");
	assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));
	const statusWrites = app.statuses.length;
	const widgetWrites = app.widgets.length;

	workflow.resolve("create");
	await staleCommand;
	assert.equal(app.statuses.length, statusWrites);
	assert.equal(app.widgets.length, widgetWrites);

	await app.shutdown(secondSession);
});

test("does not warn for the expected published ref during PR creation", async () => {
	let published = false;
	let created = false;
	const app = harness({
		async load() {
			if (created) return currentPullRequest();
			if (published) {
				return { kind: "blocked", issue: { kind: "published-without-pr", remote: "origin" } };
			}
			return noPullRequest(1);
		},
		async commandHandler() {
			return "create";
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		published = true;
		await app.tool({
			toolName: "bash",
			input: { command: "git push origin HEAD" },
			isError: false,
		}, ctx);

		assert.deepEqual(app.notifications, []);
		assert.equal(plain(app.statuses.at(-1) ?? ""), "");
		created = true;
		await app.settle(ctx);
		assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · merge-ready");
	} finally {
		await app.shutdown(ctx);
	}
});

test("keeps the create hint cleared until the workflow settles", async () => {
	const workflow = deferred<void>();
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			return loads === 1 ? noPullRequest(1) : currentPullRequest();
		},
		async commandHandler() {
			await workflow.promise;
			return "create";
		},
	});
	const ctx = app.context();
	const previousCapabilities = getCapabilities();
	setCapabilities({ ...previousCapabilities, hyperlinks: true });

	try {
		await app.start(ctx);
		assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));

		const command = app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.widgets.at(-1), routingWidgetLine, "routing feedback replaces the hint immediately");
		workflow.resolve(undefined);
		await command;

		await app.tool({
			toolName: "bash",
			input: { command: "git push origin HEAD" },
			isError: false,
		}, ctx);
		assert.equal(loads, 1);
		assert.equal(app.widgets.at(-1), undefined, "a create-workflow refresh must not restore the hint");

		await app.settle(ctx);
		assert.equal(loads, 2);
		assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · merge-ready");
		assert.match(app.statuses.at(-1) ?? "", /\x1b\]8;;https:\/\/github\.com\/acme\/project\/pull\/42\x1b\\/);
		assert.deepEqual(app.widgets.at(-1), widgetLine("✓ Run /pr to merge pull request"));

	} finally {
		setCapabilities(previousCapabilities);
		await app.shutdown(ctx);
	}
});

test("normalizes the Herdr workspace label after a create workflow settles", async () => {
	await withHerdrEnvironment("1", "workspace-7", async () => {
		let loads = 0;
		const app = harness({
			async load() {
				loads += 1;
				return loads === 1 ? noPullRequest(1) : currentPullRequest();
			},
			async commandHandler() {
				return "create";
			},
			async exec(_command, args) {
				return args[1] === "get"
					? execResult(JSON.stringify({
						result: { workspace: { workspace_id: "workspace-7", label: "#7 • #8 • Feature · PR #7 · PR #8" } },
					}))
					: execResult();
			},
		});
		const ctx = app.context();

		try {
			await app.start(ctx);
			await app.command().handler("", ctx as ExtensionCommandContext);
			assert.equal(app.execCalls.length, 0);

			await app.settle(ctx);
			assert.deepEqual(app.execCalls.map(({ command, args, options }) => ({
				command,
				args,
				cwd: options?.cwd,
				timeout: options?.timeout,
			})), [
				{
					command: "herdr",
					args: ["workspace", "get", "workspace-7"],
					cwd: "/repo",
					timeout: 10_000,
				},
				{
					command: "herdr",
					args: ["workspace", "rename", "workspace-7", "#42 • Feature"],
					cwd: "/repo",
					timeout: 10_000,
				},
			]);
			assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · merge-ready");
			assert.deepEqual(app.widgets.at(-1), widgetLine("✓ Run /pr to merge pull request"));
		} finally {
			await app.shutdown(ctx);
		}
	});
});

test("keeps one Herdr rename pending through delayed PR discovery", async () => {
	for (const scenario of [
		{ name: "missing", delayed: null },
		{ name: "failed", delayed: new Error("GitHub unavailable") },
	]) {
		await withHerdrEnvironment("1", "workspace-7", async () => {
			let loads = 0;
			const app = harness({
				async load() {
					loads += 1;
					if (loads === 1) return noPullRequest(1);
					if (loads === 2) {
						if (scenario.delayed instanceof Error) throw scenario.delayed;
						return noPullRequest();
					}
					return currentPullRequest();
				},
				async commandHandler() {
					return "create";
				},
				async exec(_command, args) {
					return args[1] === "get"
						? execResult(JSON.stringify({
							result: { workspace: { workspace_id: "workspace-7", label: "Feature" } },
						}))
						: execResult();
				},
			});
			const ctx = app.context();

			try {
				await app.start(ctx);
				await app.command().handler("", ctx as ExtensionCommandContext);
				await app.settle(ctx);
				assert.equal(app.execCalls.length, 0, scenario.name);

				await app.tool({
					toolName: "bash",
					input: { command: "git push origin HEAD" },
					isError: false,
				}, ctx);
				assert.deepEqual(app.execCalls.map(({ args }) => args[1]), ["get", "rename"], scenario.name);
			} finally {
				await app.shutdown(ctx);
			}
		});
	}
});

test("renames once when an observed configured PR rehydrates as closed or merged", async () => {
	for (const lifecycle of ["closed", "merged"] as const) {
		await withHerdrEnvironment("1", "workspace-7", async () => {
			const observed = pullRequestObservation(currentPullRequest());
			assert.ok(observed);
			let loads = 0;
			const app = harness({
				sessionEntries: [{ type: "custom", customType: "pi-pr-observation", data: observed }],
				async load(_pi, _context, _inspectedLocal, observation) {
					loads += 1;
					assert.deepEqual(observation, observed);
					return loads === 1 ? noPullRequest(1) : currentPullRequest({ lifecycle });
				},
				async commandHandler() {
					return "create";
				},
				async exec(_command, args) {
					return args[1] === "get"
						? execResult(JSON.stringify({
							result: { workspace: { workspace_id: "workspace-7", label: "Feature" } },
						}))
						: execResult();
				},
			});
			const ctx = app.context();

			try {
				await app.start(ctx);
				await app.command().handler("", ctx as ExtensionCommandContext);
				await app.settle(ctx);
				assert.equal(plain(app.statuses.at(-1) ?? ""), `PR #42 · ${lifecycle}`);
				assert.deepEqual(app.execCalls.map(({ args }) => args[1]), ["get", "rename"], lifecycle);

				await app.tool({
					toolName: "bash",
					input: { command: "git push origin HEAD" },
					isError: false,
				}, ctx);
				assert.equal(app.execCalls.length, 2, `${lifecycle} rename is one-shot`);
			} finally {
				await app.shutdown(ctx);
			}
		});
	}
});

test("warns without hiding the refreshed PR when Herdr labeling fails", async () => {
	await withHerdrEnvironment("1", "workspace-7", async () => {
		let loads = 0;
		const app = harness({
			async load() {
				loads += 1;
				return loads === 1 ? noPullRequest(1) : currentPullRequest();
			},
			async commandHandler() {
				return "create";
			},
			async exec() {
				return execResult("", 7, "workspace unavailable");
			},
		});
		const ctx = app.context();

		try {
			await app.start(ctx);
			await app.command().handler("", ctx as ExtensionCommandContext);
			await app.settle(ctx);
			assert.deepEqual(app.notifications, [{
				message: "Herdr workspace rename failed: herdr workspace get failed: workspace unavailable",
				type: "warning",
			}]);
			assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · merge-ready");
			assert.deepEqual(app.widgets.at(-1), widgetLine("✓ Run /pr to merge pull request"));

			await app.tool({
				toolName: "bash",
				input: { command: "git push origin HEAD" },
				isError: false,
			}, ctx);
			assert.equal(app.execCalls.length, 1, "an observed open PR consumes the rename after failure");
			assert.equal(app.notifications.length, 1);
		} finally {
			await app.shutdown(ctx);
		}
	});
});

test("session replacement aborts Herdr labeling before stale rename or warning", async () => {
	await withHerdrEnvironment("1", "workspace-7", async () => {
		const workspaceGet = deferred<ExecResult>();
		let loads = 0;
		const app = harness({
			async load() {
				loads += 1;
				return loads === 1 ? noPullRequest(1) : currentPullRequest();
			},
			async commandHandler() {
				return "create";
			},
			async exec(_command, args) {
				if (args[1] !== "get") throw new Error("stale workspace rename");
				return workspaceGet.promise;
			},
		});
		const firstSession = app.context();
		const secondSession = app.context();

		try {
			await app.start(firstSession);
			await app.command().handler("", firstSession as ExtensionCommandContext);
			const settling = app.settle(firstSession);
			await flush();

			await app.start(secondSession);
			assert.equal(app.execCalls[0]?.options?.signal?.aborted, true);
			workspaceGet.resolve(execResult(JSON.stringify({
				result: { workspace: { workspace_id: "workspace-7", label: "Feature · PR #7" } },
			})));
			await settling;

			assert.equal(app.execCalls.length, 1);
			assert.deepEqual(app.notifications, []);
		} finally {
			await app.shutdown(secondSession);
		}
	});
});

test("keeps a non-create hint hidden until its workflow settles", async () => {
	const workflow = deferred<"fix-ci">();
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			return loads < 3
				? currentPullRequest({ conditions: { ci: "failure" } })
				: currentPullRequest();
		},
		async commandHandler() {
			return workflow.promise;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));
		const statusWrites = app.statuses.length;

		const command = app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.widgets.at(-1), routingWidgetLine, "routing feedback replaces the hint immediately");
		assert.equal(app.statuses.length, statusWrites, "a non-create route must not clear the footer");

		workflow.resolve("fix-ci");
		await command;
		assert.equal(app.widgets.at(-1), undefined, "the hint stays hidden after workflow dispatch");
		assert.equal(app.statuses.length, statusWrites, "workflow dispatch must not clear the footer");

		await app.tool({
			toolName: "bash",
			input: { command: "git push origin HEAD" },
			isError: false,
		}, ctx);
		assert.equal(app.widgets.at(-1), undefined, "a workflow refresh must not restore the hint");

		await app.settle(ctx);
		assert.equal(loads, 3);
		assert.deepEqual(app.widgets.at(-1), widgetLine("✓ Run /pr to merge pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("restores the create hint when the dispatched workflow settles without a pull request", async () => {
	const app = harness({
		async load() {
			return noPullRequest(1);
		},
		async commandHandler() {
			return "create";
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.equal(app.widgets.at(-1), undefined);

		await app.settle(ctx);
		assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("tracks creation from the fresh command route instead of stale presentation", async () => {
	const staleNull = deferred<CurrentPullRequest | CurrentPullRequestDiscovery>();
	let staleCreateLoads = 0;
	const staleCreate = harness({
		async load() {
			staleCreateLoads += 1;
			if (staleCreateLoads === 1) return noPullRequest(1);
			if (staleCreateLoads === 2) return staleNull.promise;
			return currentPullRequest();
		},
		async commandHandler() {
			return "none";
		},
	});
	const staleCreateContext = staleCreate.context();
	try {
		await staleCreate.start(staleCreateContext);
		const polling = staleCreate.tool({
			toolName: "bash",
			input: { command: "git push origin HEAD" },
			isError: false,
		}, staleCreateContext);
		await flush();

		await staleCreate.command().handler("", staleCreateContext as ExtensionCommandContext);
		await flush();
		assert.equal(plain(staleCreate.statuses.at(-1) ?? ""), "PR #42 · merge-ready");

		staleNull.resolve(noPullRequest());
		await polling;
		assert.equal(plain(staleCreate.statuses.at(-1) ?? ""), "PR #42 · merge-ready");
	} finally {
		await staleCreate.shutdown(staleCreateContext);
	}

	const stalePr = deferred<CurrentPullRequest | CurrentPullRequestDiscovery>();
	let stalePullRequestLoads = 0;
	const stalePullRequest = harness({
		async load() {
			stalePullRequestLoads += 1;
			if (stalePullRequestLoads === 1) return currentPullRequest();
			if (stalePullRequestLoads === 2) return stalePr.promise;
			return noPullRequest(1);
		},
		async commandHandler() {
			return "create";
		},
	});
	const stalePullRequestContext = stalePullRequest.context();
	try {
		await stalePullRequest.start(stalePullRequestContext);
		const polling = stalePullRequest.tool({
			toolName: "bash",
			input: { command: "git push origin HEAD" },
			isError: false,
		}, stalePullRequestContext);
		await flush();

		await stalePullRequest.command().handler("", stalePullRequestContext as ExtensionCommandContext);
		assert.equal(stalePullRequest.statuses.at(-1), undefined);
		assert.equal(stalePullRequest.widgets.at(-1), undefined);

		stalePr.resolve(currentPullRequest());
		await polling;
		assert.equal(stalePullRequest.statuses.at(-1), undefined);
		assert.equal(stalePullRequest.widgets.at(-1), undefined);

		await stalePullRequest.settle(stalePullRequestContext);
		assert.deepEqual(stalePullRequest.widgets.at(-1), widgetLine("● Run /pr to create pull request"));
	} finally {
		await stalePullRequest.shutdown(stalePullRequestContext);
	}
});

test("restores the create hint immediately but clears it when its scheduled refresh fails", async () => {
	const scheduledRefresh = deferred<CurrentPullRequest | CurrentPullRequestDiscovery>();
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			if (loads === 1) return noPullRequest(1);
			return await scheduledRefresh.promise;
		},
		async commandHandler() {
			throw new Error("dispatch failed");
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await assert.rejects(app.command().handler("", ctx as ExtensionCommandContext), /dispatch failed/);
		assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));
		assert.equal(loads, 2);
		scheduledRefresh.reject(new Error("lookup unavailable"));
		await flush();
		assert.equal(app.widgets.at(-1), undefined);
	} finally {
		await app.shutdown(ctx);
	}
});

test("out-of-order /pr results keep every active creation workflow pending", async () => {
	const first = deferred<"create" | "none">();
	const second = deferred<"create" | "none">();
	let commands = 0;
	const app = harness({
		async load() {
			return noPullRequest(1);
		},
		async commandHandler() {
			commands += 1;
			return commands === 1 ? first.promise : second.promise;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		const older = app.command().handler("", ctx as ExtensionCommandContext);
		const newer = app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.widgets.at(-1), routingWidgetLine);

		second.resolve("create");
		await newer;
		assert.deepEqual(app.widgets.at(-1), routingWidgetLine, "the older unresolved route keeps feedback visible");
		first.resolve("none");
		await older;
		await flush();
		assert.equal(app.widgets.at(-1), undefined);

		await app.settle(ctx);
		assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("a failed second /pr keeps the active creation workflow pending", async () => {
	let commands = 0;
	const app = harness({
		async load() {
			return noPullRequest(1);
		},
		async commandHandler() {
			commands += 1;
			if (commands === 1) return "create";
			throw new Error("second dispatch failed");
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		const failed = app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.widgets.at(-1), routingWidgetLine);
		await assert.rejects(failed, /second dispatch failed/);
		assert.equal(app.widgets.at(-1), undefined, "the active workflow keeps the restored widget hidden");
		await flush();
		assert.equal(app.widgets.at(-1), undefined);

		await app.settle(ctx);
		assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("/pr restores its hint after a command error and schedules a refresh", async () => {
	let loads = 0;
	let commandCalls = 0;
	const app = harness({
		async load() {
			loads += 1;
			return currentPullRequest({ conditions: { ci: "failure" } });
		},
		async commandHandler() {
			commandCalls += 1;
			throw new Error("route failed");
		},
	});
	const ctx = app.context();
	const noUi = { hasUI: false, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;

	await app.start(ctx);
	assert.equal(loads, 1);
	await app.command().handler("", noUi as ExtensionCommandContext);
	assert.equal(commandCalls, 0);
	assert.equal(loads, 1);

	const command = app.command().handler("", ctx as ExtensionCommandContext);
	assert.deepEqual(app.widgets.at(-1), routingWidgetLine);
	await assert.rejects(command, /route failed/);
	assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));
	await flush();
	assert.equal(commandCalls, 1);
	assert.equal(loads, 2);

	await app.shutdown(ctx);
});

test("requires a newly ahead commit before offering creation after a merge", async () => {
	let loads = 0;
	let ahead = 0;
	const app = harness({
		async load() {
			loads += 1;
			return loads === 1 ? currentPullRequest() : noPullRequest(ahead);
		},
		async commandHandler() {
			return "merge";
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		assert.deepEqual(app.widgets.at(-1), widgetLine("✓ Run /pr to merge pull request"));

		await app.command().handler("", ctx as ExtensionCommandContext);
		await flush();
		assert.equal(app.statuses.at(-1), undefined);
		assert.equal(app.widgets.at(-1), undefined);

		ahead = 1;
		await app.tool({
			toolName: "bash",
			input: { command: "git commit -m change" },
			isError: false,
		}, ctx);
		assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

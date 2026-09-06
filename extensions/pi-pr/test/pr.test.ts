import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import type { PrCommandHandler } from "../extensions/pr-command.ts";
import type {
	CurrentPullRequest,
	PullRequestLoadContext,
} from "../extensions/pr-github.ts";
import pullRequestExtension from "../extensions/pr.ts";

type Loader = (
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
) => Promise<CurrentPullRequest | null>;
type EventHandler = (event: unknown, context: ExtensionContext) => Promise<void> | void;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
};

const plain = (text: string) => text.replace(/\x1b\]8;;.*?\x1b\\/g, "");
const widgetCard = (state: string, action: string): string[] => [
	`│ Pull request · ${state}`,
	`│ ${action}`,
];

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function currentPullRequest(overrides: {
	conditions?: Partial<CurrentPullRequest["conditions"]>;
	lifecycle?: CurrentPullRequest["lifecycle"];
	approved?: boolean;
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
		merge: { allowedMergeMethods: ["squash"], viewerDefaultMergeMethod: "squash" },
	};
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function harness(options: {
	load: Loader;
	hasLocalCommit?: () => Promise<boolean>;
	commandHandler?: PrCommandHandler;
	theme?: (color: string, text: string) => string;
}) {
	let sessionStart: EventHandler | undefined;
	let sessionShutdown: EventHandler | undefined;
	let agentSettled: EventHandler | undefined;
	let toolResult: EventHandler | undefined;
	let command: Command | undefined;
	const statuses: Array<string | undefined> = [];
	const widgets: unknown[] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const ui = {
		setStatus(_key: string, value: string | undefined) { statuses.push(value); },
		setWidget(_key: string, value: unknown) { widgets.push(value); },
		notify(message: string, type?: string) { notifications.push({ message, type }); },
		theme: {
			fg(color: string, text: string) { return options.theme?.(color, text) ?? text; },
			bold(text: string) { return text; },
		},
	};

	pullRequestExtension({
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStart = handler as EventHandler;
			if (event === "session_shutdown") sessionShutdown = handler as EventHandler;
			if (event === "agent_settled") agentSettled = handler as EventHandler;
			if (event === "tool_result") toolResult = handler as EventHandler;
		},
		registerCommand(name: string, registered: Command) {
			if (name === "pr") command = registered;
		},
	} as unknown as ExtensionAPI, {
		loadCurrentPullRequest: options.load,
		hasLocalCommit: options.hasLocalCommit,
		createPrCommandHandler: () => options.commandHandler ?? (async () => "none"),
	});

	const handler = <T>(value: T | undefined, name: string): T => {
		if (value === undefined) throw new Error(`Missing ${name} handler`);
		return value;
	};
	const context = (mode: "tui" | "rpc" = "rpc"): ExtensionContext => ({
		hasUI: true,
		mode,
		cwd: "/repo",
		signal: new AbortController().signal,
		isIdle: () => true,
		ui,
	} as unknown as ExtensionContext);
	const callbackContext = (ctx: ExtensionContext): ExtensionContext => ({ ...ctx });

	return {
		statuses,
		widgets,
		notifications,
		context,
		async start(ctx: ExtensionContext): Promise<void> {
			await handler(sessionStart, "session_start")({} as never, callbackContext(ctx));
		},
		async shutdown(ctx: ExtensionContext): Promise<void> {
			await handler(sessionShutdown, "session_shutdown")({} as never, callbackContext(ctx));
		},
		async settle(ctx: ExtensionContext): Promise<void> {
			await handler(agentSettled, "agent_settled")({} as never, callbackContext(ctx));
		},
		async tool(event: unknown, ctx: ExtensionContext): Promise<void> {
			await handler(toolResult, "tool_result")(event, callbackContext(ctx));
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

test("renders the shared projection and refreshes after successful create or push", async () => {
	const results: Array<CurrentPullRequest | null> = [
		currentPullRequest({ conditions: { ci: "failure" } }),
		currentPullRequest({ conditions: { ci: "running" } }),
		null,
	];
	const signals: Array<AbortSignal | undefined> = [];
	const app = harness({
		async load(_pi, context) {
			signals.push(context.signal);
			const result = results.shift();
			if (result === undefined) throw new Error("Unexpected pull request refresh");
			return result;
		},
		async hasLocalCommit() {
			return true;
		},
	});
	const noUi = { hasUI: false } as ExtensionContext;
	const ctx = app.context();

	await app.start(noUi);
	await app.tool({ toolName: "bash", input: { command: "gh pr create --fill" }, isError: false }, noUi);
	assert.equal(signals.length, 0);

	await app.start(ctx);
	assert.equal(signals.length, 1);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");
	assert.deepEqual(app.widgets.at(-1), widgetCard("CI failed", "Run /pr to fix CI"));

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
	assert.deepEqual(app.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));

	await app.shutdown(ctx);
});

test("keeps RPC widgets plain despite a terminal theme", async () => {
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
		assert.deepEqual(app.widgets.at(-1), widgetCard("CI failed", "Run /pr to fix CI"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("uses a width-aware widget component in TUI", async () => {
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
			bold(text: string): string;
		}) => { render(width: number): string[] })({} as never, {
			fg(_color, text) { return `\x1b[36m${text}\x1b[0m`; },
			bold(text) { return `\x1b[1m${text}\x1b[22m`; },
		});
		for (const width of [0, 8]) {
			const lines = component.render(width);
			assert.equal(lines.length, 2);
			assert.ok(lines.every((line) => visibleWidth(line) <= Math.max(1, width)));
		}
	} finally {
		await app.shutdown(ctx);
	}
});

test("shows the create widget only after a local commit", async () => {
	const localCommits = [false, true];
	const app = harness({
		async load() {
			return null;
		},
		async hasLocalCommit() {
			const value = localCommits.shift();
			if (value === undefined) throw new Error("Unexpected local commit check");
			return value;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		assert.equal(app.widgets.at(-1), undefined);

		await app.tool({ toolName: "bash", input: { command: "git commit -m change" }, isError: false }, ctx);
		assert.deepEqual(app.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));
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
		message: "PR status refresh failed: timer render failed",
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
		message: "PR status refresh failed: tool render failed",
		type: "error",
	});

	failure = undefined;
	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	failure = "command refresh failed";
	await app.command().handler("", ctx as ExtensionCommandContext);
	await flush();
	assert.deepEqual(app.notifications.at(-1), {
		message: "PR status refresh failed: command refresh failed",
		type: "error",
	});
	assert.equal(app.notifications.length, 3);

	await app.shutdown(ctx);
});

test("reports lookup failures once, retains display, and resets after recovery", async (t) => {
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
		message: "PR status refresh failed: initial lookup failed",
		type: "error",
	}]);
	assert.deepEqual(app.statuses, []);
	assert.deepEqual(app.widgets, []);

	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(app.notifications.length, 1, "repeated lookup failures must not spam notifications");

	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");
	assert.deepEqual(app.widgets.at(-1), widgetCard("CI failed", "Run /pr to fix CI"));
	const statusWrites = app.statuses.length;
	const widgetWrites = app.widgets.length;

	t.mock.timers.tick(30_000);
	await flush();
	assert.deepEqual(app.notifications.at(-1), {
		message: "PR status refresh failed: later lookup failed",
		type: "error",
	});
	assert.equal(app.notifications.length, 2);
	assert.equal(app.statuses.length, statusWrites);
	assert.equal(app.widgets.length, widgetWrites);

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
		message: "PR status refresh failed: temporary GitHub failure",
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

test("session context generation prevents stale /pr completion from mutating the current session", async () => {
	const workflow = deferred<"create">();
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			return loads === 1 ? null : currentPullRequest({ conditions: { ci: "failure" } });
		},
		async hasLocalCommit() {
			return true;
		},
		async commandHandler() {
			return workflow.promise;
		},
	});
	const firstSession = app.context();
	const secondSession = app.context();

	await app.start(firstSession);
	const staleCommand = app.command().handler("", firstSession as ExtensionCommandContext);
	assert.equal(app.widgets.at(-1), undefined);

	await app.shutdown(firstSession);
	await app.start(secondSession);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");
	assert.deepEqual(app.widgets.at(-1), widgetCard("CI failed", "Run /pr to fix CI"));
	const statusWrites = app.statuses.length;
	const widgetWrites = app.widgets.length;

	workflow.resolve("create");
	await staleCommand;
	assert.equal(app.statuses.length, statusWrites);
	assert.equal(app.widgets.length, widgetWrites);

	await app.shutdown(secondSession);
});

test("keeps the create hint cleared until a fresh post-workflow refresh", async () => {
	const staleRefresh = deferred<CurrentPullRequest | null>();
	const workflow = deferred<void>();
	let loads = 0;
	let localCommitChecks = 0;
	const app = harness({
		async load() {
			loads += 1;
			if (loads === 1) return null;
			if (loads === 2) return staleRefresh.promise;
			return currentPullRequest();
		},
		async hasLocalCommit() {
			localCommitChecks += 1;
			return true;
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
		assert.deepEqual(app.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));

		const command = app.command().handler("", ctx as ExtensionCommandContext);
		assert.equal(app.widgets.at(-1), undefined, "the hint clears before the workflow completes");
		workflow.resolve(undefined);
		await command;

		const polling = app.tool({
			toolName: "bash",
			input: { command: "git push origin HEAD" },
			isError: false,
		}, ctx);
		await flush();
		assert.equal(loads, 2);
		assert.equal(app.widgets.at(-1), undefined, "an in-flight stale refresh must not restore the hint");

		await app.settle(ctx);
		assert.equal(loads, 3);
		assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · merge-ready");
		assert.match(app.statuses.at(-1) ?? "", /\x1b\]8;;https:\/\/github\.com\/acme\/project\/pull\/42\x1b\\/);
		assert.deepEqual(app.widgets.at(-1), widgetCard("merge-ready", "Run /pr to merge pull request"));

		staleRefresh.resolve(null);
		await polling;
		assert.equal(localCommitChecks, 1, "an aborted stale lookup must not inspect local commits");
		assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · merge-ready");
	} finally {
		setCapabilities(previousCapabilities);
		await app.shutdown(ctx);
	}
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
		assert.deepEqual(app.widgets.at(-1), widgetCard("CI failed", "Run /pr to fix CI"));
		const statusWrites = app.statuses.length;

		const command = app.command().handler("", ctx as ExtensionCommandContext);
		assert.equal(app.widgets.at(-1), undefined, "the hint clears while /pr selects the route");
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
		assert.deepEqual(app.widgets.at(-1), widgetCard("merge-ready", "Run /pr to merge pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("restores the create hint when the dispatched workflow settles without a pull request", async () => {
	const app = harness({
		async load() {
			return null;
		},
		async hasLocalCommit() {
			return true;
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
		assert.deepEqual(app.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("tracks creation from the fresh command route instead of stale presentation", async () => {
	const staleNull = deferred<CurrentPullRequest | null>();
	let staleCreateLoads = 0;
	const staleCreate = harness({
		async load() {
			staleCreateLoads += 1;
			if (staleCreateLoads === 1) return null;
			if (staleCreateLoads === 2) return staleNull.promise;
			return currentPullRequest();
		},
		async hasLocalCommit() {
			return true;
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

		staleNull.resolve(null);
		await polling;
		assert.equal(plain(staleCreate.statuses.at(-1) ?? ""), "PR #42 · merge-ready");
	} finally {
		await staleCreate.shutdown(staleCreateContext);
	}

	const stalePr = deferred<CurrentPullRequest | null>();
	let stalePullRequestLoads = 0;
	const stalePullRequest = harness({
		async load() {
			stalePullRequestLoads += 1;
			if (stalePullRequestLoads === 1) return currentPullRequest();
			if (stalePullRequestLoads === 2) return stalePr.promise;
			return null;
		},
		async hasLocalCommit() {
			return true;
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
		assert.deepEqual(stalePullRequest.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));
	} finally {
		await stalePullRequest.shutdown(stalePullRequestContext);
	}
});

test("restores the create hint immediately when /pr cannot dispatch creation", async () => {
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			if (loads === 1) return null;
			throw new Error("lookup unavailable");
		},
		async hasLocalCommit() {
			return true;
		},
		async commandHandler() {
			throw new Error("dispatch failed");
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await assert.rejects(app.command().handler("", ctx as ExtensionCommandContext), /dispatch failed/);
		assert.deepEqual(app.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));
		await flush();
		assert.deepEqual(app.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));
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
			return null;
		},
		async hasLocalCommit() {
			return true;
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

		second.resolve("create");
		await newer;
		first.resolve("none");
		await older;
		await flush();
		assert.equal(app.widgets.at(-1), undefined);

		await app.settle(ctx);
		assert.deepEqual(app.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));
	} finally {
		await app.shutdown(ctx);
	}
});

test("a failed second /pr keeps the active creation workflow pending", async () => {
	let commands = 0;
	const app = harness({
		async load() {
			return null;
		},
		async hasLocalCommit() {
			return true;
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
		await assert.rejects(app.command().handler("", ctx as ExtensionCommandContext), /second dispatch failed/);
		await flush();
		assert.equal(app.widgets.at(-1), undefined);

		await app.settle(ctx);
		assert.deepEqual(app.widgets.at(-1), widgetCard("no pull request", "Run /pr to create pull request"));
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
	const noUi = { hasUI: false } as ExtensionContext;

	await app.start(ctx);
	assert.equal(loads, 1);
	await app.command().handler("", noUi as ExtensionCommandContext);
	assert.equal(commandCalls, 0);
	assert.equal(loads, 1);

	const command = app.command().handler("", ctx as ExtensionCommandContext);
	assert.equal(app.widgets.at(-1), undefined);
	await assert.rejects(command, /route failed/);
	assert.deepEqual(app.widgets.at(-1), widgetCard("CI failed", "Run /pr to fix CI"));
	await flush();
	assert.equal(commandCalls, 1);
	assert.equal(loads, 2);

	await app.shutdown(ctx);
});

import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
	let toolResult: EventHandler | undefined;
	let command: Command | undefined;
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];

	pullRequestExtension({
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStart = handler as EventHandler;
			if (event === "session_shutdown") sessionShutdown = handler as EventHandler;
			if (event === "tool_result") toolResult = handler as EventHandler;
		},
		registerCommand(name: string, registered: Command) {
			if (name === "pr") command = registered;
		},
	} as unknown as ExtensionAPI, {
		loadCurrentPullRequest: options.load,
		hasLocalCommit: options.hasLocalCommit,
		createPrCommandHandler: () => options.commandHandler ?? (async () => {}),
	});

	const handler = <T>(value: T | undefined, name: string): T => {
		if (value === undefined) throw new Error(`Missing ${name} handler`);
		return value;
	};
	const context = (): ExtensionContext => ({
		hasUI: true,
		cwd: "/repo",
		signal: new AbortController().signal,
		isIdle: () => true,
		ui: {
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			setWidget(_key: string, value: string[] | undefined) { widgets.push(value); },
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			theme: { fg(color: string, text: string) { return options.theme?.(color, text) ?? text; } },
		},
	} as unknown as ExtensionContext);

	return {
		statuses,
		widgets,
		notifications,
		context,
		async start(ctx: ExtensionContext): Promise<void> {
			await handler(sessionStart, "session_start")({} as never, ctx);
		},
		async shutdown(ctx: ExtensionContext): Promise<void> {
			await handler(sessionShutdown, "session_shutdown")({} as never, ctx);
		},
		async tool(event: unknown, ctx: ExtensionContext): Promise<void> {
			await handler(toolResult, "tool_result")(event, ctx);
		},
		command(): Command {
			return handler(command, "pr command");
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
	assert.deepEqual(app.widgets.at(-1), ["Run /pr to fix CI"]);

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
	assert.deepEqual(app.widgets.at(-1), ["Run /pr to create pull request"]);

	await app.shutdown(ctx);
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
		assert.deepEqual(app.widgets.at(-1), ["Run /pr to create pull request"]);
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
	assert.deepEqual(app.widgets.at(-1), ["Run /pr to fix CI"]);
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

test("/pr preserves command errors while scheduling a refresh", async () => {
	let loads = 0;
	let commandCalls = 0;
	const app = harness({
		async load() {
			loads += 1;
			return currentPullRequest({ conditions: { ci: "running" } });
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

	await assert.rejects(app.command().handler("", ctx as ExtensionCommandContext), /route failed/);
	await flush();
	assert.equal(commandCalls, 1);
	assert.equal(loads, 2);

	await app.shutdown(ctx);
});

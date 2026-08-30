import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import pullRequestExtension, { formatPullRequest, parsePullRequest } from "../extensions/pr.ts";

const result = (stdout = "", code = 0, stderr = "") => ({ stdout, stderr, code, killed: false });
const pullRequest = (overrides: Record<string, unknown> = {}) => ({
	id: "PR_kwDOExample",
	number: 42,
	url: "https://github.com/acme/project/pull/42",
	headRefOid: "abc123",
	updatedAt: "2026-08-25T12:00:00Z",
	state: "OPEN",
	isDraft: false,
	mergeable: "MERGEABLE",
	reviewDecision: null,
	statusCheckRollup: [],
	...overrides,
});
const plain = (text: string) => text
	.replace(/\x1b\]8;;.*?\x1b\\/g, "")
	.replace(/<\/?[^>]+>/g, "");

function render(value: Record<string, unknown>, unresolved = 0): string {
	const parsed = parsePullRequest(pullRequest(value));
	assert.ok(parsed);
	return formatPullRequest(parsed, {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
	} as ExtensionContext["ui"]["theme"], unresolved);
}

function withCapabilities(hyperlinks: boolean, fn: () => void): void {
	const prev = getCapabilities();
	try {
		setCapabilities({ ...prev, hyperlinks });
		fn();
	} finally {
		setCapabilities(prev);
	}
}

test("formatPullRequest emits OSC 8 hyperlink when hyperlinks capability enabled", () => {
	withCapabilities(true, () => {
		const out = render({});
		assert.match(out, /\x1b\]8;;https:\/\/github\.com\/acme\/project\/pull\/42\x1b\\/);
		assert.match(out, /<text>PR #42<\/text>/);
		assert.equal(plain(out), "PR #42 · open");
	});
});

test("formatPullRequest renders plain themed text when hyperlinks capability disabled", () => {
	withCapabilities(false, () => {
		const out = render({});
		assert.equal(out, "<text>PR #42</text> · <accent>open</accent>");
		assert.equal(plain(out), "PR #42 · open");
		assert.doesNotMatch(out, /\x1b\]8;;/);
	});
});

test("renders one plain-language PR state, prioritizing action", () => {
	withCapabilities(true, () => {
		const conflict = render({
			mergeable: "CONFLICTING",
			reviewDecision: "CHANGES_REQUESTED",
			statusCheckRollup: [{ conclusion: "FAILURE" }],
		});
		assert.equal(plain(conflict), "PR #42 · merge conflict");
		assert.match(conflict, /\x1b\]8;;https:\/\/github\.com\/acme\/project\/pull\/42\x1b\\/);
		assert.match(conflict, /<text>PR #42<\/text>/);

		assert.equal(plain(render({
			reviewDecision: "CHANGES_REQUESTED",
			statusCheckRollup: [{ conclusion: "FAILURE" }],
		})), "PR #42 · changes requested");
		assert.equal(plain(render({
			reviewDecision: "APPROVED",
			statusCheckRollup: [{ conclusion: "FAILURE" }],
		})), "PR #42 · CI failed");
		assert.equal(plain(render({
			reviewDecision: "APPROVED",
			statusCheckRollup: [{ status: "IN_PROGRESS" }],
		})), "PR #42 · CI running");
		assert.equal(plain(render({ isDraft: true })), "PR #42 · draft");
		assert.equal(plain(render({
			reviewDecision: "APPROVED",
			statusCheckRollup: [{ conclusion: "SUCCESS" }],
		})), "PR #42 · approved");
		assert.equal(plain(render({})), "PR #42 · open");
		assert.equal(plain(render({}, 5)), "PR #42 · 5 unresolved");
		assert.equal(plain(render({ state: "MERGED", statusCheckRollup: [{ conclusion: "FAILURE" }] })), "PR #42 · merged");
		assert.equal(plain(render({ state: "CLOSED" })), "PR #42 · closed");
		assert.equal(parsePullRequest(pullRequest({ url: "javascript:alert(1)" })), undefined);
	});
});

test("status formatting preserved when hyperlinks disabled", () => {
	withCapabilities(false, () => {
		const merged = render({ state: "MERGED", statusCheckRollup: [{ conclusion: "FAILURE" }] });
		assert.equal(merged, "<text>PR #42</text> · <success>merged</success>");
		assert.doesNotMatch(merged, /\x1b\]8;;/);

		const conflict = render({
			mergeable: "CONFLICTING",
			reviewDecision: "CHANGES_REQUESTED",
			statusCheckRollup: [{ conclusion: "FAILURE" }],
		});
		assert.equal(conflict, "<text>PR #42</text> · <error>merge conflict</error>");
		assert.doesNotMatch(conflict, /\x1b\]8;;/);

		const draft = render({ isDraft: true });
		assert.equal(draft, "<text>PR #42</text> · <warning>draft</warning>");
		assert.doesNotMatch(draft, /\x1b\]8;;/);
	});
});

test("polls UI sessions, starts PR workflow when absent, and cleans up", async (t) => {
	type Handler = (event: never, ctx: ExtensionContext) => Promise<void> | void;
	type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
	let sessionStart: Handler | undefined;
	let sessionShutdown: Handler | undefined;
	let toolResult: Handler | undefined;
	let command: Command | undefined;
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });

	const calls: Array<{ command: string; args: string[]; signal: AbortSignal | undefined }> = [];
	const reviewCallCount = () => calls.filter(({ command: executable, args }) => executable === "gh" && args[0] === "api" && args[1] === "graphql").length;
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const messages: Array<{ content: string; options: unknown }> = [];
	let reviewOutput = "1\n1\n";
	let viewCode = 0;
	let openPullRequest = true;
	let foreignPullRequest = false;
	let workflowAvailable = true;
	let idle = true;
	let hold: Promise<ReturnType<typeof result>> | undefined;
	let heldSignal: AbortSignal | undefined;
	let headRefOid = "abc123";
	let updatedAt = "2026-08-25T12:00:00Z";
	const good = () => JSON.stringify(pullRequest({ headRefOid, updatedAt }));
	pullRequestExtension({
		on(event: string, handler: Handler) {
			if (event === "session_start") sessionStart = handler;
			if (event === "session_shutdown") sessionShutdown = handler;
			if (event === "tool_result") toolResult = handler;
		},
		registerCommand(name: string, options: Command) {
			if (name === "pr") command = options;
		},
		exec: async (executable: string, args: string[], options?: { signal?: AbortSignal }) => {
			calls.push({ command: executable, args, signal: options?.signal });
			if (executable === "gh" && args[0] === "pr" && args[1] === "view" && args[2] === "--json") {
				if (hold) {
					heldSignal = options?.signal;
					const pending = hold;
					hold = undefined;
					return pending;
				}
				return result(good(), viewCode);
			}
			if (executable === "gh" && args[0] === "api" && args[1] === "graphql") return result(reviewOutput);
			if (executable === "git" && args.join(" ") === "branch --show-current") return result("feature/pr\n");
			if (executable === "git" && args.join(" ") === "remote get-url --push origin") return result("https://github.com/acme/project\n");
			if (executable === "gh" && args.join(" ") === "repo view https://github.com/acme/project --json nameWithOwner") {
				return result(JSON.stringify({ nameWithOwner: "acme/project" }));
			}
			if (executable === "gh" && args[0] === "pr" && args[1] === "list") {
				return result(openPullRequest ? JSON.stringify([{
					number: 42,
					headRepository: { nameWithOwner: foreignPullRequest ? "other/project" : "acme/project" },
				}]) : "[]");
			}
			if (executable === "gh" && args[0] === "pr" && args[1] === "view" && args.at(-1) === "--web") return result();
			throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
		},
		getCommands() {
			return workflowAvailable ? [{
				name: "skill:pi-pr-create",
				source: "skill",
				sourceInfo: { origin: "package" },
			}] : [];
		},
		sendUserMessage(content: string, options: unknown) {
			messages.push({ content, options });
		},
	} as unknown as ExtensionAPI);

	const commandSignal = new AbortController().signal;
	const context = {
		hasUI: true,
		cwd: "/repo",
		signal: commandSignal,
		isIdle() { return idle; },
		ui: {
			setStatus(_key: string, text: string | undefined) { statuses.push(text); },
			notify(message: string, level?: string) { notifications.push({ message, level }); },
			theme: { fg(_color: string, text: string) { return text; } },
		},
	} as unknown as ExtensionContext;
	const noUi = { hasUI: false } as ExtensionContext;
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

	await sessionStart?.({} as never, noUi);
	assert.equal(calls.length, 0);
	await sessionStart?.({} as never, context);
	assert.deepEqual(calls[0]?.args, ["pr", "view", "--json", "id,number,url,headRefOid,updatedAt,state,isDraft,mergeable,reviewDecision,statusCheckRollup"]);
	assert.deepEqual(calls[1]?.args.slice(0, 5), ["api", "graphql", "--hostname", "github.com", "--paginate"]);
	assert.equal(calls[1]?.args.at(-1), "[.data.node.reviewThreads.nodes[] | select(.isResolved == false)] | length");
	assert.equal(plain(statuses.at(-1) ?? ""), "PR #42 · 2 unresolved");
	assert.deepEqual(notifications, [{ message: "PR #42 has 2 unresolved review threads", level: "warning" }]);

	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(calls.length, 4);
	assert.equal(notifications.length, 1);

	reviewOutput = "invalid";
	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(plain(statuses.at(-1) ?? ""), "PR #42 · 2 unresolved");
	reviewOutput = "2\n";

	viewCode = 1;
	t.mock.timers.tick(30_000);
	await flush();
	viewCode = 0;
	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(notifications.length, 1);

	t.mock.timers.setTime(Date.now() + 20 * 60_000);
	const reviewsBeforeExpiry = reviewCallCount();
	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(reviewCallCount(), reviewsBeforeExpiry);
	assert.equal(plain(statuses.at(-1) ?? ""), "PR #42 · 2 unresolved");

	updatedAt = "2026-08-25T12:01:00Z";
	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(reviewCallCount(), reviewsBeforeExpiry + 1);
	assert.equal(notifications.length, 1);
	t.mock.timers.setTime(Date.now() + 20 * 60_000);

	let release!: (value: ReturnType<typeof result>) => void;
	hold = new Promise((resolve) => { release = resolve; });
	t.mock.timers.tick(30_000);
	const callsBeforeCreate = calls.length;
	await toolResult?.({
		toolName: "bash",
		input: { command: "git status && gh pr create --fill" },
		isError: false,
	} as never, context);
	assert.equal(calls.length, callsBeforeCreate);
	headRefOid = "ghi789";
	release(result(good()));
	await flush();
	assert.equal(notifications.length, 1);

	const callsAfterCreate = calls.length;
	await toolResult?.({ toolName: "bash", input: { command: "echo gh pr create" }, isError: false } as never, context);
	await toolResult?.({ toolName: "bash", input: { command: "gh pr create --fill" }, isError: true } as never, context);
	assert.equal(calls.length, callsAfterCreate);

	t.mock.timers.setTime(Date.now() + 20 * 60_000);
	t.mock.timers.tick(30_000);
	await flush();
	const reviewsBeforePush = reviewCallCount();
	reviewOutput = "1\n";
	headRefOid = "jkl012";
	await toolResult?.({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false } as never, context);
	assert.equal(reviewCallCount(), reviewsBeforePush + 1);
	assert.equal(notifications.length, 1);
	assert.equal(plain(statuses.at(-1) ?? ""), "PR #42 · 1 unresolved");

	assert.ok(command);
	calls.length = 0;
	await command.handler("", context as ExtensionCommandContext);
	await flush();
	assert.deepEqual(calls.slice(0, -1).map(({ command: executable, args }) => [executable, args]), [
		["git", ["branch", "--show-current"]],
		["git", ["remote", "get-url", "--push", "origin"]],
		["gh", ["repo", "view", "https://github.com/acme/project", "--json", "nameWithOwner"]],
		["gh", ["pr", "list", "--head", "feature/pr", "--state", "open", "--limit", "100", "--json", "number,headRepository"]],
		["gh", ["pr", "view", "42", "--web"]],
		["gh", ["pr", "view", "--json", "id,number,url,headRefOid,updatedAt,state,isDraft,mergeable,reviewDecision,statusCheckRollup"]],
	]);
	assert.deepEqual(calls.at(-1)?.args.slice(0, 5), ["api", "graphql", "--hostname", "github.com", "--paginate"]);
	assert.equal(calls[0]?.signal, commandSignal);

	foreignPullRequest = true;
	calls.length = 0;
	await command.handler("", context as ExtensionCommandContext);
	await flush();
	assert.equal(calls.some(({ command: executable, args }) => executable === "gh" && args.join(" ") === "pr view 42 --web"), false);
	assert.deepEqual(messages, [{ content: "/skill:pi-pr-create", options: { expandPromptTemplates: true } }]);

	foreignPullRequest = false;
	openPullRequest = false;
	calls.length = 0;
	messages.length = 0;
	await command.handler("", context as ExtensionCommandContext);
	await flush();
	assert.deepEqual(calls.slice(0, -1).map(({ command: executable, args }) => [executable, args]), [
		["git", ["branch", "--show-current"]],
		["git", ["remote", "get-url", "--push", "origin"]],
		["gh", ["repo", "view", "https://github.com/acme/project", "--json", "nameWithOwner"]],
		["gh", ["pr", "list", "--head", "feature/pr", "--state", "open", "--limit", "100", "--json", "number,headRepository"]],
		["gh", ["pr", "view", "--json", "id,number,url,headRefOid,updatedAt,state,isDraft,mergeable,reviewDecision,statusCheckRollup"]],
	]);
	assert.deepEqual(calls.at(-1)?.args.slice(0, 5), ["api", "graphql", "--hostname", "github.com", "--paginate"]);
	assert.deepEqual(messages, [{ content: "/skill:pi-pr-create", options: { expandPromptTemplates: true } }]);

	idle = false;
	messages.length = 0;
	await command.handler("", context as ExtensionCommandContext);
	await flush();
	assert.deepEqual(messages, [{ content: "/skill:pi-pr-create", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);
	idle = true;

	workflowAvailable = false;
	messages.length = 0;
	await assert.rejects(command.handler("", context as ExtensionCommandContext), /bundled workflow is unavailable/);
	await flush();
	assert.equal(messages.length, 0);
	workflowAvailable = true;

	let releaseAbort!: (value: ReturnType<typeof result>) => void;
	hold = new Promise((resolve) => { releaseAbort = resolve; });
	t.mock.timers.tick(30_000);
	assert.ok(heldSignal);
	await sessionShutdown?.({} as never, context);
	assert.equal(heldSignal.aborted, true);
	const callsAfterShutdown = calls.length;
	t.mock.timers.tick(30_000);
	await flush();
	assert.equal(calls.length, callsAfterShutdown);
	releaseAbort(result(good()));
});

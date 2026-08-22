import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import pullRequestExtension, { formatPullRequest, parsePullRequest } from "../extensions/pr.ts";

const result = (stdout = "", code = 0, stderr = "") => ({ stdout, stderr, code, killed: false });
const pullRequest = (overrides: Record<string, unknown> = {}) => ({
	number: 42,
	url: "https://github.com/acme/project/pull/42",
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

function render(value: Record<string, unknown>): string {
	const parsed = parsePullRequest(pullRequest(value));
	assert.ok(parsed);
	return formatPullRequest(parsed, {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
	} as ExtensionContext["ui"]["theme"]);
}

test("renders one plain-language PR state, prioritizing action", () => {
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
	assert.equal(plain(render({ state: "MERGED", statusCheckRollup: [{ conclusion: "FAILURE" }] })), "PR #42 · merged");
	assert.equal(plain(render({ state: "CLOSED" })), "PR #42 · closed");
	assert.equal(parsePullRequest(pullRequest({ url: "javascript:alert(1)" })), undefined);
});

test("polls UI sessions, queues refreshes, and cleans up", async (t) => {
	type Handler = (event: never, ctx: ExtensionContext) => Promise<void> | void;
	type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
	let sessionStart: Handler | undefined;
	let sessionShutdown: Handler | undefined;
	let toolResult: Handler | undefined;
	let command: Command | undefined;
	let interval: { callback: () => void; delay: number } | undefined;
	let intervalHandle: ReturnType<typeof setInterval> | undefined;
	let intervalCleared = false;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	globalThis.setInterval = ((callback: () => void, delay: number) => {
		interval = { callback, delay };
		intervalHandle = {} as ReturnType<typeof setInterval>;
		return intervalHandle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
		if (timer === intervalHandle) intervalCleared = true;
	}) as typeof clearInterval;
	t.after(() => {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	});

	const calls: Array<{ args: string[]; signal: AbortSignal | undefined }> = [];
	const statuses: Array<string | undefined> = [];
	let webResult = result();
	let hold: Promise<ReturnType<typeof result>> | undefined;
	let heldSignal: AbortSignal | undefined;
	const good = JSON.stringify(pullRequest());
	pullRequestExtension({
		on(event: string, handler: Handler) {
			if (event === "session_start") sessionStart = handler;
			if (event === "session_shutdown") sessionShutdown = handler;
			if (event === "tool_result") toolResult = handler;
		},
		registerCommand(name: string, options: Command) {
			if (name === "pr") command = options;
		},
		exec: async (_command: string, args: string[], options?: { signal?: AbortSignal }) => {
			calls.push({ args, signal: options?.signal });
			if (args[2] === "--web") return webResult;
			if (hold) {
				heldSignal = options?.signal;
				const pending = hold;
				hold = undefined;
				return pending;
			}
			return result(good);
		},
	} as unknown as ExtensionAPI);

	const commandSignal = new AbortController().signal;
	const context = {
		hasUI: true,
		cwd: "/repo",
		signal: commandSignal,
		ui: {
			setStatus(_key: string, text: string | undefined) { statuses.push(text); },
			theme: { fg(_color: string, text: string) { return text; } },
		},
	} as unknown as ExtensionContext;
	const noUi = { hasUI: false } as ExtensionContext;

	await sessionStart?.({} as never, noUi);
	assert.equal(calls.length, 0);
	await sessionStart?.({} as never, context);
	assert.deepEqual(calls[0]?.args, ["pr", "view", "--json", "number,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup"]);
	assert.equal(interval?.delay, 30_000);
	assert.equal(plain(statuses.at(-1) ?? ""), "PR #42 · open");

	let release!: (value: ReturnType<typeof result>) => void;
	hold = new Promise((resolve) => { release = resolve; });
	interval?.callback();
	assert.equal(calls.length, 2);
	await toolResult?.({
		toolName: "bash",
		input: { command: "git status && gh pr create --fill" },
		isError: false,
	} as never, context);
	assert.equal(calls.length, 2);
	release(result(good));
	await new Promise<void>((resolve) => setImmediate(() => resolve()));
	assert.equal(calls.length, 3);

	await toolResult?.({ toolName: "bash", input: { command: "echo gh pr create" }, isError: false } as never, context);
	await toolResult?.({ toolName: "bash", input: { command: "gh pr create --fill" }, isError: true } as never, context);
	assert.equal(calls.length, 3);

	assert.ok(command);
	await command.handler("", context as ExtensionCommandContext);
	assert.deepEqual(calls[3]?.args, ["pr", "view", "--web"]);
	assert.equal(calls[3]?.signal, commandSignal);
	await new Promise<void>((resolve) => setImmediate(() => resolve()));
	assert.equal(calls.length, 5);

	webResult = result("", 1, "no pull request for branch");
	await assert.rejects(command.handler("", context as ExtensionCommandContext), /Open pull request failed: no pull request for branch/);

	let releaseAbort!: (value: ReturnType<typeof result>) => void;
	hold = new Promise((resolve) => { releaseAbort = resolve; });
	interval?.callback();
	assert.ok(heldSignal);
	await sessionShutdown?.({} as never, context);
	assert.equal(intervalCleared, true);
	assert.equal(heldSignal.aborted, true);
	releaseAbort(result(good));
});

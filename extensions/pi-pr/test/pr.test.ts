import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBounded, type Exec as BoundedExec } from "@henryqw/pi-process";
import { PullRequestCommentSweep, StaleSweepStart } from "../extensions/pr-comment-sweep.ts";
import { PullRequestBranchUpdater } from "../extensions/pr-update-branch.ts";
import { PullRequestCiFixer, StaleCiCollect } from "../extensions/pr-ci.ts";
import { PullRequestWorkPublisher } from "../extensions/pr-publish-work.ts";
import { DEFAULT_PR_POLICY, type PrPolicy } from "../extensions/pr-run.ts";
import type {
	AgentBeforeSettleEventResult,
	ExecOptions,
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import type { PrCommandHandler } from "../extensions/pr-command.ts";
import {
	GitHubRateLimitError,
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
type EventHandler = (event: unknown, context: ExtensionContext) => Promise<AgentBeforeSettleEventResult | void> | AgentBeforeSettleEventResult | void;
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
			policy: "ready", mergeability: "known",
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
		branch: { ahead, worktree: "clean", relation: "distinct-ref" },
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
	inspectSweepRecovery?: ExtensionDependencies["inspectSweepRecovery"];
	inspectBranchRecovery?: ExtensionDependencies["inspectBranchRecovery"];
	createCiFixer?: ExtensionDependencies["createCiFixer"];
	createWorkPublisher?: ExtensionDependencies["createWorkPublisher"];
	syncLocalHead?: ExtensionDependencies["syncLocalHead"];
	policy?: Partial<PrPolicy>;
	isIdle?: () => boolean;
	skillPath?: string;
}) {
	let sessionStart: EventHandler | undefined;
	let sessionShutdown: EventHandler | undefined;
	let agentSettled: EventHandler | undefined;
	let agentBeforeSettle: EventHandler | undefined;
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
		inspectSweepRecovery: options.inspectSweepRecovery ?? (async () => false),
		inspectBranchRecovery: options.inspectBranchRecovery ?? (async () => false),
		createCiFixer: options.createCiFixer,
		createWorkPublisher: options.createWorkPublisher,
		syncLocalHead: options.syncLocalHead,
		loadPrPolicy: () => ({ ...DEFAULT_PR_POLICY, ciWaitMinutes: 0, ...options.policy }),
		needsFeedbackAttention: async () => false,
	};
	if (!options.useDefaultCommandHandler) {
		extensionDependencies.createPrCommandHandler = () => options.commandHandler ?? (async () => "none");
	}

	pullRequestExtension({
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStart = handler as EventHandler;
			if (event === "session_shutdown") sessionShutdown = handler as EventHandler;
			if (event === "agent_settled") agentSettled = handler as EventHandler;
			if (event === "agent_before_settle") agentBeforeSettle = handler as EventHandler;
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
				"skill:pi-pr-publish-work",
				"skill:pi-pr-update-branch",
				"skill:pi-pr-comment-sweep",
				"skill:pi-pr-fix-ci",
			].map((name) => ({ name, source: "skill", sourceInfo: {
				origin: "package", path: options.skillPath ?? fileURLToPath(new URL(`../skills/${name.slice("skill:".length)}/SKILL.md`, import.meta.url)),
			} }));
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
		async startNow(ctx: ExtensionContext): Promise<void> {
			await handler(sessionStart, "session_start")({} as never, callbackContext(ctx));
		},
		async start(ctx: ExtensionContext): Promise<void> {
			await handler(sessionStart, "session_start")({} as never, callbackContext(ctx));
			await flush();
		},
		async shutdown(ctx: ExtensionContext): Promise<void> {
			await handler(sessionShutdown, "session_shutdown")({} as never, callbackContext(ctx));
		},
		async beforeSettle(ctx: ExtensionContext, outcome = "completed") {
			return await handler(agentBeforeSettle, "agent_before_settle")({ outcome, entries: [], context: { canContinue: false } } as never, callbackContext(ctx));
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
				callbackContext(ctx) as ExtensionToolContext,
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

test("registers sequential model-only tools with flat object roots and strict actions", async () => {
	const app = harness({ async load() { return { kind: "inactive" }; } });
	const expected = new Map([
		["pi_pr_update_branch", ["rebase", "continue", "publish"]],
		["pi_pr_create", ["prepare", "inspect", "commit", "verify", "push", "publish"]],
		["pi_pr_publish_work", ["inspect", "commit", "validate", "publish"]],
		["pi_pr_sweep", ["start", "resume", "show", "record", "commit", "adopt", "validate", "publish", "refresh", "resolve", "finalize"]],
		["pi_pr_fix_ci", ["collect", "publish"]],
	]);

	assert.deepEqual(app.tools.map(({ name }) => name), [...expected.keys()]);
	for (const tool of app.tools) {
		assert.equal(tool.executionMode, "sequential", tool.name);
		// Codemode scripts must not batch guarded actions or filter their results; `only` mode keeps model-only tools declared.
		assert.equal(tool.exposure, "model-only", tool.name);
		// Strict OpenAI-compatible endpoints reject a root without type "object"; Claude Code drops a root union.
		const schema = tool.parameters as unknown as {
			type?: string;
			anyOf?: unknown;
			additionalProperties?: boolean;
			required?: string[];
			properties: { action: { anyOf: Array<{ const: string }> } };
		};
		assert.equal(schema.type, "object", tool.name);
		assert.equal(schema.anyOf, undefined, tool.name);
		assert.equal(schema.additionalProperties, false, tool.name);
		assert.deepEqual(schema.required, ["runId", "action"], tool.name);
		assert.deepEqual(schema.properties.action.anyOf.map(({ const: value }) => value), expected.get(tool.name), tool.name);
	}
	// Flat parameters cannot express action-dependent requirements; reject invalid combinations at execution.
	const ctx = app.context();
	const guard = { epoch: 1, runId: "run", generation: 1, fingerprint: "a".repeat(64) };
	for (const [name, args] of [
		["pi_pr_sweep", { runId: routeRunId, action: "refresh", guard, checks: [] }],
		["pi_pr_create", { runId: routeRunId, action: "commit", ownedPaths: [] }],
		["pi_pr_update_branch", { runId: routeRunId, action: "rebase", extra: true }],
		["pi_pr_fix_ci", { runId: routeRunId, action: "unknown" }],
	] as const) {
		await assert.rejects(app.callTool(name, args, ctx), /do not match one action/, name);
	}
});

for (const [route, drift] of [
	["update-branch", "local"], ["sweep", "local"], ["fix-ci", "local"],
	["update-branch", "published"], ["update-branch", "base"], ["update-branch", "conflict"],
	["update-branch", "rediscovery-head"], ["update-branch", "abort"], ["update-branch", "tool-abort"],
] as const) test(`queued ${route} replans ${drift} drift in the same /pr`, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-pr-stale-route-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "worktree");
	const bare = join(dir, "remote.git");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
	execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "ignore" });
	git("config", "user.name", "Stale Route Test");
	git("config", "user.email", "stale@example.test");
	writeFileSync(join(root, "file.txt"), "original\n");
	git("add", "file.txt");
	git("commit", "-m", "initial");
	git("switch", "-c", "feature/pr");
	writeFileSync(join(root, "feature.txt"), "feature\n");
	git("add", "feature.txt");
	git("commit", "-m", "feature");
	const original = git("rev-parse", "HEAD");
	const destination = "git@github.com:acme/project.git";
	git("remote", "add", "origin", destination);
	git("push", bare, `${original}:refs/heads/feature/pr`);
	git("switch", "main");
	writeFileSync(join(root, "base.txt"), "base\n");
	git("add", "base.txt");
	git("commit", "-m", "base");
	const base = git("rev-parse", "HEAD");
	git("switch", "feature/pr");
	let authority = currentPullRequest({ conditions: { conflict: route === "update-branch", changesRequested: route === "sweep", ci: route === "fix-ci" ? "failure" : "success" } });
	authority = { ...authority, base: { ...authority.base, oid: base }, head: { ...authority.head, oid: original },
		target: { ...authority.target, remoteOid: original } };
	const pushes: string[][] = [];
	const ciAuthorities: string[] = [];
	const reservations: Array<{ run: unknown; head: string; base: string; lease: string | null }> = [];
	const exec: BoundedExec = async (command, args, options) => {
		assert.equal(args.includes("rebase"), false, "the existing merge must never be rebased");
		if (command === "gh" && args[0] === "repo") return execResult(JSON.stringify({ nameWithOwner: "acme/project", url: "https://github.com/acme/project" }));
		if (command === "gh" && args[0] === "api") {
			assert.equal(/\/check-runs|\/actions\//.test(args.at(-1) ?? ""), false, "stale CI must cancel before reading evidence");
			const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
			return execResult(JSON.stringify({ data: { repository: { pullRequest: { comments: empty, reviews: empty, reviewThreads: empty } } } }));
		}
		if (command === "git" && ["push", "ls-remote"].includes(args[0]!)) {
			if (args[0] === "push") pushes.push([...args]);
			args = args.map((arg) => arg === destination ? bare : arg);
		}
		return await spawnBounded(command, args, options);
	};
	const ids = [routeRunId, "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
	let run = 0;
	let abortDiscovery: AbortController | undefined;
	const app = harness({
		async load() {
			abortDiscovery?.abort(new Error("tool cancelled during authority read"));
			const remoteHead = git("ls-remote", bare, "refs/heads/feature/pr").split("\t")[0]!;
			return { ...authority, head: { ...authority.head, oid: remoteHead }, target: { ...authority.target, remoteOid: remoteHead },
				local: { worktree: "clean", head: git("rev-parse", "HEAD") === remoteHead ? "equal" : "ahead" } };
		},
		useDefaultCommandHandler: true, isIdle: () => false, newRunId: () => ids[run++]!,
		async canonicalWorktree() { return root; },
		createBranchUpdater: (options) => {
			reservations.push({ run: options.run, head: options.authority.head.oid, base: options.authority.base.oid, lease: options.authority.target.remoteOid });
			return new PullRequestBranchUpdater({ ...options, exec, agentDir: join(dir, "agent") });
		},
		createCommentSweep: (options) => new PullRequestCommentSweep({ ...options, exec, agentDir: join(dir, "agent") }),
		createWorkPublisher: (options) => new PullRequestWorkPublisher({ ...options, exec, agentDir: join(dir, "agent") }),
		createCiFixer: (options) => {
			reservations.push({ run: options.run, head: options.authority.head.oid, base: options.authority.base.oid, lease: options.authority.target.remoteOid });
			ciAuthorities.push(options.authority.head.oid);
			return new PullRequestCiFixer({ ...options, exec, agentDir: join(dir, "agent") });
		},
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		if (drift === "base") {
			git("switch", "main");
			git("commit", "--allow-empty", "-m", "advance base");
			authority.base = { ...authority.base, oid: git("rev-parse", "HEAD") };
			git("switch", "feature/pr");
		} else if (drift !== "conflict") git("merge", "--no-ff", "main", "-m", "merge main locally");
		const merged = git("rev-parse", "HEAD");
		if (drift !== "local" && drift !== "base") {
			if (drift !== "conflict") git("push", bare, `${merged}:refs/heads/feature/pr`);
			authority.conditions = { ...authority.conditions, conflict: false, ci: "failure" };
		}
		const queued = await app.beforeSettle(ctx);
		const tool = route === "fix-ci" ? "pi_pr_fix_ci" : route === "sweep" ? "pi_pr_sweep" : "pi_pr_update_branch";
		const action = route === "fix-ci" ? "collect" : route === "sweep" ? "start" : "rebase";
		assert.match(JSON.stringify(queued), route === "fix-ci" ? /pi-pr-fix-ci/ : route === "sweep" ? /pi-pr-comment-sweep/ : /pi-pr-update-branch/);
		if (drift === "tool-abort") {
			abortDiscovery = new AbortController();
			await assert.rejects(app.callTool(tool, { runId: ids[0], action }, ctx, abortDiscovery.signal), /abort|cancel/i);
			assert.equal(await app.beforeSettle(ctx), undefined);
			assert.equal(reservations.length, 1);
			assert.deepEqual(pushes, []);
			return;
		}
		const stale = (await app.callTool(tool, { runId: ids[0], action }, ctx)).details;
		if (drift === "local") assert.deepEqual(stale,
			{ kind: "stale", reason: `Local HEAD is ahead of the frozen PR head; cancelled before ${route === "fix-ci" ? "CI evidence" : route === "sweep" ? "sweep recovery" : "rebase"} or publication`,
				...(route === "update-branch" ? { authority: { ...authority, local: { worktree: "clean", head: "ahead" } } } : {}) });
		else {
			assert.equal((stale as { kind: string }).kind, "stale");
			assert.match((stale as { reason: string }).reason, drift === "base" ? /Base OID changed/ : drift === "conflict" ? /PR conflict cleared/ : /Published PR head advanced by fast-forward/);
		}
		assert.deepEqual(pushes, [], "stale detection never publishes");
		await assert.rejects(app.callTool(tool, { runId: ids[0], action }, ctx), /cancelled/);
		if (drift === "rediscovery-head") {
			git("commit", "--allow-empty", "-m", "another external publication");
			git("push", bare, "HEAD:refs/heads/feature/pr");
		}
		if (drift === "abort") ctx.signal = AbortSignal.abort(new Error("cancel stale handoff"));
		const next = await app.beforeSettle(ctx);
		if (drift === "rediscovery-head" || drift === "abort") {
			assert.equal(next, undefined);
			assert.equal(reservations.length, 1);
			assert.match(app.notifications.at(-1)!.message, drift === "abort" ? /cancel stale handoff/ : /remote head changed/);
			return;
		}
		if (drift !== "local") {
			assert.equal(next?.continue, true);
			assert.match(JSON.stringify(next), drift === "base" ? /pi-pr-update-branch/ : /pi-pr-fix-ci/);
			assert.equal(reservations.length, 2);
			assert.equal(reservations[1]!.run, reservations[0]!.run, "rediscovery keeps the invocation budgets");
			assert.equal(reservations[1]!.head, merged);
			assert.equal(reservations[1]!.lease, merged);
			assert.equal(reservations[1]!.base, authority.base.oid);
			await assert.rejects(app.callTool(tool, { runId: ids[0], action }, ctx), /wrong or stale/);
			assert.equal(git("rev-parse", "HEAD"), merged);
			assert.deepEqual(pushes, []);
			return;
		}
		assert.equal(next?.continue, true);
		assert.match(JSON.stringify(next), /pi-pr-publish-work/);
		await assert.rejects(app.callTool(tool, { runId: ids[0], action }, ctx), /wrong or stale/);
		assert.deepEqual((await app.callTool("pi_pr_publish_work", { runId: ids[1], action: "inspect" }, ctx)).details, { paths: [], head: merged, originalHead: original, diverged: false });
		await assert.rejects(app.callTool("pi_pr_publish_work", { runId: ids[1], action: "publish" }, ctx), /not validated/);
		await app.callTool("pi_pr_publish_work", { runId: ids[1], action: "validate", checks: [] }, ctx);
		await app.callTool("pi_pr_publish_work", { runId: ids[1], action: "publish" }, ctx);
		assert.deepEqual(pushes, [["push", "--porcelain", `--force-with-lease=refs/heads/feature/pr:${original}`,
			"--recurse-submodules=no", "--", destination, `${merged}:refs/heads/feature/pr`]]);
		assert.equal(git("ls-remote", bare, "refs/heads/feature/pr").split("\t")[0], merged);
		assert.equal(git("rev-parse", "HEAD"), merged);
		assert.deepEqual(app.messages, []);
		assert.match(app.notifications[0]!.message, /cancelled.*rediscovering \(1\/2\)/);
		if (route === "fix-ci") {
			const resumed = await app.beforeSettle(ctx);
			assert.equal(resumed?.continue, true);
			assert.match(JSON.stringify(resumed), /pi-pr-fix-ci/);
			assert.ok(JSON.stringify(resumed).includes(`runId=${ids[2]} action=collect`));
			assert.deepEqual(ciAuthorities, [original, merged]);
			await assert.rejects(app.callTool(tool, { runId: ids[0], action }, ctx), /wrong or stale/);
		}
		if (route === "sweep") {
			const resumed = await app.beforeSettle(ctx);
			assert.equal(resumed?.continue, true);
			assert.match(JSON.stringify(resumed), /pi-pr-comment-sweep/);
			const started = await app.callTool("pi_pr_sweep", { runId: ids[2], action: "start" }, ctx);
			assert.equal((started.details as { phase: string }).phase, "triage");
			assert.equal((started.details as { originalHead: string }).originalHead, merged);
		}
	} finally { await app.shutdown(ctx); }
});

for (const route of ["update-branch", "sweep", "fix-ci"] as const)
for (const drift of ["identity", "lease", "destination", "worktree", "failure", "recovery"] as const) test(`${route} stale-route continuation stops for ${drift} drift`, async () => {
	let stale = false;
	let loads = 0;
	const pr = currentPullRequest({ conditions: { conflict: route === "update-branch", changesRequested: route === "sweep", ci: route === "fix-ci" ? "failure" : "success" } });
	const app = harness({
		async load() {
			loads++;
			if (!stale) return pr;
			const fresh = { ...pr, local: { ...pr.local, head: "ahead" as const } };
			if (drift === "identity") fresh.id = "PR_unrelated";
			if (drift === "lease") fresh.head = { ...pr.head, oid: "c".repeat(40) };
			if (drift === "destination") fresh.target = { ...pr.target, ref: "other" };
			return fresh;
		},
		useDefaultCommandHandler: true, isIdle: () => false, newRunId: () => routeRunId,
		async canonicalWorktree() { return stale && drift === "worktree" ? "/other" : "/repo"; },
		inspectBranchRecovery: async () => { if (stale && drift === "recovery") throw new Error("rebase outcome is unverified; do not replay it"); return false; },
		createBranchUpdater: () => ({ state: { phase: "ready" }, async recoveryLaunchAction() { return "rebase"; },
			async rebase() { if (drift === "failure") throw new Error("git rebase was killed; its outcome is unknown"); return { kind: "stale", reason: "HEAD mismatch before mutation", authority: pr }; } }) as never,
		createCommentSweep: () => ({ async recoveryLaunchAction() { return "start"; }, async start() {
			if (drift === "failure") throw new Error("feedback fetch failed");
			throw new StaleSweepStart("HEAD mismatch before mutation");
		} }) as never,
		createCiFixer: () => ({ async collect() {
			if (drift === "failure") throw new Error("CI evidence read failed");
			throw new StaleCiCollect("HEAD mismatch before evidence");
		} }) as never,
		createWorkPublisher: () => { throw new Error("must not authorize publication"); },
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		await app.beforeSettle(ctx);
		const tool = route === "fix-ci" ? "pi_pr_fix_ci" : route === "sweep" ? "pi_pr_sweep" : "pi_pr_update_branch";
		const params = { runId: routeRunId, action: route === "fix-ci" ? "collect" : route === "sweep" ? "start" : "rebase" };
		if (drift === "failure") {
			await assert.rejects(app.callTool(tool, params, ctx), /outcome is unknown|feedback fetch failed|CI evidence read failed/);
		} else await app.callTool(tool, params, ctx);
		stale = true;
		const before = loads;
		assert.equal(await app.beforeSettle(ctx), undefined);
		assert.equal(loads, before + (["worktree", "failure"].includes(drift) ? 0 : 1));
		if (drift !== "failure") assert.match(app.notifications.at(-1)!.message, /continuation stopped/);
	} finally { await app.shutdown(ctx); }
});

for (const routes of [
	["update-branch", "update-branch", "update-branch"], ["sweep", "sweep", "sweep"],
	["fix-ci", "fix-ci", "fix-ci"], ["fix-ci", "sweep", "update-branch"],
] as const) test(`${routes.join(" → ")} pre-mutation drift shares only two fresh rediscoveries`, async () => {
	let runs = 0;
	let loads = 0;
	const ids = [1, 2, 3].map((n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`);
	const app = harness({
		async load() { loads++; const route = routes[Math.min(runs, 2)]; return currentPullRequest({ conditions: { conflict: route === "update-branch", changesRequested: route === "sweep", ci: route === "fix-ci" ? "failure" : "success" } }); },
		useDefaultCommandHandler: true, isIdle: () => false, newRunId: () => ids[runs++]!,
		async canonicalWorktree() { return "/repo"; },
		createBranchUpdater: (options) => ({ state: { phase: "ready" }, async recoveryLaunchAction() { return "rebase"; },
			async rebase() { return { kind: "stale", reason: "local HEAD advanced before rebase, then restored", authority: options.authority }; } }) as never,
		createCommentSweep: () => ({ async recoveryLaunchAction() { return "start"; },
			async start() { throw new StaleSweepStart("local HEAD advanced before triage, then restored"); } }) as never,
		createCiFixer: () => ({ async collect() { throw new StaleCiCollect("local HEAD advanced before evidence, then restored"); } }) as never,
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		await app.beforeSettle(ctx);
		for (let n = 0; n < 3; n++) {
			const route = routes[n];
			const tool = route === "fix-ci" ? "pi_pr_fix_ci" : route === "sweep" ? "pi_pr_sweep" : "pi_pr_update_branch";
			const action = route === "fix-ci" ? "collect" : route === "sweep" ? "start" : "rebase";
			await app.callTool(tool, { runId: ids[n], action }, ctx);
			const before = loads;
			const next = await app.beforeSettle(ctx);
			assert.equal(next?.continue, n < 2 ? true : undefined);
			assert.equal(loads, before + (n < 2 ? 1 : 0));
		}
		assert.equal(runs, 3);
		assert.match(app.notifications.at(-1)!.message, /rediscovery limit exhausted/);
		await assert.rejects(app.callTool("pi_pr_fix_ci", { runId: ids[0], action: "collect" }, ctx), /No PR workflow/);
	} finally { await app.shutdown(ctx); }
});

test("dirty diverged work is committed, synced onto the PR head, and published in one /pr", async () => {
	const ids = [1, 2].map((n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`);
	const locals: Array<CurrentPullRequest["local"]> = [
		{ worktree: "dirty", head: "diverged" }, { worktree: "clean", head: "diverged" }, { worktree: "clean", head: "ahead" },
	];
	let loads = 0;
	let runs = 0;
	const syncs: string[] = [];
	const committed = "c".repeat(40);
	const app = harness({
		async load() { return { ...currentPullRequest(), local: locals[Math.min(loads++, locals.length - 1)]! }; },
		useDefaultCommandHandler: true, newRunId: () => ids[runs++]!,
		async canonicalWorktree() { return "/repo"; },
		createWorkPublisher: () => ({
			async inspect() { return { paths: ["file.ts"], head: "d".repeat(40), originalHead: "b".repeat(40), diverged: true }; },
			async commit() { return { head: committed, diverged: true }; },
			async validate() { throw new Error("validate must wait for the synced HEAD"); },
		}) as never,
		async syncLocalHead({ authority }) { syncs.push(authority.head.oid); return { kind: "rebased", head: "e".repeat(40) }; },
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.messages, [`/skill:pi-pr-publish-work runId=${ids[0]} action=inspect`]);
		assert.deepEqual((await app.callTool("pi_pr_publish_work", { runId: ids[0], action: "commit", ownedPaths: ["file.ts"], message: "fix: scoped" }, ctx)).details,
			{ head: committed, diverged: true });
		await assert.rejects(app.callTool("pi_pr_publish_work", { runId: ids[0], action: "validate", checks: [] }, ctx), /cancelled; fresh routing is pending/);
		await app.beforeSettle(ctx);
		assert.deepEqual(syncs, ["b".repeat(40)]);
		assert.equal(app.messages.length, 2, "the synced branch is published in the same invocation");
		assert.deepEqual(app.messages.at(-1), `/skill:pi-pr-publish-work runId=${ids[1]} action=inspect`);
		assert.ok(app.notifications.some(({ message }) => /syncing before publication; rediscovering \(1\/2\)/.test(message)));
		assert.ok(app.notifications.some(({ message }) => /local branch rebased onto the PR head/.test(message)));
	} finally { await app.shutdown(ctx); }
});

test("one /pr continues from a final answer through hidden boundaries until external CI", async () => {
	let stage = 0;
	let run = 0;
	const ids = [1, 2, 3, 4].map((n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`);
	const app = harness({
		async load() {
			if (stage === 0) return noPullRequest(1);
			const pr = currentPullRequest({ conditions: {
				conflict: stage === 1, ci: stage === 2 ? "failure" : stage === 4 ? "running" : "success",
				unresolvedThreads: stage === 3 ? 1 : 0,
			} });
			return pr;
		},
		useDefaultCommandHandler: true,
		isIdle: () => stage === 0,
		newRunId: () => ids[run++]!,
		async canonicalWorktree() { return "/canonical/repo"; },
		createPullRequestCreator() { return {
			state: { phase: "unprepared" },
			async publish() { stage = 1; return { kind: "published", url: "https://github.com/acme/project/pull/42" }; },
		} as never; },
		createBranchUpdater() { return {
			state: { phase: "verified" },
			async recoveryLaunchAction() { return "rebase" as const; },
			async publish() { stage = 2; return { kind: "published", head: "b".repeat(40) }; },
		} as never; },
		createCiFixer() { return {
			async publish() { stage = 3; return { kind: "published", head: "b".repeat(40), attempt: "applied" }; },
		} as never; },
		createCommentSweep() { return {
			async recoveryLaunchAction() { return "start" as const; },
			async finalize() { stage = 4; return { kind: "finalized" }; },
		} as never; },
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		const boundaryPrompts: string[] = [];
		for (const [tool, args] of [
			["pi_pr_create", { action: "publish", title: "fix", body: "Summary" }],
			["pi_pr_update_branch", { action: "publish" }],
			["pi_pr_fix_ci", { action: "publish" }],
			["pi_pr_sweep", { action: "finalize", guard: { epoch: 1, runId: "run", generation: 1, fingerprint: "a".repeat(64) }, checks: [] }],
		] as const) {
			await app.callTool(tool, { runId: ids[stage], ...args }, ctx);
			const result = await app.beforeSettle(ctx);
			if (result) {
				assert.equal(result.continue, true);
				const entry = result.entries![0]!;
				assert.equal(entry.type, "custom_message");
				if (entry.type === "custom_message") { assert.equal(entry.display, false); boundaryPrompts.push(String(entry.content)); }
			}
		}
		assert.equal(stage, 4);
		assert.deepEqual(app.messages, [`/skill:pi-pr-create runId=${ids[0]} action=prepare`]);
		assert.deepEqual(boundaryPrompts.map((prompt) => prompt.match(/name="([^"]+)"/)?.[1]),
			["pi-pr-update-branch", "pi-pr-fix-ci", "pi-pr-comment-sweep"]);
		assert.match(app.notifications.at(-1)!.message, /waiting for CI/);
	} finally { await app.shutdown(ctx); }
});

for (const quotaExhausted of [false, true]) test(quotaExhausted
	? "creation continuation does not retry an exhausted GitHub quota at settlement"
	: "creation continuation refreshes the footer when it stops for CI", async () => {
	let published = false;
	let idle = true;
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			if (published && quotaExhausted) throw new GitHubRateLimitError();
			return published ? currentPullRequest({ conditions: { ci: "running" } }) : noPullRequest(1);
		},
		useDefaultCommandHandler: true,
		isIdle: () => idle,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createPullRequestCreator() { return {
			state: { phase: "unprepared" },
			async publish() { published = true; return { kind: "published", url: "https://github.com/acme/project/pull/42" }; },
		} as never; },
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		idle = false;
		await app.callTool("pi_pr_create", { runId: routeRunId, action: "publish", title: "fix", body: "Summary" }, ctx);
		await app.beforeSettle(ctx);
		if (quotaExhausted) assert.equal(app.statuses.at(-1), undefined);
		else {
			assert.match(plain(String(app.statuses.at(-1))), /PR #42.*CI running/);
			assert.equal(app.widgets.at(-1), undefined, "the action hint waits until the agent settles");
		}
		const loadsBeforeSettlement = loads;
		idle = true;
		await app.settle(ctx);
		if (quotaExhausted) {
			assert.match(app.notifications.at(-1)!.message, /rate limit exhausted/);
			assert.equal(loads, loadsBeforeSettlement, "settlement must not immediately retry failed discovery");
		} else {
			assert.match(plain(String(app.statuses.at(-1))), /PR #42.*CI running/);
		}
	} finally { await app.shutdown(ctx); }
});

test("a completed helper does not repeat its route when fresh evidence is unchanged", async () => {
	const pr = currentPullRequest({ conditions: { ci: "failure" } });
	const app = harness({
		async load() { return pr; }, useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createCiFixer() { return { async publish() { return { kind: "published", head: pr.head.oid, attempt: "applied" }; } } as never; },
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		await app.callTool("pi_pr_fix_ci", { runId: routeRunId, action: "publish" }, ctx);
		for (const outcome of ["aborted", "error"]) await app.beforeSettle(ctx, outcome);
		assert.equal(app.notifications.length, 0, "unsuccessful outcomes must not rediscover or continue");
		await app.beforeSettle(ctx);
		assert.equal(app.messages.length, 1);
		assert.match(app.notifications.at(-1)!.message, /already ran/);
	} finally { await app.shutdown(ctx); }
});

test("matching sweep recovery precedes a dirty or behind local gate", async () => {
	const pr = currentPullRequest();
	pr.local.worktree = "dirty";
	pr.local.head = "behind";
	const app = harness({
		async load() { return pr; }, useDefaultCommandHandler: true,
		inspectSweepRecovery: async () => true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createCommentSweep() { return { async recoveryLaunchAction() { return "resume" as const; } } as never; },
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.messages, [`/skill:pi-pr-comment-sweep runId=${routeRunId} action=resume`]);
	} finally { await app.shutdown(ctx); }
});

test("matching verified rebase recovery outranks a diverged local head and sweep", async () => {
	const pr = currentPullRequest({ conditions: { conflict: false, unresolvedThreads: 1 } });
	pr.local.head = "diverged";
	const app = harness({
		async load() { return pr; }, useDefaultCommandHandler: true,
		inspectBranchRecovery: async () => true,
		inspectSweepRecovery: async () => { throw new Error("sweep must wait for rebase publication"); },
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createBranchUpdater() { return {
			state: { phase: "verified" },
			async recoveryLaunchAction() { return "rebase" as const; },
			async rebase() { return { kind: "verified", head: pr.head.oid, fastForward: false }; },
		} as never; },
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.messages, [`/skill:pi-pr-update-branch runId=${routeRunId} action=rebase`]);
		assert.deepEqual((await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "rebase" }, ctx)).details,
			{ kind: "verified", head: pr.head.oid, fastForward: false });
	} finally { await app.shutdown(ctx); }
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
				async recoveryLaunchAction() { return "rebase" as const; },
				async rebase() { calls.push("rebase"); state.phase = "verified"; return { kind: "verified", head: authority.head.oid, fastForward: false }; },
				async continue() { calls.push("continue"); return { kind: "verified", head: authority.head.oid, fastForward: false }; },
				async publish() { calls.push("publish"); return { kind: "published", head: authority.head.oid }; },
			} as never;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.messages, [`/skill:pi-pr-update-branch runId=${routeRunId} action=rebase`]);

		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: "22222222-2222-4222-8222-222222222222", action: "rebase" }, ctx),
			/wrong or stale/,
		);
		await assert.rejects(
			app.callTool("pi_pr_create", { runId: routeRunId, action: "prepare" }, ctx),
			/route is update-branch, not create/,
		);
		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "rebase" }, { ...ctx, cwd: "/other" }),
			/worktree is wrong or stale/,
		);
		await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "rebase" }, ctx);
		await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "publish" }, ctx);
		assert.deepEqual(calls, ["rebase", "publish"]);

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
		assert.equal(app.statuses.at(-1), undefined, "stale command discovery must not replace the new session footer");
		assert.equal(canonicalCalls, 0);
		assert.deepEqual(app.messages, []);
		await assert.rejects(
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "rebase" }, replacement),
			/No PR workflow is active/,
		);
	} finally {
		await app.shutdown(replacement);
	}
});

for (const cancelled of [false, true]) test(`does not render command discovery from ${cancelled ? "an aborted lookup" : "another cwd"}`, async () => {
	const pending = deferred<CurrentPullRequest>();
	let loads = 0;
	const app = harness({
		async load() { return ++loads === 2 ? pending.promise : { kind: "inactive" }; },
		useDefaultCommandHandler: true,
		async canonicalWorktree() { throw new Error("stop after discovery"); },
	});
	const ctx = app.context();
	const controller = new AbortController();
	const commandContext = { ...ctx, cwd: cancelled ? ctx.cwd : "/other", signal: controller.signal };
	try {
		await app.start(ctx);
		const command = app.command().handler("", commandContext as ExtensionCommandContext);
		if (cancelled) controller.abort();
		pending.resolve(currentPullRequest({ conditions: { conflict: true } }));
		await assert.rejects(command, /stop after discovery/);
		assert.ok(app.statuses.every((status) => status === undefined), "unrelated discovery must never enter the footer");
	} finally { await app.shutdown(ctx); }
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
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "rebase" }, replacement),
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
		createBranchUpdater() { reservations += 1; return { async recoveryLaunchAction() { return "rebase" as const; } } as never; },
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
			app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "rebase" }, replacement),
			/No PR workflow is active/,
		);
	} finally {
		await app.shutdown(replacement);
	}
});

for (const route of ["update-branch", "fix-ci"] as const) test(`session replacement aborts an in-flight ${route} helper`, async () => {
	const authority = currentPullRequest({ conditions: { conflict: route === "update-branch", ci: route === "fix-ci" ? "failure" : "success" } });
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
		createCiFixer(options) {
			const signal = options.signal;
			assert.ok(signal);
			helperSignal = signal;
			return { async collect() { actionStarted.resolve(); return await waitForAbort(signal); } } as never;
		},
		createBranchUpdater(options) {
			const signal = options.signal;
			assert.ok(signal);
			helperSignal = signal;
			return {
				state,
				async recoveryLaunchAction() { return "rebase" as const; },
				async rebase() {
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
		const action = app.callTool(route === "fix-ci" ? "pi_pr_fix_ci" : "pi_pr_update_branch", { runId: routeRunId, action: route === "fix-ci" ? "collect" : "rebase" }, first);
		const cancelled = assert.rejects(action, (error) => {
			assert.equal(error, helperSignal?.reason);
			return true;
		});
		await actionStarted.promise;
		await app.start(replacement);
		await cancelled;
		assert.equal(helperSignal?.aborted, true);
		assert.equal(await app.beforeSettle(replacement), undefined);
		await assert.rejects(app.callTool(route === "fix-ci" ? "pi_pr_fix_ci" : "pi_pr_update_branch", { runId: routeRunId, action: route === "fix-ci" ? "collect" : "rebase" }, replacement), /No PR workflow/);
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
				async recoveryLaunchAction() { return "rebase" as const; },
				async rebase() {
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
			{ runId: routeRunId, action: "rebase" },
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

for (const outcome of ["completed", "aborted", "error"]) {
	test(`busy /pr launch is consumed at boundary or cancelled (${outcome})`, async () => {
		let idle = false;
		let loads = 0;
		const app = harness({
			async load() { loads += 1; return currentPullRequest({ conditions: { ci: "failure" } }); },
			useDefaultCommandHandler: true, isIdle: () => idle, newRunId: () => routeRunId,
			async canonicalWorktree() { return "/canonical/repo"; },
			createCiFixer: () => ({} as never),
		});
		const ctx = app.context();
		try {
			await app.start(ctx);
			await app.command().handler("", ctx as ExtensionCommandContext);
			assert.deepEqual(app.messages, []);
			const result = await app.beforeSettle(ctx, outcome);
			if (outcome === "completed") {
				assert.equal(result?.continue, true);
				const entry = result?.entries?.[0];
				assert.equal(entry?.type, "custom_message");
				if (entry?.type === "custom_message") {
					assert.equal(entry.display, false);
					assert.match(String(entry.content), /name="pi-pr-fix-ci"/);
					assert.match(String(entry.content), new RegExp(`runId=${routeRunId} action=collect`));
				}
				assert.equal(await app.beforeSettle(ctx), undefined, "an unused launch is not replayed");
			} else assert.equal(result, undefined);
			assert.equal(loads, 2, "launch handoff must not rediscover the reserved route");
			idle = true;
			await app.settle(ctx);
			assert.equal(loads, 3);
			await assert.rejects(app.callTool("pi_pr_fix_ci", { runId: routeRunId, action: "collect" }, ctx), /No PR workflow is active/);
		} finally { await app.shutdown(ctx); }
	});
}

test("reports an unreadable boundary skill and releases its reserved run without retry", async () => {
	let loads = 0;
	const app = harness({
		async load() { loads += 1; return currentPullRequest({ conditions: { ci: "failure" } }); },
		useDefaultCommandHandler: true, isIdle: () => false, newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createCiFixer: () => ({} as never), skillPath: "/missing/pi-pr-fix-ci/SKILL.md",
	});
	const ctx = app.context();
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.equal(await app.beforeSettle(ctx), undefined);
		assert.match(app.notifications.at(-1)!.message, /PR continuation stopped:.*ENOENT/);
		assert.equal(loads, 2, "failed launch must not immediately retry discovery");
		await assert.rejects(app.callTool("pi_pr_fix_ci", { runId: routeRunId, action: "collect" }, ctx), /No PR workflow is active/);
	} finally { await app.shutdown(ctx); }
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
				async recoveryLaunchAction() { return "rebase" as const; },
				async rebase() {
					calls.push("rebase");
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
		await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "rebase" }, ctx);
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
		assert.deepEqual(calls, ["rebase", "continue:conflicted.ts"]);
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
				async recoveryLaunchAction() { return "rebase" as const; },
				async rebase() {
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
		await app.callTool("pi_pr_update_branch", { runId: routeRunId, action: "rebase" }, ctx);
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
		async load() {
			return noPullRequest(1);
		},
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createPullRequestCreator() {
			return {
				state: creatorState,
				async prepare(base?: string) { createCalls.push(["prepare", base]); creatorState.phase = "prepared"; return { kind: "prepared" }; },
				async inspect() { return { paths: [], head: "b".repeat(40) }; },
				async commit() { return { head: "b".repeat(40) }; },
				async verify() { createCalls.push(["verify"]); return { kind: "verified" }; },
				async push() { createCalls.push(["push"]); return { kind: "pushed" }; },
				async publish(title: string, body: string) { createCalls.push(["publish", title, body]); return { kind: "published", url: "https://github.com/acme/project/pull/42" }; },
			} as never;
		},
	});
	const createContext = create.context();
	try {
		await create.start(createContext);
		await create.command().handler("", createContext as ExtensionCommandContext);
		await create.callTool("pi_pr_create", { runId: routeRunId, action: "prepare" }, createContext);
		assert.deepEqual(createCalls, [["prepare", undefined]]);
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
				async recoveryLaunchAction() { return "start" as const; },
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

test("feedback record, commit, resolution, and finalization require no UI confirmation", async () => {
	const calls: string[] = [];
	const guard = { epoch: 1, runId: "sweep", generation: 1, fingerprint: "a".repeat(64) };
	const app = harness({
		async load() { return currentPullRequest({ conditions: { unresolvedThreads: 1 } }); },
		useDefaultCommandHandler: true,
		newRunId: () => routeRunId,
		async canonicalWorktree() { return "/canonical/repo"; },
		createCommentSweep() { return {
			async recoveryLaunchAction() { return "start" as const; },
			async record() { calls.push("record"); return { phase: "recorded", guard }; },
			async commit(receivedGuard: unknown, message: string) {
				assert.deepEqual(receivedGuard, guard);
				assert.equal(message, "fix: address review");
				calls.push("commit");
				return { head: "b".repeat(40) };
			},
			async resolve() { calls.push("resolve"); return { phase: "resolved", guard }; },
			async finalize() { calls.push("finalize"); return { kind: "finalized", head: "a".repeat(40) }; },
		} as never; },
	});
	const base = app.context();
	const ctx = { ...base, ui: { ...base.ui, async confirm() { throw new Error("unexpected approval prompt"); } } } as ExtensionContext;
	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		for (const action of ["record", "commit", "resolve", "finalize"] as const) {
			await app.callTool("pi_pr_sweep", { runId: routeRunId, action, guard,
				...(action === "record" ? { ledger: [], ownedPaths: [] } : {}),
				...(action === "commit" ? { message: "fix: address review" } : {}),
				...(action === "finalize" ? { checks: [] } : {}),
			}, ctx);
		}
		assert.deepEqual(calls, ["record", "commit", "resolve", "finalize"]);
	} finally { await app.shutdown(ctx); }
});

test("fresh automatic feedback sweeps rotate route IDs and resume package recovery after settlement", async () => {
	const firstRunId = routeRunId;
	const secondRunId = "22222222-2222-4222-8222-222222222222";
	const runIds = [firstRunId, secondRunId];
	const authority = currentPullRequest({ conditions: { unresolvedThreads: 1 } });
	const inspections: string[] = [];
	const actions: string[] = [];
	let recoveryExists = false;
	let loads = 0;
	let runIndex = 0;
	const app = harness({
		async load() { loads += 1; return authority; },
		useDefaultCommandHandler: true,
		newRunId: () => runIds[runIndex++]!,
		async canonicalWorktree() { return "/canonical/repo"; },
		createCommentSweep(options) {
			assert.equal(options.cwd, "/canonical/repo");
			assert.equal(options.authority, authority);
			return {
				async recoveryLaunchAction() {
					const action = recoveryExists ? "resume" : "start";
					inspections.push(action);
					return action;
				},
				async start() {
					actions.push("start");
					recoveryExists = true;
					return { phase: "triage" };
				},
				async resume() {
					actions.push("resume");
					return { phase: "triage" };
				},
			} as never;
		},
	});
	const ctx = app.context();

	try {
		await app.start(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.messages, [
			`/skill:pi-pr-comment-sweep runId=${firstRunId} action=start`,
		]);
		await app.callTool("pi_pr_sweep", { runId: firstRunId, action: "start" }, ctx);
		await app.settle(ctx);
		await assert.rejects(
			app.callTool("pi_pr_sweep", { runId: firstRunId, action: "resume" }, ctx),
			/run \/pr/,
		);

		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.deepEqual(app.messages, [
			`/skill:pi-pr-comment-sweep runId=${firstRunId} action=start`,
			`/skill:pi-pr-comment-sweep runId=${secondRunId} action=resume`,
		]);
		await assert.rejects(
			app.callTool("pi_pr_sweep", { runId: firstRunId, action: "resume" }, ctx),
			/wrong or stale/,
		);
		await app.callTool("pi_pr_sweep", { runId: secondRunId, action: "resume" }, ctx);
		assert.deepEqual(inspections, ["start", "resume"]);
		assert.deepEqual(actions, ["start", "resume"]);
		assert.equal(loads, 4, "each /pr must run fresh discovery");
	} finally {
		await app.shutdown(ctx);
	}
});

test("direct workflow tools without a route tell the caller to run /pr", async () => {
	const app = harness({ async load() { return { kind: "inactive" }; } });
	const ctx = app.context();
	const calls = [
		["pi_pr_update_branch", { runId: routeRunId, action: "rebase" }],
		["pi_pr_create", { runId: routeRunId, action: "prepare" }],
		["pi_pr_sweep", { runId: routeRunId, action: "start" }],
		["pi_pr_fix_ci", { runId: routeRunId, action: "collect" }],
	] as const;

	for (const [tool, params] of calls) {
		await assert.rejects(app.callTool(tool, params, ctx), (error: unknown) => {
			assert(error instanceof Error);
			assert.match(error.message, /run \/pr/);
			assert.doesNotMatch(error.message, /\/sweep/);
			return true;
		});
	}
});

test("starts PR discovery without blocking the next extension and publishes the result later", async () => {
	const pending = deferred<CurrentPullRequest>();
	const app = harness({ async load() { return pending.promise; } });
	const ctx = app.context();

	try {
		const started = await Promise.race([
			app.startNow(ctx).then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
		]);
		assert.equal(started, true, "session_start must not await GitHub discovery");
		assert.equal(app.statuses.at(-1), undefined);
		assert.equal(app.widgets.at(-1), undefined);
		pending.resolve(currentPullRequest());
		await flush();
		assert.match(app.statuses.at(-1) ?? "", /PR #42/);
	} finally {
		pending.resolve(currentPullRequest());
		await app.shutdown(ctx);
	}
});

test("cancels pending presentation discovery before /pr reads fresh authority", async () => {
	const pending = deferred<CurrentPullRequestDiscovery>();
	let loads = 0;
	let presentationAbortedAtCommandLoad = false;
	let presentationSignal: AbortSignal | undefined;
	const app = harness({
		useDefaultCommandHandler: true,
		async load(_pi, context) {
			if (++loads === 1) {
				presentationSignal = context.signal;
				return pending.promise;
			}
			if (loads === 2) presentationAbortedAtCommandLoad = presentationSignal?.aborted ?? false;
			return { kind: "inactive" };
		},
	});
	const ctx = app.context();

	try {
		await app.startNow(ctx);
		await app.command().handler("", ctx as ExtensionCommandContext);
		assert.equal(loads >= 2, true, "/pr must perform fresh discovery");
		assert.equal(presentationAbortedAtCommandLoad, true);
		pending.resolve({ kind: "current", pullRequest: currentPullRequest() });
		await flush();
		assert.equal(app.statuses.at(-1), undefined, "cancelled presentation must not overwrite the command result");
	} finally {
		pending.resolve({ kind: "inactive" });
		await app.shutdown(ctx);
	}
});

test("clears the previous session PR status and action while new discovery is pending", async () => {
	const pending = deferred<CurrentPullRequestDiscovery>();
	let loads = 0;
	const app = harness({ async load() { return ++loads === 1 ? currentPullRequest() : pending.promise; } });
	const first = app.context();
	const replacement = app.context();

	try {
		await app.start(first);
		assert.match(app.statuses.at(-1) ?? "", /PR #42/);
		assert.notEqual(app.widgets.at(-1), undefined);
		await app.startNow(replacement);
		assert.equal(app.statuses.at(-1), undefined);
		assert.equal(app.widgets.at(-1), undefined);
		pending.resolve({ kind: "inactive" });
		await flush();
		assert.equal(app.statuses.at(-1), undefined);
	} finally {
		pending.resolve({ kind: "inactive" });
		await app.shutdown(replacement);
	}
});

test("stays silent outside a Git worktree", async () => {
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			return { kind: "inactive" };
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	assert.ok(app.statuses.every((status) => status === undefined));
	assert.ok(app.widgets.every((widget) => widget === undefined));
	assert.deepEqual(app.notifications, []);
	assert.equal(loads, 1);

	await app.shutdown(ctx);
});

test("does not poll presentation or duplicate observations", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const pullRequest = currentPullRequest();
	const expected = pullRequestObservation(pullRequest);
	assert.ok(expected);
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			return pullRequest;
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	assert.equal(loads, 1);
	assert.deepEqual(app.appended, [{ customType: "pi-pr-observation", data: expected }]);

	t.mock.timers.tick(60_000);
	await flush();
	assert.equal(loads, 1, "advancing time must not perform another presentation load");
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

test("stays silent when a worktree becomes inactive after a native refresh", async () => {
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
	assert.equal(loads, 1);
	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(loads, 2);
	assert.deepEqual(app.statuses.at(-1), undefined);
	assert.deepEqual(app.widgets.at(-1), undefined);

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(loads, 2, "an inactive worktree must stay silent");

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

test("warns once for one blocked issue and warns again after recovery", async () => {
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
		{ kind: "blocked", issue: { kind: "candidate-prs-ambiguous", urls: [
			new URL("https://github.com/acme/project/pull/42"),
			new URL("https://github.com/acme/project/pull/43"),
		] } },
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
	assert.equal(app.notifications.length, 1);
	assert.equal(app.notifications[0]?.type, "warning");
	assert.match(app.notifications[0]?.message ?? "", /pull\/42, https:\/\/github\.com\/acme\/project\/pull\/43/);

	for (const command of ["git push origin HEAD", "git commit -m recovery", "git push origin HEAD"]) {
		await app.tool({ toolName: "bash", input: { command }, isError: false }, ctx);
	}
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
	assert.deepEqual(app.widgets.at(-1), widgetLine("! Run /pr to wait for CI, then continue"));

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(signals.length, 3);
	assert.equal(app.statuses.at(-1), undefined);
	assert.deepEqual(app.widgets.at(-1), widgetLine("● Run /pr to create pull request"));

	await app.shutdown(ctx);
});

test("failed CI replaces review feedback in the footer on refresh", async () => {
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

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
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

test("animates and clears a width-aware TUI routing widget at route resolution", async (t) => {
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
	const renderWidget = (widget: unknown, width: number): string[] => {
		assert.equal(typeof widget, "function");
		const component = (widget as (tui: unknown, theme: {
			fg(color: string, text: string): string;
		}) => { render(width: number): string[] })({}, {
			fg(color, text) { return `<${color}>${text}</${color}>`; },
		});
		return component.render(width);
	};

	try {
		await app.start(ctx);
		const statusWrites = app.statuses.length;
		const command = app.command().handler("", ctx as ExtensionCommandContext);
		const firstWidget = app.widgets.at(-1);
		assert.deepEqual(renderWidget(firstWidget, 0), []);
		assert.match(renderWidget(firstWidget, 80)[0] ?? "", /<accent>⠋<\/accent> Checking pull request…/);
		assert.ok(renderWidget(firstWidget, 8).every((line) => visibleWidth(line) <= 8));

		t.mock.timers.tick(80);
		assert.match(renderWidget(app.widgets.at(-1), 80)[0] ?? "", /<accent>⠙<\/accent> Checking pull request…/);

		discovery.resolve();
		await flush();
		assert.equal(app.widgets.at(-1), undefined, "routing feedback clears before route interaction");
		assert.equal(app.statuses.length, statusWrites, "routing must preserve the footer");
		const widgetWrites = app.widgets.length;
		t.mock.timers.tick(160);
		assert.equal(app.widgets.length, widgetWrites, "route resolution must stop animation");

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

test("reports startup render failures without publishing a broken status", async () => {
	const app = harness({
		async load() {
			return currentPullRequest();
		},
		theme() {
			throw new Error("theme failed");
		},
	});
	const ctx = app.context();

	await app.start(ctx);
	assert.deepEqual(app.notifications, [{ message: "PR status refresh failed: status unavailable", type: "error" }]);
	assert.ok(app.statuses.every((status) => status === undefined));
	await app.shutdown(ctx);
});

test("reports detached render failures once and resumes after recovery", async () => {
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
	failure = "native render failed";
	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.deepEqual(app.notifications, [{
		message: "PR status refresh failed: status unavailable",
		type: "error",
	}]);
	assert.equal(app.statuses.length, statusWritesBeforeFailure);
	assert.equal(app.widgets.length, widgetWritesBeforeFailure);

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(app.notifications.length, 1, "persistent refresh failures must not spam notifications");

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

test("reports lookup failures once, clears stale actions, and resets after recovery", async () => {
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
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR · status unavailable");
	assert.equal(app.widgets.at(-1), undefined);

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(app.notifications.length, 1, "repeated lookup failures must not spam notifications");

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI failed");
	assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));
	const statusWrites = app.statuses.length;
	const widgetWrites = app.widgets.length;

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
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

test("reports generic then sanitized rate-limit failures, clears its stale action, and does not retry /pr", async () => {
	let loads = 0;
	const app = harness({
		async load() {
			loads += 1;
			if (loads === 1) return currentPullRequest({ conditions: { ci: "failure" } });
			if (loads === 2) throw new Error("native refresh failed");
			throw new GitHubRateLimitError();
		},
		useDefaultCommandHandler: true,
	});
	const ctx = app.context();

	await app.start(ctx);
	assert.deepEqual(app.widgets.at(-1), widgetLine("✗ Run /pr to fix CI"));

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.deepEqual(app.notifications, [{
		message: "PR status refresh failed: status unavailable",
		type: "error",
	}]);
	assert.equal(app.widgets.at(-1), undefined);

	await assert.rejects(
		app.command().handler("", ctx as ExtensionCommandContext),
		(error: unknown) => error instanceof GitHubRateLimitError,
	);
	assert.equal(loads, 3);
	assert.deepEqual(app.notifications, [
		{
			message: "PR status refresh failed: status unavailable",
			type: "error",
		},
		{
			message: "GitHub API rate limit exhausted; retry after GitHub resets it",
			type: "error",
		},
	]);
	assert.equal(
		app.notifications.filter(({ message }) => message === "GitHub API rate limit exhausted; retry after GitHub resets it").length,
		1,
	);
	assert.doesNotMatch(app.notifications.at(-1)?.message ?? "", /secret|password|token/i);
	assert.equal(app.widgets.at(-1), undefined, "a rate-limited /pr must clear the stale action");

	await flush();
	assert.equal(loads, 3, "a rate-limited /pr must not schedule an immediate refresh");
	await app.shutdown(ctx);
});

test("serializes native-event refreshes, retains loader errors, and stops cleanly", async () => {
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
	const pendingRefresh = app.tool({
		toolName: "bash",
		input: { command: "gh pr create --fill" },
		isError: false,
	}, ctx);
	await flush();
	assert.equal(calls, 2);
	assert.equal(signals[1]?.aborted, false);

	await app.tool({ toolName: "bash", input: { command: "git push origin HEAD" }, isError: false }, ctx);
	assert.equal(calls, 2, "matching tool result queues behind the active refresh");

	pending.resolve(currentPullRequest({ conditions: { ci: "running" } }));
	await pendingRefresh;
	await flush();
	assert.equal(calls, 3, "queued refresh runs after the active request");
	assert.equal(plain(app.statuses.at(-1) ?? ""), "PR #42 · CI running");
	assert.equal(app.widgets.at(-1), undefined);
	assert.deepEqual(app.notifications, [{
		message: "PR status refresh failed: status unavailable",
		type: "error",
	}]);

	const shutdownRefresh = app.tool({
		toolName: "bash",
		input: { command: "git push origin HEAD" },
		isError: false,
	}, ctx);
	await flush();
	assert.equal(calls, 4);
	assert.equal(signals[3]?.aborted, false);
	await app.tool({ toolName: "bash", input: { command: "gh pr create --fill" }, isError: false }, ctx);
	assert.equal(calls, 4, "matching tool result queues behind the signal-ignoring request");

	const statusWritesBeforeShutdown = app.statuses.length;
	const widgetWritesBeforeShutdown = app.widgets.length;
	await app.shutdown(ctx);
	assert.equal(signals[3]?.aborted, true);
	const callsAfterShutdown = calls;

	duringShutdown.resolve(currentPullRequest());
	await shutdownRefresh;
	await flush();
	assert.equal(calls, callsAfterShutdown, "shutdown must not restart queued refreshes");
	assert.equal(app.statuses.length, statusWritesBeforeShutdown, "shutdown request must not render a status");
	assert.equal(app.widgets.length, widgetWritesBeforeShutdown, "shutdown request must not render a widget");
});

test("session replacement stops routing animation before stale /pr completion", async (t) => {
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
	assert.equal(typeof app.widgets.at(-1), "function");
	const widgetWritesBeforeTick = app.widgets.length;
	t.mock.timers.tick(80);
	assert.equal(app.widgets.length, widgetWritesBeforeTick + 1);
	assert.equal(typeof app.widgets.at(-1), "function");

	await app.shutdown(firstSession);
	const widgetWritesAfterShutdown = app.widgets.length;
	t.mock.timers.tick(160);
	assert.equal(app.widgets.length, widgetWritesAfterShutdown, "shutdown must stop the stale spinner timer");
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
		const toolRefresh = staleCreate.tool({
			toolName: "bash",
			input: { command: "git push origin HEAD" },
			isError: false,
		}, staleCreateContext);
		await flush();

		await staleCreate.command().handler("", staleCreateContext as ExtensionCommandContext);
		await flush();
		assert.equal(plain(staleCreate.statuses.at(-1) ?? ""), "PR #42 · merge-ready");

		staleNull.resolve(noPullRequest());
		await toolRefresh;
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
		const toolRefresh = stalePullRequest.tool({
			toolName: "bash",
			input: { command: "git push origin HEAD" },
			isError: false,
		}, stalePullRequestContext);
		await flush();

		await stalePullRequest.command().handler("", stalePullRequestContext as ExtensionCommandContext);
		assert.equal(stalePullRequest.statuses.at(-1), undefined);
		assert.equal(stalePullRequest.widgets.at(-1), undefined);

		stalePr.resolve(currentPullRequest());
		await toolRefresh;
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

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createPrCommandHandler } from "../extensions/pr-command.ts";

const cwd = "/repo";
const localHead = "a".repeat(40);
const nextHead = "b".repeat(40);
const baseHead = "c".repeat(40);
const DEFAULT_HOST = "github.com";
const workflowRunId = "11111111-1111-4111-8111-111111111111";

type PullRequestSpec = {
	id?: string;
	number?: number;
	host?: string;
	state?: "OPEN" | "MERGED" | "CLOSED";
	isDraft?: boolean;
	baseRepository?: string;
	baseRefName?: string;
	baseRefOid?: string;
	headRefOid?: string;
	mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	mergeStateStatus?: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
	reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	statusCheckRollup?: unknown[];
	methods?: {
		mergeCommitAllowed: boolean;
		rebaseMergeAllowed: boolean;
		squashMergeAllowed: boolean;
		viewerDefaultMergeMethod: "MERGE" | "REBASE" | "SQUASH";
	};
};

type CommandSpec = {
	name: string;
	source: "extension" | "skill";
	origin: "package" | "top-level";
};

type Call = { command: string; args: string[] };

type HarnessOptions = {
	states: Array<PullRequestSpec | null>;
	commands?: CommandSpec[];
	idle?: boolean;
	confirmed?: boolean;
	status?: string;
	statuses?: string[];
	ancestry?: "behind" | "ahead" | "diverged";
	baseRefTargets?: string[];
	localHead?: string;
	localHeads?: string[];
	unresolvedThreads?: number[];
	pushReference?: string;
	remoteNames?: string[];
	sendError?: Error;
};

const result = (stdout = "", code = 0, stderr = "") => ({ stdout, stderr, code, killed: false });

function pullRequest(overrides: PullRequestSpec = {}) {
	const host = overrides.host ?? DEFAULT_HOST;
	return {
		id: overrides.id ?? "PR_kwDOExample",
		number: overrides.number ?? 42,
		url: `https://${host}/${overrides.baseRepository ?? "acme/project"}/pull/42`,
		state: overrides.state ?? "OPEN",
		isDraft: overrides.isDraft ?? false,
		baseRefName: overrides.baseRefName ?? "main",
		baseRefOid: overrides.baseRefOid ?? baseHead,
		headRefName: "feature/pr",
		headRefOid: overrides.headRefOid ?? localHead,
		headRepository: { nameWithOwner: "acme/project" },
		mergeable: overrides.mergeable ?? "MERGEABLE",
		mergeStateStatus: overrides.mergeStateStatus ?? "CLEAN",
		reviewDecision: overrides.reviewDecision ?? "APPROVED",
		statusCheckRollup: overrides.statusCheckRollup ?? [{ conclusion: "SUCCESS" }],
	};
}

function searchOutput(candidate: PullRequestSpec | null): string {
	const head = candidate ? pullRequest(candidate) : null;
	const edges = head ? [{
		cursor: "cursor-1",
		node: {
			__typename: "PullRequest",
			number: head.number,
			url: head.url,
			state: head.state,
			baseRepository: { nameWithOwner: candidate?.baseRepository ?? "acme/project" },
			headRepository: head.headRepository,
			headRefName: head.headRefName,
			headRefOid: head.headRefOid,
		},
	}] : [];
	return JSON.stringify({ data: { search: {
		issueCount: edges.length,
		edges,
		pageInfo: {
			hasNextPage: false,
			startCursor: edges[0]?.cursor ?? null,
			endCursor: edges.at(-1)?.cursor ?? null,
		},
	} } });
}

function packageCommand(name: string): CommandSpec {
	return { name, source: "skill", origin: "package" };
}

function harness(options: HarnessOptions) {
	const calls: Call[] = [];
	const messages: Array<{ content: string; options: unknown }> = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	const reservations: unknown[] = [];
	const releases: string[] = [];
	const events: string[] = [];
	let stateIndex = 0;
	let statusIndex = 0;
	let headIndex = 0;
	let baseTargetIndex = 0;
	let active: PullRequestSpec | null = null;
	const configuredLocalHead = options.localHead ?? localHead;
	const nextHost = () => options.states[stateIndex]?.host ?? DEFAULT_HOST;
	const pi = {
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args: [...args] });
			if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
			if (command === "git" && args.join(" ") === "branch --show-current") return result("feature/pr\n");
			if (
				command === "git" &&
				(args.join(" ") === "rev-parse --verify HEAD^{commit}" || args.join(" ") === "rev-parse --verify HEAD")
			) return result(`${options.localHeads?.[headIndex++] ?? configuredLocalHead}\n`);
			if (command === "git" && args.join(" ") === "for-each-ref --format=%(push:short) refs/heads/feature/pr") {
				return result(`${options.pushReference ?? "fork/feature/pr"}\n`);
			}
			if (command === "git" && args.join(" ") === "remote") return result(`${(options.remoteNames ?? ["fork", "origin"]).join("\n")}\n`);
			if (command === "git" && args[0] === "check-ref-format") {
				if (args[1] === "--branch") return result(`${args[2]}\n`);
				if (args[1]?.startsWith("refs/heads/")) return result();
			}
			if (
				command === "git" &&
				(args.join(" ") === "remote get-url --push --all fork" || args.join(" ") === "remote get-url --all fork")
			) return result(`git@${nextHost()}:acme/project.git\n`);
			if (
				command === "gh" && args[0] === "repo" && args[1] === "view" &&
				args[2] === `${nextHost()}/acme/project` && args[4] === "nameWithOwner,url"
			) return result(JSON.stringify({ nameWithOwner: "acme/project", url: `https://${nextHost()}/acme/project` }));
			if (command === "git" && args[0] === "ls-remote") {
				const remoteHead = options.states[stateIndex]?.headRefOid ?? localHead;
				return result(`${remoteHead}\t${args.at(-1)}\n`);
			}
			if (command === "git" && args[0] === "config") return result("", 1);
			if (command === "gh" && args[0] === "pr" && args[1] === "view") {
				return result(JSON.stringify(active ? pullRequest(active) : null));
			}
			if (
				command === "gh" &&
				args.join(" ") === `api --hostname ${active?.host ?? DEFAULT_HOST} --paginate --slurp -H Accept: application/vnd.github+json -H X-GitHub-Api-Version: 2022-11-28 repos/${active?.baseRepository ?? "acme/project"}/rules/branches/${encodeURIComponent(active?.baseRefName ?? "main")}`
			) return result("[[]]");
			if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
				const query = args.find((arg) => arg.startsWith("query=")) ?? "";
				if (query.includes("search(query:")) {
					events.push("load");
					active = options.states[stateIndex++] ?? null;
					return result(searchOutput(active));
				}
				if (query.includes("reviewThreads")) {
					const unresolved = options.unresolvedThreads?.[stateIndex - 1] ?? 0;
					return result(JSON.stringify([{
						data: { node: { reviewThreads: {
							nodes: Array.from({ length: unresolved }, () => ({ isResolved: false })),
							pageInfo: { hasNextPage: false, endCursor: null },
						} } },
					}]));
				}
				if (query.includes("target{oid}")) {
					return result(JSON.stringify({ data: { repository: {
						nameWithOwner: active?.baseRepository ?? "acme/project",
						ref: {
							name: active?.baseRefName ?? "main",
							target: { oid: options.baseRefTargets?.[baseTargetIndex++] ?? baseHead },
						},
					} } }));
				}
				if (query.includes("branchProtectionRule")) {
					return result(JSON.stringify({ data: { repository: {
						nameWithOwner: active?.baseRepository ?? "acme/project",
						ref: { name: active?.baseRefName ?? "main", branchProtectionRule: null },
					} } }));
				}
				if (query.includes("mergePullRequest")) {
					events.push("merge");
					return result(JSON.stringify({ data: { mergePullRequest: { pullRequest: { id: pullRequest(active ?? {}).id, state: "MERGED" } } } }));
				}
			}
			if (command === "gh" && args[0] === "repo" && args[1] === "view") {
				return result(JSON.stringify(active?.methods ?? {
					mergeCommitAllowed: true,
					rebaseMergeAllowed: true,
					squashMergeAllowed: true,
					viewerDefaultMergeMethod: "MERGE",
				}));
			}
			if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") {
				return result(options.statuses?.[statusIndex++] ?? options.status ?? "");
			}
			if (
				command === "git" &&
				args.join(" ") === "rev-parse --git-path MERGE_HEAD --git-path rebase-merge --git-path rebase-apply --git-path CHERRY_PICK_HEAD --git-path REVERT_HEAD --git-path sequencer"
			) {
				return result("/repo/.git/MERGE_HEAD\n/repo/.git/rebase-merge\n/repo/.git/rebase-apply\n/repo/.git/CHERRY_PICK_HEAD\n/repo/.git/REVERT_HEAD\n/repo/.git/sequencer\n");
			}
			if (command === "git" && args[0] === "fetch") return result();
			if (command === "git" && args[0] === "cat-file" && args[1] === "-e") return result();
			if (command === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor") {
				const [left, right] = args.slice(2);
				const remoteHead = active?.headRefOid ?? localHead;
				const localReference = (value: string | undefined) => value === configuredLocalHead || value === "HEAD";
				const remoteReference = (value: string | undefined) => value === remoteHead;
				if (options.ancestry === "behind" && localReference(left) && remoteReference(right)) return result();
				if (options.ancestry === "ahead" && remoteReference(left) && localReference(right)) return result();
				return result("", 1);
			}
			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		},
		getCommands: () => (options.commands ?? []).map((command) => ({
			name: command.name,
			source: command.source,
			sourceInfo: { origin: command.origin },
		})),
		sendUserMessage(content: string, messageOptions: unknown) {
			events.push("send");
			if (options.sendError) throw options.sendError;
			messages.push({ content, options: messageOptions });
		},
	} as unknown as Pick<ExtensionAPI, "exec" | "getCommands" | "sendUserMessage">;
	const context = {
		cwd,
		signal: new AbortController().signal,
		isIdle: () => options.idle ?? true,
		ui: {
			async confirm(title: string, message: string) {
				events.push("confirm");
				confirmations.push({ title, message });
				return options.confirmed ?? true;
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type: type ?? "info" });
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		pi,
		handler: createPrCommandHandler(pi, {
			async reserveWorkflow(reservation) {
				events.push("reserve");
				reservations.push(reservation);
				return workflowRunId;
			},
			releaseWorkflow(runId) {
				events.push("release");
				releases.push(runId);
			},
		}),
		context,
		calls,
		messages,
		notifications,
		confirmations,
		reservations,
		releases,
		events,
	};
}

function mutationCalls(calls: Call[]): Call[] {
	return calls.filter(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("mergePullRequest")),
	);
}

const routes: Array<{ name: string; state: PullRequestSpec | null; command: string; action: string }> = [
	{ name: "create", state: null, command: "skill:pi-pr-create", action: "prepare" },
	{
		name: "branch update outranks feedback and CI",
		state: {
			mergeable: "CONFLICTING",
			mergeStateStatus: "DIRTY",
			reviewDecision: "CHANGES_REQUESTED",
			statusCheckRollup: [{ conclusion: "FAILURE" }],
		},
		command: "skill:pi-pr-update-branch",
		action: "merge",
	},
	{
		name: "CI repair outranks review sweep",
		state: { reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ conclusion: "FAILURE" }] },
		command: "skill:pi-pr-fix-ci",
		action: "collect",
	},
	{
		name: "CI repair outranks waiting",
		state: { reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ conclusion: "FAILURE" }] },
		command: "skill:pi-pr-fix-ci",
		action: "collect",
	},
	{
		name: "review feedback",
		state: { reviewDecision: "CHANGES_REQUESTED" },
		command: "skill:pi-pr-comment-sweep",
		action: "start",
	},
];

test("routes one package workflow without opening a browser or chaining", async () => {
	for (const route of routes) {
		const app = harness({ states: [route.state], commands: [packageCommand(route.command)] });
		await app.handler("", app.context);

		assert.deepEqual(app.messages, [{
			content: `/${route.command} runId=${workflowRunId} action=${route.action}`,
			options: { expandPromptTemplates: true },
		}], route.name);
		assert.equal(app.reservations.length, 1, route.name);
		assert.equal(app.confirmations.length, 0, route.name);
		assert.equal(mutationCalls(app.calls).length, 0, route.name);
		assert.equal(app.calls.some(({ args }) => args.includes("--web")), false, route.name);
	}
});

test("names and confirms an inferred target before linking it", async () => {
	const state: PullRequestSpec = {};
	const app = harness({ states: [state, state], pushReference: "", remoteNames: ["fork"] });
	let linked = false;
	const handler = createPrCommandHandler(app.pi, {
		async linkInferredPullRequest(_pi, _context, current) {
			linked = true;
			return { ...current, target: { ...current.target, provenance: "configured" } };
		},
	});

	assert.equal(await handler("", app.context), "link-branch");
	assert.equal(linked, true);
	assert.deepEqual(app.confirmations, [{
		title: "Link pull request branch to fork/feature/pr?",
		message: "Set fork/feature/pr as the push target for this branch.",
	}]);
	assert.equal(app.messages.length, 0);
});

test("returns silently outside a Git worktree", async () => {
	const app = harness({ states: [] });
	const handler = createPrCommandHandler(app.pi, {
		loadCurrentPullRequest: async () => ({ kind: "inactive" }),
	});

	assert.equal(await handler("", app.context), "none");
	assert.deepEqual(app.notifications, []);
	assert.deepEqual(app.messages, []);
});

test("does not route an observed GitHub lookup failure to PR creation", async () => {
	const app = harness({ states: [], commands: [packageCommand("skill:pi-pr-create")] });
	const handler = createPrCommandHandler(app.pi, {
		loadCurrentPullRequest: async () => {
			throw new Error("Load observed pull request failed: exit code 1");
		},
	});

	await assert.rejects(handler("", app.context), /Load observed pull request failed/);
	assert.deepEqual(app.messages, []);
});

test("does not dispatch mutating workflows when the worktree is dirty or local HEAD is behind", async () => {
	const conditions: Array<{ name: string; state: PullRequestSpec }> = [
		{ name: "update branch", state: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } },
		{ name: "comment sweep", state: { reviewDecision: "CHANGES_REQUESTED" } },
		{ name: "CI fix", state: { statusCheckRollup: [{ conclusion: "FAILURE" }] } },
	];
	for (const route of conditions) {
		const dirty = harness({ states: [route.state], status: " M file.ts\n" });
		await dirty.handler("", dirty.context);
		assert.deepEqual(dirty.messages, [], `${route.name} dirty`);
		assert.match(dirty.notifications[0]?.message ?? "", /dirty worktree/, `${route.name} dirty`);

		const behind = harness({
			states: [{ ...route.state, headRefOid: nextHead }],
			ancestry: "behind",
		});
		await behind.handler("", behind.context);
		assert.deepEqual(behind.messages, [], `${route.name} behind`);
		assert.match(behind.notifications[0]?.message ?? "", /local HEAD behind/, `${route.name} behind`);
	}
});

test("dispatches a workflow as a follow-up only while the agent is busy", async () => {
	const app = harness({
		states: [null],
		commands: [packageCommand("skill:pi-pr-create")],
		idle: false,
	});
	await app.handler("", app.context);

	assert.deepEqual(app.messages, [{
		content: `/skill:pi-pr-create runId=${workflowRunId} action=prepare`,
		options: { deliverAs: "followUp", expandPromptTemplates: true },
	}]);
});

test("accepts only an anchored create base and keeps it out of the prompt", async () => {
	const app = harness({ states: [null], commands: [packageCommand("skill:pi-pr-create")] });

	await app.handler("  --base=github.com/acme/project:feature/base  ", app.context);
	assert.deepEqual(app.messages, [{
		content: `/skill:pi-pr-create runId=${workflowRunId} action=prepare`,
		options: { expandPromptTemplates: true },
	}]);
	assert.equal((app.reservations[0] as { route: string }).route, "create");
	assert.equal((app.reservations[0] as { base: string }).base, "github.com/acme/project:feature/base");

	for (const invalid of ["please use main", "--base=github.com/acme/project:main extra", "x --base=github.com/acme/project:main"]) {
		const rejected = harness({ states: [null], commands: [packageCommand("skill:pi-pr-create")] });
		await assert.rejects(rejected.handler(invalid, rejected.context), /accepts only --base=/, invalid);
		assert.deepEqual(rejected.reservations, [], invalid);
	}
});

test("rejects instructions for non-create helper routes before reservation", async () => {
	const app = harness({
		states: [{ statusCheckRollup: [{ conclusion: "FAILURE" }] }],
		commands: [packageCommand("skill:pi-pr-fix-ci")],
	});

	await assert.rejects(app.handler("rerun the job", app.context), /helper route does not accept instructions/);
	assert.deepEqual(app.reservations, []);
	assert.deepEqual(app.messages, []);
});

test("checks command generation after discovery and reservation and immediately before send", async () => {
	for (const failAt of [1, 2, 3]) {
		const app = harness({
			states: [null],
			commands: [packageCommand("skill:pi-pr-create")],
		});
		let checks = 0;

		await assert.rejects(app.handler("", app.context, {
			sessionGeneration: 7,
			assertCurrent() {
				checks += 1;
				if (checks === failAt) throw new Error("session replaced");
			},
		}), /session replaced/, `generation check ${failAt}`);
		assert.deepEqual(app.messages, [], `generation check ${failAt}`);
		assert.equal(app.reservations.length, failAt === 1 ? 0 : 1, `generation check ${failAt}`);
		assert.deepEqual(app.releases, failAt === 1 ? [] : [workflowRunId], `generation check ${failAt}`);
	}
});

test("rolls back exactly the new reservation when prompt dispatch fails", async () => {
	const app = harness({
		states: [null],
		commands: [packageCommand("skill:pi-pr-create")],
		sendError: new Error("send failed"),
	});

	await assert.rejects(app.handler("", app.context), /send failed/);
	assert.deepEqual(app.events, ["load", "reserve", "send", "release"]);
	assert.deepEqual(app.releases, [workflowRunId]);
	assert.deepEqual(app.messages, []);
});

test("rejects instructions when the current route handles the action directly", async () => {
	const app = harness({ states: [{}] });

	await assert.rejects(app.handler("use squash", app.context), /current \/pr route does not accept instructions/);
	assert.deepEqual(app.confirmations, []);
	assert.equal(mutationCalls(app.calls).length, 0);
});

test("requires the effective package-owned skill", async () => {
	const cases: Array<{ name: string; commands: CommandSpec[] }> = [
		{ name: "missing", commands: [] },
		{ name: "extension command", commands: [{ name: "skill:pi-pr-create", source: "extension", origin: "package" }] },
		{ name: "top-level skill", commands: [{ name: "skill:pi-pr-create", source: "skill", origin: "top-level" }] },
	];

	for (const candidate of cases) {
		const app = harness({ states: [null], commands: candidate.commands });
		await assert.rejects(app.handler("", app.context), /bundled workflow is unavailable/, candidate.name);
		assert.deepEqual(app.messages, [], candidate.name);
	}
});

test("reports lifecycle and merge blockers without taking an action", async () => {
	const cases: Array<{
		name: string;
		state: PullRequestSpec;
		status?: string;
		ancestry?: "ahead" | "diverged";
		message: string;
		type: "info" | "warning";
	}> = [
		{ name: "merged", state: { state: "MERGED" }, message: "PR #42 is merged; no action needed", type: "info" },
		{ name: "closed", state: { state: "CLOSED" }, message: "PR #42 is closed; no action needed", type: "info" },
		{ name: "draft", state: { isDraft: true }, message: "PR #42 is draft; no action available", type: "warning" },
		{ name: "CI running", state: { statusCheckRollup: [{ state: "IN_PROGRESS" }] }, message: "PR #42 is waiting for CI", type: "warning" },
		{ name: "review pending", state: { reviewDecision: "REVIEW_REQUIRED" }, message: "PR #42 is waiting for review", type: "warning" },
		{ name: "merge policy pending", state: { mergeStateStatus: "BLOCKED" }, message: "PR #42 is blocked by merge policy", type: "warning" },
		{ name: "dirty worktree", state: {}, status: " M file.ts\n", message: "PR #42 is blocked by a dirty worktree", type: "warning" },
		{ name: "ahead local HEAD", state: { headRefOid: nextHead }, ancestry: "ahead", message: "PR #42 is blocked by local HEAD ahead", type: "warning" },
		{ name: "diverged local HEAD", state: { headRefOid: nextHead }, ancestry: "diverged", message: "PR #42 is blocked by local HEAD diverged", type: "warning" },
	];

	for (const candidate of cases) {
		const app = harness({ states: [candidate.state], status: candidate.status, ancestry: candidate.ancestry });
		await app.handler("", app.context);

		assert.deepEqual(app.notifications, [{ message: candidate.message, type: candidate.type }], candidate.name);
		assert.deepEqual(app.messages, [], candidate.name);
		assert.equal(app.confirmations.length, 0, candidate.name);
		assert.equal(mutationCalls(app.calls).length, 0, candidate.name);
	}
});

test("stops before refetching or mutating when merge confirmation is declined", async () => {
	const app = harness({ states: [{}], confirmed: false });
	assert.equal(await app.handler("", app.context), "none");

	assert.equal(app.confirmations.length, 1);
	assert.deepEqual(app.events, ["load", "confirm"]);
	assert.equal(mutationCalls(app.calls).length, 0);
});

test("cancels a confirmed merge when post-inspection authority is absent, different, or no longer ready", async () => {
	const cases: Array<{
		name: string;
		states: [PullRequestSpec, PullRequestSpec | null];
		statuses?: string[];
		unresolvedThreads?: number[];
		error: RegExp;
	}> = [
		{
			name: "PR disappears",
			states: [{}, null],
			error: /pull request is no longer current/,
		},
		{
			name: "PR identity changes",
			states: [{}, { id: "PR_other" }],
			error: /confirmed pull request context changed/,
		},
		{
			name: "PR host changes",
			states: [{ host: DEFAULT_HOST }, { host: "github.example.test" }],
			error: /confirmed pull request context changed/,
		},
		{
			name: "worktree becomes dirty during readiness",
			states: [{}, {}],
			statuses: ["", "", " M file.ts\n"],
			error: /Final local merge safety check failed: worktree is dirty/,
		},
		{
			name: "untracked file appears during readiness",
			states: [{}, {}],
			statuses: ["", "", "?? untracked.ts\n"],
			error: /Final local merge safety check failed: worktree is dirty/,
		},
		{
			name: "optional check fails",
			states: [{}, { statusCheckRollup: [{ conclusion: "FAILURE" }] }],
			error: /no longer merge-ready/,
		},
		{
			name: "changes are requested",
			states: [{}, { reviewDecision: "CHANGES_REQUESTED" }],
			error: /no longer merge-ready/,
		},
		{
			name: "review thread becomes unresolved",
			states: [{}, {}],
			unresolvedThreads: [0, 1],
			error: /no longer merge-ready/,
		},
	];

	for (const candidate of cases) {
		const app = harness({ states: candidate.states, statuses: candidate.statuses, unresolvedThreads: candidate.unresolvedThreads });
		await assert.rejects(app.handler("", app.context), candidate.error, candidate.name);

		assert.equal(app.confirmations.length, 1, candidate.name);
		assert.deepEqual(app.events, ["load", "confirm", "load"], candidate.name);
		assert.equal(mutationCalls(app.calls).length, 0, candidate.name);
	}
});

test("cancels a confirmed merge when local HEAD changes during readiness", async () => {
	const app = harness({
		states: [{}, {}],
		localHeads: [localHead, localHead, nextHead, nextHead],
	});

	await assert.rejects(app.handler("", app.context), /Final local merge safety check failed: HEAD changed/);
	assert.deepEqual(app.events, ["load", "confirm", "load"]);
	assert.equal(app.calls.filter(({ command, args }) => command === "git" && args[0] === "fetch").length, 2);
	assert.equal(mutationCalls(app.calls).length, 0);
});

test("cancels a confirmed merge when the confirmed head or base context changes", async () => {
	const cases: Array<{ name: string; fresh: PullRequestSpec; ancestry?: "behind"; baseRefTargets?: string[] }> = [
		{ name: "force-pushed head", fresh: { headRefOid: nextHead }, ancestry: "behind" },
		{ name: "base repository retarget", fresh: { baseRepository: "acme/other" } },
		{ name: "base ref retarget", fresh: { baseRefName: "release" } },
		{ name: "base advances", fresh: {}, baseRefTargets: [baseHead, "d".repeat(40)] },
	];

	for (const candidate of cases) {
		const app = harness({
			states: [{}, candidate.fresh],
			ancestry: candidate.ancestry,
			baseRefTargets: candidate.baseRefTargets,
		});
		await assert.rejects(app.handler("", app.context), /confirmed pull request context changed/, candidate.name);

		assert.deepEqual(app.events, ["load", "confirm", "load"], candidate.name);
		assert.equal(app.calls.filter(({ command, args }) => command === "git" && args[0] === "fetch").length, 2, candidate.name);
		assert.equal(mutationCalls(app.calls).length, 0, candidate.name);
	}
});

test("cancels when the base retargets or advances during final readiness evaluation", async () => {
	for (const candidate of [
		{ name: "base repository retarget", finalState: { baseRepository: "acme/other" }, baseRefTargets: undefined },
		{ name: "base ref retarget", finalState: { baseRefName: "release" }, baseRefTargets: undefined },
		{ name: "base advance", finalState: {}, baseRefTargets: [baseHead, "d".repeat(40)] },
	]) {
		const app = harness({ states: [{}, candidate.finalState], baseRefTargets: candidate.baseRefTargets });
		await assert.rejects(app.handler("", app.context), /confirmed pull request context changed/, candidate.name);

		assert.deepEqual(app.events, ["load", "confirm", "load"], candidate.name);
		assert.equal(mutationCalls(app.calls).length, 0, candidate.name);
		const finalFetch = app.calls.map(({ command, args }) => command === "git" && args[0] === "fetch").lastIndexOf(true);
		const readiness = app.calls.map(({ command, args }) =>
			command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("search(query:"))
		).lastIndexOf(true);
		assert.ok(finalFetch >= 0 && readiness > finalFetch, candidate.name);
		assert.equal(app.calls.slice(readiness).some(({ command, args }) => command === "git" && args[0] === "fetch"), false, candidate.name);
	}
});

test("merges unchanged confirmed context with the atomic expected head", async () => {
	const host = "github.example.test";
	const app = harness({
		states: [
			{
				id: "PR_kwDOExample",
				host,
				methods: {
					mergeCommitAllowed: true,
					rebaseMergeAllowed: false,
					squashMergeAllowed: false,
					viewerDefaultMergeMethod: "MERGE",
				},
			},
			{
				id: "PR_kwDOExample",
				host,
				methods: {
					mergeCommitAllowed: true,
					rebaseMergeAllowed: false,
					squashMergeAllowed: false,
					viewerDefaultMergeMethod: "MERGE",
				},
			},
		],
	});
	assert.equal(await app.handler("", app.context), "merge");

	assert.deepEqual(app.confirmations, [{
		title: "Merge PR #42?",
		message: "Method: merge.",
	}]);
	assert.deepEqual(app.events, ["load", "confirm", "load", "merge"]);
	const fetches = app.calls.filter(({ command, args }) => command === "git" && args[0] === "fetch");
	assert.equal(fetches.length, 2);
	assert.ok(fetches.every(({ args }) => args[4] === `git@${host}:acme/project.git`));
	assert.equal(fetches.some(({ args }) => args.includes("fork") || args.includes("acme/project")), false);
	assert.equal(fetches.some(({ args }) => !args.includes("--no-write-fetch-head") || !args.includes("--no-recurse-submodules")), false);
	const finalReadiness = app.calls.map(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("search(query:"))
	).lastIndexOf(true);
	assert.ok(finalReadiness > app.calls.map(({ command, args }) => command === "git" && args[0] === "fetch").lastIndexOf(true));
	assert.equal(app.calls.slice(finalReadiness).some(({ command, args }) => command === "git" && args[0] === "fetch"), false);
	const finalStatus = app.calls.map(({ command, args }) => command === "git" && args[0] === "status").lastIndexOf(true);
	const mutationIndex = app.calls.findIndex(({ command, args }) => command === "gh" && args.some((arg) => arg.includes("mergePullRequest")));
	assert.ok(finalStatus > finalReadiness && mutationIndex > finalStatus);
	assert.equal(app.calls.slice(finalStatus + 1, mutationIndex).some(({ command, args }) =>
		command === "gh" || (command === "git" && (args[0] === "fetch" || args[0] === "ls-remote"))
	), false);
	assert.deepEqual(mutationCalls(app.calls), [{
		command: "gh",
		args: [
			"api",
			"graphql",
			"--hostname",
			host,
			"-f",
			"query=mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!,$mergeMethod:PullRequestMergeMethod!){mergePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid,mergeMethod:$mergeMethod}){pullRequest{id state}}}",
			"-F",
			"pullRequestId=PR_kwDOExample",
			"-F",
			`expectedHeadOid=${localHead}`,
			"-F",
			"mergeMethod=MERGE",
		],
	}]);
	assert.equal(app.calls.some(({ args }) => args.includes("--web")), false);
});

test("cancels a confirmed merge when the fresh merge method changes", async () => {
	const app = harness({
		states: [
			{
				methods: {
					mergeCommitAllowed: true,
					rebaseMergeAllowed: false,
					squashMergeAllowed: false,
					viewerDefaultMergeMethod: "MERGE",
				},
			},
			{
				methods: {
					mergeCommitAllowed: false,
					rebaseMergeAllowed: true,
					squashMergeAllowed: false,
					viewerDefaultMergeMethod: "REBASE",
				},
			},
		],
		ancestry: "behind",
	});

	await assert.rejects(app.handler("", app.context), /merge method changed from merge to rebase/);
	assert.deepEqual(app.confirmations, [{
		title: "Merge PR #42?",
		message: "Method: merge.",
	}]);
	assert.deepEqual(app.events, ["load", "confirm", "load"]);
	assert.equal(mutationCalls(app.calls).length, 0);
});

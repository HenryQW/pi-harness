import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Exec, ExecResult } from "../extensions/pr-execution.ts";
import { PullRequestCreator } from "../extensions/pr-create.ts";
import type { PullRequestTarget } from "../extensions/pr-routing.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const cwd = process.cwd();
const url = "https://github.com/acme/project/pull/42";
const OPERATION_PATHS = Array.from({ length: 6 }, (_, index) => `/tmp/pi-pr-create-no-operation-${index}`).join("\n") + "\n";

function result(stdout = "", code = 0, stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

function target(noTarget = true): PullRequestTarget {
	return {
		provenance: noTarget ? "inferred" : "configured",
		branch: "feature",
		remote: "origin",
		ref: "feature",
		repository: "acme/project",
		host: "github.com",
		fetchSource: "git@github.com:acme/project.git",
		remoteOid: noTarget ? null : "c".repeat(40),
	};
}

function none(creationTarget: PullRequestTarget) {
	return { kind: "none" as const, creationTarget, branch: { ahead: 0 } };
}

function baseOutput(ref = "main") {
	return JSON.stringify({ data: { repository: {
		nameWithOwner: "acme/project",
		ref: { name: ref, target: { oid: base } },
	} } });
}

function repositoryOutput() {
	return JSON.stringify({ nameWithOwner: "acme/project", url: "https://github.com/acme/project" });
}

function searchOutput(found: boolean, options: {
	baseRepository?: string;
	headRepository?: string;
	url?: string;
} = {}) {
	const baseRepository = options.baseRepository ?? "acme/project";
	const headRepository = options.headRepository ?? "acme/project";
	const pullRequestUrl = options.url ?? url;
	const edges = found ? [{
		cursor: "cursor-1",
		node: {
			__typename: "PullRequest",
			number: 42,
			url: pullRequestUrl,
			state: "OPEN",
			baseRepository: { nameWithOwner: baseRepository },
			headRepository: { nameWithOwner: headRepository },
			headRefName: "feature",
			headRefOid: head,
		},
	}] : [];
	return JSON.stringify({ data: { repository: {
		nameWithOwner: headRepository,
		ref: {
			name: "feature",
			associatedPullRequests: {
				totalCount: edges.length,
				edges,
				pageInfo: {
					hasNextPage: false,
					startCursor: edges[0]?.cursor ?? null,
					endCursor: edges[0]?.cursor ?? null,
				},
			},
		},
	} } });
}

function publication(body: string) {
	return JSON.stringify({
		number: 42,
		url,
		state: "OPEN",
		baseRefName: "main",
		headRefName: "feature",
		headRefOid: head,
		headRepository: { nameWithOwner: "acme/project" },
		title: "feat: publish",
		body,
	});
}

function createAuthorityOutput(
	baseRepository: string,
	headRepository: string,
	headOwnerType: "Organization" | "User",
	inputFields = ["repositoryId", "baseRefName", "headRepositoryId", "headRefName", "title", "body"],
) {
	return JSON.stringify({ data: {
		base: { id: "BASE_REPOSITORY_ID", nameWithOwner: baseRepository },
		head: {
			id: "HEAD_REPOSITORY_ID",
			nameWithOwner: headRepository,
			owner: { __typename: headOwnerType },
		},
		createInput: { inputFields: inputFields.map((name) => ({ name })) },
	} });
}

function creator(exec: Exec, creationTarget: PullRequestTarget, signal?: AbortSignal) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-create-agent-"));
	const workflow = new PullRequestCreator({
		cwd,
		target: creationTarget,
		signal,
		exec,
		agentDir,
		loadCurrentPullRequest: async () => none({ ...creationTarget, provenance: "configured", remoteOid: head }),
	});
	workflow.state.phase = "verified";
	workflow.state.base = {
		host: "github.com", repository: "acme/project", ref: "main", oid: base,
		fetchSource: "git@github.com:acme/project.git",
	};
	workflow.state.mergeHead = head;
	return { workflow, agentDir };
}

test("successful no-target upstream setup revalidates a changed configured push ref", async (t) => {
	const calls: Array<[string, string[]]> = [];
	let tracking = false;
	let upstream = false;
	let discoveredTarget = target(true);
	const exec: Exec = async (command, args) => {
		calls.push([command, [...args]]);
		const text = args.join(" ");
		if (command === "git" && text === "branch --show-current") return result("feature\n");
		if (command === "gh" && args[0] === "api") return result(baseOutput());
		if (command === "git" && text === "status --porcelain=v1 --untracked-files=all") return result();
		if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(OPERATION_PATHS);
		if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${head}\n`);
		if (command === "git" && args[0] === "merge-base") return result();
		if (command === "git" && args[0] === "push") return result("ok\n");
		if (command === "git" && args[0] === "ls-remote") return result(`${head}\trefs/heads/feature\n`);
		if (command === "git" && args[0] === "fetch") {
			tracking = true;
			return result();
		}
		if (command === "git" && text === "rev-parse --verify --quiet refs/remotes/origin/feature^{commit}") {
			return tracking ? result(`${head}\n`) : result("", 1);
		}
		if (command === "git" && args[0] === "branch" && args[1]?.startsWith("--set-upstream-to=")) {
			upstream = true;
			return result();
		}
		if (command === "git" && args[0] === "for-each-ref") return result(upstream ? "origin/feature\n" : "\n");
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const app = creator(exec, target(true));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	// Push must compare against the original no-target authority, not the post-push discovery fixture.
	(app.workflow as unknown as { load: () => Promise<unknown> }).load = async () => ({ kind: "none", creationTarget: discoveredTarget });
	assert.deepEqual(await app.workflow.push(), { kind: "pushed", head });
	discoveredTarget = { ...target(false), ref: "renamed", remoteOid: head };
	await assert.rejects(app.workflow.publish("feat: publish", "expected"), /Published target authority changed/);
	assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "push"), ["git", [
		"push", "--porcelain", "--force-with-lease=refs/heads/feature:", "--recurse-submodules=no", "--",
		"git@github.com:acme/project.git", `${head}:refs/heads/feature`,
	]]);
	assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "fetch"), ["git", [
		"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules",
		"git@github.com:acme/project.git", `+${head}:refs/remotes/origin/feature`,
	]]);
	assert.equal(app.workflow.state.phase, "pushed");
});

test("a successful push remains publishable when no-target upstream setup fails", async (t) => {
	const calls: Array<[string, string[]]> = [];
	let pushes = 0;
	let searches = 0;
	const body = "Published after upstream setup failed.";
	const exec: Exec = async (command, args) => {
		calls.push([command, [...args]]);
		const text = args.join(" ");
		if (command === "git" && text === "branch --show-current") return result("feature\n");
		if (command === "git" && text === "status --porcelain=v1 --untracked-files=all") return result();
		if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(OPERATION_PATHS);
		if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${head}\n`);
		if (command === "git" && args[0] === "merge-base") return result();
		if (command === "git" && args[0] === "push") {
			pushes += 1;
			return result("ok\n");
		}
		if (command === "git" && args[0] === "ls-remote") return result(`${head}\trefs/heads/feature\n`);
		if (command === "git" && args[0] === "fetch") return result("", 1, "upstream fetch failed\n");
		if (command === "git" && text === "remote get-url --push --all origin") return result("git@github.com:acme/project.git\n");
		if (command === "git" && text === "remote get-url --all origin") return result("git@github.com:acme/project.git\n");
		if (command === "gh" && args[0] === "repo") return result(repositoryOutput());
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			const query = args.find((arg) => arg.startsWith("query=")) ?? "";
			if (query.includes("associatedPullRequests(")) return result(searchOutput(searches++ > 0));
			return result(baseOutput());
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "create") return result(`${url}\n`);
		if (command === "gh" && args[0] === "pr" && args[1] === "view") return result(publication(body));
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const app = creator(exec, target(true));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	(app.workflow as unknown as { load: () => Promise<unknown> }).load = async () => ({
		kind: "none", creationTarget: target(true),
	});
	await assert.rejects(app.workflow.push(), /Fetch branch tracking ref failed/);
	assert.equal(app.workflow.state.phase, "pushed");
	const callsAfterFailure = calls.length;
	await assert.rejects(app.workflow.push(), /not ready to push/);
	assert.equal(calls.length, callsAfterFailure);
	assert.deepEqual(await app.workflow.publish("feat: publish", body), { kind: "published", url });
	assert.equal(pushes, 1);
});

test("configured-target pushes never read or change upstream", async (t) => {
	const calls: Array<[string, string[]]> = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, [...args]]);
		const text = args.join(" ");
		if (command === "git" && text === "branch --show-current") return result("feature\n");
		if (command === "gh" && args[0] === "api") return result(baseOutput());
		if (command === "git" && text === "status --porcelain=v1 --untracked-files=all") return result();
		if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(OPERATION_PATHS);
		if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${head}\n`);
		if (command === "git" && args[0] === "merge-base") return result();
		if (command === "git" && args[0] === "push") return result("ok\n");
		if (command === "git" && args[0] === "ls-remote") return result(`${head}\trefs/heads/feature\n`);
		if (command === "git" && (args[0] === "config" || args[0] === "fetch" || args[0] === "branch")) {
			throw new Error("configured target must not touch upstream");
		}
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const app = creator(exec, target(false));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	(app.workflow as unknown as { load: () => Promise<unknown> }).load = async () => none(target(false));

	assert.deepEqual(await app.workflow.push(), { kind: "pushed", head });
	assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "config"), false);
	assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "fetch"), false);
	assert.equal(calls.some(([command, args]) =>
		command === "git" && args[0] === "branch" && args[1]?.startsWith("--set-upstream-to="),
	), false);
});

test("creates an organization-owned same-repository PR with an unqualified head", async (t) => {
	const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
	let searches = 0;
	const body = "## Summary\n\n- Publish safely.\n\n## Testing\n\n- Tests pass.\n";
	const exec: Exec = async (command, args, options) => {
		calls.push({ command, args: [...args], stdin: options.stdin });
		if (command === "git" && args.join(" ") === "branch --show-current") return result("feature\n");
		if (command === "git" && args.join(" ") === "remote get-url --push --all origin") return result("git@github.com:acme/project.git\n");
		if (command === "git" && args.join(" ") === "remote get-url --all origin") return result("git@github.com:acme/project.git\n");
		if (command === "gh" && args[0] === "repo") return result(repositoryOutput());
		if (command === "git" && args[0] === "ls-remote") return result(`${head}\trefs/heads/feature\n`);
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			const query = args.find((arg) => arg.startsWith("query=")) ?? "";
			if (query.includes("associatedPullRequests(")) return result(searchOutput(searches++ > 0));
			return result(baseOutput());
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "create") return result(`${url}\n`);
		if (command === "gh" && args[0] === "pr" && args[1] === "view") return result(publication(body));
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const app = creator(exec, target(false));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.phase = "pushed";
	app.workflow.state.publicationHead = head;
	assert.deepEqual(await app.workflow.publish("feat: publish", body), { kind: "published", url });
	const mutation = calls.find(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create");
	assert.deepEqual(mutation, {
		command: "gh",
		args: [
			"pr", "create", "--repo", "github.com/acme/project", "--head", "feature",
			"--base", "main", "--title", "feat: publish", "--body-file", "-",
		],
		stdin: body,
	});
	assert.equal(mutation!.args.includes("--hostname"), false);
	assert.equal(searches, 2);
});

test("preflights and creates an organization-owned cross-repository PR through exact GraphQL identities", async (t) => {
	const baseRepository = "acme/upstream";
	const headRepository = "acme/head";
	const prUrl = "https://github.com/acme/upstream/pull/42";
	const remoteHead = "c".repeat(40);
	const creationTarget: PullRequestTarget = {
		...target(false),
		repository: headRepository,
		fetchSource: "git@github.com:acme/head.git",
		remoteOid: remoteHead,
	};
	const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
	let published = false;
	let searches = 0;
	const body = "Created from an organization repository.";
	const exec: Exec = async (command, args, options) => {
		calls.push({ command, args: [...args], stdin: options.stdin });
		const text = args.join(" ");
		if (command === "git" && text === "branch --show-current") return result("feature\n");
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			const query = args.find((arg) => arg.startsWith("query=")) ?? "";
			if (query.includes("target{oid}")) {
				return result(JSON.stringify({ data: { repository: {
					nameWithOwner: baseRepository,
					ref: { name: "main", target: { oid: base } },
				} } }));
			}
			if (query.includes("createInput:__type")) {
				return result(createAuthorityOutput(baseRepository, headRepository, "Organization"));
			}
			if (query.includes("associatedPullRequests(")) {
				return result(searchOutput(searches++ > 0, { baseRepository, headRepository, url: prUrl }));
			}
			if (query.includes("createPullRequest(")) {
				return result(JSON.stringify({ data: { createPullRequest: { pullRequest: { url: prUrl } } } }));
			}
		}
		if (command === "git" && text === "status --porcelain=v1 --untracked-files=all") return result();
		if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(OPERATION_PATHS);
		if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${head}\n`);
		if (command === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor") return result();
		if (command === "git" && args[0] === "push") {
			published = true;
			return result("ok\n");
		}
		if (command === "git" && args[0] === "ls-remote") {
			return result(`${published ? head : remoteHead}\trefs/heads/feature\n`);
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "view") {
			return result(JSON.stringify({
				number: 42, url: prUrl, state: "OPEN", baseRefName: "main", headRefName: "feature",
				headRefOid: head, headRepository: { nameWithOwner: headRepository }, title: "feat: publish", body,
			}));
		}
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const app = creator(exec, creationTarget);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.base = {
		host: "github.com", repository: baseRepository, ref: "main", oid: base,
		fetchSource: "git@github.com:acme/upstream.git",
	};
	(app.workflow as unknown as { load: () => Promise<unknown> }).load = async () =>
		none({ ...creationTarget, remoteOid: published ? head : remoteHead });

	assert.deepEqual(await app.workflow.push(), { kind: "pushed", head });
	assert.deepEqual(await app.workflow.publish("feat: publish", body), { kind: "published", url: prUrl });
	const preflightIndex = calls.findIndex(({ command, args }) =>
		command === "gh" && args.some((arg) => arg.includes("createInput:__type"))
	);
	const pushIndex = calls.findIndex(({ command, args }) => command === "git" && args[0] === "push");
	assert.ok(preflightIndex >= 0 && preflightIndex < pushIndex);
	assert.equal(calls.some(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create"), false);
	const mutation = calls.find(({ command, args }) =>
		command === "gh" && args.some((arg) => arg.includes("createPullRequest("))
	);
	assert.deepEqual(mutation?.args.slice(0, 4), ["api", "graphql", "--hostname", "github.com"]);
	assert.equal(mutation?.args.includes("repositoryId=BASE_REPOSITORY_ID"), true);
	assert.equal(mutation?.args.includes("headRepositoryId=HEAD_REPOSITORY_ID"), true);
	assert.equal(mutation?.args.includes("headRefName=feature"), true);
	assert.equal(mutation?.args.includes("baseRefName=main"), true);
});

test("rejects an unsupported organization cross-repository API before pushing", async (t) => {
	const creationTarget: PullRequestTarget = {
		...target(false),
		repository: "acme/head",
		fetchSource: "git@github.com:acme/head.git",
	};
	const calls: Array<[string, string[]]> = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, [...args]]);
		const text = args.join(" ");
		if (command === "git" && text === "branch --show-current") return result("feature\n");
		if (command === "gh" && args.some((arg) => arg.includes("target{oid}"))) {
			return result(JSON.stringify({ data: { repository: {
				nameWithOwner: "acme/upstream",
				ref: { name: "main", target: { oid: base } },
			} } }));
		}
		if (command === "gh" && args.some((arg) => arg.includes("createInput:__type"))) {
			return result(createAuthorityOutput("acme/upstream", "acme/head", "Organization", ["repositoryId"]));
		}
		if (command === "git" && text === "status --porcelain=v1 --untracked-files=all") return result();
		if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(OPERATION_PATHS);
		if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${head}\n`);
		if (command === "git" && args[0] === "merge-base") return result();
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const app = creator(exec, creationTarget);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.base = {
		host: "github.com", repository: "acme/upstream", ref: "main", oid: base,
		fetchSource: "git@github.com:acme/upstream.git",
	};
	(app.workflow as unknown as { load: () => Promise<unknown> }).load = async () => none(creationTarget);
	await assert.rejects(app.workflow.push(), /cannot create an exact organization-owned cross-repository pull request/);
	assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "push"), false);
});

test("keeps user-owned fork creation on gh pr create with a qualified head", async (t) => {
	const headRepository = "octocat/fork";
	const baseRepository = "acme/upstream";
	const prUrl = "https://github.com/acme/upstream/pull/42";
	const creationTarget: PullRequestTarget = {
		...target(false),
		repository: headRepository,
		fetchSource: "git@github.com:octocat/fork.git",
	};
	const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
	let published = false;
	let searches = 0;
	const body = "User fork.";
	const exec: Exec = async (command, args, options) => {
		calls.push({ command, args: [...args], stdin: options.stdin });
		if (command === "git" && args.join(" ") === "branch --show-current") return result("feature\n");
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			const query = args.find((arg) => arg.startsWith("query=")) ?? "";
			if (query.includes("target{oid}")) {
				return result(JSON.stringify({ data: { repository: {
					nameWithOwner: baseRepository,
					ref: { name: "main", target: { oid: base } },
				} } }));
			}
			if (query.includes("createInput:__type")) {
				return result(createAuthorityOutput(baseRepository, headRepository, "User"));
			}
			if (query.includes("associatedPullRequests(")) {
				return result(searchOutput(searches++ > 0, { baseRepository, headRepository, url: prUrl }));
			}
		}
		if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") return result();
		if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(OPERATION_PATHS);
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") return result(`${head}\n`);
		if (command === "git" && args[0] === "merge-base") return result();
		if (command === "git" && args[0] === "push") {
			published = true;
			return result("ok\n");
		}
		if (command === "git" && args[0] === "ls-remote") return result(`${head}\trefs/heads/feature\n`);
		if (command === "gh" && args[0] === "pr" && args[1] === "create") return result(`${prUrl}\n`);
		if (command === "gh" && args[0] === "pr" && args[1] === "view") {
			return result(JSON.stringify({
				number: 42, url: prUrl, state: "OPEN", baseRefName: "main", headRefName: "feature",
				headRefOid: head, headRepository: { nameWithOwner: headRepository }, title: "feat: publish", body,
			}));
		}
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const app = creator(exec, creationTarget);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.base = {
		host: "github.com", repository: baseRepository, ref: "main", oid: base,
		fetchSource: "git@github.com:acme/upstream.git",
	};
	(app.workflow as unknown as { load: () => Promise<unknown> }).load = async () =>
		none({ ...creationTarget, remoteOid: published ? head : creationTarget.remoteOid });

	assert.deepEqual(await app.workflow.push(), { kind: "pushed", head });
	assert.deepEqual(await app.workflow.publish("feat: publish", body), { kind: "published", url: prUrl });
	const mutation = calls.find(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create");
	assert.deepEqual(mutation?.args, [
		"pr", "create", "--repo", "github.com/acme/upstream", "--head", "octocat:feature",
		"--base", "main", "--title", "feat: publish", "--body-file", "-",
	]);
	assert.equal(mutation?.stdin, body);
	const preflightIndex = calls.findIndex(({ command, args }) =>
		command === "gh" && args.some((arg) => arg.includes("createInput:__type"))
	);
	const pushIndex = calls.findIndex(({ command, args }) => command === "git" && args[0] === "push");
	assert.ok(preflightIndex >= 0 && preflightIndex < pushIndex);
});

test("prepare uses shared explicit, configured, and default preflight bases with captured OIDs", async (t) => {
	const mergeBase = "d".repeat(40);
	const cases = [
		{ name: "explicit", explicit: "release", configured: undefined, selected: "release" },
		{ name: "configured", explicit: undefined, configured: "release", selected: "release" },
		{ name: "default", explicit: undefined, configured: undefined, selected: "trunk" },
	];
	for (const candidate of cases) {
		const calls: Array<[string, string[]]> = [];
		const bases: Array<string | undefined> = [];
		const creationTarget = target(true);
		const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-create-agent-"));
		t.after(() => rmSync(agentDir, { recursive: true, force: true }));
		const exec: Exec = async (command, args) => {
			calls.push([command, [...args]]);
			const text = args.join(" ");
			if (command === "git" && text === "branch --show-current") return result("feature\n");
			if (command === "git" && args[0] === "check-ref-format") return result(`${args[2]}\n`);
			if (command === "git" && text === "remote get-url --push --all origin") return result("git@github.com:acme/project.git\n");
			if (command === "git" && text === "remote get-url --all origin") return result("git@github.com:acme/project.git\n");
			if (command === "git" && args[0] === "config" && args[1] === "--get-all") {
				return candidate.configured === undefined ? result("", 1) : result(`${candidate.configured}\n`);
			}
			if (command === "gh" && args[0] === "repo" && args[4] === "nameWithOwner,url") return result(repositoryOutput());
			if (command === "gh" && args[0] === "repo" && args[4] === "defaultBranchRef") {
				return result(JSON.stringify({ defaultBranchRef: { name: "trunk" } }));
			}
			if (command === "git" && args[0] === "fetch") return result();
			if (command === "git" && args[0] === "rev-parse" && args[2]?.startsWith("refs/remotes/origin/")) return result(`${base}\n`);
			if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${head}\n`);
			if (command === "git" && args[0] === "merge-base") return result(`${mergeBase}\n`);
			if (command === "git" && args[0] === "rev-list" && args[1] === "--count") return result("1\n");
			if (command === "git" && args[0] === "cat-file") return result();
			if (command === "gh" && args[0] === "api" && args[1] === "graphql") return result(baseOutput(candidate.selected));
			throw new Error(`Unexpected ${command} ${text}`);
		};
		const workflow = new PullRequestCreator({
			cwd,
			target: creationTarget,
			agentDir,
			exec,
			async loadCurrentPullRequest(...args) {
				bases.push(args[4]);
				return none(creationTarget);
			},
		});

		const prepared = await workflow.prepare(candidate.explicit);
		assert.deepEqual(prepared, {
			kind: "prepared",
			base: {
				host: "github.com", repository: "acme/project", ref: candidate.selected, oid: base,
				fetchSource: "git@github.com:acme/project.git",
			},
			mergeBase,
		}, candidate.name);
		assert.deepEqual(bases, [candidate.explicit, candidate.explicit], candidate.name);
		assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "merge-base")?.[1], [
			"merge-base", head, base,
		], candidate.name);
		assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "rev-list")?.[1], [
			"rev-list", "--count", `${mergeBase}..${head}`,
		], candidate.name);
		assert.equal(calls.some(([command, args]) =>
			command === "git" && (args[0] === "for-each-ref" || args.includes("--prune") || args.includes("--left-right"))
		), false, candidate.name);
	}
});

test("prepare rejects a shared preflight with no commits ahead", async (t) => {
	const creationTarget = target(true);
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-create-agent-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const calls: Array<[string, string[]]> = [];
	const workflow = new PullRequestCreator({
		cwd,
		target: creationTarget,
		agentDir,
		exec: async (command, args) => {
			calls.push([command, [...args]]);
			const text = args.join(" ");
			if (command === "git" && text === "branch --show-current") return result("feature\n");
			if (command === "git" && args[0] === "check-ref-format") return result(`${args[2]}\n`);
			if (command === "git" && text === "remote get-url --push --all origin") return result("git@github.com:acme/project.git\n");
			if (command === "git" && text === "remote get-url --all origin") return result("git@github.com:acme/project.git\n");
			if (command === "gh" && args[0] === "repo") return result(repositoryOutput());
			if (command === "git" && args[0] === "fetch") return result();
			if (command === "git" && args[0] === "rev-parse" && args[2]?.startsWith("refs/remotes/origin/")) return result(`${base}\n`);
			if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${head}\n`);
			if (command === "git" && args[0] === "merge-base") return result(`${base}\n`);
			if (command === "git" && args[0] === "rev-list") return result("0\n");
			throw new Error(`Unexpected ${command} ${text}`);
		},
		loadCurrentPullRequest: async () => none(creationTarget),
	});

	await assert.rejects(workflow.prepare("main"), /at least one commit ahead/);
	assert.equal(workflow.state.phase, "unprepared");
	assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "cat-file"), false);
});

test("a blocked conflict continuation prevents replay", async (t) => {
	let commands = 0;
	const app = creator(async () => {
		commands += 1;
		return result();
	}, target(true));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.phase = "conflict-awaiting-user";
	app.workflow.state.conflict = { paths: ["conflicted.ts"], statusBaseline: "", originalHead: head };
	app.workflow.state.phase = "blocked";
	await assert.rejects(app.workflow.continue(["conflicted.ts"]), /no conflict awaiting continuation/);
	assert.equal(commands, 0);
});

test("a title/body race after PR mutation is terminal unknown and is never replayed", async (t) => {
	let searches = 0;
	let mutations = 0;
	const exec: Exec = async (command, args) => {
		if (command === "git" && args.join(" ") === "branch --show-current") return result("feature\n");
		if (command === "git" && args.join(" ") === "remote get-url --push --all origin") return result("git@github.com:acme/project.git\n");
		if (command === "git" && args.join(" ") === "remote get-url --all origin") return result("git@github.com:acme/project.git\n");
		if (command === "gh" && args[0] === "repo") return result(repositoryOutput());
		if (command === "git" && args[0] === "ls-remote") return result(`${head}\trefs/heads/feature\n`);
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			const query = args.find((arg) => arg.startsWith("query=")) ?? "";
			if (query.includes("associatedPullRequests(")) return result(searchOutput(searches++ > 0));
			return result(baseOutput());
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "create") {
			mutations += 1;
			return result(`${url}\n`);
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "view") return result(publication("changed concurrently"));
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const app = creator(exec, target(false));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.phase = "pushed";
	app.workflow.state.publicationHead = head;
	await assert.rejects(app.workflow.publish("feat: publish", "expected"), /did not retain canonical identity, title, and body/);
	await assert.rejects(app.workflow.publish("feat: publish", "expected"), /not ready to publish metadata/);
	assert.equal(mutations, 1);
	assert.equal(app.workflow.state.phase, "blocked");
});

test("does not push when HEAD or target authority changes after final ancestry checks", async (t) => {
	for (const race of ["HEAD", "authority"] as const) {
		let localHead = head;
		let latestTarget = target(true);
		const calls: Array<[string, string[]]> = [];
		const exec: Exec = async (command, args) => {
			calls.push([command, [...args]]);
			const text = args.join(" ");
			if (command === "git" && text === "branch --show-current") return result("feature\n");
			if (command === "gh" && args[0] === "api") return result(baseOutput());
			if (command === "git" && text === "status --porcelain=v1 --untracked-files=all") return result();
			if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(OPERATION_PATHS);
			if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${localHead}\n`);
			if (command === "git" && args[0] === "merge-base") {
				if (race === "HEAD") localHead = "d".repeat(40);
				else latestTarget = { ...latestTarget, fetchSource: "git@github.com:acme/moved.git", remoteOid: "e".repeat(40) };
				return result();
			}
			throw new Error(`Unexpected ${command} ${text}`);
		};
		const app = creator(exec, target(true));
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		(app.workflow as unknown as { load: () => Promise<unknown> }).load = async () => none(latestTarget);
		await assert.rejects(app.workflow.push(), race === "HEAD" ? /local HEAD changed before push/ : /fresh complete discovery is no longer none/);
		assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "push"), false, race);
	}
});

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

function baseOutput() {
	return JSON.stringify({ data: { repository: {
		nameWithOwner: "acme/project",
		ref: { name: "main", target: { oid: base } },
	} } });
}

function searchOutput(found: boolean) {
	const edges = found ? [{
		cursor: "cursor-1",
		node: {
			__typename: "PullRequest",
			number: 42,
			url,
			state: "OPEN",
			baseRepository: { nameWithOwner: "acme/project" },
			headRepository: { nameWithOwner: "acme/project" },
			headRefName: "feature",
			headRefOid: head,
		},
	}] : [];
	return JSON.stringify({ data: { search: {
		issueCount: edges.length,
		edges,
		pageInfo: {
			hasNextPage: false,
			startCursor: edges[0]?.cursor ?? null,
			endCursor: edges[0]?.cursor ?? null,
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

function creator(exec: Exec, creationTarget: PullRequestTarget) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-create-agent-"));
	const workflow = new PullRequestCreator({
		cwd,
		target: creationTarget,
		exec,
		agentDir,
		loadCurrentPullRequest: async () => ({
			kind: "none",
			creationTarget: { ...creationTarget, provenance: "configured", remoteOid: head },
		}),
	});
	workflow.state.phase = "verified";
	workflow.state.base = {
		host: "github.com", repository: "acme/project", ref: "main", oid: base,
		fetchSource: "git@github.com:acme/project.git",
	};
	workflow.state.mergeHead = head;
	return { workflow, agentDir };
}

test("push uses an empty exact lease then fetches tracking and sets verified upstream as separate attempts", async (t) => {
	const calls: Array<[string, string[]]> = [];
	let tracking = false;
	let upstream = false;
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
	(app.workflow as unknown as { load: () => Promise<unknown> }).load = async () => ({ kind: "none", creationTarget: target(true) });
	assert.deepEqual(await app.workflow.push(), { kind: "pushed", head });
	assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "push"), ["git", [
		"push", "--porcelain", "--force-with-lease=refs/heads/feature:", "--recurse-submodules=no", "--",
		"git@github.com:acme/project.git", `${head}:refs/heads/feature`,
	]]);
	assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "fetch"), ["git", [
		"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules",
		"git@github.com:acme/project.git", `${head}:refs/remotes/origin/feature`,
	]]);
	assert.equal(app.workflow.state.attempts.fetchTracking, "applied");
	assert.equal(app.workflow.state.attempts.setUpstream, "applied");
});

test("creates with fully pinned gh arguments and verifies sole canonical metadata", async (t) => {
	const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
	let searches = 0;
	const body = "## Summary\n\n- Publish safely.\n\n## Testing\n\n- Tests pass.\n";
	const exec: Exec = async (command, args, options) => {
		calls.push({ command, args: [...args], stdin: options.stdin });
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			const query = args.find((arg) => arg.startsWith("query=")) ?? "";
			if (query.includes("search(query:")) return result(searchOutput(searches++ > 0));
			return result(baseOutput());
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "create") return result(`${url}\n`);
		if (command === "gh" && args[0] === "pr" && args[1] === "view") return result(publication(body));
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const app = creator(exec, target(true));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.phase = "pushed";
	app.workflow.state.publicationHead = head;
	assert.deepEqual(await app.workflow.publish("feat: publish", body), { kind: "published", url });
	const mutation = calls.find(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create");
	assert.deepEqual(mutation, {
		command: "gh",
		args: [
			"pr", "create", "--repo", "github.com/acme/project", "--head", "acme:feature",
			"--base", "main", "--title", "feat: publish", "--body-file", "-",
		],
		stdin: body,
	});
	assert.equal(mutation!.args.includes("--hostname"), false);
	assert.equal(searches, 2);
});

test("rejects a cross-host explicit base before repository lookup", async (t) => {
	let commands = 0;
	const creationTarget = target(true);
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-create-agent-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const workflow = new PullRequestCreator({
		cwd,
		target: creationTarget,
		agentDir,
		exec: async (command, args) => {
			commands += 1;
			if (command === "git" && args.join(" ") === "branch --show-current") return result("feature\n");
			throw new Error("unexpected command");
		},
		loadCurrentPullRequest: async () => ({ kind: "none", creationTarget }),
	});
	await assert.rejects(workflow.prepare("ghe.example/acme/project:main"), /base and head must use the same GitHub host/);
	assert.equal(commands, 1);
});

test("base inference skips the symbolic origin HEAD", async (t) => {
	const creationTarget = target(true);
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-create-agent-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const exec: Exec = async (command, args) => {
		const text = args.join(" ");
		if (command === "git" && text === "branch --show-current") return result("feature\n");
		if (command === "git" && args[0] === "config") return result("", 1);
		if (command === "git" && text === "remote get-url --push --all origin") return result("git@github.com:acme/project.git\n");
		if (command === "git" && text === "remote get-url --all origin") return result("git@github.com:acme/project.git\n");
		if (command === "gh" && args[0] === "repo") {
			return result(JSON.stringify({ nameWithOwner: "acme/project", url: "https://github.com/acme/project" }));
		}
		if (command === "git" && args[0] === "for-each-ref") {
			return result(`refs/remotes/origin/HEAD\t${base}\trefs/remotes/origin/main\nrefs/remotes/origin/main\t${base}\t\n`);
		}
		if (command === "git" && args[0] === "rev-list") return result("1 2\n");
		if (command === "git" && args[0] === "check-ref-format") return result("main\n");
		if (command === "gh" && args[0] === "api") return result(baseOutput());
		if (command === "git" && args[0] === "fetch") return result();
		if (command === "git" && args[0] === "cat-file") return result();
		if (command === "git" && args[0] === "merge-base") return result(`${head}\n`);
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const workflow = new PullRequestCreator({
		cwd,
		target: creationTarget,
		agentDir,
		exec,
		loadCurrentPullRequest: async () => ({ kind: "none", creationTarget }),
	});
	const prepared = await workflow.prepare();
	assert.equal(prepared.kind, "prepared");
	if (prepared.kind === "prepared") assert.equal(prepared.base.ref, "main");
});

test("a consumed conflict stage prevents continuation replay", async (t) => {
	let commands = 0;
	const app = creator(async () => {
		commands += 1;
		return result();
	}, target(true));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.phase = "conflict-awaiting-user";
	app.workflow.state.conflict = { paths: ["conflicted.ts"], statusBaseline: "", originalHead: head };
	app.workflow.state.attempts.stage = "unknown";
	await assert.rejects(app.workflow.continue(["conflicted.ts"]), /continuation was already consumed/);
	assert.equal(commands, 0);
});

test("a title/body race after PR mutation is terminal unknown and is never replayed", async (t) => {
	let searches = 0;
	let mutations = 0;
	const exec: Exec = async (command, args) => {
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			const query = args.find((arg) => arg.startsWith("query=")) ?? "";
			if (query.includes("search(query:")) return result(searchOutput(searches++ > 0));
			return result(baseOutput());
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "create") {
			mutations += 1;
			return result(`${url}\n`);
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "view") return result(publication("changed concurrently"));
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const app = creator(exec, target(true));
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.phase = "pushed";
	app.workflow.state.publicationHead = head;
	await assert.rejects(app.workflow.publish("feat: publish", "expected"), /did not retain canonical identity, title, and body/);
	await assert.rejects(app.workflow.publish("feat: publish", "expected"), /not ready to publish metadata/);
	assert.equal(mutations, 1);
	assert.equal(app.workflow.state.attempts.pullRequest, "unknown");
});

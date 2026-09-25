import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnBounded, type Exec, type ExecResult } from "@henryqw/pi-process";
import type { CurrentPullRequest } from "../extensions/pr-github.ts";
import { PullRequestBranchUpdater } from "../extensions/pr-update-branch.ts";

const oldHead = "a".repeat(40);
const base = "b".repeat(40);
const merged = "c".repeat(40);
const cwd = process.cwd();
const OPERATION_PATHS = Array.from({ length: 6 }, (_, index) => `/tmp/pi-pr-no-operation-${index}`).join("\n") + "\n";

function result(stdout = "", code = 0, stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

function cleanInspection(command: string, args: string[]): ExecResult | undefined {
	const text = args.join(" ");
	if (command === "git" && text === "status --porcelain=v1 --untracked-files=all") return result();
	if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(OPERATION_PATHS);
	return undefined;
}

function pullRequest(overrides: Partial<CurrentPullRequest> = {}): CurrentPullRequest {
	return {
		id: "PR_example",
		number: 42,
		url: new URL("https://github.com/acme/project/pull/42"),
		host: "github.com",
		approved: true,
		lifecycle: "open",
		conditions: {
			draft: false, baseUpdateRequired: false, conflict: true, changesRequested: false,
			unresolvedThreads: 0, ci: "success", review: "ready", policy: "pending",
		},
		local: { worktree: "clean", head: "equal" },
		base: { repository: "acme/project", ref: "main", oid: base },
		head: { repository: "acme/fork", ref: "feature", oid: oldHead },
		headFetchSource: "git@github.com:acme/fork.git",
		target: {
			provenance: "configured", branch: "feature", remote: "fork", ref: "feature",
			repository: "acme/fork", host: "github.com", fetchSource: "git@github.com:acme/fork.git", remoteOid: oldHead,
		},
		...overrides,
	};
}

function updater(exec: Exec, loads: CurrentPullRequest[] = [pullRequest(), pullRequest()]) {
	let index = 0;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-update-agent-"));
	return {
		agentDir,
		workflow: new PullRequestBranchUpdater({
			cwd,
			authority: pullRequest(),
			exec,
			agentDir,
			loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: loads[Math.min(index++, loads.length - 1)]! }),
		}),
	};
}

test("fetches only the frozen base OID and skips merge when it is already an ancestor", async (t) => {
	const calls: Array<[string, string[]]> = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, [...args]]);
		const inspection = cleanInspection(command, args);
		if (inspection) return inspection;
		const text = args.join(" ");
		if (command === "git" && text === "branch --show-current") return result("feature\n");
		if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${oldHead}\n`);
		if (command === "git" && text === "status --porcelain=v2 -z --untracked-files=all") return result();
		if (command === "gh" && text === "config get git_protocol --host github.com") return result("ssh\n");
		if (command === "git" && args[0] === "fetch") return result();
		if (command === "git" && args[0] === "cat-file") return result();
		if (command === "git" && args[0] === "merge-base") return result();
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const app = updater(exec);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	assert.deepEqual(await app.workflow.rebase(), { kind: "verified", head: oldHead, fastForward: false });
	assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "fetch"), [
		"git", ["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "git@github.com:acme/project.git", base],
	]);
	assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "merge"), false);
});

test("rechecks frozen authority after fetch before launching merge", async (t) => {
	const calls: Array<[string, string[]]> = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, [...args]]);
		const inspection = cleanInspection(command, args);
		if (inspection) return inspection;
		if (command === "git" && args[0] === "branch") return result("feature\n");
		if (command === "git" && args[0] === "rev-parse") return result(`${oldHead}\n`);
		if (command === "git" && args[0] === "status") return result();
		if (command === "gh" && args[0] === "config") return result("ssh\n");
		if (command === "git" && (args[0] === "fetch" || args[0] === "cat-file")) return result();
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const moved = pullRequest({ base: { repository: "acme/project", ref: "main", oid: "d".repeat(40) } });
	const app = updater(exec, [pullRequest(), moved]);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	await assert.rejects(app.workflow.rebase(), /frozen pull request authority changed/);
	assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "merge"), false);
});

test("publishes one exact-OID refspec with the original lease and never replays a lost response", async (t) => {
	let pushes = 0;
	const calls: Array<[string, string[]]> = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, [...args]]);
		const inspection = cleanInspection(command, args);
		if (inspection) return inspection;
		if (command === "git" && args[0] === "branch") return result("feature\n");
		if (command === "git" && args[0] === "rev-parse") return result(`${merged}\n`);
		if (command === "git" && args[0] === "status") return result();
		if (command === "git" && args[0] === "merge-base") return result();
		if (command === "git" && args[0] === "push") {
			pushes += 1;
			throw new Error("response lost");
		}
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const app = updater(exec, [pullRequest()]);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	app.workflow.state.phase = "verified";
	app.workflow.state.verifiedHead = merged;
	await assert.rejects(app.workflow.publish(), /outcome is unknown; do not retry/);
	assert.equal(app.workflow.state.phase, "blocked");
	await assert.rejects(app.workflow.publish(), /not ready to publish/);
	assert.equal(pushes, 1);
	assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "push"), ["git", [
		"push", "--porcelain", `--force-with-lease=refs/heads/feature:${oldHead}`,
		"--recurse-submodules=no", "--", "git@github.com:acme/fork.git", `${merged}:refs/heads/feature`,
	]]);
});

test("does not push when HEAD or target authority changes after final base checks", async (t) => {
	for (const race of ["HEAD", "authority"] as const) {
		let localHead = merged;
		let ancestryChecks = 0;
		const loads = [pullRequest(), pullRequest()];
		const calls: Array<[string, string[]]> = [];
		const exec: Exec = async (command, args) => {
			calls.push([command, [...args]]);
			const inspection = cleanInspection(command, args);
			if (inspection) return inspection;
			if (command === "git" && args[0] === "branch") return result("feature\n");
			if (command === "git" && args[0] === "rev-parse") return result(`${localHead}\n`);
			if (command === "git" && args[0] === "status") return result();
			if (command === "git" && args[0] === "merge-base") {
				ancestryChecks += 1;
				if (ancestryChecks === 1) {
					if (race === "HEAD") localHead = "d".repeat(40);
					else {
						const changed = pullRequest();
						loads[1] = pullRequest({ target: {
							...changed.target, fetchSource: "git@github.com:acme/moved.git", remoteOid: "e".repeat(40),
						} });
					}
				}
				return result();
			}
			throw new Error(`Unexpected ${command} ${args.join(" ")}`);
		};
		const app = updater(exec, loads);
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		app.workflow.state.phase = "verified";
		app.workflow.state.verifiedHead = merged;
		await assert.rejects(app.workflow.publish(), race === "HEAD" ? /local HEAD changed/ : /frozen pull request authority changed/);
		assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "push"), false, race);
	}
});

test("refuses to rebase a merge-containing PR branch before changing HEAD", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-pr-merge-history-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const worktree = join(directory, "worktree");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
	execFileSync("git", ["init", "--initial-branch=main", worktree]);
	git("config", "user.name", "Rebase Test");
	git("config", "user.email", "rebase@example.test");
	writeFileSync(join(worktree, "file.txt"), "original\n");
	git("add", "file.txt");
	git("commit", "-m", "initial");
	git("switch", "-c", "feature");
	writeFileSync(join(worktree, "file.txt"), "feature\n");
	git("commit", "-am", "feature");
	git("switch", "-c", "topic");
	writeFileSync(join(worktree, "topic.txt"), "topic\n");
	git("add", "topic.txt");
	git("commit", "-m", "topic");
	git("switch", "feature");
	git("merge", "--no-ff", "topic", "-m", "merge topic");
	const featureHead = git("rev-parse", "HEAD");
	git("switch", "main");
	writeFileSync(join(worktree, "base.txt"), "base\n");
	git("add", "base.txt");
	git("commit", "-m", "base");
	const baseHead = git("rev-parse", "HEAD");
	git("switch", "feature");
	const authority = pullRequest({
		base: { repository: "acme/project", ref: "main", oid: baseHead },
		head: { repository: "acme/fork", ref: "feature", oid: featureHead },
	});
	let rebases = 0;
	const exec: Exec = async (command, args, options) => {
		if (command === "gh") return result("ssh\n");
		if (command === "git" && args[0] === "fetch") return result();
		if (command === "git" && args.includes("rebase")) rebases++;
		return await spawnBounded(command, args, options);
	};
	const workflow = new PullRequestBranchUpdater({ cwd: worktree, authority, exec, agentDir: join(directory, "agent"),
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	await assert.rejects(workflow.rebase(), /merge commits/);
	assert.equal(rebases, 0);
	assert.equal(git("rev-parse", "HEAD"), featureHead);
});

test("confirmed conflict rebases only onto the pinned base and publishes the rewritten head once", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-pr-rebase-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const worktree = join(directory, "worktree");
	const remote = join(directory, "remote.git");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
	execFileSync("git", ["init", "--bare", remote]);
	execFileSync("git", ["init", "--initial-branch=main", worktree]);
	git("config", "user.name", "Rebase Test");
	git("config", "user.email", "rebase@example.test");
	writeFileSync(join(worktree, "file.txt"), "original\n");
	git("add", "file.txt");
	git("commit", "-m", "initial");
	git("branch", "feature");
	writeFileSync(join(worktree, "file.txt"), "base change\n");
	git("commit", "-am", "base change");
	const baseHead = git("rev-parse", "HEAD");
	git("switch", "feature");
	writeFileSync(join(worktree, "file.txt"), "feature change\n");
	git("commit", "-am", "feature change");
	const featureHead = git("rev-parse", "HEAD");
	git("remote", "add", "origin", remote);
	git("push", "origin", `${featureHead}:refs/heads/feature`);
	const authority = pullRequest({
		base: { repository: "acme/project", ref: "main", oid: baseHead },
		head: { repository: "acme/fork", ref: "feature", oid: featureHead },
		headFetchSource: remote,
		target: { ...pullRequest().target, fetchSource: remote, remoteOid: featureHead },
	});
	let pushes = 0;
	const exec: Exec = async (command, args, options) => {
		if (command === "gh" && args.join(" ") === "config get git_protocol --host github.com") return result("ssh\n");
		if (command === "git" && args[0] === "fetch" && args.includes("git@github.com:acme/project.git")) {
			args = args.map((value) => value === "git@github.com:acme/project.git" ? remote : value);
		}
		if (command === "git" && args[0] === "push") pushes += 1;
		return await spawnBounded(command, args, options);
	};
	const workflow = new PullRequestBranchUpdater({
		cwd: worktree, authority, exec, agentDir: join(directory, "agent"),
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }),
	});
	assert.deepEqual(await workflow.rebase(), { kind: "conflict", paths: ["file.txt"] });
	assert.equal(pushes, 0);
	writeFileSync(join(worktree, "file.txt"), "resolved change\n");
	const verified = await workflow.continue(["file.txt"]);
	assert.equal(verified.kind, "verified");
	assert.equal(git("merge-base", "--is-ancestor", baseHead, git("rev-parse", "HEAD")), "");
	assert.equal(git("status", "--porcelain"), "");
	assert.deepEqual(await workflow.publish(), { kind: "published", head: git("rev-parse", "HEAD") });
	assert.equal(pushes, 1);
	assert.equal(git("ls-remote", remote, "refs/heads/feature").split("\t")[0], git("rev-parse", "HEAD"));
	await assert.rejects(workflow.publish(), /not ready to publish/);
});

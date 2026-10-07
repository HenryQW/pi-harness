import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import type { CurrentPullRequest } from "../extensions/pr-github.ts";
import { PullRequestWorkPublisher } from "../extensions/pr-publish-work.ts";
import { PrRun } from "../extensions/pr-run.ts";

const result = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });

test("scoped pending work is committed, validated, and pushed by exact lease once", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-pr-publish-work-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "worktree");
	const bare = join(dir, "remote.git");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	execFileSync("git", ["init", "--bare", bare]);
	execFileSync("git", ["init", "--initial-branch=feature", root]);
	git("config", "user.name", "Local Work Test");
	git("config", "user.email", "local@example.test");
	writeFileSync(join(root, "file.txt"), "original\n");
	writeFileSync(join(root, "*.txt"), "literal path\n");
	git("add", "-A");
	git("commit", "-m", "initial");
	const oldHead = git("rev-parse", "HEAD");
	git("remote", "add", "origin", "git@github.com:acme/project.git");
	git("push", bare, `${oldHead}:refs/heads/feature`);
	writeFileSync(join(root, "file.txt"), "updated\n");
	writeFileSync(join(root, "*.txt"), "updated literal path\n");
	let authority: CurrentPullRequest = {
		id: "PR_123", number: 42, url: new URL("https://github.com/acme/project/pull/42"), host: "github.com",
		approved: true, lifecycle: "open", conditions: { draft: false, baseUpdateRequired: false, conflict: false,
			changesRequested: false, unresolvedThreads: 0, ci: "success", review: "ready", policy: "ready", mergeability: "known" },
		local: { worktree: "dirty", head: "equal" },
		base: { repository: "acme/project", ref: "main", oid: oldHead },
		head: { repository: "acme/project", ref: "feature", oid: oldHead },
		headFetchSource: "git@github.com:acme/project.git",
		target: { provenance: "configured", branch: "feature", remote: "origin", ref: "feature",
			repository: "acme/project", host: "github.com", fetchSource: "git@github.com:acme/project.git", remoteOid: oldHead },
	};
	let pushes = 0;
	let losePushResponse = false;
	let loseCommitResponse = false;
	let failCheck = true;
	const exec: Exec = async (command, args, options) => {
		if (command === "work-check") return { ...result(), code: failCheck ? 7 : 0 };
		if (command === "gh" && args[0] === "repo") return result(JSON.stringify({ nameWithOwner: "acme/project", url: "https://github.com/acme/project" }));
		if (command === "git" && (args[0] === "push" || args[0] === "ls-remote") && args.includes("git@github.com:acme/project.git")) {
			args = args.map((value) => value === "git@github.com:acme/project.git" ? bare : value);
			if (args[0] === "push") pushes += 1;
		}
		const response = await spawnBounded(command, args, options);
		if (command === "git" && args[0] === "push" && losePushResponse) throw new Error("push response lost");
		if (command === "git" && args[0] === "commit" && loseCommitResponse) throw new Error("commit response lost");
		return response;
	};
	const workflow = new PullRequestWorkPublisher({ cwd: root, agentDir: join(dir, "agent"), authority, exec, run: new PrRun(),
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	assert.deepEqual(await workflow.inspect(), { paths: ["*.txt", "file.txt"], head: oldHead, originalHead: oldHead, diverged: false });
	writeFileSync(join(root, "*.txt"), "same status, different bytes\n");
	await assert.rejects(workflow.commit(["*.txt"], "fix: drifted work"), /changed after inspection/);
	assert.equal(git("diff", "--cached"), "");
	writeFileSync(join(root, "*.txt"), "updated literal path\n");
	await assert.rejects(workflow.commit(["unknown.txt"], "fix: scope work"), /reviewed pending paths/);
	let committed = await workflow.commit(["*.txt"], "fix: scope work");
	assert.notEqual(committed.head, oldHead);
	assert.equal(git("diff", "--name-only", `${oldHead}..${committed.head}`), "*.txt");
	assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "M file.txt");
	writeFileSync(join(root, "file.txt"), "original\n");
	const checks = [{ command: "work-check", args: [] }];
	await assert.rejects(workflow.validate(checks), /failed/);
	await assert.rejects(workflow.validate(checks), /already executed/);
	writeFileSync(join(root, "*.txt"), "repaired\n");
	assert.deepEqual((await workflow.inspect()).paths, ["*.txt"]);
	committed = await workflow.commit(["*.txt"], "fix: repair failed check");
	await assert.rejects(workflow.validate([]), /frozen/);
	failCheck = false;
	assert.deepEqual(await workflow.validate(checks), { head: committed.head, checks: 2 });
	assert.deepEqual(await workflow.publish(), { kind: "published", head: committed.head });
	assert.equal(pushes, 1);
	assert.equal(git("ls-remote", bare, "refs/heads/feature").split("\t")[0], committed.head);
	await assert.rejects(workflow.publish(), /not validated/);

	// The exact remote postcondition proves publication even when Git loses its response.
	authority = { ...authority, head: { ...authority.head, oid: committed.head },
		target: { ...authority.target, remoteOid: committed.head } };
	writeFileSync(join(root, "file.txt"), "updated again\n");
	const resumed = new PullRequestWorkPublisher({ cwd: root, agentDir: join(dir, "agent"), authority, exec,
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	await resumed.inspect();
	const second = await resumed.commit(["file.txt"], "fix: follow up");
	await resumed.validate([]);
	losePushResponse = true;
	assert.deepEqual(await resumed.publish(), { kind: "published", head: second.head });
	assert.equal(pushes, 2);
	await assert.rejects(resumed.publish(), /not validated/);
	await assert.rejects(resumed.inspect(), /consumed/);
	await assert.rejects(resumed.validate([]), /unavailable/);

	authority = { ...authority, head: { ...authority.head, oid: second.head },
		target: { ...authority.target, remoteOid: second.head } };
	git("mv", "--", "*.txt", "renamed.txt");
	const renamed = new PullRequestWorkPublisher({ cwd: root, agentDir: join(dir, "agent"), authority, exec,
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	assert.deepEqual((await renamed.inspect()).paths, ["renamed.txt", "*.txt"]);
	await assert.rejects(renamed.commit(["renamed.txt"], "fix: rename"), /Unrelated staged changes/);
	assert.equal(git("status", "--porcelain=v1"), "R  *.txt -> renamed.txt");
	await renamed.commit(["*.txt", "renamed.txt"], "refactor: rename file");
	assert.equal(git("status", "--porcelain=v1"), "");
	git("reset", "--hard", second.head);
	writeFileSync(join(root, "file.txt"), "commit response will be lost\n");
	const uncertain = new PullRequestWorkPublisher({ cwd: root, agentDir: join(dir, "agent"), authority, exec,
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	await uncertain.inspect();
	loseCommitResponse = true;
	await assert.rejects(uncertain.commit(["file.txt"], "fix: pending work"), /commit response lost/);
	await assert.rejects(uncertain.inspect(), /consumed/);
	await assert.rejects(uncertain.validate([]), /unavailable/);
	loseCommitResponse = false;

	git("reset", "--hard", oldHead);
	writeFileSync(join(root, "file.txt"), "local work on stale head\n");
	authority = { ...authority, local: { worktree: "dirty", head: "equal" },
		head: { ...authority.head, oid: second.head }, target: { ...authority.target, remoteOid: second.head } };
	const stale = new PullRequestWorkPublisher({ cwd: root, agentDir: join(dir, "agent"), authority, exec,
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	// Pending work on a non-descendant HEAD may be committed; validation and publication wait for sync.
	assert.equal((await stale.inspect()).diverged, true);
	const divergedCommit = await stale.commit(["file.txt"], "fix: work on stale head");
	assert.equal(divergedCommit.diverged, true);
	assert.equal(git("rev-parse", "HEAD"), divergedCommit.head);
	assert.equal(git("status", "--porcelain=v1"), "");
	await assert.rejects(stale.validate([]), /not a descendant/);
	assert.equal(pushes, 2);
	git("reset", "--hard", oldHead);
	const cleanStale = new PullRequestWorkPublisher({ cwd: root, agentDir: join(dir, "agent"), authority, exec,
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	await assert.rejects(cleanStale.inspect(), /not a descendant/);
});

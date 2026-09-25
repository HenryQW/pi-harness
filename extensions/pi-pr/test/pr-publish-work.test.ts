import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import type { CurrentPullRequest } from "../extensions/pr-github.ts";
import { PullRequestWorkPublisher } from "../extensions/pr-publish-work.ts";

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
			changesRequested: false, unresolvedThreads: 0, ci: "success", review: "ready", policy: "ready" },
		local: { worktree: "dirty", head: "equal" },
		base: { repository: "acme/project", ref: "main", oid: oldHead },
		head: { repository: "acme/project", ref: "feature", oid: oldHead },
		headFetchSource: "git@github.com:acme/project.git",
		target: { provenance: "configured", branch: "feature", remote: "origin", ref: "feature",
			repository: "acme/project", host: "github.com", fetchSource: "git@github.com:acme/project.git", remoteOid: oldHead },
	};
	let pushes = 0;
	let losePushResponse = false;
	const exec: Exec = async (command, args, options) => {
		if (command === "gh" && args[0] === "repo") return result(JSON.stringify({ nameWithOwner: "acme/project", url: "https://github.com/acme/project" }));
		if (command === "git" && (args[0] === "push" || args[0] === "ls-remote") && args.includes("git@github.com:acme/project.git")) {
			args = args.map((value) => value === "git@github.com:acme/project.git" ? bare : value);
			if (args[0] === "push") pushes += 1;
		}
		const response = await spawnBounded(command, args, options);
		if (command === "git" && args[0] === "push" && losePushResponse) throw new Error("push response lost");
		return response;
	};
	const workflow = new PullRequestWorkPublisher({ cwd: root, agentDir: join(dir, "agent"), authority, exec,
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	assert.deepEqual(await workflow.inspect(), { paths: ["*.txt", "file.txt"], head: oldHead });
	await assert.rejects(workflow.commit(["unknown.txt"], "fix: scope work"), /reviewed pending paths/);
	const committed = await workflow.commit(["*.txt"], "fix: scope work");
	assert.notEqual(committed.head, oldHead);
	assert.equal(git("diff", "--name-only", `${oldHead}..${committed.head}`), "*.txt");
	assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "M file.txt");
	writeFileSync(join(root, "file.txt"), "original\n");
	assert.deepEqual(await workflow.validate([]), { head: committed.head, checks: 1 });
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
});

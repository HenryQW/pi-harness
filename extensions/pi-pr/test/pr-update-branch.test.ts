import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CurrentPullRequest } from "../extensions/pr-github.ts";
import type { Exec, ExecResult } from "../extensions/pr-execution.ts";
import { PullRequestBranchUpdater } from "../extensions/pr-update-branch.ts";

const oldHead = "a".repeat(40);
const base = "b".repeat(40);
const merged = "c".repeat(40);
const zero = "0".repeat(40);
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
			draft: false, baseUpdateRequired: true, conflict: false, changesRequested: false,
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
		merge: { allowedMergeMethods: ["squash"], viewerDefaultMergeMethod: "squash" },
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
		if (command === "gh" && args[0] === "api") return result(JSON.stringify({
			clone_url: "https://github.com/acme/project.git",
			ssh_url: "git@github.com:acme/project.git",
		}));
		if (command === "git" && args[0] === "fetch") return result();
		if (command === "git" && args[0] === "cat-file") return result();
		if (command === "git" && args[0] === "merge-base") return result();
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const app = updater(exec);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	assert.deepEqual(await app.workflow.merge(), { kind: "verified", head: oldHead, fastForward: false });
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
		if (command === "gh" && args[0] === "api") return result(JSON.stringify({ clone_url: "https://github.com/acme/project.git", ssh_url: "git@github.com:acme/project.git" }));
		if (command === "git" && (args[0] === "fetch" || args[0] === "cat-file")) return result();
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const moved = pullRequest({ base: { repository: "acme/project", ref: "main", oid: "d".repeat(40) } });
	const app = updater(exec, [pullRequest(), moved]);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	await assert.rejects(app.workflow.merge(), /frozen pull request authority changed/);
	assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "merge"), false);
});

test("captures a conflict baseline and rejects an outside-set delta before staging", async (t) => {
	const staged = `1 M. N... 100644 100644 100644 ${zero} ${oldHead} generated.lock\0`;
	const unresolved = `u UU N... 100644 100644 100644 100644 ${zero} ${oldHead} ${base} source.ts\0`;
	let statusReads = 0;
	const calls: Array<[string, string[]]> = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, [...args]]);
		const inspection = cleanInspection(command, args);
		if (inspection) return inspection;
		const text = args.join(" ");
		if (command === "git" && text === "branch --show-current") return result("feature\n");
		if (command === "git" && text === "rev-parse --verify HEAD^{commit}") return result(`${oldHead}\n`);
		if (command === "git" && text === "status --porcelain=v2 -z --untracked-files=all") {
			statusReads += 1;
			return result(statusReads === 1 ? staged + unresolved : unresolved);
		}
		if (command === "gh" && args[0] === "config") return result("ssh\n");
		if (command === "gh" && args[0] === "api") return result(JSON.stringify({ clone_url: "https://github.com/acme/project.git", ssh_url: "git@github.com:acme/project.git" }));
		if (command === "git" && (args[0] === "fetch" || args[0] === "cat-file")) return result();
		if (command === "git" && args[0] === "merge-base") return result("", 1);
		if (command === "git" && args[0] === "merge") return result("", 1, "conflict");
		if (command === "git" && text === "rev-parse --verify MERGE_HEAD^{commit}") return result(`${base}\n`);
		if (command === "git" && args[0] === "diff") return result("source.ts\0");
		throw new Error(`Unexpected ${command} ${text}`);
	};
	const app = updater(exec);
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	assert.deepEqual(await app.workflow.merge(), { kind: "conflict", paths: ["source.ts"] });
	await assert.rejects(app.workflow.continue(["source.ts"]), /changed outside declared conflict paths: generated\.lock/);
	assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "add"), false);
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
	await assert.rejects(app.workflow.publish(), /response lost/);
	await assert.rejects(app.workflow.publish(), /not ready to publish/);
	assert.equal(pushes, 1);
	assert.deepEqual(calls.find(([command, args]) => command === "git" && args[0] === "push"), ["git", [
		"push", "--porcelain", `--force-with-lease=refs/heads/feature:${oldHead}`,
		"--recurse-submodules=no", "--", "git@github.com:acme/fork.git", `${merged}:refs/heads/feature`,
	]]);
});

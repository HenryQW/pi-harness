import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	collectPullRequestFeedback,
	FEEDBACK_API_PAGE_MAX_BYTES,
	type FeedbackAuthority,
} from "../extensions/pr-feedback.ts";
import {
	PullRequestCommentSweep,
	SWEEP_RECOVERY_MAX_BYTES,
	type SweepLedgerEntry,
	type SweepStatus,
} from "../extensions/pr-comment-sweep.ts";
import type { CurrentPullRequest } from "../extensions/pr-github.ts";
import { spawnBounded, type Exec, type ExecResult } from "../extensions/pr-execution.ts";

const operationPaths = Array.from({ length: 6 }, (_, index) => `/tmp/pi-pr-sweep-no-operation-${index}`).join("\n") + "\n";

function result(stdout = "", code = 0, stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
	return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function authority(head = "a".repeat(40)): FeedbackAuthority {
	return {
		id: "PR_42",
		number: 42,
		url: "https://github.com/acme/project/pull/42",
		host: "github.com",
		base: { repository: "acme/project", ref: "main", oid: "b".repeat(40) },
		head: { repository: "acme/fork", ref: "feature", oid: head },
	};
}

function comment(id: string, body = id) {
	return { id, url: `https://github.com/acme/project/pull/42#issuecomment-${id}`, body, createdAt: "2025-01-01T00:00:00Z", author: { login: "reviewer" } };
}

function review(id: string, body = id) {
	return { id, url: `https://github.com/acme/project/pull/42#pullrequestreview-${id}`, state: "CHANGES_REQUESTED", body, submittedAt: "2025-01-01T00:00:00Z", author: { login: "reviewer" } };
}

function thread(id: string, isResolved = false, comments = [comment(`${id}-comment`)]) {
	return {
		id,
		isResolved,
		isOutdated: false,
		path: "file.txt",
		line: 1,
		diffSide: "RIGHT",
		startLine: null,
		startDiffSide: null,
		originalLine: 1,
		originalStartLine: null,
		comments: page(comments),
	};
}

test("feedback reads paginate every connection and enforce page and record bounds", async () => {
	let calls = 0;
	const seenLimits: number[] = [];
	const exec: Exec = async (_command, _args, options) => {
		calls += 1;
		seenLimits.push(options.stdoutLimitBytes!);
		const variables = new Map(_args.filter((arg) => arg.includes("=")).map((arg) => arg.split("=", 2) as [string, string]));
		const second = variables.get("commentsCursor") === "comments-2";
		return result(JSON.stringify({ data: { repository: { pullRequest: {
			comments: page([comment(second ? "comment-2" : "comment-1")], !second, second ? null : "comments-2"),
			reviews: page([review("review-1")]),
			reviewThreads: page([thread("thread-1")]),
		} } } }));
	};
	const snapshot = await collectPullRequestFeedback(authority(), { exec, cwd: process.cwd(), pause: async () => {} });
	assert.deepEqual(snapshot.conversationComments.map(({ id }) => id), ["comment-1", "comment-2"]);
	assert.equal(calls, 2);
	assert.deepEqual(new Set(seenLimits), new Set([FEEDBACK_API_PAGE_MAX_BYTES]));
	await assert.rejects(collectPullRequestFeedback({
		...authority(),
		url: "https://github.com/acme/project/pull/41",
	}, { exec, cwd: process.cwd() }), /URL does not match its number and base repository/);
	assert.equal(calls, 2);

	let pages = 0;
	const endless: Exec = async () => {
		pages += 1;
		return result(JSON.stringify({ data: { repository: { pullRequest: {
			comments: page([], true, `cursor-${pages}`), reviews: page([]), reviewThreads: page([]),
		} } } }));
	};
	await assert.rejects(collectPullRequestFeedback(authority(), { exec: endless, cwd: process.cwd(), pause: async () => {} }), /exceeds 100 pages/);
	assert.equal(pages, 100);

	const tooMany: Exec = async () => result(JSON.stringify({ data: { repository: { pullRequest: {
		comments: page([]),
		reviews: page([]),
		reviewThreads: page(Array.from({ length: 100 }, (_, index) => thread(`thread-${index}`, false,
			Array.from({ length: 10 }, (__, commentIndex) => comment(`comment-${index}-${commentIndex}`))))),
	} } } }));
	await assert.rejects(collectPullRequestFeedback(authority(), { exec: tooMany, cwd: process.cwd() }), /exceeds 1000 records/);
});

type Fixture = {
	root: string;
	bare: string;
	agentDir: string;
	initial: string;
	world: { resolved: boolean; body: string; extraBody: string | null; mutationCalls: number; pushCalls: number; checkCalls: number; losePushResponse: boolean; applyPush: boolean; loseMutationResponse: boolean; applyMutation: boolean; loseCheckResponse: boolean };
	exec: Exec;
	current: () => CurrentPullRequest;
	workflow: (ids?: string[]) => PullRequestCommentSweep;
	cleanup: () => void;
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): Fixture {
	const temporary = mkdtempSync(join(tmpdir(), "pi-pr-comment-sweep-"));
	const root = join(temporary, "worktree");
	const bare = join(temporary, "remote.git");
	const agentDir = join(temporary, "agent");
	execFileSync("git", ["init", "--bare", bare]);
	execFileSync("git", ["init", "--initial-branch=feature", root]);
	git(root, "config", "user.name", "Sweep Test");
	git(root, "config", "user.email", "sweep@example.test");
	writeFileSync(join(root, "file.txt"), "initial\n");
	git(root, "add", "file.txt");
	git(root, "commit", "-m", "initial");
	const initial = git(root, "rev-parse", "HEAD");
	git(root, "remote", "add", "origin", bare);
	git(root, "push", "origin", `${initial}:refs/heads/feature`);
	const world = { resolved: false, body: "please fix", extraBody: null as string | null, mutationCalls: 0, pushCalls: 0, checkCalls: 0, losePushResponse: false, applyPush: true, loseMutationResponse: false, applyMutation: true, loseCheckResponse: false };
	const exec: Exec = async (command, args, options) => {
		if (command === "gh" && args[0] === "api" && options.stdin?.includes("resolveReviewThread")) {
			world.mutationCalls += 1;
			if (world.applyMutation) world.resolved = true;
			if (world.loseMutationResponse) throw new Error("mutation response lost");
			return result(JSON.stringify({ data: { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } } }));
		}
		if (command === "gh" && args[0] === "api") {
			return result(JSON.stringify({ data: { repository: { pullRequest: {
				comments: page([
					comment("conversation-1", world.body),
					...(world.extraBody === null ? [] : [comment("conversation-2", world.extraBody)]),
				]),
				reviews: page([review("review-1")]),
				reviewThreads: page([thread("thread-1", world.resolved)]),
			} } } }));
		}
		if (command === "git" && args[0] === "push") {
			world.pushCalls += 1;
			if (world.losePushResponse) {
				if (world.applyPush) await spawnBounded(command, args, options);
				throw new Error("push response lost");
			}
		}
		if (command === "sweep-lost-check") {
			world.checkCalls += 1;
			if (world.loseCheckResponse) throw new Error("check response lost");
			return result();
		}
		return await spawnBounded(command, args, options);
	};
	const remoteHead = () => git(root, "ls-remote", "--refs", bare, "refs/heads/feature").split("\t")[0]!;
	const current = (): CurrentPullRequest => {
		const head = remoteHead();
		return {
			id: "PR_42",
			number: 42,
			url: new URL("https://github.com/acme/project/pull/42"),
			host: "github.com",
			approved: false,
			lifecycle: "open",
			conditions: {
				draft: false, baseUpdateRequired: false, conflict: false, changesRequested: true,
				unresolvedThreads: world.resolved ? 0 : 1, ci: "success", review: "pending", policy: "pending",
			},
			local: { worktree: "clean", head: "equal" },
			base: { repository: "acme/project", ref: "main", oid: initial },
			head: { repository: "acme/fork", ref: "feature", oid: head },
			headFetchSource: bare,
			target: {
				provenance: "configured", branch: "feature", remote: "origin", ref: "feature",
				repository: "acme/fork", host: "github.com", fetchSource: bare, remoteOid: head,
			},
		};
	};
	const workflow = (ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]) => {
		let index = 0;
		return new PullRequestCommentSweep({
			cwd: root,
			authority: current(),
			agentDir,
			exec,
			loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: current() }),
			newRunId: () => ids[Math.min(index++, ids.length - 1)]!,
			pause: async () => {},
		});
	};
	return { root, bare, agentDir, initial, world, exec, current, workflow, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
}

function ledger(status: SweepStatus): SweepLedgerEntry[] {
	assert.equal(status.feedbackCount, status.feedback.length);
	return status.feedback.map(({ id, kind }) => ({ id, kind, disposition: "addressed", note: "verified" }));
}

test("a real sweep start persists recovery and read-only launch inspection chooses resume", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();

	assert.equal(await workflow.recoveryLaunchAction(), "start");
	await workflow.start();
	const recoveryPath = await workflow.recoveryPath();
	const recovery = readFileSync(recoveryPath, "utf8");
	assert.equal(await workflow.recoveryLaunchAction(), "resume");
	assert.equal(readFileSync(recoveryPath, "utf8"), recovery);
});

test("runs exact coverage, guarded publication, fresh resolution, checks, and final projection end to end", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	const started = await workflow.start();
	assert.deepEqual(started.feedback, [
		{ id: "conversation-1", kind: "conversation_comment" },
		{ id: "review-1", kind: "review" },
		{ id: "thread-1", kind: "thread" },
		{ id: "thread-1-comment", kind: "thread_comment" },
	]);
	await assert.rejects(workflow.record(started.guard, ledger(started)), /requires ownedPaths/);
	const shown = await workflow.show(started.guard, started.feedback[0]!.id);
	assert.equal(shown.kind, "conversation_comment");
	if (shown.kind !== "conversation_comment") throw new Error("unexpected feedback kind");
	assert.equal(shown.body, "please fix");
	await assert.rejects(workflow.record(started.guard, ledger(started).slice(1), ["file.txt"]), /cover every feedback item exactly once/);
	const recorded = await workflow.record(started.guard, ledger(started), ["file.txt"]);
	writeFileSync(join(app.root, "file.txt"), "fixed\n");
	git(app.root, "add", "file.txt");
	git(app.root, "commit", "-m", "fix: address review");
	const published = await workflow.publish(recorded.guard);
	assert.equal(published.phase, "published");
	assert.equal(app.world.pushCalls, 1);
	assert.notEqual(published.publicationHead, app.initial);
	const refreshPending = await workflow.refresh(published.guard);
	assert.equal(refreshPending.phase, "refresh-pending");
	assert.equal(refreshPending.ledgerComplete, false);
	const refreshed = await workflow.record(refreshPending.guard, ledger(refreshPending));
	assert.equal(refreshed.phase, "refreshed");
	assert(refreshed.projection);
	const recoveryPath = await workflow.recoveryPath();
	const validRecovery = readFileSync(recoveryPath, "utf8");
	const tamperedRecovery = JSON.parse(validRecovery);
	tamperedRecovery.projection.threads[0].isResolved = false;
	const tamperedText = `${JSON.stringify(tamperedRecovery)}\n`;
	writeFileSync(recoveryPath, tamperedText);
	await assert.rejects(workflow.resume(), /final projection does not match feedback and ledger coverage/);
	assert.equal(readFileSync(recoveryPath, "utf8"), tamperedText);
	writeFileSync(recoveryPath, validRecovery);
	const resolved = await workflow.resolve(refreshed.guard, ["thread-1"]);
	assert.equal(resolved.phase, "resolved");
	assert.equal(app.world.mutationCalls, 1);

	app.world.body = "late edit";
	await assert.rejects(workflow.finalize(resolved.guard, refreshed.projection!, [{ command: "git", args: ["diff", "--check"] }]), /declared final projection/);
	app.world.body = "please fix";
	assert.deepEqual(await workflow.finalize(resolved.guard, refreshed.projection!, [{ command: "git", args: ["diff", "--check"] }]), {
		kind: "finalized", pullRequestUrl: "https://github.com/acme/project/pull/42", head: published.publicationHead, checks: 1,
	});
	assert.throws(() => readFileSync(recoveryPath, "utf8"), { code: "ENOENT" });
});

test("freezes and exposes new feedback before accepting an exact fresh ledger", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	const started = await workflow.start();
	const initialLedger = ledger(started);
	const recorded = await workflow.record(started.guard, initialLedger, []);
	const published = await workflow.publish(recorded.guard);

	app.world.extraBody = "new feedback after publish";
	const refreshPending = await workflow.refresh(published.guard);
	assert.equal(refreshPending.phase, "refresh-pending");
	assert.equal(refreshPending.guard.generation, published.guard.generation + 1);
	assert.equal(refreshPending.ledgerComplete, false);
	assert.equal(refreshPending.projection, null);
	assert.deepEqual(refreshPending.feedback.find(({ id }) => id === "conversation-2"), {
		id: "conversation-2", kind: "conversation_comment",
	});
	assert.doesNotMatch(JSON.stringify(refreshPending), /new feedback after publish/);

	const resumed = await workflow.resume();
	assert.equal(resumed.phase, "refresh-pending");
	assert.equal(resumed.guard.generation, refreshPending.guard.generation);
	assert.equal(resumed.guard.fingerprint, refreshPending.guard.fingerprint);
	assert.deepEqual(resumed.feedback, refreshPending.feedback);
	assert.doesNotMatch(JSON.stringify(resumed), /new feedback after publish/);
	await assert.rejects(workflow.show(published.guard, "conversation-2"), /stale comment sweep run/);
	await assert.rejects(workflow.show(refreshPending.guard, "conversation-2"), /stale comment sweep run/);
	const shown = await workflow.show(resumed.guard, "conversation-2");
	assert.equal(shown.kind, "conversation_comment");
	if (shown.kind !== "conversation_comment") throw new Error("unexpected feedback kind");
	assert.equal(shown.body, "new feedback after publish");
	await assert.rejects(workflow.resolve(resumed.guard, []), /not ready to resolve/);
	await assert.rejects(workflow.finalize(resumed.guard, resumed.projection!, []), /not ready to finalize/);
	await assert.rejects(workflow.record(published.guard, ledger(resumed)), /stale comment sweep run/);
	await assert.rejects(workflow.record(refreshPending.guard, ledger(resumed)), /stale comment sweep run/);
	await assert.rejects(workflow.record(resumed.guard, initialLedger), /cover every feedback item exactly once/);
	await assert.rejects(workflow.record(resumed.guard, ledger(resumed), []), /cannot change ownedPaths/);

	const refreshed = await workflow.record(resumed.guard, ledger(resumed));
	const resolved = await workflow.resolve(refreshed.guard, ["thread-1"]);
	await workflow.finalize(resolved.guard, refreshed.projection!, []);
});

test("edited same-ID feedback cannot inherit its pre-refresh disposition", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	const started = await workflow.start();
	const initialLedger = ledger(started);
	const recorded = await workflow.record(started.guard, initialLedger, []);
	const published = await workflow.publish(recorded.guard);

	app.world.body = "edited feedback after publish";
	const refreshPending = await workflow.refresh(published.guard);
	assert.equal(refreshPending.phase, "refresh-pending");
	assert.deepEqual(refreshPending.feedback, published.feedback);
	assert.notEqual(refreshPending.guard.fingerprint, published.guard.fingerprint);
	assert.equal(refreshPending.ledgerComplete, false);
	assert.equal(refreshPending.projection, null);
	assert.doesNotMatch(JSON.stringify(refreshPending), /please fix|edited feedback after publish/);
	const shown = await workflow.show(refreshPending.guard, "conversation-1");
	assert.equal(shown.kind, "conversation_comment");
	if (shown.kind !== "conversation_comment") throw new Error("unexpected feedback kind");
	assert.equal(shown.body, "edited feedback after publish");
	await assert.rejects(workflow.record(published.guard, initialLedger), /stale comment sweep run/);

	const freshLedger = ledger(refreshPending).map((entry) => entry.id === "conversation-1"
		? { ...entry, disposition: "blocked" as const, note: "reassessed edited feedback" }
		: entry);
	const refreshed = await workflow.record(refreshPending.guard, freshLedger);
	assert.equal(refreshed.phase, "refreshed");
	const resolved = await workflow.resolve(refreshed.guard, ["thread-1"]);
	await workflow.finalize(resolved.guard, refreshed.projection!, []);
});

test("committed rename ownership includes the source and destination", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	const started = await workflow.start();
	const recorded = await workflow.record(started.guard, ledger(started), ["renamed.txt"]);
	git(app.root, "config", "diff.renames", "true");
	git(app.root, "mv", "file.txt", "renamed.txt");
	git(app.root, "commit", "-m", "fix: rename reviewed file");

	await assert.rejects(workflow.publish(recorded.guard), /changed outside owned paths: file\.txt/);
	assert.equal(app.world.pushCalls, 0);
});

test("resume rejects another route authority in the same worktree without mutation", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	await workflow.start();
	const recoveryPath = await workflow.recoveryPath();
	const recovery = readFileSync(recoveryPath, "utf8");
	const current = app.current();
	const mismatched = new PullRequestCommentSweep({
		cwd: app.root,
		authority: {
			...current,
			id: "PR_99",
			number: 99,
			url: new URL("https://github.com/acme/project/pull/99"),
			head: { ...current.head, ref: "other" },
			target: { ...current.target, branch: "other", ref: "other" },
		},
		agentDir: app.agentDir,
		exec: app.exec,
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: app.current() }),
		newRunId: () => "33333333-3333-4333-8333-333333333333",
		pause: async () => {},
	});

	await assert.rejects(mismatched.recoveryLaunchAction(), (error: unknown) => {
		assert(error instanceof Error);
		assert.match(error.message, /freshly discovered route authority/);
		assert.ok(error.message.includes(recoveryPath));
		return true;
	});
	assert.equal(readFileSync(recoveryPath, "utf8"), recovery);
	await assert.rejects(mismatched.resume(), (error: unknown) => {
		assert(error instanceof Error);
		assert.match(error.message, /supplied route authority/);
		assert.ok(error.message.includes(recoveryPath));
		return true;
	});
	assert.equal(readFileSync(recoveryPath, "utf8"), recovery);
	assert.deepEqual({
		push: app.world.pushCalls,
		thread: app.world.mutationCalls,
		checks: app.world.checkCalls,
	}, { push: 0, thread: 0, checks: 0 });
});

test("resume reconciles a lost push response, rotates the run, and never replays it", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	app.world.losePushResponse = true;
	const workflow = app.workflow();
	const started = await workflow.start();
	const recorded = await workflow.record(started.guard, ledger(started), ["file.txt"]);
	writeFileSync(join(app.root, "file.txt"), "fixed\n");
	git(app.root, "add", "file.txt");
	git(app.root, "commit", "-m", "fix: address review");
	await assert.rejects(workflow.publish(recorded.guard), /push response lost/);
	assert.equal(app.world.pushCalls, 1);
	const resumed = await app.workflow(["33333333-3333-4333-8333-333333333333"]).resume();
	assert.equal(resumed.phase, "published");
	assert.equal(resumed.attempts.push, "applied");
	assert.equal(resumed.guard.epoch, 2);
	assert.notEqual(resumed.guard.runId, recorded.guard.runId);
	assert.deepEqual(resumed.feedback, started.feedback);
	assert.equal((await workflow.show(resumed.guard, resumed.feedback[0]!.id)).id, "conversation-1");
	await assert.rejects(workflow.show(recorded.guard, "conversation-1"), /stale comment sweep run/);
	await assert.rejects(workflow.publish(resumed.guard), /not ready to publish/);
	assert.equal(app.world.pushCalls, 1);
});

test("resume permits a new push only after proving a lost push was not applied", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	app.world.losePushResponse = true;
	app.world.applyPush = false;
	const workflow = app.workflow();
	const started = await workflow.start();
	const recorded = await workflow.record(started.guard, ledger(started), ["file.txt"]);
	writeFileSync(join(app.root, "file.txt"), "fixed\n");
	git(app.root, "add", "file.txt");
	git(app.root, "commit", "-m", "fix: address review");
	await assert.rejects(workflow.publish(recorded.guard), /push response lost/);
	const resumed = await workflow.resume();
	assert.equal(resumed.attempts.push, "none");
	assert.equal(resumed.publicationHead, null);
	app.world.losePushResponse = false;
	assert.equal((await workflow.publish(resumed.guard)).phase, "published");
	assert.equal(app.world.pushCalls, 2);
});

test("resume reconciles a lost thread response without replaying the mutation", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	const started = await workflow.start();
	const recorded = await workflow.record(started.guard, ledger(started), []);
	const published = await workflow.publish(recorded.guard);
	assert.equal(app.world.pushCalls, 0);
	const refreshPending = await workflow.refresh(published.guard);
	const refreshed = await workflow.record(refreshPending.guard, ledger(refreshPending));
	app.world.loseMutationResponse = true;
	await assert.rejects(workflow.resolve(refreshed.guard, ["thread-1"]), /mutation response lost/);
	assert.equal(app.world.mutationCalls, 1);
	await assert.rejects(workflow.resolve(refreshed.guard, []), /unreconciled thread mutation/);
	await assert.rejects(workflow.refresh(refreshed.guard), /unreconciled thread mutation/);
	assert.equal(app.world.mutationCalls, 1);
	const resumed = await workflow.resume();
	assert.equal(resumed.phase, "resolved");
	assert.equal(resumed.attempts.resolutions[0]?.state, "applied");
	await assert.rejects(workflow.resolve(resumed.guard, ["thread-1"]), /not ready to resolve|Only addressed unresolved/);
	assert.equal(app.world.mutationCalls, 1);
});

test("resume permits retry only after proving a lost thread mutation was not applied", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	const started = await workflow.start();
	const recorded = await workflow.record(started.guard, ledger(started), []);
	const published = await workflow.publish(recorded.guard);
	const refreshPending = await workflow.refresh(published.guard);
	const refreshed = await workflow.record(refreshPending.guard, ledger(refreshPending));
	app.world.applyMutation = false;
	app.world.loseMutationResponse = true;
	await assert.rejects(workflow.resolve(refreshed.guard, ["thread-1"]), /mutation response lost/);
	await assert.rejects(workflow.refresh(refreshed.guard), /unreconciled thread mutation/);
	const resumed = await workflow.resume();
	assert.equal(resumed.attempts.resolutions.length, 0);
	app.world.applyMutation = true;
	app.world.loseMutationResponse = false;
	const resolved = await workflow.resolve(resumed.guard, ["thread-1"]);
	assert.equal(resolved.phase, "resolved");
	assert.equal(app.world.mutationCalls, 2);
});

test("a blocked finalization requires resume before checks can run again", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	const started = await workflow.start();
	const recorded = await workflow.record(started.guard, ledger(started), []);
	const published = await workflow.publish(recorded.guard);
	const refreshPending = await workflow.refresh(published.guard);
	const refreshed = await workflow.record(refreshPending.guard, ledger(refreshPending));
	const resolved = await workflow.resolve(refreshed.guard, ["thread-1"]);
	const failedCheck = [{ command: process.execPath, args: ["-e", "process.exit(7)"] }];
	await assert.rejects(workflow.finalize(resolved.guard, refreshed.projection!, failedCheck), /exit code 7/);
	await assert.rejects(workflow.finalize(resolved.guard, refreshed.projection!, failedCheck), /unreconciled finalization attempt/);
	await assert.rejects(workflow.refresh(resolved.guard), /unreconciled finalization attempt/);
	const resumed = await workflow.resume();
	assert.equal(resumed.attempts.finalize, "none");
	assert.deepEqual(await workflow.finalize(resumed.guard, resumed.projection!, [{ command: process.execPath, args: ["-e", ""] }]), {
		kind: "finalized", pullRequestUrl: "https://github.com/acme/project/pull/42", head: published.publicationHead, checks: 1,
	});
});

test("an unknown finalization result remains terminal after resume", async (t) => {
	const app = fixture();
	t.after(app.cleanup);
	const workflow = app.workflow();
	const started = await workflow.start();
	const recorded = await workflow.record(started.guard, ledger(started), []);
	const published = await workflow.publish(recorded.guard);
	const refreshPending = await workflow.refresh(published.guard);
	const refreshed = await workflow.record(refreshPending.guard, ledger(refreshPending));
	const resolved = await workflow.resolve(refreshed.guard, ["thread-1"]);
	app.world.loseCheckResponse = true;
	const checks = [{ command: "sweep-lost-check", args: [] }];
	await assert.rejects(workflow.finalize(resolved.guard, refreshed.projection!, checks), /check response lost/);
	const resumed = await workflow.resume();
	assert.equal(resumed.attempts.finalize, "unknown");
	await assert.rejects(workflow.finalize(resumed.guard, resumed.projection!, checks), /unreconciled finalization attempt/);
	await assert.rejects(workflow.refresh(resumed.guard), /unreconciled finalization attempt/);
	assert.equal(app.world.checkCalls, 1);
});

test("invalid recovery blocks launch and stays byte-for-byte preserved", async (t) => {
	const cases: Array<{ name: string; contents(valid: string): string; blocker: RegExp }> = [
		{ name: "malformed", contents: () => "{malformed\n", blocker: /Malformed comment sweep recovery/ },
		{ name: "oversized", contents: () => "x".repeat(SWEEP_RECOVERY_MAX_BYTES + 1), blocker: /exceeds 1048576 bytes/ },
		{
			name: "obsolete",
			contents: (valid) => {
				const state = JSON.parse(valid);
				state.version = 0;
				return `${JSON.stringify(state)}\n`;
			},
			blocker: /unsupported sweep recovery state version/,
		},
		{
			name: "wrong worktree",
			contents: (valid) => {
				const state = JSON.parse(valid);
				state.worktree.root = "/another/worktree";
				return `${JSON.stringify(state)}\n`;
			},
			blocker: /belongs to another worktree/,
		},
	];

	for (const candidate of cases) {
		const app = fixture();
		t.after(app.cleanup);
		const workflow = app.workflow();
		await workflow.start();
		const path = await workflow.recoveryPath();
		const contents = candidate.contents(readFileSync(path, "utf8"));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents);

		await assert.rejects(workflow.recoveryLaunchAction(), (error: unknown) => {
			assert(error instanceof Error);
			assert.match(error.message, candidate.blocker, candidate.name);
			assert.ok(error.message.includes(path), candidate.name);
			return true;
		});
		assert.equal(readFileSync(path, "utf8"), contents, candidate.name);
		await assert.rejects(workflow.start(), candidate.blocker, candidate.name);
		assert.equal(readFileSync(path, "utf8"), contents, candidate.name);
	}
});

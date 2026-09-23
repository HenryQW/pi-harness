import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IntegrationGit, type StageReceipt } from "../src/integration-git.ts";
import { CheckedGitRuntime } from "../src/git-runtime.ts";
import type { CheckBatchEvidence, WorkspaceIdentity } from "../src/schema.ts";
import { createChildWorktree, finalizeChildWorktree, type WorktreeInfo } from "../src/worktree.ts";

const signal = new AbortController().signal;
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
async function repo(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "integration-git-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	git(root, "init", "-qb", "main");
	git(root, "config", "user.name", "Git Test");
	git(root, "config", "user.email", "test@example.com");
	await writeFile(join(root, "shared.txt"), "base\n");
	git(root, "add", "shared.txt");
	git(root, "commit", "-qm", "base");
	return root;
}
async function commit(root: string, text: string): Promise<void> {
	await writeFile(join(root, "shared.txt"), `${text}\n`);
	git(root, "add", "shared.txt");
	git(root, "commit", "-qm", text);
}
async function allocate(runtime: IntegrationGit, root: string, base: WorkspaceIdentity, id: string): Promise<WorktreeInfo> {
	let recorded: WorktreeInfo | undefined;
	const result = await runtime.allocate(root, id, base, async (info) => {
		assert.equal(git(root, "branch", "--list", info.branch), "", "intent precedes allocation");
		recorded = info;
	}, signal);
	assert.equal(result.outcome, "ready", JSON.stringify(result));
	assert.deepEqual(result.outcome === "ready" && result.value, recorded);
	return recorded!;
}
function checks(tip: WorkspaceIdentity): CheckBatchEvidence {
	return { phase: "final", candidate: tip, identityAfter: tip, passed: true, results: [], at: Date.now() };
}

test("same-file isolated candidates merge in Main-ordered integration checkout; Main moves only after exact combined-tip gates", async (t) => {
	const root = await repo(t);
	const runtime = new IntegrationGit();
	const base = await new CheckedGitRuntime().inspectMain({ root }, { signal, deadline: Date.now() + 30000, timeoutMs: 30000 });
	const integration = await allocate(runtime, root, base, "integration");
	const first = await allocate(runtime, root, base, "first");
	const second = await allocate(runtime, root, base, "second");
	await commit(first.path, "first");
	await commit(second.path, "second");
	const candidate = (path: string): WorkspaceIdentity => ({
		branch: git(path, "symbolic-ref", "HEAD"), head: git(path, "rev-parse", "HEAD"),
		index: git(path, "rev-parse", "HEAD^{tree}"), tree: git(path, "rev-parse", "HEAD^{tree}"),
	});
	const firstCandidate = candidate(first.path);
	const secondCandidate = candidate(second.path);
	assert.deepEqual(await runtime.reconcileStage(root, integration, base, [], first, firstCandidate, signal), { outcome: "ready", value: "not_started" });
	const staged = await runtime.stage(root, integration, base, [], first, firstCandidate, signal);
	assert.equal(staged.outcome, "ready", JSON.stringify(staged));
	const stages: StageReceipt[] = [staged.outcome === "ready" ? staged.value : assert.fail("first merge failed")];
	const conflicting = await runtime.stage(root, integration, base, stages, second, secondCandidate, signal);
	assert.equal(conflicting.outcome, "conflict", JSON.stringify(conflicting));
	const pending = await runtime.reconcileStage(root, integration, base, stages, second, secondCandidate, signal);
	assert.equal(pending.outcome, "conflict", JSON.stringify(pending));
	assert.match(await readFile(join(integration.path, "shared.txt"), "utf8"), /<<<<<<< HEAD/);
	assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "base\n");
	assert.equal(await readFile(join(second.path, "shared.txt"), "utf8"), "second\n");
	assert.equal(git(root, "rev-parse", "HEAD"), base.head);
	assert.equal((await runtime.confirmStage(root, integration, base, stages, second, secondCandidate, signal)).outcome, "unknown", "uncommitted conflict is not a resolution receipt");
	await writeFile(join(integration.path, "shared.txt"), "first and second\n");
	git(integration.path, "add", "shared.txt");
	git(integration.path, "commit", "-qm", "Main resolved both candidates");
	const resolved = await runtime.confirmStage(root, integration, base, stages, second, secondCandidate, signal);
	assert.equal(resolved.outcome, "ready", JSON.stringify(resolved));
	const recovered = await runtime.reconcileStage(root, integration, base, stages, second, secondCandidate, signal);
	assert.equal(recovered.outcome, "ready", JSON.stringify(recovered));
	assert.deepEqual(recovered.outcome === "ready" && recovered.value, resolved.outcome === "ready" && resolved.value);
	stages.push(resolved.outcome === "ready" ? resolved.value : assert.fail("resolution failed"));
	const combined = await runtime.inspectCombined(root, integration, base, stages, signal);
	assert.equal(git(root, "rev-parse", "HEAD"), base.head);
	const bad = await runtime.promote({ root, integration, base, stages, checks: checks(firstCandidate), commands: [] }, signal);
	assert.equal(bad.outcome, "blocked");
	const promoted = await runtime.promote({ root, integration, base, stages, checks: checks(combined), commands: [] }, signal);
	assert.equal(promoted.outcome, "ready", JSON.stringify(promoted));
	assert.equal(git(root, "rev-parse", "HEAD"), combined.head);
	assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "first and second\n");
	const approved = promoted.outcome === "ready" ? promoted.value : assert.fail("promotion failed");
	await writeFile(join(root, "untracked.txt"), "dirty\n");
	const refused = await runtime.cleanup(root, integration, first, base, stages, approved, "worktree", signal);
	assert.equal(refused.outcome, "unknown");
	assert.equal(git(first.path, "rev-parse", "HEAD"), firstCandidate.head);
	await rm(join(root, "untracked.txt"));
	for (const worktree of [first, second, integration]) {
		assert.deepEqual(await runtime.cleanup(root, integration, worktree, base, stages, approved, "worktree", signal), { outcome: "ready", value: "removed" });
		assert.deepEqual(await runtime.cleanup(root, integration, worktree, base, stages, approved, "branch", signal), { outcome: "ready", value: "removed" });
	}
});

test("text and changeset dependents read and edit an exact staged predecessor without moving Main", async (t) => {
	const root = await repo(t);
	const runtime = new IntegrationGit();
	const checked = new CheckedGitRuntime();
	const context = { signal, deadline: Date.now() + 30000, timeoutMs: 30000 };
	const inspected = (path: string) => checked.inspectMain({ root: path }, context);
	const base = await inspected(root);
	const integration = await allocate(runtime, root, base, "dependency-integration");
	const predecessor = await allocate(runtime, root, base, "dependency-predecessor");
	await commit(predecessor.path, "predecessor");
	const first = await runtime.stage(root, integration, base, [], predecessor, await inspected(predecessor.path), signal);
	assert.equal(first.outcome, "ready", JSON.stringify(first));
	const stages = [first.outcome === "ready" ? first.value : assert.fail("predecessor stage failed")];
	const snapshot = stages[0]!.tip;
	const textCheckout = await createChildWorktree(integration.path, "text-dependent");
	assert.ok(textCheckout);
	assert.equal(textCheckout.baseCommit, snapshot.head);
	assert.equal(await readFile(join(textCheckout.path, "shared.txt"), "utf8"), "predecessor\n");
	assert.equal((await finalizeChildWorktree(textCheckout)).outcome, "pruned");
	let worker: WorktreeInfo | undefined;
	const attempt = { waveBase: snapshot } as Parameters<typeof checked.allocateWorktree>[0]["attempt"];
	const intent = { kind: "worktree", token: "token-1234567890123456" } as Parameters<typeof checked.allocateWorktree>[0]["intent"];
	const task = { id: "dependent" } as Parameters<typeof checked.allocateWorktree>[0]["task"];
	const allocated = await checked.allocateWorktree({ root, baseRoot: integration.path, intent, task, attempt,
		onPrepared: async (prepared) => { worker = prepared; assert.equal(prepared.baseCommit, snapshot.head); } }, context);
	assert.deepEqual(allocated, { kind: "worktree", outcome: "owned" });
	assert.ok(worker);
	assert.equal(await readFile(join(worker.path, "shared.txt"), "utf8"), "predecessor\n");
	await commit(worker.path, "dependent edit");
	const second = await runtime.stage(root, integration, base, stages, worker, await inspected(worker.path), signal);
	assert.equal(second.outcome, "ready", JSON.stringify(second));
	stages.push(second.outcome === "ready" ? second.value : assert.fail("dependent stage failed"));
	assert.equal(await readFile(join(integration.path, "shared.txt"), "utf8"), "dependent edit\n");
	assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "base\n");
});

test("Main's exact single-parent correction needs fresh final evidence before guarded promotion", async (t) => {
	const root = await repo(t);
	const runtime = new IntegrationGit();
	const inspected = (path: string) => new CheckedGitRuntime().inspectMain({ root: path },
		{ signal, deadline: Date.now() + 30000, timeoutMs: 30000 });
	const base = await inspected(root);
	const integration = await allocate(runtime, root, base, "correction-integration");
	const worker = await allocate(runtime, root, base, "correction-worker");
	await commit(worker.path, "worker");
	const candidate = await inspected(worker.path);
	const result = await runtime.stage(root, integration, base, [], worker, candidate, signal);
	assert.equal(result.outcome, "ready");
	const stages = [result.outcome === "ready" ? result.value : assert.fail("stage failed")];
	const from = stages[0]!.tip;
	await commit(integration.path, "Main corrected interaction");
	const to = await inspected(integration.path);
	await runtime.inspectCorrection(root, integration, base, stages, from, to, signal);
	assert.equal((await runtime.promote({ root, integration, base, stages, correction: { from, to },
		checks: checks(from), commands: [] }, signal)).outcome, "blocked");
	assert.equal(git(root, "rev-parse", "HEAD"), base.head);
	const promoted = await runtime.promote({ root, integration, base, stages, correction: { from, to },
		checks: checks(to), commands: [] }, signal);
	assert.equal(promoted.outcome, "ready", JSON.stringify(promoted));
	const approved = promoted.outcome === "ready" ? promoted.value : assert.fail("promotion failed");
	assert.equal(approved.head, to.head);
	for (const checkout of [worker, integration]) {
		assert.equal((await runtime.cleanup(root, integration, checkout, base, stages, approved, "worktree", signal, { from, to })).outcome, "ready");
		assert.equal((await runtime.cleanup(root, integration, checkout, base, stages, approved, "branch", signal, { from, to })).outcome, "ready");
	}
});

test("an immutable candidate can be replayed after Main advances, without changing its worker checkout", async (t) => {
	const root = await repo(t);
	const runtime = new IntegrationGit();
	const inspected = () => new CheckedGitRuntime().inspectMain({ root }, { signal, deadline: Date.now() + 30000, timeoutMs: 30000 });
	const original = await inspected();
	const worker = await allocate(runtime, root, original, "replay-worker");
	await commit(worker.path, "candidate");
	const workerTree = git(worker.path, "rev-parse", "HEAD^{tree}");
	const candidate = { branch: `refs/heads/${worker.branch}`, head: git(worker.path, "rev-parse", "HEAD"), index: workerTree, tree: workerTree };
	await writeFile(join(root, "main-only.txt"), "new Main work\n");
	git(root, "add", "main-only.txt");
	git(root, "commit", "-qm", "Main advanced");
	const base = await inspected();
	const integration = await allocate(runtime, root, base, "replay-integration");
	const staged = await runtime.stage(root, integration, base, [], worker, candidate, signal);
	assert.equal(staged.outcome, "ready", JSON.stringify(staged));
	const stages = [staged.outcome === "ready" ? staged.value : assert.fail("replay failed")];
	const combined = await runtime.inspectCombined(root, integration, base, stages, signal);
	assert.equal(git(root, "rev-parse", "HEAD"), base.head);
	assert.equal(git(worker.path, "rev-parse", "HEAD"), candidate.head);
	const promoted = await runtime.promote({ root, integration, base, stages, checks: checks(combined), commands: [] }, signal);
	assert.equal(promoted.outcome, "ready", JSON.stringify(promoted));
	assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "candidate\n");
	assert.equal(await readFile(join(root, "main-only.txt"), "utf8"), "new Main work\n");
	const approved = promoted.outcome === "ready" ? promoted.value : assert.fail("promotion failed");
	assert.deepEqual(await runtime.cleanup(root, integration, worker, base, stages, approved, "worktree", signal), { outcome: "ready", value: "removed" });
	assert.deepEqual(await runtime.cleanup(root, integration, worker, base, stages, approved, "branch", signal), { outcome: "ready", value: "removed" });
});

test("manual resolution cannot adopt a changed worker candidate", async (t) => {
	const root = await repo(t);
	const runtime = new IntegrationGit();
	const base = await new CheckedGitRuntime().inspectMain({ root }, { signal, deadline: Date.now() + 30000, timeoutMs: 30000 });
	const integration = await allocate(runtime, root, base, "stale-integration");
	const first = await allocate(runtime, root, base, "stale-first");
	const second = await allocate(runtime, root, base, "stale-second");
	await commit(first.path, "first");
	await commit(second.path, "second");
	const identity = (info: WorktreeInfo): WorkspaceIdentity => {
		const tree = git(info.path, "rev-parse", "HEAD^{tree}");
		return { branch: `refs/heads/${info.branch}`, head: git(info.path, "rev-parse", "HEAD"), index: tree, tree };
	};
	const firstCandidate = identity(first);
	const secondCandidate = identity(second);
	const staged = await runtime.stage(root, integration, base, [], first, firstCandidate, signal);
	assert.equal(staged.outcome, "ready");
	const stages = [staged.outcome === "ready" ? staged.value : assert.fail("stage failed")];
	assert.equal((await runtime.stage(root, integration, base, stages, second, secondCandidate, signal)).outcome, "conflict");
	await commit(second.path, "revised");
	await writeFile(join(integration.path, "shared.txt"), "resolved\n");
	git(integration.path, "add", "shared.txt");
	git(integration.path, "commit", "-qm", "resolve old candidate");
	assert.equal((await runtime.reconcileStage(root, integration, base, stages, second, secondCandidate, signal)).outcome, "unknown");
	assert.equal((await runtime.confirmStage(root, integration, base, stages, second, secondCandidate, signal)).outcome, "unknown");
	assert.equal(git(root, "rev-parse", "HEAD"), base.head);
});

test("dirty and drifted Main block promotion without touching owned candidate or integration worktree", async (t) => {
	const root = await repo(t);
	const runtime = new IntegrationGit();
	const inspected = () => new CheckedGitRuntime().inspectMain({ root }, { signal, deadline: Date.now() + 30000, timeoutMs: 30000 });
	const base = await inspected();
	const integration = await allocate(runtime, root, base, "integration-drift");
	const worker = await allocate(runtime, root, base, "worker-drift");
	await commit(worker.path, "candidate");
	const tree = git(worker.path, "rev-parse", "HEAD^{tree}");
	const candidate = { branch: `refs/heads/${worker.branch}`, head: git(worker.path, "rev-parse", "HEAD"), index: tree, tree };
	const staged = await runtime.stage(root, integration, base, [], worker, candidate, signal);
	assert.equal(staged.outcome, "ready", JSON.stringify(staged));
	const stages = [staged.outcome === "ready" ? staged.value : assert.fail("stage failed")];
	const combined = await runtime.inspectCombined(root, integration, base, stages, signal);
	await writeFile(join(root, "dirty.txt"), "dirty\n");
	await assert.rejects(runtime.promote({ root, integration, base, stages, checks: checks(combined), commands: [] }, signal), /not clean/);
	await rm(join(root, "dirty.txt"));
	await commit(root, "external");
	const drift = await runtime.promote({ root, integration, base, stages, checks: checks(combined), commands: [] }, signal);
	assert.equal(drift.outcome, "drift");
	assert.equal(git(integration.path, "rev-parse", "HEAD"), combined.head);
	assert.equal(git(worker.path, "rev-parse", "HEAD"), candidate.head);
	assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "external\n");
});

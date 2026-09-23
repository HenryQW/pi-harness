import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runGit, type GitResult } from "./git-process.ts";
import { CheckedGitRuntime } from "./git-runtime.ts";
import { createChildWorktree, WorktreeSetupError, type WorktreeInfo } from "./worktree.ts";
import {
	checkBatchPasses, reviewEvidencePasses, sameIdentity, type CheckBatchEvidence,
	type CheckCommand, type ReviewEvidence, type WorkspaceIdentity,
} from "./schema.ts";

// The caller persists allocation intent before add, each stage intent before merge, and
// receipts before proceeding. An unknown result is never replayed automatically.
export type StageReceipt = {
	previous: WorkspaceIdentity;
	worker: WorkspaceIdentity;
	tip: WorkspaceIdentity;
};
export type GitOutcome<T> =
	| { outcome: "ready"; value: T }
	| { outcome: "blocked" | "conflict" | "drift" | "unknown"; failure: string; possibleResources?: string[] };

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const diagnostic = (value: string) => value.trim().slice(0, 500);
const failure = (args: string[], result: GitResult) => `git ${args[0]} failed (exit ${result.code}): ${diagnostic(result.stderr || result.stdout)}`;
const unknown = (failure: string, worktree: WorktreeInfo): GitOutcome<never> => ({
	outcome: "unknown", failure, possibleResources: [worktree.path, worktree.branch],
});

async function git(args: string[], cwd: string, signal: AbortSignal): Promise<GitResult> {
	if (signal.aborted) throw signal.reason;
	return await runGit(args, cwd, signal);
}
async function requireGit(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	const result = await git(args, cwd, signal);
	if (result.code !== 0) throw new Error(failure(args, result));
	return result.stdout.trimEnd();
}
async function ancestor(base: string, tip: string, cwd: string, signal: AbortSignal): Promise<boolean> {
	const args = ["merge-base", "--is-ancestor", base, tip];
	const result = await git(args, cwd, signal);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new Error(failure(args, result));
}
async function sharedHistory(base: string, tip: string, cwd: string, signal: AbortSignal): Promise<boolean> {
	const args = ["merge-base", base, tip];
	const result = await git(args, cwd, signal);
	if (result.code === 1) return false;
	if (result.code !== 0) throw new Error(failure(args, result));
	if (!oidPattern.test(result.stdout.trim())) throw new Error("Git returned a malformed shared ancestor.");
	return true;
}

/** Check helper-derived names even after a safely removed checkout is no longer present. */
async function ownershipMetadata(root: string, info: WorktreeInfo, signal: AbortSignal): Promise<void> {
	const canonical = await realpath(root);
	if (await realpath(await requireGit(["rev-parse", "--show-toplevel"], root, signal)) !== canonical
		|| info.repoRoot !== canonical || info.cwd !== info.path
		|| !/^pi-subagent\/subagent-[0-9a-f]{24}$/.test(info.branch)
		|| info.path !== join(canonical, ".worktrees", basename(info.branch))) {
		throw new Error("Git worktree is not an exact owned checkout of Main.");
	}
}

/** Only helper-derived, still-registered worktrees belonging to the exact Main repository. */
async function owned(root: string, info: WorktreeInfo, signal: AbortSignal): Promise<void> {
	await ownershipMetadata(root, info, signal);
	if (await realpath(info.path) !== info.path) throw new Error("Owned worktree path changed.");
	const registered = await requireGit(["worktree", "list", "--porcelain", "-z"], root, signal);
	if (!registered.split("\0").includes(`worktree ${info.path}`)) throw new Error("Owned worktree registration is missing.");
	const common = await realpath(await requireGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root, signal));
	const other = await realpath(await requireGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], info.path, signal));
	if (common !== other) throw new Error("Owned worktree belongs to a different repository.");
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

let inspector: CheckedGitRuntime | undefined; // Lazy: schema -> index -> runner -> integration-git -> git-runtime.
async function inspect(path: string, signal: AbortSignal): Promise<WorkspaceIdentity> {
	return await (inspector ??= new CheckedGitRuntime()).inspectMain({ root: path }, { signal, deadline: Date.now() + 30_000, timeoutMs: 30_000 });
}
async function current(root: string, info: WorktreeInfo, signal: AbortSignal): Promise<WorkspaceIdentity> {
	await owned(root, info, signal);
	const identity = await inspect(info.path, signal);
	if (identity.branch !== `refs/heads/${info.branch}`) throw new Error("Owned worktree switched branch.");
	const tip = await requireGit(["rev-parse", "--verify", `refs/heads/${info.branch}^{commit}`], root, signal);
	if (identity.head !== tip) throw new Error("Owned branch differs from checked-out HEAD.");
	return identity;
}

async function parents(commit: string, root: string, signal: AbortSignal): Promise<string[]> {
	const line = await requireGit(["rev-list", "--parents", "-n", "1", commit], root, signal);
	const ids = line.split(" ");
	if (ids[0] !== commit || !ids.every((id) => oidPattern.test(id))) throw new Error("Git returned malformed merge ancestry.");
	return ids.slice(1);
}

// Git's merge normally updates the checked-out HEAD and ref through a reference
// transaction. Reject any unexpected ref movement *inside* that transaction.
function refGuard(branch: string, from: string, to: string): string {
	return `#!/usr/bin/env node
const {readFileSync} = require("node:fs");
const branch = ${JSON.stringify(branch)}, from = ${JSON.stringify(from)}, to = ${JSON.stringify(to)};
const state = process.argv[2];
if (state !== "preparing" && state !== "prepared") process.exit(0);
function reject() { process.stderr.write("pi-subagent: promotion ref drift\\n"); process.exit(1); }
const input = readFileSync(0, "utf8");
if (!input.endsWith("\\n")) reject();
const lines = input.slice(0, -1).split("\\n").map(line => {
  const parts = line.split(" ");
  if (parts.length !== 3) reject();
  return parts;
});
if (new Set(lines.map(line => line[2])).size !== lines.length) reject();
if (lines.some(([old, next, ref]) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(old)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(next)
    || (ref !== "HEAD" && ref !== "ORIG_HEAD" && ref !== "AUTO_MERGE" && !ref.startsWith("refs/")))) reject();
if (lines.some(([old, next, ref]) => ref === "ORIG_HEAD" && next !== from)) reject();
const moving = lines.filter(line => line[2] === "HEAD" || line[2].startsWith("refs/"));
const exact = (line, ref) => line[0] === from && line[1] === to && line[2] === ref;
if (!moving.length) process.exit(0);
if (state === "preparing") {
  if (moving.length !== 1 || !exact(moving[0], "HEAD")) reject();
} else if (!(moving.length === 1 && exact(moving[0], branch)
    || moving.length === 2 && moving.some(line => exact(line, "HEAD"))
      && moving.some(line => exact(line, branch)))) reject();
`;
}

async function proveHistory(root: string, base: WorkspaceIdentity, stages: readonly StageReceipt[], branch: string, signal: AbortSignal): Promise<WorkspaceIdentity> {
	let previous = { ...base, branch };
	for (const stage of stages) {
		const ancestry = await parents(stage.tip.head, root, signal);
		if (!sameIdentity(stage.previous, previous) || !oidPattern.test(stage.worker.head)
			|| stage.worker.index !== stage.worker.tree
			|| stage.worker.head === previous.head
			|| !await sharedHistory(base.head, stage.worker.head, root, signal)
			|| stage.tip.branch !== branch || stage.tip.index !== stage.tip.tree
			|| ancestry.length !== 2 || ancestry[0] !== previous.head || ancestry[1] !== stage.worker.head) {
			throw new Error("Integration stage provenance differs from its recorded first-parent/worker merge.");
		}
		previous = stage.tip;
	}
	return previous;
}

export class IntegrationGit {
	/** Refresh is allowed only for the exact clean checked-out Main and a strict same-branch descendant. */
	async inspectMainAdvance(root: string, from: WorkspaceIdentity, to: WorkspaceIdentity, signal: AbortSignal): Promise<void> {
		if (from.branch !== to.branch || from.head === to.head || from.index !== from.tree || to.index !== to.tree
			|| !sameIdentity(await inspect(root, signal), to) || !await ancestor(from.head, to.head, root, signal)) {
			throw new Error("Main refresh requires the exact clean same-branch descendant of recorded Main.");
		}
	}

	/** Persist the prepared path/branch/base before Git is allowed to create anything. */
	async allocate(root: string, childId: string, base: WorkspaceIdentity, onPrepared: (info: WorktreeInfo) => Promise<void>, signal: AbortSignal): Promise<GitOutcome<WorktreeInfo>> {
		if (!sameIdentity(await inspect(root, signal), base)) return { outcome: "drift", failure: "Main drifted before integration allocation." };
		let prepared: WorktreeInfo | undefined;
		try {
			const added = await createChildWorktree(root, childId, runGit, signal, async (info) => {
				prepared = info;
				if (info.baseCommit !== base.head) throw new Error("Integration base differs from recorded Main.");
				await onPrepared(info);
				if (!sameIdentity(await inspect(root, signal), base)) throw new Error("Main drifted before worktree add.");
			});
			if (!added) return { outcome: "blocked", failure: "Integration requires committed Git Main." };
			if (!sameIdentity(await inspect(root, signal), base)) return unknown("Main drifted during worktree allocation; retain the worktree.", added);
			await current(root, added, signal);
			return { outcome: "ready", value: added };
		} catch (error) {
			if (error instanceof WorktreeSetupError) return unknown(error.message, error.worktree);
			if (prepared) return unknown(`Allocation could not be proved: ${String(error)}`, prepared);
			throw error;
		}
	}

	/** Prove each recorded merge before any new merge or final gate. */
	async inspectCombined(root: string, integration: WorktreeInfo, base: WorkspaceIdentity, stages: readonly StageReceipt[], signal: AbortSignal): Promise<WorkspaceIdentity> {
		if (integration.baseCommit !== base.head) throw new Error("Integration worktree has a different base.");
		const tip = await current(root, integration, signal);
		const previous = await proveHistory(root, base, stages, tip.branch, signal);
		if (!sameIdentity(tip, previous)) throw new Error("Integration tip drifted from recorded stages.");
		return tip;
	}

	/** Main's correction is one exact committed child of the checked staged tip. */
	async inspectCorrection(root: string, integration: WorktreeInfo, base: WorkspaceIdentity,
		stages: readonly StageReceipt[], from: WorkspaceIdentity, to: WorkspaceIdentity, signal: AbortSignal): Promise<void> {
		const staged = await proveHistory(root, base, stages, `refs/heads/${integration.branch}`, signal);
		if (!sameIdentity(staged, from) || !sameIdentity(await current(root, integration, signal), to)
			|| to.head === from.head || (await parents(to.head, root, signal)).join() !== from.head) {
			throw new Error("Main correction must be one clean committed child of the exact staged tip.");
		}
	}

	/** Main orders calls. On conflict leave MERGE_HEAD and the index untouched for manual resolution. */
	async stage(root: string, integration: WorktreeInfo, base: WorkspaceIdentity, stages: readonly StageReceipt[], worker: WorktreeInfo, candidate: WorkspaceIdentity, signal: AbortSignal): Promise<GitOutcome<StageReceipt>> {
		const previous = await this.inspectCombined(root, integration, base, stages, signal);
		if (worker.path === integration.path || !(await ancestor(worker.baseCommit, base.head, root, signal)
				|| stages.some((stage) => stage.tip.head === worker.baseCommit))
			|| !sameIdentity(await current(root, worker, signal), candidate)
			|| candidate.head === worker.baseCommit || !await ancestor(worker.baseCommit, candidate.head, root, signal)
			|| await ancestor(candidate.head, previous.head, root, signal)) {
			return { outcome: "blocked", failure: "Worker is not an unchanged independent committed candidate from the recorded base." };
		}
		const args = ["merge", "--no-ff", "--no-edit", "--no-autostash", "--no-overwrite-ignore", candidate.head];
		let merged: GitResult;
		try { merged = await git(args, integration.path, signal); }
		catch (error) { return unknown(`Merge outcome uncertain: ${String(error)}`, integration); }
		if (merged.code !== 0) {
			if (merged.code !== -1) {
				try {
					const mergeHead = await git(["rev-parse", "--verify", "MERGE_HEAD"], integration.path, signal);
					if (mergeHead.code === 0 && mergeHead.stdout.trim() === candidate.head) {
						return { outcome: "conflict", failure: "Merge needs Main's resolution in the retained integration worktree.", possibleResources: [integration.path, integration.branch] };
					}
				} catch { /* Retain the uncertain merge. */ }
			}
			return unknown(failure(args, merged), integration);
		}
		return await this.confirmStage(root, integration, base, stages, worker, candidate, signal);
	}

	/** After manual conflict resolution: only the exact two-parent merge is a valid receipt. */
	async confirmStage(root: string, integration: WorktreeInfo, base: WorkspaceIdentity, stages: readonly StageReceipt[], worker: WorktreeInfo, candidate: WorkspaceIdentity, signal: AbortSignal): Promise<GitOutcome<StageReceipt>> {
		try {
			const previous = stages.at(-1)?.tip ?? { ...base, branch: `refs/heads/${integration.branch}` };
			if (worker.path === integration.path || !(await ancestor(worker.baseCommit, base.head, root, signal)
					|| stages.some((stage) => stage.tip.head === worker.baseCommit))
				|| candidate.head === worker.baseCommit || !await ancestor(worker.baseCommit, candidate.head, root, signal)
				|| !sameIdentity(await current(root, worker, signal), candidate)) {
				throw new Error("Worker candidate changed or does not descend from the recorded base.");
			}
			await owned(root, integration, signal);
			const tip = await current(root, integration, signal);
			const ancestry = await parents(tip.head, root, signal);
			if (ancestry.length !== 2 || ancestry[0] !== previous.head || ancestry[1] !== candidate.head) throw new Error("Resolution is not the exact expected two-parent merge.");
			const receipt = { previous, worker: candidate, tip };
			await this.inspectCombined(root, integration, base, [...stages, receipt], signal);
			return { outcome: "ready", value: receipt };
		} catch (error) { return unknown(`Stage resolution could not be proved: ${String(error)}`, integration); }
	}

	/** Reconcile an interrupted merge without retrying it or discarding conflict state. */
	async reconcileStage(root: string, integration: WorktreeInfo, base: WorkspaceIdentity, stages: readonly StageReceipt[], worker: WorktreeInfo, candidate: WorkspaceIdentity, signal: AbortSignal): Promise<GitOutcome<StageReceipt | "not_started">> {
		try {
			if (!sameIdentity(await current(root, worker, signal), candidate)) throw new Error("Worker candidate drifted before stage reconciliation.");
			await owned(root, integration, signal);
			const previous = await proveHistory(root, base, stages, `refs/heads/${integration.branch}`, signal);
			const head = await requireGit(["rev-parse", "HEAD"], integration.path, signal);
			const branch = await requireGit(["symbolic-ref", "HEAD"], integration.path, signal);
			if (branch !== previous.branch) throw new Error("Integration branch changed.");
			const mergeHead = await git(["rev-parse", "--verify", "MERGE_HEAD"], integration.path, signal);
			if (mergeHead.code !== 0 && mergeHead.code !== 128) throw new Error("Merge state could not be inspected.");
			if (head === previous.head && mergeHead.code === 0 && mergeHead.stdout.trim() === candidate.head) {
				return { outcome: "conflict", failure: "Exact merge remains pending Main resolution.", possibleResources: [integration.path, integration.branch] };
			}
			if (head === previous.head && mergeHead.code !== 0) {
				await this.inspectCombined(root, integration, base, stages, signal);
				return { outcome: "ready", value: "not_started" };
			}
			if (mergeHead.code !== 0) return await this.confirmStage(root, integration, base, stages, worker, candidate, signal);
			throw new Error("Merge state differs from the recorded stage intent.");
		} catch (error) { return unknown(`Interrupted stage outcome uncertain: ${String(error)}`, integration); }
	}

	async inspectWorker(root: string, worker: WorktreeInfo, candidate: WorkspaceIdentity, signal: AbortSignal): Promise<void> {
		if (!sameIdentity(await current(root, worker, signal), candidate)) throw new Error("Staged worker candidate changed after selection.");
	}

	/** Read-only reconciliation of a lost promotion response; never repeat the merge. */
	async reconcilePromotion(root: string, integration: WorktreeInfo, base: WorkspaceIdentity,
		stages: readonly StageReceipt[], signal: AbortSignal, correction?: { from: WorkspaceIdentity; to: WorkspaceIdentity }): Promise<GitOutcome<WorkspaceIdentity>> {
		try {
			const tip = correction ? (await this.inspectCorrection(root, integration, base, stages, correction.from, correction.to, signal), correction.to)
				: await this.inspectCombined(root, integration, base, stages, signal);
			const main = await inspect(root, signal);
			if (main.branch === base.branch && main.head === tip.head && sameIdentity(main, { ...tip, branch: base.branch })) {
				return { outcome: "ready", value: main };
			}
			return { outcome: "unknown", failure: sameIdentity(main, base)
				? "Promotion did not change Main; intent is retained and cannot be replayed."
				: "Main differs from both the expected base and the promoted tip; manual recovery required.",
				possibleResources: [integration.path, integration.branch] };
		} catch (error) { return unknown(`Promotion reconciliation uncertain: ${String(error)}`, integration); }
	}

	/** Checks/review must be persisted for this exact combined tip; never move Main via update-ref. */
	async promote(input: {
		root: string; integration: WorktreeInfo; base: WorkspaceIdentity; stages: readonly StageReceipt[];
		checks: CheckBatchEvidence; commands: readonly CheckCommand[];
		review?: ReviewEvidence; criterion?: string;
		correction?: { from: WorkspaceIdentity; to: WorkspaceIdentity };
	}, signal: AbortSignal): Promise<GitOutcome<WorkspaceIdentity>> {
		const { root, integration, base, stages } = input;
		if (!stages.length) return { outcome: "blocked", failure: "No worker stages to promote." };
		const tip = input.correction ? (await this.inspectCorrection(root, integration, base, stages, input.correction.from, input.correction.to, signal), input.correction.to)
			: await this.inspectCombined(root, integration, base, stages, signal);
		if (input.checks.phase !== "final" || !checkBatchPasses(input.checks, input.commands, tip)
			|| (input.criterion !== undefined && !reviewEvidencePasses(input.review, "final", input.criterion, base, tip))
			|| (input.criterion === undefined && input.review !== undefined)) {
			return { outcome: "blocked", failure: "Exact combined-tip final checks/review evidence is missing or failed." };
		}
		if (!sameIdentity(await inspect(root, signal), base)) return { outcome: "drift", failure: "Main drifted before promotion." };
		const hookDir = await mkdtemp(join(tmpdir(), "pi-subagent-promote-"));
		const args = ["-c", `core.hooksPath=${hookDir}`, "merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", tip.head];
		let merged: GitResult;
		try {
			await writeFile(join(hookDir, "reference-transaction"), refGuard(base.branch, base.head, tip.head));
			await chmod(join(hookDir, "reference-transaction"), 0o700);
			merged = await git(args, root, signal);
		} catch (error) {
			return { outcome: "unknown", failure: `Promotion outcome uncertain: ${String(error)}`, possibleResources: [integration.path, integration.branch] };
		} finally { await rm(hookDir, { recursive: true }); }
		if (merged.code !== 0) {
			if (merged.code === -1) return { outcome: "unknown", failure: failure(args, merged), possibleResources: [integration.path, integration.branch] };
			if (merged.stderr.includes("pi-subagent: promotion ref drift")) return { outcome: "drift", failure: "Main drifted at the guarded ref transaction." };
			try {
				if (sameIdentity(await inspect(root, signal), base)) return { outcome: "blocked", failure: failure(args, merged) };
			} catch { /* The exact post-failure state is unknown. */ }
			return { outcome: "unknown", failure: failure(args, merged), possibleResources: [integration.path, integration.branch] };
		}
		try {
			const main = await inspect(root, signal);
			if (main.branch === base.branch && main.head === tip.head && main.index === tip.index && main.tree === tip.tree) return { outcome: "ready", value: main };
		} catch { /* Retain all resources when verification fails. */ }
		return { outcome: "unknown", failure: "Promotion returned success but exact clean Main tip could not be proved.", possibleResources: [integration.path, integration.branch] };
	}

	/** Cleanup is deliberately separate per resource; callers persist each proven substep. */
	async cleanup(root: string, integration: WorktreeInfo, info: WorktreeInfo, base: WorkspaceIdentity, stages: readonly StageReceipt[], promoted: WorkspaceIdentity, kind: "worktree" | "branch", signal: AbortSignal, correction?: { from: WorkspaceIdentity; to: WorkspaceIdentity }): Promise<GitOutcome<"removed" | "absent">> {
		const possibleResources = [info.path, info.branch];
		try {
			await ownershipMetadata(root, info, signal);
			await ownershipMetadata(root, integration, signal);
			if (!stages.length || !sameIdentity(await inspect(root, signal), promoted)
				|| promoted.branch !== base.branch || promoted.head !== (correction?.to ?? stages.at(-1)!.tip).head) {
				return { outcome: "blocked", failure: "Cleanup requires the unchanged exact promoted Main tip." };
			}
			await proveHistory(root, base, stages, `refs/heads/${integration.branch}`, signal);
			if (correction) {
				if (!sameIdentity(correction.from, stages.at(-1)!.tip)
					|| (await parents(correction.to.head, root, signal)).join() !== correction.from.head) {
					return { outcome: "blocked", failure: "Correction provenance changed before cleanup." };
				}
				if (kind === "worktree" && info.path === integration.path) {
					await this.inspectCorrection(root, integration, base, stages, correction.from, correction.to, signal);
				}
			}
			const stageIndex = stages.findIndex((stage) => stage.worker.branch === `refs/heads/${info.branch}`);
			const expected = info.path === integration.path ? correction?.to ?? stages.at(-1)!.tip
				: stages[stageIndex]?.worker;
			const stagedBase = info.path === integration.path ? info.baseCommit === base.head
				: await ancestor(info.baseCommit, base.head, root, signal)
					|| stages.slice(0, stageIndex).some((stage) => stage.tip.head === info.baseCommit);
			if (!expected || !stagedBase || !await ancestor(info.baseCommit, expected.head, root, signal)) {
				return { outcome: "blocked", failure: "No proven staged base and candidate for this owned checkout." };
			}
			const registered = await requireGit(["worktree", "list", "--porcelain", "-z"], root, signal);
			const present = registered.split("\0").includes(`worktree ${info.path}`);
			const pathPresent = await exists(info.path);
			const ref = `refs/heads/${info.branch}`;
			const branch = await git(["rev-parse", "--verify", ref], root, signal);
			if (branch.code !== 0 && branch.code !== 128) throw new Error("Branch tip could not be inspected.");
			if (kind === "worktree") {
				if (!present && !pathPresent) return { outcome: "ready", value: "absent" };
				if (!present || !pathPresent || branch.stdout.trim() !== expected.head) return { outcome: "blocked", failure: "Worktree registration/path/branch do not match approved tip." };
				if (!sameIdentity(await current(root, info, signal), expected)) return { outcome: "blocked", failure: "Worktree differs from approved clean candidate." };
				const args = ["worktree", "remove", info.path];
				const removed = await git(args, root, signal);
				if (removed.code !== 0) return unknown(failure(args, removed), info);
				const after = await requireGit(["worktree", "list", "--porcelain", "-z"], root, signal);
				if (await exists(info.path) || after.split("\0").includes(`worktree ${info.path}`)) return unknown("Worktree remove returned success but checkout remains.", info);
				return { outcome: "ready", value: "removed" };
			}
			if (present || pathPresent) return { outcome: "blocked", failure: "Remove the exact worktree before branch deletion." };
			if (branch.code === 128) return { outcome: "ready", value: "absent" };
			if (branch.stdout.trim() !== expected.head) return { outcome: "blocked", failure: "Branch differs from approved tip." };
			const args = ["branch", "-d", "--", info.branch];
			const deleted = await git(args, root, signal);
			if (deleted.code !== 0) return unknown(failure(args, deleted), info);
			const after = await git(["show-ref", "--verify", "--quiet", ref], root, signal);
			if (after.code !== 1) return unknown("Branch delete returned success but ref absence could not be proved.", info);
			return { outcome: "ready", value: "removed" };
		} catch (error) { return { outcome: "unknown", failure: `Cleanup state uncertain: ${String(error)}`, possibleResources }; }
	}
}

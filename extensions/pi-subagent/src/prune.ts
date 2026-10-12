import { existsSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { createHerdrClient } from "@henryqw/pi-herdr";
import { runGit, type GitRunner } from "./git-process.ts";
import { runProcess } from "./process.ts";
import { inspectWorktreeDirty, OWNED_BRANCH_PATTERN, WORKTREES_DIRNAME } from "./worktree.ts";

const HERDR_TIMEOUT_MS = 30_000;
const IN_PROGRESS_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"];

/** One reviewed pi-subagent branch, with its registered checkout when one exists. */
export interface PruneItem {
	branch: string;
	tip: string;
	path?: string;
	prunable: boolean;
	/** Why the item is prunable, or every exact blocker. */
	reason: string;
	/** Ignored entries as Git collapses them; removing the checkout deletes them. */
	ignored: readonly string[];
}

export interface PruneOwnership {
	/** The request or state that may still own a resource name (`subagent-<hex>`), if any. */
	owner(name: string): string | undefined;
	/** The live productive lease that blocks pruning, if any. */
	lease?: string;
}

export interface PruneGuards {
	/** Ownership and lease evidence across the repository's existing checkouts. */
	ownership(checkouts: readonly string[]): Promise<PruneOwnership>;
	/** Every Herdr pane; rejects when Herdr cannot be inspected. */
	panes(): Promise<readonly { paneId: string; cwds: readonly string[] }[]>;
	/** The confirming session still owns the command; checked immediately before each removal step. */
	current?(): boolean;
}

export type PruneRemoval = { outcome: "removed" | "skipped" | "failed"; item: PruneItem; reason: string };

type Checkout = { path: string; branch?: string; locked: boolean; missing: boolean };
type Snapshot = {
	primary: string;
	checkouts: Checkout[];
	branches: Map<string, string>;
	targets: { label: string; head: string }[];
};

async function requireGit(run: GitRunner, args: string[], cwd: string): Promise<string> {
	const result = await run(args, cwd);
	if (result.code !== 0) throw new Error(`git ${args[0]} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
	return result.stdout.trimEnd();
}

const within = (directory: string, path: string) => path === directory || path.startsWith(`${directory}${sep}`);

/** Every pane in every Herdr workspace with its shell and foreground working directories. */
export async function listHerdrPanes(cwd: string): Promise<{ paneId: string; cwds: string[] }[]> {
	const response = await createHerdrClient(runProcess).json(["pane", "list"], { cwd, timeoutMs: HERDR_TIMEOUT_MS });
	const result = response.result as { type?: unknown; panes?: unknown } | undefined;
	if (result?.type !== "pane_list" || !Array.isArray(result.panes)) throw new Error("Herdr pane list response is malformed.");
	return result.panes.map((pane: Record<string, unknown>) => {
		const cwds = [pane.cwd, pane.foreground_cwd].filter((cwd): cwd is string => typeof cwd === "string");
		if (typeof pane.pane_id !== "string" || !cwds.length) throw new Error("Herdr listed a pane without an ID or working directory.");
		return { paneId: pane.pane_id, cwds };
	});
}

async function snapshot(root: string, mainCwd: string, run: GitRunner): Promise<Snapshot> {
	const checkouts: Checkout[] = [];
	let current: Checkout | undefined;
	for (const field of (await requireGit(run, ["worktree", "list", "--porcelain", "-z"], root)).split("\0")) {
		if (field.startsWith("worktree ")) checkouts.push(current = { path: field.slice("worktree ".length), locked: false, missing: false });
		else if (current && field.startsWith("branch refs/heads/")) current.branch = field.slice("branch refs/heads/".length);
		else if (current && (field === "locked" || field.startsWith("locked "))) current.locked = true;
		else if (current && (field === "prunable" || field.startsWith("prunable "))) current.missing = true;
	}
	if (!checkouts[0]) throw new Error("Primary Git worktree is unavailable.");
	const branches = new Map<string, string>();
	for (const line of (await requireGit(run, ["for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads/"], root)).split("\n")) {
		const [branch, tip] = line.split(" ");
		if (branch && tip && OWNED_BRANCH_PATTERN.test(branch)) branches.set(branch, tip);
	}
	const targets = [{ label: "Main HEAD", head: await requireGit(run, ["rev-parse", "--verify", "HEAD^{commit}"], mainCwd) }];
	const origin = await run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], root);
	if (origin.code === 0) {
		const ref = origin.stdout.trim();
		targets.push({ label: ref.replace(/^refs\/remotes\//, ""), head: await requireGit(run, ["rev-parse", "--verify", `${ref}^{commit}`], root) });
	}
	return { primary: checkouts[0].path, checkouts, branches, targets };
}

async function classify(snap: Snapshot, branch: string, mainCwd: string, ownership: PruneOwnership,
	panes: Awaited<ReturnType<PruneGuards["panes"]>> | string, run: GitRunner, root: string): Promise<PruneItem> {
	const tip = snap.branches.get(branch)!;
	const name = basename(branch);
	const ownedPath = join(snap.primary, WORKTREES_DIRNAME, name);
	// A detached or switched owned checkout no longer names the branch; find it by its owned path too.
	const checkout = snap.checkouts.find((item) => item.branch === branch) ?? snap.checkouts.find((item) => item.path === ownedPath);
	const blockers: string[] = [];
	if (checkout && checkout.branch !== branch) blockers.push(`owned checkout is ${checkout.branch ? `on branch ${checkout.branch}` : "detached"}; inspect it manually`);
	let ignored: string[] = [];
	const owner = ownership.owner(name);
	if (owner) blockers.push(owner);
	if (ownership.lease) blockers.push(ownership.lease);
	let merged: string | undefined;
	for (const target of snap.targets) {
		const result = await run(["merge-base", "--is-ancestor", tip, target.head], root);
		if (result.code === 0) { merged = target.label; break; }
		if (result.code !== 1) throw new Error(`git merge-base failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
	}
	if (!merged) blockers.push(`branch has commits not in ${snap.targets.map(({ label }) => label).join(" or ")}`);
	if (checkout) {
		const path = checkout.path;
		if (path !== ownedPath) blockers.push("checkout is not at its owned .worktrees path");
		if (checkout.locked) blockers.push("checkout is locked");
		if (checkout.missing || !existsSync(path)) blockers.push("checkout directory is missing; inspect it, then run git worktree prune");
		else {
			const real = realpathSync.native(path);
			if (within(real, realpathSync.native(mainCwd))) blockers.push("Main runs inside the checkout");
			const gitDir = await requireGit(run, ["rev-parse", "--absolute-git-dir"], path);
			const markers = IN_PROGRESS_MARKERS.filter((marker) => existsSync(join(gitDir, marker)));
			if (markers.length) blockers.push(`Git operation in progress (${markers.join(", ")})`);
			const dirty = await inspectWorktreeDirty(path, run, false);
			if (dirty.failure) blockers.push(`checkout could not be inspected: ${dirty.failure}`);
			else if (dirty.dirty) blockers.push("checkout has tracked or untracked changes");
			else if (dirty.initializedSubmodules) blockers.push("checkout has initialized submodules; Git cannot remove it without force, so remove it manually");
			if (typeof panes === "string") blockers.push(`Herdr unavailable (${panes}); cannot prove no pane uses the checkout`);
			else {
				const used = panes.filter((pane) => pane.cwds.some((cwd) => within(path, cwd) || within(real, cwd)));
				if (used.length) blockers.push(`Herdr pane ${used.map(({ paneId }) => paneId).join(", ")} works inside the checkout`);
			}
			ignored = (await requireGit(run, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"], path))
				.split("\0").filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3));
		}
	}
	return {
		branch, tip, ...(checkout ? { path: checkout.path } : {}), prunable: !blockers.length, ignored,
		reason: blockers.length ? blockers.join("; ") : `merged into ${merged}; ${checkout ? "clean checkout" : "no checkout"}`,
	};
}

const existing = (snap: Snapshot) => snap.checkouts.filter((item) => !item.missing && existsSync(item.path)).map(({ path }) => path);

async function evidence(root: string, mainCwd: string, guards: PruneGuards, run: GitRunner) {
	const snap = await snapshot(root, mainCwd, run);
	const ownership = await guards.ownership(existing(snap));
	let panes: Awaited<ReturnType<PruneGuards["panes"]>> | string;
	try { panes = await guards.panes(); } catch (error) { panes = (error instanceof Error ? error.message : String(error)).slice(0, 200); }
	return { snap, ownership, panes };
}

/** Read-only review of every pi-subagent worker or integration branch and its checkout. */
export async function inspectPruneCandidates(root: string, mainCwd: string, guards: PruneGuards, run: GitRunner = runGit): Promise<PruneItem[]> {
	const { snap, ownership, panes } = await evidence(root, mainCwd, guards, run);
	const items: PruneItem[] = [];
	for (const branch of [...snap.branches.keys()].sort()) items.push(await classify(snap, branch, mainCwd, ownership, panes, run, root));
	return items;
}

async function removeOne(root: string, mainCwd: string, reviewed: PruneItem, allowIgnored: boolean,
	guards: PruneGuards, run: GitRunner): Promise<PruneRemoval> {
	const skip = (reason: string): PruneRemoval => ({ outcome: "skipped", item: reviewed, reason });
	const fail = (reason: string): PruneRemoval => ({ outcome: "failed", item: reviewed, reason });
	const { snap, ownership, panes } = await evidence(root, mainCwd, guards, run);
	if (snap.branches.get(reviewed.branch) !== reviewed.tip) return skip("branch was deleted or moved since review");
	const fresh = await classify(snap, reviewed.branch, mainCwd, ownership, panes, run, root);
	if (!fresh.prunable) return skip(fresh.reason);
	if (fresh.path !== reviewed.path) return skip("checkout registration changed since review");
	if (fresh.ignored.some((entry) => !allowIgnored || !reviewed.ignored.includes(entry))) return skip("ignored content was not approved or changed since review");
	const stale = () => guards.current !== undefined && !guards.current();
	if (fresh.path) {
		if (stale()) return skip("session or branch changed before removal; reopen /subagent prune");
		// Git removes ignored content without --force; the checks above approved it.
		const removed = await run(["worktree", "remove", fresh.path], root);
		if (removed.code !== 0) return fail(`git worktree remove failed: ${removed.stderr.trim().slice(0, 200)}`);
		if (existsSync(fresh.path)) return fail("git worktree remove succeeded but the checkout remains");
	}
	if (stale()) return skip(`${fresh.path ? "checkout removed; " : ""}session or branch changed before branch deletion; branch kept`);
	const deleted = await run(["update-ref", "-d", `refs/heads/${reviewed.branch}`, reviewed.tip], root);
	if (deleted.code !== 0) return fail(`${fresh.path ? "checkout removed; " : ""}branch kept: ${deleted.stderr.trim().slice(0, 200)}`);
	return { outcome: "removed", item: reviewed, reason: fresh.reason };
}

/**
 * Re-verify each reviewed prunable item immediately before removing its checkout, then delete its
 * branch only at the reviewed tip. Ignored entries are deleted only when `allowIgnored` and all of
 * them were in the review. Returns the repository checkouts that still exist.
 */
export async function removePruneCandidates(root: string, mainCwd: string, reviewed: readonly PruneItem[], allowIgnored: boolean,
	guards: PruneGuards, run: GitRunner = runGit): Promise<{ removals: PruneRemoval[]; checkouts: string[] }> {
	const removals: PruneRemoval[] = [];
	for (const item of reviewed) {
		try { removals.push(await removeOne(root, mainCwd, item, allowIgnored, guards, run)); }
		catch (error) { removals.push({ outcome: "failed", item, reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) }); }
	}
	return { removals, checkouts: existing(await snapshot(root, mainCwd, run)) };
}

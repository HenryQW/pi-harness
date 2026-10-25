import { existsSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { createHerdrClient } from "@henryqw/pi-herdr";
import { runGit, type GitRunner } from "./git-process.ts";
import { runProcess } from "./process.ts";
import { inspectWorktreeDirty, OWNED_BRANCH_PATTERN, WORKTREES_DIRNAME } from "./worktree.ts";

const HERDR_TIMEOUT_MS = 30_000;
const INSPECTION_CONCURRENCY = 4;
export type PruneProgress = (completed: number, total: number) => void;
const IN_PROGRESS_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"];

/** Blockers that a separately confirmed force removal of an unowned item may override; every other kind is hard. */
export const FORCEABLE_PRUNE_BLOCKERS = ["unmerged", "changes", "operation", "submodules"] as const;
export type PruneBlockerKind = typeof FORCEABLE_PRUNE_BLOCKERS[number] | "owner" | "lease" | "hard";
export interface PruneBlocker { kind: PruneBlockerKind; text: string }
const forceable = (kind: PruneBlockerKind) => (FORCEABLE_PRUNE_BLOCKERS as readonly string[]).includes(kind);

/** Saved identity of a readable request that owns a resource name. */
export interface PruneRequest { id: string; name: string; status: string; directory: string; root: string; orphaned: boolean }

/** One reviewed pi-subagent branch, with its registered checkout when one exists. */
export interface PruneItem {
	branch: string;
	tip: string;
	path?: string;
	prunable: boolean;
	/** Why the item is prunable, or every exact blocker. */
	reason: string;
	blockers: readonly PruneBlocker[];
	/** The only, readable request that owns the item. */
	owner?: PruneRequest;
	/** How a blocked item can still go after separate confirmation: discard of its whole owning request, or
	 * force removal when every blocker is forceable. Absent for prunable and hard-blocked items. */
	override?: "discard" | "force";
	/** Ignored entries as Git collapses them; removing the checkout deletes them. */
	ignored: readonly string[];
}

export interface PruneOwnership {
	/** Every request or state that may still own an exact resource name; unreadable state has no request. */
	owners(name: string): readonly { label: string; request?: PruneRequest }[];
	/** The live productive lease that blocks pruning, if any. */
	lease?: string;
}

export interface PruneGuards {
	/** Ownership and lease evidence across the repository's existing checkouts, primary first. */
	ownership(checkouts: readonly string[]): Promise<PruneOwnership>;
	/** Every Herdr pane; rejects when Herdr cannot be inspected. */
	panes(): Promise<readonly { paneId: string; cwds: readonly string[] }[]>;
	/** The command is not cancelled and its session is current; checked before each candidate and removal step. */
	current?(): boolean;
	progress?: PruneProgress;
}

export type PruneRemoval = { outcome: "removed" | "skipped" | "failed"; item: PruneItem; reason: string };

type Checkout = { path: string; branch?: string; locked: boolean; missing: boolean };
type Snapshot = {
	primary: string;
	checkouts: Checkout[];
	branches: Map<string, string>;
	targets: { label: string; head: string }[];
};

export async function requireGit(run: GitRunner, args: string[], cwd: string): Promise<string> {
	const result = await run(args, cwd);
	if (result.code !== 0) throw new Error(`git ${args[0]} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
	return result.stdout.trimEnd();
}

export const within = (directory: string, path: string) => path === directory || path.startsWith(`${directory}${sep}`);

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

function candidateCheckout(snap: Snapshot, branch: string): Checkout | undefined {
	const ownedPath = join(snap.primary, WORKTREES_DIRNAME, basename(branch));
	// A detached or switched owned checkout no longer names the branch; find it by its owned path too.
	return snap.checkouts.find((item) => item.branch === branch) ?? snap.checkouts.find((item) => item.path === ownedPath);
}

async function classify(snap: Snapshot, branch: string, mainCwd: string, ownership: PruneOwnership,
	panes: Awaited<ReturnType<PruneGuards["panes"]>> | string, run: GitRunner, root: string): Promise<PruneItem> {
	const tip = snap.branches.get(branch)!;
	const name = basename(branch);
	const ownedPath = join(snap.primary, WORKTREES_DIRNAME, name);
	const checkout = candidateCheckout(snap, branch);
	const blockers: PruneBlocker[] = [];
	const block = (kind: PruneBlockerKind, text: string) => blockers.push({ kind, text });
	if (checkout && checkout.branch !== branch) block("hard", `owned checkout is ${checkout.branch ? `on branch ${checkout.branch}` : "detached"}; inspect it manually`);
	let ignored: string[] = [];
	const owners = ownership.owners(name);
	for (const { label } of owners) block("owner", label);
	if (ownership.lease) block("lease", ownership.lease);
	let merged: string | undefined;
	for (const target of snap.targets) {
		const result = await run(["merge-base", "--is-ancestor", tip, target.head], root);
		if (result.code === 0) { merged = target.label; break; }
		if (result.code !== 1) throw new Error(`git merge-base failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
	}
	if (!merged) block("unmerged", `branch has commits not in ${snap.targets.map(({ label }) => label).join(" or ")}`);
	if (checkout) {
		const path = checkout.path;
		if (path !== ownedPath) block("hard", "checkout is not at its owned .worktrees path");
		if (checkout.locked) block("hard", "checkout is locked");
		if (checkout.missing || !existsSync(path)) block("hard", "checkout directory is missing; inspect it, then run git worktree prune");
		else {
			const real = realpathSync.native(path);
			if (within(real, realpathSync.native(mainCwd))) block("hard", "Main runs inside the checkout");
			const gitDir = await requireGit(run, ["rev-parse", "--absolute-git-dir"], path);
			const markers = IN_PROGRESS_MARKERS.filter((marker) => existsSync(join(gitDir, marker)));
			if (markers.length) block("operation", `Git operation in progress (${markers.join(", ")})`);
			const dirty = await inspectWorktreeDirty(path, run, false);
			if (dirty.failure) block("hard", `checkout could not be inspected: ${dirty.failure}`);
			else if (dirty.dirty) block("changes", "checkout has tracked or untracked changes");
			else if (dirty.initializedSubmodules) block("submodules", "checkout has initialized submodules; Git cannot remove it without force");
			if (typeof panes === "string") block("hard", `Herdr unavailable (${panes}); cannot prove no pane uses the checkout`);
			else {
				const used = panes.filter((pane) => pane.cwds.some((cwd) => within(path, cwd) || within(real, cwd)));
				if (used.length) block("hard", `Herdr pane ${used.map(({ paneId }) => paneId).join(", ")} works inside the checkout`);
			}
			ignored = (await requireGit(run, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"], path))
				.split("\0").filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3));
		}
	}
	// The owning request's discard review owns its other blockers; a lease or any second owner keeps the item.
	const owner = owners.length === 1 ? owners[0]!.request : undefined;
	const override = !blockers.length ? undefined : owner && !blockers.some(({ kind }) => kind === "lease") ? "discard" as const
		: blockers.every(({ kind }) => forceable(kind)) ? "force" as const : undefined;
	return {
		branch, tip, ...(checkout ? { path: checkout.path } : {}), prunable: !blockers.length, ignored, blockers,
		...(owner ? { owner } : {}), ...(override ? { override } : {}),
		reason: blockers.length ? blockers.map(({ text }) => text).join("; ") : `merged into ${merged}; ${checkout ? "clean checkout" : "no checkout"}`,
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
	const branches = [...snap.branches.keys()].sort();
	const groups = new Map<string, number[]>();
	for (const [index, branch] of branches.entries()) {
		const checkout = candidateCheckout(snap, branch);
		// Git inspection refreshes the index. Aliases and owned-path fallbacks must share one worker.
		const key = checkout && !checkout.missing && existsSync(checkout.path) ? realpathSync.native(checkout.path) : branch;
		const group = groups.get(key) ?? [];
		group.push(index);
		groups.set(key, group);
	}
	const pending = [...groups.values()];
	const items: PruneItem[] = new Array(branches.length);
	let next = 0, completed = 0, failed = false;
	guards.progress?.(0, branches.length);
	const workers = await Promise.allSettled(Array.from({ length: Math.min(INSPECTION_CONCURRENCY, pending.length) }, async () => {
		try {
			while (next < pending.length && !failed) {
				for (const index of pending[next++]!) {
					if (failed) return;
					if (guards.current && !guards.current()) throw new Error("Prune scan cancelled or session changed.");
					items[index] = await classify(snap, branches[index]!, mainCwd, ownership, panes, run, root);
					guards.progress?.(++completed, branches.length);
				}
			}
		} catch (error) { failed = true; throw error; }
	}));
	// Do not release this scan while another worker can still inspect an index.
	for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
	return items;
}

async function removeOne(root: string, mainCwd: string, reviewed: PruneItem, allowIgnored: boolean, force: boolean,
	guards: PruneGuards, run: GitRunner): Promise<PruneRemoval> {
	const skip = (reason: string): PruneRemoval => ({ outcome: "skipped", item: reviewed, reason });
	const fail = (reason: string): PruneRemoval => ({ outcome: "failed", item: reviewed, reason });
	const { snap, ownership, panes } = await evidence(root, mainCwd, guards, run);
	if (snap.branches.get(reviewed.branch) !== reviewed.tip) return skip("branch was deleted or moved since review");
	const fresh = await classify(snap, reviewed.branch, mainCwd, ownership, panes, run, root);
	// Force applies only to an item reviewed as forceable, and only while no blocker of a new or hard kind appears.
	const forced = force && reviewed.override === "force";
	if (forced ? !fresh.blockers.every(({ kind }) => forceable(kind) && reviewed.blockers.some((item) => item.kind === kind))
		: !fresh.prunable) return skip(fresh.reason);
	if (fresh.path !== reviewed.path) return skip("checkout registration changed since review");
	if (fresh.ignored.some((entry) => !allowIgnored || !reviewed.ignored.includes(entry))) return skip("ignored content was not approved or changed since review");
	const stale = () => guards.current !== undefined && !guards.current();
	if (fresh.path) {
		if (stale()) return skip("prune cancelled or session or branch changed before removal; reopen /subagent prune");
		// Git removes ignored content without --force; the checks above approved it. Force also deletes reviewed changes.
		const removed = await run(["worktree", "remove", ...(forced ? ["--force"] : []), fresh.path], root);
		if (removed.code !== 0) return fail(`git worktree remove failed: ${removed.stderr.trim().slice(0, 200)}`);
		if (existsSync(fresh.path)) return fail("git worktree remove succeeded but the checkout remains");
	}
	if (stale()) return skip(`${fresh.path ? "checkout removed; " : ""}prune cancelled or session or branch changed before branch deletion; branch kept`);
	try {
		const deleted = await run(["update-ref", "-d", `refs/heads/${reviewed.branch}`, reviewed.tip], root);
		if (deleted.code !== 0) return fail(`${fresh.path ? "checkout removed; " : ""}branch kept: ${deleted.stderr.trim().slice(0, 200)}`);
		return { outcome: "removed", item: reviewed, reason: fresh.reason };
	} catch (error) { return fail(`${fresh.path ? "checkout removed; " : ""}branch deletion not verified: ${String(error).slice(0, 200)}`); }
}

/**
 * Re-verify each reviewed prunable item immediately before removing its checkout, then delete its
 * branch only at the reviewed tip. Ignored entries are deleted only when `allowIgnored` and all of
 * them were in the review. With `force`, a reviewed forceable item is removed with `--force` while
 * every fresh blocker is forceable and of a reviewed kind. Cancellation keeps completed outcomes.
 */
export async function removePruneCandidates(root: string, mainCwd: string, reviewed: readonly PruneItem[], allowIgnored: boolean,
	force: boolean, guards: PruneGuards, run: GitRunner = runGit): Promise<{ removals: PruneRemoval[] }> {
	const removals: PruneRemoval[] = [];
	guards.progress?.(0, reviewed.length);
	for (const item of reviewed) {
		if (guards.current && !guards.current()) removals.push({ outcome: "skipped", item, reason: "prune cancelled or session changed before removal; reopen /subagent prune" });
		else try { removals.push(await removeOne(root, mainCwd, item, allowIgnored, force, guards, run)); }
		catch (error) { removals.push({ outcome: "failed", item, reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) }); }
		guards.progress?.(removals.length, reviewed.length);
	}
	return { removals };
}

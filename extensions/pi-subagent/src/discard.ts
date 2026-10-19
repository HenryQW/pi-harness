import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { runGit, type GitRunner } from "./git-process.ts";
import type { ChangesetTaskAttempt, ChangesetTaskState, CleanupStep, IntegrationGeneration, RunState, TextTaskAttempt } from "./schema.ts";
import type { RunStateHandle } from "./store.ts";
import { inspectIndexFlags, OWNED_BRANCH_PATTERN, WORKTREES_DIRNAME, type WorktreeInfo } from "./worktree.ts";
import type { PruneGuards } from "./prune.ts";

export interface DiscardItem {
	key: string;
	identity: string;
	path?: string;
	branch?: string;
	tip?: string;
	checkout: boolean;
	commits?: number;
	dirty?: boolean;
	ignored: string[];
	hosts: string[];
	blockers: string[];
}
export interface DiscardPlan {
	root: string;
	directory: string;
	requestId: string;
	items: DiscardItem[];
}
export interface DiscardGuards {
	panes: PruneGuards["panes"];
	blocked(): Promise<string | undefined>;
	current(): boolean;
}
export interface DiscardResource {
	key: string;
	worktree?: Omit<WorktreeInfo, "baseCommit"> & { baseCommit?: string };
	textAttempt?: TextTaskAttempt;
	task?: ChangesetTaskState;
	attempt?: ChangesetTaskAttempt;
	generation?: IntegrationGeneration;
}
export type DiscardRemoval = { key: string; outcome: "removed" | "skipped" | "failed"; reason: string };

export function discardResources(state: RunState): DiscardResource[] {
	return [
		...state.tasks.flatMap<DiscardResource>((task) => task.kind === "changeset" ? task.attempts.map((attempt, index) => ({
			key: `task/${task.taskId}/${index + 1}`, task, attempt,
			worktree: attempt.allocations.filter((item) => item.kind === "worktree").at(-1)?.worktree,
		})) : task.attempts.flatMap((attempt) => attempt.cleanup ? [{
			key: `task/${task.taskId}/${attempt.number}`, textAttempt: attempt,
			worktree: { path: attempt.cleanup.path, cwd: attempt.cleanup.path, branch: attempt.cleanup.branch,
				repoRoot: dirname(dirname(attempt.cleanup.path)) },
		}] : [])),
		...state.integration.generations.map((generation) => ({ key: `integration/${generation.number}`, generation, worktree: generation.worktree })),
	];
}

async function git(args: string[], root: string, run: GitRunner): Promise<string> {
	const result = await run(args, root);
	if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 300)}`);
	return result.stdout.trimEnd();
}

export async function primaryCheckout(root: string, run: GitRunner = runGit): Promise<string> {
	const first = (await git(["worktree", "list", "--porcelain", "-z"], root, run)).split("\0")[0];
	if (!first?.startsWith("worktree ")) throw new Error("Primary Git checkout is unavailable.");
	return realpathSync.native(first.slice(9));
}

const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
const identity = (resource: DiscardResource) => JSON.stringify([resource.worktree, resource.attempt?.allocations]);

/** Read-only evidence. A resource is one worker attempt or integration generation, including its host resources. */
export async function inspectDiscardResource(primary: string, mainCwd: string, resource: DiscardResource,
	guards: DiscardGuards, run: GitRunner = runGit): Promise<DiscardItem> {
	const { worktree, attempt } = resource;
	const allocations = attempt?.allocations ?? [];
	const item: DiscardItem = {
		key: resource.key, identity: identity(resource), checkout: false, ignored: [], blockers: [],
		hosts: allocations.filter((allocation) => allocation.kind !== "worktree").map((allocation) => JSON.stringify(allocation)),
	};
	const blocked = await guards.blocked();
	if (blocked) item.blockers.push(blocked);
	if (allocations.some((allocation) => allocation.status === "allocating" || allocation.status === "unknown")) {
		item.blockers.push("Allocation ownership is uncertain; inspect the recorded resources.");
	}
	if (!worktree) return item;
	item.path = worktree.path;
	item.branch = worktree.branch;
	if (!OWNED_BRANCH_PATTERN.test(worktree.branch) || worktree.repoRoot !== primary
		|| worktree.path !== join(primary, WORKTREES_DIRNAME, basename(worktree.branch))) {
		item.blockers.push("Checkout or branch is not at this repository's owned path.");
		return item;
	}
	const ref = `refs/heads/${worktree.branch}`;
	const branches = (await git(["for-each-ref", "--format=%(refname) %(objectname) %(symref)", ref], primary, run)).split("\n");
	const branch = branches.find((line) => line.startsWith(`${ref} `))?.split(" ");
	item.tip = branch?.[1];
	if (branch?.[2]) item.blockers.push("Owned branch is a symbolic reference; inspect it manually.");
	if (item.tip && worktree.baseCommit) item.commits = Number(await git(["rev-list", "--count", `${worktree.baseCommit}..${item.tip}`], primary, run));
	const records = (await git(["worktree", "list", "--porcelain", "-z"], primary, run)).split("\0\0");
	const registered = records.filter((record) => record.split("\0").includes(`branch refs/heads/${worktree.branch}`));
	const owned = records.find((record) => record.startsWith(`worktree ${worktree.path}\0`));
	if (registered.some((record) => !record.startsWith(`worktree ${worktree.path}\0`))) item.blockers.push("Branch is checked out at another path.");
	item.checkout = existsSync(worktree.path);
	const cleanup = attempt?.cleanup ?? resource.generation?.cleanup;
	if (item.checkout && (resource.textAttempt?.cleanup?.outcome === "pruned" || cleanup?.some((step) => step.kind === "worktree" && step.status === "completed"))
		|| item.tip && (resource.textAttempt?.cleanup?.outcome === "pruned" || cleanup?.some((step) => step.kind === "branch" && step.status === "completed"))) {
		item.blockers.push("A resource exists after completed cleanup; new ownership is unproved.");
	}
	if (allocations.filter((allocation) => allocation.kind === "worktree").at(-1)?.status === "absent"
		&& (item.checkout || item.tip)) item.blockers.push("Allocation was recorded absent; ownership of the existing resource is unproved.");
	if (owned && !item.checkout) item.blockers.push("Checkout registration remains but its directory is missing; inspect it manually.");
	if (!item.checkout) return item;
	if (!owned || !owned.split("\0").includes(`branch refs/heads/${worktree.branch}`)) item.blockers.push("Checkout registration changed or checkout is detached.");
	if (owned?.split("\0").some((field) => field === "locked" || field.startsWith("locked "))) item.blockers.push("Checkout is locked.");
	const real = realpathSync.native(worktree.path);
	if (real !== worktree.path) item.blockers.push("Owned checkout path is redirected.");
	if (within(real, realpathSync.native(mainCwd))) item.blockers.push("Main runs inside the checkout.");
	const status = (await git(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal", "--ignore-submodules=none"], worktree.path, run)).split("\0").filter(Boolean);
	item.ignored = status.filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3));
	item.dirty = status.some((entry) => !entry.startsWith("!! "));
	if (!item.dirty) {
		const flags = await inspectIndexFlags(worktree.path, run);
		if (flags.failure || flags.hidden) {
			delete item.dirty;
			item.blockers.push(flags.failure ?? "Index flags hide tracked files; dirty state cannot be proved.");
		}
	}
	const submodules = await git(["submodule", "status", "--recursive"], worktree.path, run);
	if (submodules.split("\n").some((line) => line && !line.startsWith("-"))) {
		item.blockers.push("Initialized submodules require separate inspection of their commits and ignored files.");
	}
	try {
		const ownPanes = allocations.flatMap((allocation) => allocation.status !== "owned" ? []
			: allocation.kind === "workspace" ? [allocation.rootPaneId]
			: allocation.kind === "worker_tab" || allocation.kind === "agent" ? [allocation.paneId] : []);
		const foreign = (await guards.panes()).filter((pane) => !ownPanes.includes(pane.paneId)
			&& pane.cwds.some((cwd) => within(real, cwd) || within(worktree.path, cwd)));
		if (foreign.length) item.blockers.push(`Other Herdr panes use this checkout: ${foreign.map((pane) => pane.paneId).join(", ")}`);
	} catch (error) { item.blockers.push(`Herdr cannot be inspected: ${error instanceof Error ? error.message : String(error)}`); }
	return item;
}

export async function inspectDiscard(primary: string, mainCwd: string, state: RunState, guards: DiscardGuards): Promise<DiscardItem[]> {
	const items: DiscardItem[] = [];
	for (const resource of discardResources(state)) {
		try {
			const item = await inspectDiscardResource(primary, mainCwd, resource, guards);
			const complete = resource.textAttempt?.cleanup?.outcome === "pruned"
				|| (resource.attempt?.cleanup ?? resource.generation?.cleanup)?.every((step) => step.status === "completed");
			if (!complete || item.checkout || item.tip || item.blockers.length) items.push(item);
		}
		catch (error) { items.push({ key: resource.key, identity: identity(resource), path: resource.worktree?.path,
			branch: resource.worktree?.branch, checkout: false, ignored: [], hosts: [], blockers: [`Inspection failed: ${String(error)}`] }); }
	}
	return items;
}

/** Called only after the command's confirmation. Never exposed as an agent tool. */
export async function removeDiscardResources(handle: RunStateHandle, primary: string, mainCwd: string,
	reviewed: readonly DiscardItem[], guards: DiscardGuards,
	close: (resource: DiscardResource, check: () => Promise<void>) => Promise<void>, run: GitRunner = runGit): Promise<DiscardRemoval[]> {
	const results: DiscardRemoval[] = [];
	const removals: Array<() => Promise<void>> = [];
	for (const item of reviewed) {
		const resource = discardResources(handle.state).find((resource) => resource.key === item.key);
		if (!resource || identity(resource) !== item.identity || item.blockers.length) {
			results.push({ key: item.key, outcome: "skipped", reason: "Ownership changed or the reviewed item is blocked." }); continue;
		}
		let checkoutRemoved = false;
		const verify = async () => {
			if (!guards.current()) throw new Error("Session changed; reopen /subagent.");
			const fresh = await inspectDiscardResource(primary, mainCwd, resource, guards, run);
			if (fresh.blockers.length) throw new Error(fresh.blockers.join("; "));
			if (fresh.tip !== item.tip) throw new Error("Branch was deleted or moved since review; branch kept.");
			if (fresh.checkout !== (checkoutRemoved ? false : item.checkout)) throw new Error("Checkout changed since review.");
			if (fresh.ignored.some((entry) => !item.ignored.includes(entry))) throw new Error("Ignored entries changed since review.");
			const blocked = await guards.blocked();
			if (blocked) throw new Error(blocked);
			if (!guards.current()) throw new Error("Session changed; reopen /subagent.");
		};
		try { await verify(); }
		catch (error) { results.push({ key: item.key, outcome: "skipped", reason: String(error) }); continue; }
		const failed = async (error: unknown) => {
			const pending = (resource.attempt?.cleanup ?? resource.generation?.cleanup)?.find((step) => step.status === "running");
			if (pending) { pending.failure = `User-confirmed discard failed: ${String(error)}`.slice(0, 500); await handle.save(); }
			results.push({ key: item.key, outcome: "failed", reason: `${checkoutRemoved ? "Checkout removed; " : ""}${String(error)}` });
		};
		try { await close(resource, verify); }
		catch (error) { await failed(error); continue; }
		// Close all reviewed workers and host resources before any Git checkout is removed.
		removals.push(async () => { try {
			const pending: CleanupStep[] = [{ kind: "worktree", status: "pending" }, { kind: "branch", status: "pending" }];
			const steps = resource.attempt?.cleanup ?? (resource.generation ? resource.generation.cleanup ??= pending : pending);
			for (const kind of ["worktree", "branch"] as const) {
				const step = steps.find((step) => step.kind === kind)!;
				await verify();
				if (step.status === "completed") continue;
				step.status = "running";
				delete step.failure;
				await handle.save();
				await verify();
				if (kind === "worktree" && item.checkout) {
					await git(["worktree", "remove", "--force", item.path!], primary, run);
					checkoutRemoved = true;
				} else if (kind === "branch" && item.tip) {
					await git(["update-ref", "--no-deref", "-d", `refs/heads/${item.branch}`, item.tip], primary, run);
				}
				step.status = "completed";
				if (resource.textAttempt) resource.textAttempt.cleanup = kind === "branch"
					? { outcome: "pruned", path: item.path!, branch: item.branch! }
					: { outcome: "recovery", path: item.path!, branch: item.branch!, note: "User confirmed discard: checkout removed; branch cleanup pending." };
				await handle.save();
			}
			results.push({ key: item.key, outcome: "removed", reason: "Reviewed resources removed; cleanup saved." });
		} catch (error) { await failed(error); } });
	}
	for (const remove of removals) await remove();
	return results;
}

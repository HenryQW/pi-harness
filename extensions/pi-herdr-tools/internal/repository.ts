import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrClient } from "@henryqw/pi-herdr";
import type { HerdrWorkspace } from "./worktree.ts";

type Git = Pick<ExtensionAPI, "exec">;
export type Repository = { checkout: string; repoRoot: string; repoKey: string; checkouts: string[] };
export type WorktreeSource = Repository & { base: string; branch?: string };

export async function gitOutput(pi: Git, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0 || result.killed) throw new Error(`Git check failed in ${cwd}: ${result.stderr.trim() || args.join(" ")}`);
	return result.stdout.replace(/\r?\n$/, "");
}

export function absolutePath(value: unknown, label: string): string {
	if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} is not an absolute path.`);
	return resolve(value);
}

/** Git resolves only the selected directory; it never searches sibling repositories. */
export async function inspectRepository(pi: Git, cwd: string): Promise<Repository> {
	const checkout = absolutePath(await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"]), "Git checkout");
	const repoKey = absolutePath(await gitOutput(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "Git common directory");
	const fields = (await gitOutput(pi, cwd, ["worktree", "list", "--porcelain", "-z"])).split("\0");
	const first = fields[0];
	if (!first?.startsWith("worktree ") || !fields.includes(`worktree ${checkout}`)) throw new Error("Git checkout registration could not be verified.");
	return { checkout, repoKey, repoRoot: absolutePath(first.slice(9), "Git primary repository"),
		checkouts: fields.filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9)) };
}

export async function selectWorktreeSource(
	pi: Git, herdr: HerdrClient<{ cwd: string }>, cwd: string, workspace: HerdrWorkspace,
	project: string | undefined, kind: "clone" | "handoff", branch?: string,
): Promise<WorktreeSource> {
	if (project !== undefined && !project.trim()) throw new Error("Project path must not be empty.");
	const selected = resolve(cwd, project ?? ".");
	let repository: Repository;
	try { repository = await inspectRepository(pi, selected); }
	catch (error) { throw new Error(`Select a Git project with an explicit project path relative to ${cwd}; nothing was created. ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
	if (project === undefined) {
		if (!workspace.checkout || (await inspectRepository(pi, workspace.checkout)).repoKey !== repository.repoKey) {
			throw new Error("Current directory and Herdr workspace are different Git repositories; supply an explicit project path. Nothing was created.");
		}
	}
	const primary = await inspectRepository(pi, repository.repoRoot);
	if (primary.checkout !== repository.repoRoot || primary.repoKey !== repository.repoKey) throw new Error("Git primary repository identity did not match; nothing was created.");
	// Native cwd targeting must resolve the primary, not an ambient folder workspace.
	const listing = await herdr.json(["worktree", "list", "--cwd", repository.repoRoot], { cwd });
	const result = listing.result as { type?: unknown; source?: { repo_key?: unknown; repo_root?: unknown; source_checkout_path?: unknown }; worktrees?: Array<{ path?: unknown; is_linked_worktree?: unknown; is_bare?: unknown }> } | undefined;
	if (result?.type !== "worktree_list" || result.source?.repo_key !== repository.repoKey ||
		result.source?.repo_root !== repository.repoRoot || result.source?.source_checkout_path !== repository.repoRoot ||
		!result.worktrees?.some((item) => item.path === repository.repoRoot && item.is_linked_worktree === false && item.is_bare === false)) {
		throw new Error("Herdr cwd targeting did not verify the selected primary repository; nothing was created.");
	}
	let base: string;
	try { base = await gitOutput(pi, selected, ["rev-parse", "--verify", kind === "clone" ? "HEAD^{commit}" : "refs/heads/main^{commit}"]); }
	catch (error) { throw new Error(kind === "handoff" ? `herdr_handoff requires a local main branch in ${selected}; nothing was created.` : "Selected checkout has no HEAD commit; nothing was created.", { cause: error }); }
	if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error("Git base commit could not be verified; nothing was created.");
	if (branch !== undefined) {
		if (await gitOutput(pi, selected, ["check-ref-format", "--branch", branch]) !== branch) throw new Error("Use a literal new branch name; nothing was created.");
		const existing = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: selected });
		if (existing.code !== 1 || existing.killed) throw new Error(`herdr_handoff: branch ${branch} already exists or could not be checked; choose a new branch. Nothing was created.`);
	}
	return { ...repository, base, branch };
}

export async function verifyCheckout(pi: Git, checkout: string, source: WorktreeSource): Promise<void> {
	const actual = await inspectRepository(pi, checkout);
	if (actual.checkout !== checkout || actual.repoRoot !== source.repoRoot || actual.repoKey !== source.repoKey || source.checkouts.includes(checkout) ||
		await gitOutput(pi, checkout, ["rev-parse", "--verify", "HEAD^{commit}"]) !== source.base) {
		throw new Error("Created checkout does not match the selected repository and base.");
	}
	if (source.branch && await gitOutput(pi, checkout, ["symbolic-ref", "HEAD"]) !== `refs/heads/${source.branch}`) throw new Error("Created checkout branch did not match.");
}

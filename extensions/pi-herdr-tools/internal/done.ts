import { tmpdir } from "node:os";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, withWorktreeLock } from "@henryqw/pi-herdr";
import { verifyPaneTarget, requiredString } from "./worktree.ts";
import { absolutePath } from "./repository.ts";
import { CommandRemovalBlocked } from "./command-state.ts";
import { runLockedGit } from "./locked-git.ts";

type SnapshotPane = { tab_id?: unknown; cwd?: unknown };
type TabEntry = { tab_id?: unknown; workspace_id?: unknown; label?: unknown };

export default function herdrDoneExtension(pi: ExtensionAPI,
	guardRemoval: <T>(checkout: string, operation: (descriptor: number) => Promise<T>) => Promise<T>,
	recoverRemoval?: (checkout: string, ctx: ExtensionContext, check: () => void) => Promise<boolean>,
	mutateGit = runLockedGit,
): void {
	let lifecycle = 0;
	const advance = () => { lifecycle++; };
	pi.on("session_start", advance);
	pi.on("session_tree", advance);
	pi.on("session_before_switch", advance);
	pi.on("session_shutdown", advance);
	const herdr = createHerdrClient<{ cwd: string }>(pi.exec.bind(pi));

	const execOrThrow = async (command: string, args: string[], cwd: string): Promise<string> => {
		const result: ExecResult = await pi.exec(command, args, { cwd });
		if (result.code !== 0 || result.killed) {
			throw new Error(`${command} ${args[0]} failed: ${result.stderr.trim() || "killed"}`);
		}
		return result.stdout;
	};

	pi.registerCommand("done", {
		description: "Remove the current Herdr worktree and close its workspace tabs",
		handler: async (args, ctx) => {
			const option = args.trim();
			const force = option === "--force" || option === "-f";
			if (option && !force) throw new Error("Usage: /done [--force|-f]");
			if (process.env.HERDR_ENV !== "1") {
				throw new Error("/done requires the current Pi session inside Herdr (HERDR_ENV=1).");
			}
			const tabId = process.env.HERDR_TAB_ID?.trim();
			if (!tabId) throw new Error("HERDR_TAB_ID is missing.");
			const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
			if (!workspaceId) throw new Error("HERDR_WORKSPACE_ID is missing.");
			const paneId = requiredString(process.env.HERDR_PANE_ID, "HERDR_PANE_ID");

			const generation = lifecycle, sessionId = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId(), cwd = ctx.cwd;
			const check = () => {
				if (generation !== lifecycle || sessionId !== ctx.sessionManager.getSessionId() || leaf !== ctx.sessionManager.getLeafId() || cwd !== ctx.cwd ||
					process.env.HERDR_ENV !== "1" || process.env.HERDR_TAB_ID?.trim() !== tabId || process.env.HERDR_WORKSPACE_ID?.trim() !== workspaceId || process.env.HERDR_PANE_ID?.trim() !== paneId) {
					throw new Error("Session, branch, pane, or completion lifecycle changed; reopen /done.");
				}
			};
			if (!force) {
				if (!ctx.hasUI) throw new Error("/done requires a user interface for confirmation.");
				const confirmed = await ctx.ui.confirm("Done", "Close its Herdr tabs and remove the current worktree?");
				check();
				if (!confirmed) return;
			}

			let target: string | undefined, identity: string | undefined, removalStarted = false;
			const remove = async () => {
				await ctx.waitForIdle();
				check();
				const checkout = absolutePath((await execOrThrow("git", ["rev-parse", "--show-toplevel"], ctx.cwd)).replace(/\r?\n$/, ""), "Git checkout");
				// First record of the NUL-delimited list is always the main worktree;
				// -z keeps paths containing newlines parseable.
				const worktreeFields = (await execOrThrow("git", ["worktree", "list", "--porcelain", "-z"], checkout)).split("\0");
				const mainCheckout = worktreeFields[0]?.startsWith("worktree ") ? worktreeFields[0].slice("worktree ".length) : undefined;
				if (!mainCheckout) throw new Error("git worktree list returned no main worktree.");
				if (mainCheckout === checkout || !worktreeFields.includes(`worktree ${checkout}`)) {
					throw new Error("/done requires the current workspace's registered linked checkout, not a primary repository.");
				}
				// A bare primary has no working tree to pull into.
				const parentIsBare = worktreeFields.slice(1, worktreeFields.indexOf("")).includes("bare");

				if (target !== undefined && checkout !== target) throw new Error("Checkout identity changed during recovery; reopen /done.");
				check();
				// Lock order is checkout, then command store. Forced completion still needs the guard.
				const siblingTabIds = await withWorktreeLock(checkout, async (checkoutDescriptor) => {
					const repoKey = absolutePath((await execOrThrow("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], checkout)).replace(/\r?\n$/, ""), "Git common directory");
					const currentIdentity = JSON.stringify([checkout, mainCheckout, repoKey, parentIsBare]);
					if (identity !== undefined && identity !== currentIdentity) throw new Error("Checkout identity changed during recovery; reopen /done.");
					target = checkout; identity = currentIdentity;
					const paneCwd = await verifyPaneTarget(herdr, ctx.cwd, { workspaceId, tabId, rootPaneId: paneId, checkoutPath: checkout }, { repoRoot: mainCheckout, repoKey }, true);
					if ((await execOrThrow("git", ["rev-parse", "--show-toplevel"], paneCwd)).replace(/\r?\n$/, "") !== checkout) {
						throw new Error("/done pane directory is not in the target linked checkout.");
					}
					check();
					return await guardRemoval(checkout, async (storeDescriptor) => {
						let dependentIds: string[] = [];
						if (!force) {
							const snapshot = await herdr.json(["api", "snapshot"], { cwd: ctx.cwd });
							const panes = (snapshot.result as { snapshot?: { panes?: SnapshotPane[] } } | undefined)?.snapshot?.panes;
							if (!Array.isArray(panes)) throw new Error("herdr api snapshot returned no panes.");
							dependentIds = [...new Set(panes
								.filter((pane): pane is SnapshotPane & { tab_id: string; cwd: string } =>
									typeof pane.tab_id === "string" && pane.tab_id !== tabId && typeof pane.cwd === "string" &&
									(pane.cwd === checkout || pane.cwd.startsWith(`${checkout}/`)))
								.map((pane) => pane.tab_id))];
						}
						const listing = await herdr.json(["tab", "list"], { cwd: ctx.cwd });
						const tabs = (listing.result as { tabs?: TabEntry[] } | undefined)?.tabs;
						if (!Array.isArray(tabs)) throw new Error("herdr tab list returned no tabs.");
						const validTabs = tabs.filter((tab): tab is TabEntry & { tab_id: string } => typeof tab.tab_id === "string");
						const tabsById = new Map(validTabs.map((tab) => [tab.tab_id, tab]));
						if (tabsById.get(tabId)?.workspace_id !== workspaceId) {
							throw new Error(`Herdr tab ${tabId} does not belong to workspace ${workspaceId}.`);
						}
						const siblingTabIds = validTabs
							.filter((tab) => tab.tab_id !== tabId && tab.workspace_id === workspaceId)
							.map((tab) => tab.tab_id);
						const blockers = dependentIds.filter((id) => tabsById.get(id)?.workspace_id !== workspaceId);
						if (blockers.length > 0) {
							const names = blockers.map((id) => {
								const label = tabsById.get(id)?.label;
								return typeof label === "string" ? label : id;
							});
							throw new Error(`Worktree still used by Herdr tabs ${names.join(", ")}; close them first.`);
						}

						check();
						removalStarted = true;
						await mutateGit({ operation: "remove", checkout, force, cwd }, [checkoutDescriptor, storeDescriptor]);
						return siblingTabIds;
					});
				});
				return { siblingTabIds, mainCheckout, parentIsBare };
			};
			let removed: Awaited<ReturnType<typeof remove>>;
			try { removed = await remove(); }
			catch (error) {
				// All locks are released before consent. Never retry a possibly started mutation.
				if (removalStarted || !(error instanceof CommandRemovalBlocked) || !ctx.hasUI || !recoverRemoval || !target) throw error;
				check();
				if (!await recoverRemoval(target, ctx, check)) { ctx.ui.notify("Worktree retained; command protection stays held.", "info"); return; }
				check();
				removed = await remove();
			}
			const { siblingTabIds, mainCheckout, parentIsBare } = removed;
			try {
				await Promise.all(siblingTabIds.map((id) => herdr.run(["tab", "close", id], { cwd: tmpdir() })));
				if (!parentIsBare) {
					// Serialize concurrent completions pulling the same parent checkout.
					// Run outside the removed checkout because its directory no longer exists.
					await withWorktreeLock(mainCheckout, (descriptor) => mutateGit({ operation: "pull", cwd: mainCheckout }, [descriptor]));
				}
			} finally {
				// Close this session's tab last, even if sibling cleanup or the parent pull fails.
				await herdr.run(["tab", "close", tabId], { cwd: tmpdir() });
			}
		},
	});
}

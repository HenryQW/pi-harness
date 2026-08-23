import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, withWorktreeLock } from "@henryqw/pi-herdr";

type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };

type SnapshotPane = { tab_id?: unknown; cwd?: unknown };
type TabEntry = { tab_id?: unknown; label?: unknown };

export default function herdrDoneExtension(pi: ExtensionAPI): void {
	const herdr = createHerdrClient<{ cwd: string }>((command, args, options) =>
		pi.exec(command, [...args], options));

	const execOrThrow = async (command: string, args: string[], cwd: string): Promise<string> => {
		const result = await pi.exec(command, args, { cwd }) as unknown as ExecResult;
		if (result.code !== 0 || result.killed) {
			throw new Error(`${command} ${args[0]} failed: ${result.stderr.trim() || "killed"}`);
		}
		return result.stdout;
	};

	pi.registerCommand("done", {
		description: "Remove the current Herdr worktree, then fast-forward its parent workspace",
		handler: async (args, ctx) => {
			const option = args.trim();
			if (option && option !== "--force") throw new Error("Usage: /done [--force]");
			if (process.env.HERDR_ENV !== "1") {
				throw new Error("/done requires the current Pi session inside Herdr (HERDR_ENV=1).");
			}
			const tabId = process.env.HERDR_TAB_ID?.trim();
			if (!tabId) throw new Error("HERDR_TAB_ID is missing.");

			if (option !== "--force") {
				const confirmed = await ctx.ui.confirm("Done", "Close and remove the current Herdr worktree?");
				if (!confirmed) return;
			}

			await ctx.waitForIdle();
			const checkout = (await execOrThrow("git", ["rev-parse", "--show-toplevel"], ctx.cwd)).trim();
			// First record of the NUL-delimited list is always the main worktree;
			// -z keeps paths containing newlines parseable.
			const worktreeFields = (await execOrThrow("git", ["worktree", "list", "--porcelain", "-z"], checkout)).split("\0");
			const mainCheckout = worktreeFields[0]?.startsWith("worktree ") ? worktreeFields[0].slice("worktree ".length) : undefined;
			if (!mainCheckout) throw new Error("git worktree list returned no main worktree.");
			// A bare primary has no working tree to pull into.
			const parentIsBare = mainCheckout !== checkout &&
				worktreeFields.slice(1, worktreeFields.indexOf("")).includes("bare");

			await withWorktreeLock(checkout, async () => {
				// With --force, skip the dependents check entirely and let git remove the checkout.
				if (option !== "--force") {
					const snapshot = await herdr.json(["api", "snapshot"], { cwd: ctx.cwd });
					const panes = (snapshot.result as { snapshot?: { panes?: SnapshotPane[] } } | undefined)?.snapshot?.panes;
					if (!Array.isArray(panes)) throw new Error("herdr api snapshot returned no panes.");
					const dependentIds = [...new Set(panes
						.filter((pane): pane is SnapshotPane & { tab_id: string; cwd: string } =>
							typeof pane.tab_id === "string" && pane.tab_id !== tabId && typeof pane.cwd === "string" &&
							(pane.cwd === checkout || pane.cwd.startsWith(`${checkout}/`)))
						.map((pane) => pane.tab_id))];
					if (dependentIds.length > 0) {
						const listing = await herdr.json(["tab", "list"], { cwd: ctx.cwd });
						const tabs = (listing.result as { tabs?: TabEntry[] } | undefined)?.tabs;
						const labels = new Map(
							(Array.isArray(tabs) ? tabs : [])
								.filter((tab): tab is TabEntry & { tab_id: string; label: string } =>
									typeof tab.tab_id === "string" && typeof tab.label === "string")
								.map((tab) => [tab.tab_id, tab.label]));
						const names = [...new Set(dependentIds.map((id) => labels.get(id) ?? id))];
						throw new Error(`Worktree still used by Herdr tabs ${names.join(", ")}; close them first.`);
					}
				}

				await execOrThrow("git", [
					"worktree", "remove", ...(option === "--force" ? ["--force"] : []), checkout,
				], ctx.cwd);
			});
			try {
				if (!parentIsBare && mainCheckout !== checkout) {
					// Serialize concurrent completions pulling the same parent checkout.
					// Run outside the removed checkout because its directory no longer exists.
					await withWorktreeLock(mainCheckout, () => execOrThrow("git", ["pull", "--ff-only"], mainCheckout));
				}
			} finally {
				// Close only this session's tab once its checkout is removed, even if the parent pull fails.
				await herdr.run(["tab", "close", tabId], { cwd: tmpdir() });
			}
		},
	});
}

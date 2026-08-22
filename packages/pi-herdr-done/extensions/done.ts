import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@henryqw/pi-herdr";
import { lock } from "proper-lockfile";

type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };

type SnapshotPane = { tab_id?: unknown; cwd?: unknown };

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
		description: "Close and remove the current Herdr worktree",
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

			const release = await lock(checkout);
			try {
				const snapshot = await herdr.json(["api", "snapshot"], { cwd: ctx.cwd });
				const panes = (snapshot.result as { snapshot?: { panes?: SnapshotPane[] } } | undefined)?.snapshot?.panes;
				if (!Array.isArray(panes)) throw new Error("herdr api snapshot returned no panes.");
				const dependents = [...new Set(panes
					.filter((pane): pane is SnapshotPane & { tab_id: string; cwd: string } =>
						typeof pane.tab_id === "string" && pane.tab_id !== tabId &&
						typeof pane.cwd === "string" &&
						(pane.cwd === checkout || pane.cwd.startsWith(`${checkout}/`)))
					.map((pane) => pane.tab_id))];
				if (dependents.length > 0) {
					throw new Error(`Worktree still used by Herdr tabs ${dependents.join(", ")}; close them first.`);
				}

				await execOrThrow("git", [
					"worktree", "remove", ...(option === "--force" ? ["--force"] : []), checkout,
				], ctx.cwd);
			} finally {
				await release();
			}
			// Close only this session's tab so unrelated tabs survive.
			// Run outside the removed checkout because its directory no longer exists.
			await herdr.run(["tab", "close", tabId], { cwd: tmpdir() });
		},
	});
}

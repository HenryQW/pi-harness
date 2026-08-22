import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@henryqw/pi-herdr";

type ExecResult = { code: number; stderr: string };

export default function herdrDoneExtension(pi: ExtensionAPI): void {
	const herdr = createHerdrClient<{ cwd: string }>((command, args, options) =>
		pi.exec(command, [...args], options));

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
			const removal = await pi.exec("git", [
				"worktree", "remove", ...(option === "--force" ? ["--force"] : []), ".",
			], { cwd: ctx.cwd }) as unknown as ExecResult;
			if (removal.code !== 0) {
				throw new Error(`git worktree remove failed: ${removal.stderr.trim()}`);
			}
			// Close only this session's tab so sibling tabs in the workspace survive.
			// Run outside the removed checkout because its directory no longer exists.
			await herdr.run(["tab", "close", tabId], { cwd: tmpdir() });
		},
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@henryqw/pi-herdr";

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
			const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
			if (!workspaceId) throw new Error("HERDR_WORKSPACE_ID is missing.");

			if (option !== "--force") {
				const confirmed = await ctx.ui.confirm("Done", "Close and remove the current Herdr worktree?");
				if (!confirmed) return;
			}

			await ctx.waitForIdle();
			await herdr.run([
				"worktree", "remove", "--workspace", workspaceId,
				...(option === "--force" ? ["--force"] : []),
			], { cwd: ctx.cwd });
		},
	});
}

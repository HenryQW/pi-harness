import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function undoExtension(pi: ExtensionAPI): void {
	pi.registerCommand("undo", {
		description: "Rewind context to the latest user prompt",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /undo");

			ctx.abort();
			await ctx.waitForIdle();
			const turn = [...ctx.sessionManager.getBranch()]
				.reverse()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!turn) {
				ctx.ui.notify("Nothing to undo.", "info");
				return;
			}
			await ctx.navigateTree(turn.id, { summarize: false });
		},
	});
}

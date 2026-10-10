import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerBtwExtension from "../internal/btw.ts";
import herdrCloneExtension from "../internal/clone-tab.ts";
import herdrDoneExtension from "../internal/done.ts";
import herdrRenameExtension from "../internal/rename.ts";

export default async function herdrToolsExtension(pi: ExtensionAPI): Promise<void> {
	herdrRenameExtension(pi);
	await registerBtwExtension(pi);
	herdrCloneExtension(pi);
	herdrDoneExtension(pi);
	registerDialogStatus(pi);
}

/** Report open TUI dialogs through Herdr's blocked-status event, contributing at most one block. */
function registerDialogStatus(pi: ExtensionAPI): void {
	// An earlier async ui_prompt_start handler can delay this start until after its end,
	// so a signed balance returns to zero instead of leaving a stale block.
	let balance = 0;
	let closed = false;
	const track = (delta: 1 | -1) => (_event: unknown, ctx: ExtensionContext) => {
		if (closed || ctx.mode !== "tui") return;
		const wasBlocked = balance > 0;
		balance += delta;
		if ((balance > 0) === wasBlocked) return;
		pi.events.emit("herdr:blocked", wasBlocked ? { active: false } : { active: true, label: "Input required" });
	};
	pi.on("ui_prompt_start", track(1));
	pi.on("ui_prompt_end", track(-1));
	pi.on("session_shutdown", () => {
		closed = true;
		if (balance > 0) pi.events.emit("herdr:blocked", { active: false });
	});
}

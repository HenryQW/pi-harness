import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerBtwExtension from "../internal/btw.ts";
import herdrCloneExtension from "../internal/clone-tab.ts";
import herdrDoneExtension from "../internal/done.ts";
import herdrRenameExtension from "../internal/rename.ts";

export default async function herdrToolsExtension(pi: ExtensionAPI): Promise<void> {
	herdrRenameExtension(pi);
	await registerBtwExtension(pi);
	herdrCloneExtension(pi);
	herdrDoneExtension(pi);
}

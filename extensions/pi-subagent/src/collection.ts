import { createHerdrClient } from "@henryqw/pi-herdr";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A collection trigger, not a limit on tabs or workers. */
export const COLLECTION_TAB_TRIGGER = 10;

export async function workspaceNeedsCollection(pi: Pick<ExtensionAPI, "exec">, cwd: string, workspaceId: string): Promise<boolean> {
	const response = await createHerdrClient(pi.exec.bind(pi)).json(["tab", "list", "--workspace", workspaceId], { cwd, timeout: 5_000 });
	const result = response.result as { type?: unknown; tabs?: unknown } | undefined;
	if (result?.type !== "tab_list" || !Array.isArray(result.tabs)) throw new Error("Malformed Herdr collection tab list.");
	const ids = new Set<string>();
	for (const tab of result.tabs) {
		if (!tab || tab.workspace_id !== workspaceId || typeof tab.tab_id !== "string" || !tab.tab_id || ids.has(tab.tab_id)) {
			throw new Error("Herdr collection tab list has uncertain workspace or tab identity.");
		}
		ids.add(tab.tab_id);
	}
	return ids.size > COLLECTION_TAB_TRIGGER;
}

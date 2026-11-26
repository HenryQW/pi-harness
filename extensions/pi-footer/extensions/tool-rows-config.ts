import { createConfigStore, field, parsers } from "@henryqw/pi-config-store";

/** How /tool-rows folds tool rows: one summary line per stretch of tools, one line per tool, or Pi's own rows. */
export const TOOL_ROW_MODES = ["group", "line", "off"] as const;
export type ToolRowMode = (typeof TOOL_ROW_MODES)[number];

/** A missing file or an invalid mode keeps Pi's own rows. */
export function createToolRowsConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-tool-rows",
		agentDir,
		fields: { mode: field(parsers.oneOf(TOOL_ROW_MODES), "off") },
	});
}

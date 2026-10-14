import { createConfigStore, field, parsers } from "@henryqw/pi-config-store";

const DEFAULT_COMMAND = "code";

/** The open-in config store, shared by the footer link and `/open`. */
export function createOpenInConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-open-in",
		agentDir,
		fields: { command: field(parsers.string({ trim: true }), DEFAULT_COMMAND) },
	});
}

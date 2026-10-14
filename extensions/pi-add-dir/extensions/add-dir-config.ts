import { createConfigStore, field, parsers } from "@henryqw/pi-config-store";

export function createAddDirConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-add-dir",
		agentDir,
		fields: {
			directories: field(parsers.array(parsers.absolutePath(), { unique: (directory) => directory }), []),
		},
	});
}

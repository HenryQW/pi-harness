import { join } from "node:path";
import { createConfigStore, extensionConfigDir, field, parsers } from "@henryqw/pi-config-store";

const EXTENSION_ID = "pi-memory";

export const DEFAULT_MEMORY_CHAR_LIMIT = 8800;
export const DEFAULT_USER_CHAR_LIMIT = 5500;

const charLimit = parsers.integer({ min: 1, max: 100_000 });

export function memoryConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: EXTENSION_ID,
		agentDir,
		fields: {
			// A default directory would read and write the wrong store, so an invalid one disables memory.
			directory: field(parsers.absolutePath(), join(extensionConfigDir(EXTENSION_ID, agentDir), "memory"), { onInvalid: "disable" }),
			memoryCharLimit: field(charLimit, DEFAULT_MEMORY_CHAR_LIMIT),
			userCharLimit: field(charLimit, DEFAULT_USER_CHAR_LIMIT),
		},
	});
}

export type MemoryConfigStore = ReturnType<typeof memoryConfigStore>;
export type MemoryConfig = Extract<ReturnType<MemoryConfigStore["loadSync"]>, { status: "ok" }>["value"];

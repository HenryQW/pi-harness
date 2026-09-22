import { isAbsolute } from "node:path";
import { createConfigStore } from "@henryqw/pi-config-store";

export interface AddDirConfig {
	directories: string[];
}

function parseConfig(value: unknown): AddDirConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid pi-add-dir config: expected an object.");
	}
	const config = value as Record<string, unknown>;
	if (Object.keys(config).length !== 1 || !Array.isArray(config.directories)) {
		throw new Error('Invalid pi-add-dir config: expected only a "directories" array.');
	}
	const directories = config.directories;
	if (
		directories.some(
			(directory) =>
				typeof directory !== "string" ||
				!isAbsolute(directory) ||
				directory.length === 0 ||
				/\p{C}/u.test(directory),
		)
	) {
		throw new Error("Invalid pi-add-dir config: directories must be absolute paths without control characters.");
	}
	if (new Set(directories).size !== directories.length) {
		throw new Error("Invalid pi-add-dir config: directories must be unique.");
	}
	return { directories: [...directories] };
}

export function createAddDirConfigStore(agentDir?: string) {
	return createConfigStore<AddDirConfig>({
		extensionId: "pi-add-dir",
		agentDir,
		defaults: () => ({ directories: [] }),
		parse: parseConfig,
	});
}

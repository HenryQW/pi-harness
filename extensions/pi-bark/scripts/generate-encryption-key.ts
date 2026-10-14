#!/usr/bin/env node

import {
	ENCRYPTION_ALGORITHM,
	ENCRYPTION_MODE,
	ENCRYPTION_PADDING,
	writeBarkConfig,
} from "../src/config.ts";
import { generateEncryptionKey } from "../src/encryption.ts";

const args = process.argv.slice(2);
const force = args.length === 1 && args[0] === "--force";
const disable = args.length === 1 && args[0] === "--disable";

if (args.length > 1 || (args.length === 1 && !force && !disable)) {
	console.error("Usage: pi-bark-key [--force | --disable]");
	process.exitCode = 1;
} else {
	try {
		if (disable) {
			await writeBarkConfig(undefined, ["encryption"], (config) => ({ ...config, encryption: null }));
			console.log("Disabled Bark push encryption.");
		} else {
			let key = "";
			// Without --force, an invalid existing key blocks the write instead of being replaced.
			await writeBarkConfig(undefined, force ? ["encryption"] : [], (config) => {
				if (config.encryption && !force) {
					throw new Error("A Bark Custom Encryption Key already exists. Use --force to replace it.");
				}
				key = generateEncryptionKey();
				return {
					...config,
					encryption: {
						algorithm: ENCRYPTION_ALGORITHM,
						mode: ENCRYPTION_MODE,
						padding: ENCRYPTION_PADDING,
						key,
					},
				};
			});
			console.log("Generated and saved a Bark Custom Encryption Key.");
			console.log(`Algorithm: ${ENCRYPTION_ALGORITHM}`);
			console.log(`Mode: ${ENCRYPTION_MODE}`);
			console.log(`Padding: ${ENCRYPTION_PADDING}`);
			console.log(`Key: ${key}`);
			console.log("Enter these settings in Bark App > Push Encryption.");
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

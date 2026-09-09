import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const shellControlSyntax = /[\n\r;|&<>`]|[$][(]/;
const directPnpmTest = /^pnpm[ \t]+test(?:[ \t]+.*)?$/;

function recognizedCommand(command: string): string | undefined {
	if (shellControlSyntax.test(command)) return undefined;

	const trimmed = command.trim();
	if (trimmed.startsWith("rtk") || !directPnpmTest.test(trimmed)) return undefined;
	return trimmed;
}

export default async function rtkTestExtension(pi: ExtensionAPI): Promise<void> {
	let rtkAvailable = false;
	try {
		const { code, killed } = await pi.exec("rtk", ["test", "--help"], { timeout: 2_000 });
		rtkAvailable = code === 0 && !killed;
	} catch {
		rtkAvailable = false;
	}

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" || typeof event.input.command !== "string") return undefined;

		const command = recognizedCommand(event.input.command);
		if (!command) return undefined;
		if (!rtkAvailable) {
			return {
				block: true,
				reason: "RTK is unavailable. Install RTK and verify `rtk test --help`.",
			};
		}

		event.input.command = `rtk test ${command}`;
		return undefined;
	});
}

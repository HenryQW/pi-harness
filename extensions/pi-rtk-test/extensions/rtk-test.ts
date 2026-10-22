import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const shellControlSyntax = /[\n\r;|&<>`]|[$][(]/;
const directPnpmTest = /^pnpm[ \t]+test(?:[ \t]+.*)?$/;

export default async function rtkTestExtension(pi: ExtensionAPI): Promise<void> {
	let rtkAvailable = false;
	try {
		const { code, killed } = await pi.exec("rtk", ["test", "--help"], { timeout: 2_000 });
		rtkAvailable = code === 0 && !killed;
	} catch {}

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" || typeof event.input.command !== "string") return undefined;

		const command = event.input.command.trim();
		if (shellControlSyntax.test(event.input.command) || !directPnpmTest.test(command)) return undefined;
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

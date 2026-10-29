import { createMcpExtension, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRoleMcpConfig, roleMcpAllowlistFromArgv, ROLE_MCP_POLICY_FLAG } from "@henryqw/pi-subagent";

export default function roleMcp(pi: ExtensionAPI): void | Promise<void> {
	pi.registerFlag(ROLE_MCP_POLICY_FLAG, {
		description: "Internal Pi Subagent Role MCP policy",
		type: "string",
	});
	// Pi binds extension flag values after factories load. Throwing here exits the child non-zero.
	const config = loadRoleMcpConfig(getAgentDir(), roleMcpAllowlistFromArgv(process.argv));
	return createMcpExtension({ loadConfig: () => config })(pi);
}

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { loadMcpConfig } from "pi-mcp-adapter/config";
import { roleMcpAllowlistFromArgv, ROLE_MCP_POLICY_FLAG, selectRoleMcpConfig } from "@henryqw/pi-subagent";

export default function roleMcp(pi: ExtensionAPI): void {
	pi.registerFlag(ROLE_MCP_POLICY_FLAG, {
		description: "Internal Pi Subagent Role MCP policy",
		type: "string",
	});
	// Pi binds extension flag values after factories load.
	const allowlist = roleMcpAllowlistFromArgv(process.argv);
	const config = selectRoleMcpConfig(loadMcpConfig(join(getAgentDir(), "mcp.json"), process.cwd()), allowlist);
	createMcpAdapter({ config })(pi);
}

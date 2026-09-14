import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { loadMcpConfig } from "pi-mcp-adapter/config";
import {
	parseRoleMcpAllowlist,
	ROLE_MCP_POLICY_FLAG,
	roleMcpFlagValue,
	selectRoleMcpConfig,
} from "@henryqw/pi-subagent";

export default function roleMcp(pi: ExtensionAPI): void {
	pi.registerFlag(ROLE_MCP_POLICY_FLAG, {
		description: "Internal Pi Subagent Role MCP policy",
		type: "string",
	});
	const allowlist = parseRoleMcpAllowlist(roleMcpFlagValue(process.argv, `--${ROLE_MCP_POLICY_FLAG}`));
	const config = selectRoleMcpConfig(loadMcpConfig(join(getAgentDir(), "mcp.json"), process.cwd()), allowlist);
	createMcpAdapter({ config })(pi);
}

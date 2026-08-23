import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DENIED_TOOLS: readonly string[] = ["delegate_task", "ask_question", "auto_dag_approve", "auto_dag_start"] as const;

// ponytail: bash remains a full escape hatch; this is tool-surface hygiene, not a sandbox.
export default function childPolicy(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const denied = new Set(DENIED_TOOLS);
		pi.setActiveTools(pi.getActiveTools().filter((name) => !denied.has(name)));
	});
}

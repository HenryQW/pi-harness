import { formatConfigIssues, type ConfigLoad } from "@henryqw/pi-config-store";
import type { ExecutionPolicySnapshot } from "../dist/schema.js";
import type { SubagentConfig } from "@henryqw/pi-subagent";

export type EffectiveExecutionPolicy = ExecutionPolicySnapshot;

/** Resolve one immutable policy. A disabled config blocks delegation. */
export function resolveExecutionPolicy(path: string, loaded: ConfigLoad<SubagentConfig>): EffectiveExecutionPolicy {
	if (loaded.status === "disabled") {
		throw new Error(`${path}: ${formatConfigIssues(loaded.issues)}; delegation is blocked until this file is corrected.`);
	}
	const { maxSubagents, maxTurns, maxTokens, maxCorrections, timeout } = loaded.value;
	return Object.freeze({
		maxSubagents,
		maxTurns,
		...(maxTokens === undefined ? {} : { maxTokens }),
		childIdleMs: timeout.idleMinutes * 60_000,
		childMaxMs: timeout.maxMinutes * 60_000,
		maxCorrections,
	});
}

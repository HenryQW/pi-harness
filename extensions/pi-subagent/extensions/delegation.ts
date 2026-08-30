import type { EphemeralSubagentExecutor, EphemeralSubagentResult, EphemeralSubagentRunInput } from "@henryqw/pi-subagent";

/** Runs one caller-prepared child launch without making lifecycle decisions. */
export function runDelegation(
	executor: EphemeralSubagentExecutor,
	input: EphemeralSubagentRunInput,
): Promise<EphemeralSubagentResult> {
	return executor.run(input);
}

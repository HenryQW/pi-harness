import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_EXCLUDED_TOOL_NAMES, EXECUTION_BUDGET_ENV, ROLE_TOOL_POLICY_FLAG } from "@henryqw/pi-subagent";

const childExcludedTools: ReadonlySet<string> = new Set(CHILD_EXCLUDED_TOOL_NAMES);
const WARNING_RATIO = 0.8;
const WARNING_MESSAGE_TYPE = "pi-subagent-execution-budget";

function configuredTools(value: unknown): string[] {
	if (typeof value !== "string") throw new Error(`${ROLE_TOOL_POLICY_FLAG} must be JSON tool names.`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${ROLE_TOOL_POLICY_FLAG} must be JSON tool names.`);
	}
	if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string" || !name.trim() || name.includes("\0"))) {
		throw new Error(`${ROLE_TOOL_POLICY_FLAG} must be JSON tool names.`);
	}
	return [...new Set(parsed.map((name) => name.trim()))];
}

function executionBudget(value: string | undefined): { maxTurns: number; maxMs: number } | undefined {
	if (value === undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${EXECUTION_BUDGET_ENV} must be a JSON execution budget.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${EXECUTION_BUDGET_ENV} must be a JSON execution budget.`);
	}
	const budget = parsed as Record<string, unknown>;
	if (Object.keys(budget).length !== 2 || !("maxTurns" in budget) || !("maxMs" in budget)
		|| !Number.isSafeInteger(budget.maxTurns) || (budget.maxTurns as number) < 1
		|| typeof budget.maxMs !== "number" || !Number.isFinite(budget.maxMs) || budget.maxMs <= 0) {
		throw new Error(`${EXECUTION_BUDGET_ENV} must be a JSON execution budget.`);
	}
	return { maxTurns: budget.maxTurns as number, maxMs: budget.maxMs };
}

function expectsAnotherTurn(message: unknown): boolean {
	if (!message || typeof message !== "object" || Array.isArray(message)) return false;
	const record = message as Record<string, unknown>;
	return record.role === "assistant" && Array.isArray(record.content)
		&& record.content.some((part) => part && typeof part === "object" && !Array.isArray(part)
			&& (part as Record<string, unknown>).type === "toolCall");
}

export default function roleTools(pi: ExtensionAPI): void {
	pi.registerFlag(ROLE_TOOL_POLICY_FLAG, {
		description: "Internal Pi Subagent Role tool policy",
		type: "string",
	});
	pi.on("session_start", () => {
		const selected = configuredTools(pi.getFlag(ROLE_TOOL_POLICY_FLAG));
		const allTools = pi.getAllTools();
		const registeredTools = new Set(allTools.map((tool) => tool.name));
		const extensionTools = allTools
			.filter((tool) => !["builtin", "sdk", "inline"].includes(tool.sourceInfo.source))
			.map((tool) => tool.name);
		pi.setActiveTools([...new Set([...selected, ...extensionTools])].filter((name) => !childExcludedTools.has(name)));
		const activeTools = new Set(pi.getActiveTools().filter((name) => registeredTools.has(name) && !childExcludedTools.has(name)));
		const unavailable = selected.filter((name) => !activeTools.has(name));
		if (unavailable.length) {
			throw new Error(`Subagent requested unavailable tools: ${unavailable.join(", ")}. Check spelling and load the provider extension that registers them.`);
		}
	});

	const budget = executionBudget(process.env[EXECUTION_BUDGET_ENV]);
	if (!budget) return;
	const startedAt = Date.now();
	const warningTurn = Math.ceil(budget.maxTurns * WARNING_RATIO);
	let completedTurns = 0;
	let turnWarningSent = false;
	let runtimeWarningSent = false;
	pi.on("turn_end", (event) => {
		completedTurns += 1;
		if (!expectsAnotherTurn(event.message)) return;
		const elapsedMs = Date.now() - startedAt;
		const turnWarningDue = !turnWarningSent && completedTurns >= warningTurn;
		const runtimeWarningDue = !runtimeWarningSent && elapsedMs >= budget.maxMs * WARNING_RATIO;
		if (!turnWarningDue && !runtimeWarningDue) return;
		if (turnWarningDue) turnWarningSent = true;
		if (runtimeWarningDue) runtimeWarningSent = true;
		const remainingTurns = Math.max(0, budget.maxTurns - completedTurns);
		const remainingMinutes = Math.max(0, Math.ceil((budget.maxMs - elapsedMs) / 60_000));
		const maxMinutes = budget.maxMs / 60_000;
		pi.sendMessage({
			customType: WARNING_MESSAGE_TYPE,
			content: `**Execution budget warning:** ${remainingTurns} of ${budget.maxTurns} turns and approximately ${remainingMinutes} of ${maxMinutes} minutes remain before forced termination.\nConverge now: stop expanding scope, complete the highest-priority required work, perform only essential validation, and return a concise final result. If completion is impossible, follow your role’s recovery requirements and report the blocker and exact remaining work. This warning does not change your role, scope, or permissions.`,
			display: true,
		}, { deliverAs: "steer", triggerTurn: false });
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CHILD_EXCLUDED_TOOL_NAMES,
	EXECUTION_BUDGET_ENV,
	ROLE_TOOL_POLICY_FLAG,
	type EphemeralSubagentExecutionBudget,
} from "@henryqw/pi-subagent";

const childExcludedTools: ReadonlySet<string> = new Set(CHILD_EXCLUDED_TOOL_NAMES);
const WARNING_RATIO = 0.8;
const WARNING_MESSAGE_TYPE = "pi-subagent-execution-budget";
const FINAL_HANDOFF_MESSAGE = {
	customType: "pi-subagent-final-handoff",
	content: "**Final handoff required.** Tools are disabled. If your assigned task or Role requires exact output, reply only with that output instead; it takes precedence over this decision packet. Otherwise, reply only with this decision packet:\n\n**Status:** completed | blocked | incomplete\n**Outcome:** one sentence describing what is now true\n**Evidence:** up to three concrete findings, changes, or checks; include an attempted approach only when it prevents Main from repeating failed work\n**Blocker:** none or the exact blocker\n**Risk:** none or one material risk\n**Suggested next:** none or one concrete action",
	display: true,
};

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

function executionBudget(value: string | undefined): EphemeralSubagentExecutionBudget | undefined {
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
	const maxTokensValid = budget.maxTokens === undefined
		|| Number.isSafeInteger(budget.maxTokens) && (budget.maxTokens as number) >= 1;
	if (Object.keys(budget).some((key) => !["maxTurns", "maxMs", "startedAt", "maxTokens"].includes(key))
		|| !("maxTurns" in budget) || !("maxMs" in budget) || !("startedAt" in budget)
		|| !Number.isSafeInteger(budget.maxTurns) || (budget.maxTurns as number) < 1
		|| typeof budget.maxMs !== "number" || !Number.isFinite(budget.maxMs) || budget.maxMs <= 0
		|| !Number.isSafeInteger(budget.startedAt) || (budget.startedAt as number) < 0
		|| !maxTokensValid) {
		throw new Error(`${EXECUTION_BUDGET_ENV} must be a JSON execution budget.`);
	}
	return {
		maxTurns: budget.maxTurns as number,
		maxMs: budget.maxMs,
		startedAt: budget.startedAt as number,
		...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens as number }),
	};
}

function expectsAnotherTurn(message: unknown): boolean {
	if (!message || typeof message !== "object" || Array.isArray(message)) return false;
	const record = message as Record<string, unknown>;
	return record.role === "assistant" && Array.isArray(record.content)
		&& record.content.some((part) => part && typeof part === "object" && !Array.isArray(part)
			&& (part as Record<string, unknown>).type === "toolCall");
}

function messageTokens(message: unknown): number | undefined {
	if (!message || typeof message !== "object" || Array.isArray(message)) return;
	const usage = (message as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
	const totalTokens = (usage as Record<string, unknown>).totalTokens;
	return typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens >= 0 ? totalTokens : undefined;
}

function joinBudgetParts(parts: string[]): string {
	return `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} and ${parts.at(-1)}`;
}

export default function roleTools(pi: ExtensionAPI): void {
	pi.registerFlag(ROLE_TOOL_POLICY_FLAG, {
		description: "Internal Pi Subagent Role tool policy",
		type: "string",
	});
	const budget = executionBudget(process.env[EXECUTION_BUDGET_ENV]);
	let handoffSent = false;
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
		if (budget?.maxTurns === 1 && !handoffSent) {
			pi.setActiveTools([]);
			pi.sendMessage(FINAL_HANDOFF_MESSAGE, { deliverAs: "steer", triggerTurn: false });
			handoffSent = true;
		}
	});

	if (!budget) return;
	const warningTurn = Math.ceil(budget.maxTurns * WARNING_RATIO);
	const warningTokens = budget.maxTokens === undefined ? undefined : Math.ceil(budget.maxTokens * WARNING_RATIO);
	let completedTurns = 0;
	let completedTokens = 0;
	let currentTokens = 0;
	let turnWarningSent = false;
	let tokenWarningSent = false;
	let runtimeWarningSent = false;
	pi.on("message_update", (event) => {
		currentTokens = messageTokens(event.message) ?? currentTokens;
	});
	pi.on("turn_end", (event) => {
		completedTurns += 1;
		completedTokens += messageTokens(event.message) ?? currentTokens;
		currentTokens = 0;
		const continuing = expectsAnotherTurn(event.message);
		const tokenBudgetCrossed = budget.maxTokens !== undefined && completedTokens >= budget.maxTokens;
		if (!handoffSent && (continuing && completedTurns === budget.maxTurns - 1 || tokenBudgetCrossed)) {
			pi.setActiveTools([]);
			pi.sendMessage(FINAL_HANDOFF_MESSAGE, { deliverAs: "steer", triggerTurn: false });
			handoffSent = true;
			return;
		}
		if (!continuing || handoffSent) return;
		const elapsedMs = Math.max(0, Date.now() - budget.startedAt);
		const turnWarningDue = !turnWarningSent && completedTurns >= warningTurn;
		const tokenWarningDue = warningTokens !== undefined && !tokenWarningSent && completedTokens >= warningTokens;
		const runtimeWarningDue = !runtimeWarningSent && elapsedMs >= budget.maxMs * WARNING_RATIO;
		if (!turnWarningDue && !tokenWarningDue && !runtimeWarningDue) return;
		if (turnWarningDue) turnWarningSent = true;
		if (tokenWarningDue) tokenWarningSent = true;
		if (runtimeWarningDue) runtimeWarningSent = true;
		const remainingTurns = Math.max(0, budget.maxTurns - completedTurns);
		const remainingMinutes = Math.max(0, Math.ceil((budget.maxMs - elapsedMs) / 60_000));
		const maxMinutes = budget.maxMs / 60_000;
		const parts = [
			`${remainingTurns} of ${budget.maxTurns} turns`,
			...(budget.maxTokens === undefined ? [] : [`${Math.max(0, budget.maxTokens - completedTokens)} of ${budget.maxTokens} tokens`]),
			`approximately ${remainingMinutes} of ${maxMinutes} minutes`,
		];
		pi.sendMessage({
			customType: WARNING_MESSAGE_TYPE,
			content: `**Execution budget warning:** ${joinBudgetParts(parts)} remain before forced termination.\nConverge now: stop expanding scope, complete the highest-priority required work, perform only essential validation, and return a concise final result. If completion is impossible, follow your role’s recovery requirements and report the blocker and exact remaining work. This warning does not change your role, scope, or permissions.`,
			display: true,
		}, { deliverAs: "steer", triggerTurn: false });
	});
}

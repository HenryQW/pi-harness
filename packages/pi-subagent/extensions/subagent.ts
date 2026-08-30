import { basename } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	availableTaskModels,
	loadTaskModelsConfig,
	type ThinkingLevel,
	modelReference,
	registerModelTask,
	resolveAvailableModel,
	resolveConfiguredTaskRoute,
	type ResolvedTaskRoute,
	taskThinkingLevels,
} from "@henryqw/pi-task-models";
import {
	capEphemeralSubagentOutput as capOutput,
	createChildWorktree,
	createEphemeralSubagentExecutor,
	DELEGATE_TASK,
	createRoleLaunch,
	DEFAULT_MAX_TURNS,
	EphemeralSubagentError,
	finalizeChildWorktree,
	formatDuration,
	loadRoles,
	resolveTaskRoute,
	worktreeContextNote,
	type EphemeralSubagentActivityEvent,
	type EphemeralSubagentResult,
	type EphemeralSubagentTimeout,
	type Role,
	type WorktreeInfo,
	type WorktreePayload,
} from "@henryqw/pi-subagent";
import { DEFAULT_TIMEOUT_CONFIG, readSubagentConfig, type SubagentTimeoutConfig } from "./config.ts";
import { registerDelegateFlow } from "./delegate-flow.ts";
import { runDelegation } from "./delegation.ts";
import { MODEL_CLASS_GUIDANCE } from "./model-class-policy.ts";
import {
	formatBackgroundWorkflowResult,
	formatWorkflowResult,
	formatWorkflowUpdate,
	WorkflowAbortedError,
	WorkflowFailureError,
	type WorkflowTransportEntry,
} from "./result-transport.ts";
import {
	identifyWorkflowEntries,
	parseWorkflow,
	runForegroundWorkflow,
	WorkflowSchema,
	type Delegation,
	type ParsedWorkflow,
	type WorkflowEntry,
} from "./workflow.ts";
import { TASK_NAME_CONTRACT } from "./task-name.ts";

const WIDGET_KEY = "subagent-status";
const WIDGET_INTERVAL_MS = 80;
const MAX_WIDGET_ITEMS = 8;
const MAX_WIDGET_LINES = 6;
export const MAX_WIDGET_ACTIVE_TOOLS = 8;
const DEFAULT_TIMEOUT_POLICY = {
	idleMs: DEFAULT_TIMEOUT_CONFIG.idleMinutes * 60_000,
	maxMs: DEFAULT_TIMEOUT_CONFIG.maxMinutes * 60_000,
};
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type TimeoutPolicy = EphemeralSubagentTimeout;

/** Merge validated config-file timeout fields over defaults; absent keys keep defaults. */
export function resolveTimeoutPolicy(partial: SubagentTimeoutConfig | undefined): TimeoutPolicy {
	return {
		idleMs: partial?.idleMinutes === undefined ? DEFAULT_TIMEOUT_POLICY.idleMs : partial.idleMinutes * 60_000,
		maxMs: partial?.maxMinutes === undefined ? DEFAULT_TIMEOUT_POLICY.maxMs : partial.maxMinutes * 60_000,
	};
}
type WidgetStatus = "working" | "success" | "failure" | "aborted";
type WidgetActiveTool = {
	toolName: string;
	path?: string;
	startedAt: number;
	order: number;
};
type WidgetItem = {
	role: string;
	model: string;
	thinkingLevel: string;
	name: string;
	tokens: number;
	startedAt: number;
	status: WidgetStatus;
	finishedAt?: number;
	completedAssistantTurns: number;
	startedToolCount: number;
	activeTools: Map<string, WidgetActiveTool>;
	activeToolId?: string;
	activityOrder: number;
};

function roleBadge(role: string): string {
	const initial = Array.from(role)[0]!.toUpperCase();
	return `[${Array.from(initial)[0]!}]`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function statusGlyph(status: WidgetStatus, spinnerIndex: number, theme: Theme): string {
	switch (status) {
		case "working": return theme.fg("accent", SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]!);
		case "success": return theme.fg("success", "✓");
		case "failure": return theme.fg("error", "✗");
		case "aborted": return theme.fg("warning", "■");
	}
}

function statusLabel(status: WidgetStatus): string {
	switch (status) {
		case "working": return "working";
		case "success": return "complete";
		case "failure": return "failed";
		case "aborted": return "stopped";
	}
}

function activityLabel(item: WidgetItem, now: number): string {
	if (item.status === "success") return "Done";
	if (item.status === "failure") return "Failed";
	if (item.status === "aborted") return "Stopped";
	const activeTool = item.activeToolId === undefined ? undefined : item.activeTools.get(item.activeToolId);
	if (!activeTool) return "thinking…";
	return [
		activeTool.toolName,
		formatDuration(now - activeTool.startedAt),
		...(activeTool.path === undefined ? [] : [activeTool.path]),
	].join(" · ");
}

function activityMetrics(item: WidgetItem, now: number): string {
	return [
		...(item.completedAssistantTurns === 0
			? []
			: [`${item.completedAssistantTurns} turn${item.completedAssistantTurns === 1 ? "" : "s"}`]),
		...(item.startedToolCount === 0
			? []
			: [`${item.startedToolCount} tool${item.startedToolCount === 1 ? "" : "s"}`]),
		`${item.model}·${item.thinkingLevel}`,
		`${formatTokens(item.tokens)} tok`,
		formatDuration((item.finishedAt ?? now) - item.startedAt),
	].join(" · ");
}

function renderWidgetRows(
	items: WidgetItem[],
	width: number,
	now: number,
	spinnerIndex: number,
	theme: Theme,
): string[] {
	const ordered = [...items.filter(({ status }) => status === "working"), ...items.filter(({ status }) => status !== "working")];
	const visible = ordered.slice(0, ordered.length > MAX_WIDGET_LINES ? MAX_WIDGET_LINES - 1 : MAX_WIDGET_LINES);
	if (!visible.length) return [];
	const hidden = ordered.slice(visible.length);
	const lines = visible.map((item) => truncateToWidth(
		`${statusGlyph(item.status, spinnerIndex, theme)} ${theme.fg("accent", item.role)} ${theme.fg("text", item.name)} · ${theme.fg("text", activityLabel(item, now))} · ${theme.fg("muted", activityMetrics(item, now))}`,
		width,
	));
	if (hidden.length) {
		const counts: Record<WidgetStatus, number> = { working: 0, success: 0, failure: 0, aborted: 0 };
		for (const { status } of hidden) counts[status] += 1;
		lines.push(truncateToWidth(theme.fg("muted", [
			`… ${hidden.length} more`,
			...(["working", "success", "failure", "aborted"] as const).flatMap((status) =>
				counts[status] ? [`${counts[status]} ${statusLabel(status)}`] : []),
		].join(" · ")), width));
	}
	return lines;
}

function resolveDesignatedRoute(ctx: ExtensionContext, reference: string, thinking?: ThinkingLevel): ResolvedTaskRoute {
	const models = availableTaskModels(ctx);
	const model = resolveAvailableModel(models, reference, ctx.model?.provider);
	if (!model) {
		throw new Error(`Unknown delegate_task model: ${reference}. Available models: ${models.map((candidate) => modelReference(candidate)).join(", ") || "none"}.`);
	}
	const levels = taskThinkingLevels(ctx, model);
	if (thinking !== undefined) {
		if (!levels.includes(thinking)) {
			throw new Error(`delegate_task thinking ${thinking} is not usable for ${modelReference(model)} in this session. Usable levels here: ${levels.join(", ") || "none"}.`);
		}
		return { model, thinkingLevel: thinking };
	}
	if (!levels.length) {
		throw new Error(`${modelReference(model)} has no usable thinking level in this session; pick another model or adjust the scoped thinking pin.`);
	}
	return { model, thinkingLevel: levels.includes("medium") ? "medium" : levels.at(-1)! };
}

const BACKGROUND_RESULT_TYPE = "subagent-background-result";

function boundedError(error: unknown): Error {
	const message = capOutput(error instanceof Error ? error.message : String(error));
	return error instanceof Error && error.message === message ? error : new Error(message, { cause: error });
}

function failedToolPatch(error: WorkflowFailureError | WorkflowAbortedError) {
	return {
		content: [{ type: "text" as const, text: error.message }],
		details: error.details,
		isError: true as const,
		...(error.usage === undefined ? {} : { usage: error.usage }),
	};
}

const roleSummary = (): string => {
	try {
		return loadRoles().map((role) => `${role.name}: ${role.description}`).join("; ");
	} catch (error) {
		return `configuration error: ${error instanceof Error ? error.message : String(error)}`;
	}
};

export default function subagentExtension(
	pi: ExtensionAPI,
	overrideTimeoutPolicy?: TimeoutPolicy,
): void {
	registerModelTask(pi, DELEGATE_TASK);
	const widgetItems = new Map<string, WidgetItem>();
	// Each child is a full Pi process issuing its own model calls; cap parallel
	// spend. Precedence: PI_SUBAGENT_MAX_SUBAGENTS env > config/pi-subagent/config.json
	// maxSubagents > default 5. Invalid present config falls back to the default
	// and is reported at session start; an invalid env value fails fast.
	const loadedConfig = readSubagentConfig();
	let maxActiveSubagents = loadedConfig.config.maxSubagents ?? 5;
	const maxSubagentsRaw = process.env.PI_SUBAGENT_MAX_SUBAGENTS;
	if (maxSubagentsRaw !== undefined) {
		// Reject "2workers", "1.5", "1e3" — parseInt would silently accept prefixes —
		// and digit strings that overflow to Infinity, which would disable the cap.
		if (!/^\d+$/.test(maxSubagentsRaw) || !/^[1-9]\d*$/.test(maxSubagentsRaw)) {
			throw boundedError(new Error(`PI_SUBAGENT_MAX_SUBAGENTS must be a positive integer, got ${JSON.stringify(maxSubagentsRaw)}.`));
		}
		const parsed = Number.parseInt(maxSubagentsRaw, 10);
		if (!Number.isSafeInteger(parsed)) {
			throw boundedError(new Error(`PI_SUBAGENT_MAX_SUBAGENTS exceeds the supported range, got ${JSON.stringify(maxSubagentsRaw)}.`));
		}
		maxActiveSubagents = parsed;
	}
	let backgroundSequence = 0;
	// Explicit policy argument (tests/embedders) wins; otherwise resolve from
	// config file over defaults.
	const timeoutPolicy: TimeoutPolicy = overrideTimeoutPolicy ?? resolveTimeoutPolicy(loadedConfig.config.timeout);
	const executor = createEphemeralSubagentExecutor({
		maxConcurrency: maxActiveSubagents,
		maxTurns: loadedConfig.config.maxTurns ?? DEFAULT_MAX_TURNS,
		timeout: timeoutPolicy,
	});
	// Background children outlive the launching tool call, so they get their own
	// abort signal: tied to the session, not to the turn that started them.
	const backgroundTasks = new Map<string, { controller: AbortController; settled: Promise<void> }>();
	const failedToolPatches = new Map<string, ReturnType<typeof failedToolPatch>>();
	// Latest known session context; refreshed on session lifecycle and model
	// changes so queued background launches resolve against effective state.
	let latestCtx: ExtensionContext | undefined;
	// Bumped by session_start and session_shutdown; background tasks may only
	// deliver into the exact session that launched them.
	let sessionEpoch = 0;
	let invalidateDelegateFlow = () => {};
	let widgetInstalled = false;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerIndex = 0;
	let activeTui: TUI | undefined;
	const stopWidgetTimer = () => {
		if (!widgetTimer) return;
		clearInterval(widgetTimer);
		widgetTimer = undefined;
	};

	const requestWidgetRender = () => activeTui?.requestRender();

	const startWidgetTimer = () => {
		if (widgetTimer) return;
		widgetTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
			requestWidgetRender();
		}, WIDGET_INTERVAL_MS);
		widgetTimer.unref();
	};

	const ensureWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || widgetInstalled) return;
		widgetInstalled = true;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme): Component => {
			activeTui = tui;
			return {
				invalidate() {},
				render: (width) => renderWidgetRows([...widgetItems.values()], width, Date.now(), spinnerIndex, theme),
			};
		});
	};

	const startWidgetItem = (
		id: string,
		role: string,
		model: string,
		thinkingLevel: string | undefined,
		name: string,
		ctx: ExtensionContext,
	) => {
		if (!ctx.hasUI) return;
		ensureWidget(ctx);
		if (!widgetItems.has(id) && widgetItems.size >= MAX_WIDGET_ITEMS) {
			for (const [oldestId, item] of widgetItems) {
				if (item.status === "working") continue;
				widgetItems.delete(oldestId);
				if (widgetItems.size < MAX_WIDGET_ITEMS) break;
			}
		}
		widgetItems.set(id, {
			role: roleBadge(role),
			model,
			thinkingLevel: thinkingLevel ?? "default",
			name,
			tokens: 0,
			startedAt: Date.now(),
			status: "working",
			completedAssistantTurns: 0,
			startedToolCount: 0,
			activeTools: new Map(),
			activityOrder: 0,
		});
		startWidgetTimer();
		requestWidgetRender();
	};

	const updateWidgetTokens = (id: string, tokens: number) => {
		const item = widgetItems.get(id);
		if (!item) return;
		item.tokens = tokens;
		requestWidgetRender();
	};

	const updateWidgetActivity = (id: string, event: EphemeralSubagentActivityEvent) => {
		const item = widgetItems.get(id);
		if (!item || item.status !== "working") return;
		switch (event.type) {
			case "tool_execution_start": {
				if (item.activeTools.has(event.toolCallId)) break;
				if (item.activeTools.size >= MAX_WIDGET_ACTIVE_TOOLS) {
					let oldest: [string, WidgetActiveTool] | undefined;
					for (const candidate of item.activeTools) {
						if (!oldest || candidate[1].order < oldest[1].order) oldest = candidate;
					}
					if (oldest) item.activeTools.delete(oldest[0]);
				}
				const path = event.path === undefined ? undefined : basename(event.path);
				item.startedToolCount += 1;
				item.activeTools.set(event.toolCallId, {
					toolName: event.toolName,
					...(path ? { path } : {}),
					startedAt: Date.now(),
					order: ++item.activityOrder,
				});
				item.activeToolId = event.toolCallId;
				break;
			}
			case "tool_execution_end": {
				item.activeTools.delete(event.toolCallId);
				if (item.activeToolId === event.toolCallId) {
					let latest: [string, WidgetActiveTool] | undefined;
					for (const candidate of item.activeTools) {
						if (!latest || candidate[1].order > latest[1].order) latest = candidate;
					}
					item.activeToolId = latest?.[0];
				}
				break;
			}
			case "message_end":
				item.completedAssistantTurns += 1;
				break;
		}
		requestWidgetRender();
	};

	const finishWidgetItem = (id: string, status: Exclude<WidgetStatus, "working">) => {
		const item = widgetItems.get(id);
		if (!item) return;
		item.status = status;
		item.finishedAt = Date.now();
		item.activeTools.clear();
		item.activeToolId = undefined;
		if (![...widgetItems.values()].some(({ status }) => status === "working")) stopWidgetTimer();
		requestWidgetRender();
	};

	pi.on("session_start", (_event, ctx) => {
		sessionEpoch += 1;
		invalidateDelegateFlow();
		latestCtx = ctx;
		ensureWidget(ctx);
		if (loadedConfig.error !== undefined) ctx.ui.notify(loadedConfig.error, "warning");
		try {
			if (loadTaskModelsConfig().source === "missing") {
				ctx.ui.notify("Task model config is missing; run /task-models to configure it.", "warning");
			}
		} catch {
			// Route resolution retains the existing malformed shared-config error.
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		failedToolPatches.clear();
		stopWidgetTimer();
		widgetItems.clear();
		activeTui = undefined;
		widgetInstalled = false;
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		// Invalidate ordinary outcomes, abort children, then let preserved isolated
		// work report into the outgoing session before Pi tears it down.
		sessionEpoch += 1;
		invalidateDelegateFlow();
		const tasks = [...backgroundTasks.values()];
		for (const { controller } of tasks) controller.abort();
		await Promise.allSettled(tasks.map(({ settled }) => settled));
		backgroundTasks.clear();
	});
	// btw-style context refresh: model_select carries the new model on the event,
	// agent_settled delivers the freshest full context after each turn.
	pi.on("input", (event) => {
		if (event.source === "extension") return;
		for (const [id, item] of widgetItems) {
			if (item.status !== "working") widgetItems.delete(id);
		}
		requestWidgetRender();
	});
	pi.on("model_select", (event, ctx) => {
		latestCtx = { ...ctx, model: event.model } as ExtensionContext;
	});
	pi.on("agent_settled", (_event, ctx) => {
		latestCtx = ctx;
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "delegate_task") return;
		const patch = failedToolPatches.get(event.toolCallId);
		if (!patch) return;
		failedToolPatches.delete(event.toolCallId);
		return patch;
	});

	const reportBackground = (
		launchEpoch: number,
		taskId: string,
		mode: ParsedWorkflow["mode"],
		entries: readonly WorkflowTransportEntry[],
		setupRecoveries: ReadonlyMap<string, string>,
	): void => {
		const stale = launchEpoch !== sessionEpoch;
		const retained = entries.filter(({ worktreePayload }) => worktreePayload && !worktreePayload.pruned);
		if (stale && !retained.length && !setupRecoveries.size) return;
		const transport = formatBackgroundWorkflowResult(mode, entries);
		const outcome = stale ? "aborted" : transport.failed ? "failed" : "completed";
		const content = stale
			? capOutput([
				"Background workflow left recoverable isolated work after session shutdown.",
				`Task ID: ${taskId}`,
				`Mode: ${mode}`,
				"Recovery locations:",
				...retained.map((entry) =>
					`- [${entry.index}] worktree path=${JSON.stringify(entry.worktreePayload!.path)} branch=${JSON.stringify(entry.worktreePayload!.branch)}`),
				...[...setupRecoveries].map(([id, recovery]) => {
					const entry = entries.find((candidate) => candidate.id === id)!;
					return `- [${entry.index}] setup state: ${recovery}`;
				}),
				"Evidence:",
				...retained.map((entry) => {
					const payload = entry.worktreePayload!;
					return `- [${entry.index}] retained worktree commits=${payload.commits} dirty=${payload.dirty} inspection_failed=${payload.inspection_failed === true}`;
				}),
				...[...setupRecoveries].map(([id, recovery]) => {
					const entry = entries.find((candidate) => candidate.id === id)!;
					return `- [${entry.index}] recoverable WorktreeSetupError: ${recovery}`;
				}),
			].join("\n"))
			: transport.text;
		try {
			// Custom messages convert to user-role LLM messages, so the parent agent
			// sees the aggregate on its next turn without forcing one now.
			pi.sendMessage({
				customType: BACKGROUND_RESULT_TYPE,
				content,
				display: true,
				details: {
					...transport.details,
					taskId,
					outcome,
					...(transport.usage === undefined ? {} : { usage: transport.usage }),
					...(stale ? { recovery: true } : {}),
				},
			}, { triggerTurn: false });
		} catch (error) {
			// Delivery can disappear during teardown; only an active UI gets a visible failure.
			if (!stale && latestCtx?.hasUI) {
				latestCtx.ui.notify(boundedError(new Error(
					`Background workflow ${taskId} result delivery failed: ${error instanceof Error ? error.message : String(error)}`,
				)).message, "error");
			}
		}
	};

	invalidateDelegateFlow = registerDelegateFlow(pi, {
		executor,
		maxRuntimeMs: timeoutPolicy.maxMs,
		getSessionGeneration: () => sessionEpoch,
		loadRoles,
		resolveLaunch: (role, modelClass, ctx) => {
			const launchCtx = latestCtx ?? ctx;
			return createRoleLaunch(pi, launchCtx, {
				role,
				route: modelClass === undefined
					? resolveConfiguredTaskRoute(launchCtx, DELEGATE_TASK)
					: resolveTaskRoute(launchCtx, modelClass),
			});
		},
		startWidget: startWidgetItem,
		updateWidgetTokens,
		updateWidgetActivity,
		finishWidget: finishWidgetItem,
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Subagent",
		description: `Delegate one selected single, parallel, or chain workflow of bounded tasks to isolated Pi Subagents. Roles: ${roleSummary()}.`,
		promptSnippet: "Delegate one bounded single, parallel, or chain workflow to isolated roles",
		promptGuidelines: [
			"Call delegate_task with exactly one mode: role+name+task for one task, tasks for 1–8 independent parallel tasks, or chain for 1–8 dependent sequential tasks using {previous} for the immediately preceding assistant output; split independent, commuting outcomes into parallel entries, sequence dependent work in chain entries, and never divide one invariant across multiple entries.",
			`${TASK_NAME_CONTRACT.promptGuidance} Every delegate_task entry must own one concrete outcome with one focused validation story: state its objective, exact scope and exclusions, relevant context and constraints, expected deliverable, and validation; if the affected flow or scope is not yet known, perform bounded read-only discovery first; never pass the parent request unchanged.`,
			`For each delegate_task entry, populate model and thinking only for an explicit user override. Otherwise, ${MODEL_CLASS_GUIDANCE} This is Main policy, not runtime enforcement.`,
			"Parallel delegate_task entries must own non-overlapping files. Keep integration and cross-cutting decisions in Main, and use the minimum number of Subagents needed.",
			"delegate_task background applies to the whole selected workflow and returns before results exist; use it only when the user explicitly asks for non-blocking work.",
		],
		parameters: WorkflowSchema,
		prepareArguments(args) {
			try {
				const workflow = parseWorkflow(args);
				if (workflow.mode === "single") return { ...workflow.delegations[0], background: workflow.background };
				if (workflow.mode === "parallel") return { tasks: workflow.delegations, background: workflow.background };
				return { chain: workflow.delegations, background: workflow.background };
			} catch (error) {
				throw boundedError(error);
			}
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const throwIfAborted = () => {
				if (signal?.aborted) throw new EphemeralSubagentError("aborted", "Subagent was aborted.", signal.reason);
			};
			throwIfAborted();
			let workflow: ParsedWorkflow;
			let roles: Role[];
			try {
				workflow = parseWorkflow(params);
				roles = loadRoles();
				const knownRoles = new Set(roles.map(({ name }) => name));
				for (const { role } of workflow.delegations) {
					if (!knownRoles.has(role)) {
						throw new Error(`Unknown Subagent role: ${role}. Available roles: ${roles.map(({ name }) => name).join(", ") || "none"}.`);
					}
				}
			} catch (error) {
				throw boundedError(error);
			}
			throwIfAborted();
			const rolesByName = new Map(roles.map((role) => [role.name, role]));

			// Resolve against the latest known session context after each FIFO permit.
			const launchCtx = () => latestCtx ?? ctx;
			const resolveLaunch = (role: Role, delegation: Delegation) => createRoleLaunch(pi, launchCtx(), {
				role,
				route: delegation.model !== undefined
					? resolveDesignatedRoute(launchCtx(), delegation.model, delegation.thinking)
					: delegation.modelClass === undefined
						? resolveConfiguredTaskRoute(launchCtx(), DELEGATE_TASK, undefined, delegation.thinking)
						: resolveTaskRoute(launchCtx(), delegation.modelClass, undefined, delegation.thinking),
			});
			const notifyMissingSkills = (role: Role, launch: ReturnType<typeof resolveLaunch>) => {
				if (launch.missingSkills.length) {
					ctx.ui.notify(
						`Subagent role ${role.name} skipped unavailable Pi skills: ${launch.missingSkills.join(", ")}.`,
						"warning",
					);
				}
			};

			const foregroundWorkflow: ParsedWorkflow = { ...workflow, background: false };
			const entries = identifyWorkflowEntries(toolCallId, foregroundWorkflow);
			const states = new Map<string, WorkflowTransportEntry>(entries.map((entry) => [entry.id, {
				id: entry.id,
				index: entry.index,
				role: entry.delegation.role,
				status: "pending",
			}]));
			const setupRecoveries = new Map<string, string>();
			const emitUpdate = (enabled: boolean) => {
				if (!enabled) return;
				const update = formatWorkflowUpdate(workflow.mode, [...states.values()]);
				onUpdate?.({
					content: [{ type: "text", text: update.text }],
					details: update.details,
					...(update.usage === undefined ? {} : { usage: update.usage }),
				});
			};
			const runWorkflow = async (workflowSignal: AbortSignal | undefined, emitToolUpdates: boolean) => {
				try {
					return await runForegroundWorkflow<EphemeralSubagentResult>(toolCallId, foregroundWorkflow, async (entry: WorkflowEntry) => {
					const role = rolesByName.get(entry.delegation.role)!;
					let model: string | undefined;
					let thinkingLevel: string | undefined;
					let worktree: WorktreeInfo | undefined;
					let worktreePayload: WorktreePayload | undefined;
					let child: EphemeralSubagentResult | undefined;
					let rejected: unknown;
					let rejectedUsage: Usage | undefined;
					let aborted = false;
					let status: "succeeded" | "failed" | "rejected" = "rejected";
					let text = "Subagent did not start.";
					const setState = (
						nextStatus: "running" | "succeeded" | "failed" | "rejected",
						nextText: string,
					) => {
						const usage = child?.usage ?? rejectedUsage;
						const base = {
							id: entry.id,
							index: entry.index,
							role: role.name,
							...(model === undefined ? {} : { model }),
							...(thinkingLevel === undefined ? {} : { thinkingLevel }),
							...(worktreePayload === undefined ? {} : { worktreePayload }),
							...(usage === undefined ? {} : { usage }),
						};
						states.set(entry.id, nextStatus === "failed" || nextStatus === "rejected"
							? { ...base, status: nextStatus, failure: nextText }
							: { ...base, status: nextStatus, assistantOutput: nextText });
					};
					try {
						child = await runDelegation(executor, {
							signal: workflowSignal,
							onUpdate: (output) => {
								setState("running", output);
								emitUpdate(emitToolUpdates);
							},
							onTokens: (tokens) => updateWidgetTokens(entry.id, tokens),
							onActivity: (event) => updateWidgetActivity(entry.id, event),
							prepare: async () => {
								// Route and effective Role resources resolve only after this entry's
								// shared executor permit, before isolated state is created.
								const launch = resolveLaunch(role, entry.delegation);
								notifyMissingSkills(role, launch);
								model = modelReference(launch.model);
								thinkingLevel = launch.thinkingLevel;
								if (role.isolation === "worktree") {
									worktree = await createChildWorktree(ctx.cwd, entry.id, undefined, workflowSignal);
								}
								startWidgetItem(entry.id, role.name, launch.model.id, launch.thinkingLevel, entry.delegation.name, ctx);
								setState("running", "");
								emitUpdate(emitToolUpdates);
								return {
									launch,
									task: worktree ? `${entry.delegation.task}${worktreeContextNote(worktree)}` : entry.delegation.task,
									cwd: worktree?.cwd ?? ctx.cwd,
								};
							},
						});
						if (child.outcome === "failure") {
							status = "failed";
							text = capOutput(child.errorMessage || child.stderr.trim() || child.output || `Subagent exited with code ${child.exitCode}.`);
						} else {
							status = "succeeded";
							text = child.output;
						}
					} catch (error) {
						rejected = error;
						aborted = error instanceof EphemeralSubagentError && error.code === "aborted";
						rejectedUsage = error instanceof EphemeralSubagentError
							? (error as EphemeralSubagentError & { usage?: Usage }).usage
							: undefined;
						const cause = error instanceof EphemeralSubagentError ? error.cause : error;
						if (cause instanceof Error && cause.name === "WorktreeSetupError") {
							setupRecoveries.set(entry.id, cause.message);
						}
						text = capOutput(error instanceof Error ? error.message : String(error));
					}
					try {
						worktreePayload = worktree ? await finalizeChildWorktree(worktree) : undefined;
					} catch (error) {
						rejected = error;
						aborted = false;
						status = "rejected";
						text = capOutput(error instanceof Error ? error.message : String(error));
						worktreePayload = worktree ? {
							path: worktree.path,
							branch: worktree.branch,
							commits: 0,
							dirty: false,
							pruned: false,
							inspection_failed: true,
							note: capOutput(`Worktree finalization failed (${text}); commits/dirty UNKNOWN. Inspect retained work before assuming no changes.`),
						} : undefined;
					}
					if (worktreePayload?.inspection_failed) {
						const note = capOutput(worktreePayload.note ?? `Worktree inspection failed; inspect ${worktreePayload.path} before assuming no work.`);
						worktreePayload = { ...worktreePayload, note };
						rejected = new Error(note, rejected === undefined ? undefined : { cause: rejected });
						status = "rejected";
						text = capOutput(`${note}\n${text}`);
					}
					if (rejected !== undefined) status = "rejected";
					setState(status, text);
					try {
						finishWidgetItem(entry.id, aborted ? "aborted" : status === "succeeded" ? "success" : "failure");
					} catch (error) {
						rejected = error;
						status = "rejected";
						setState("rejected", capOutput(error instanceof Error ? error.message : String(error)));
						finishWidgetItem(entry.id, "failure");
					}
					if (rejected !== undefined) throw rejected;
						return child!.outcome === "success"
							? { ok: true, assistantOutput: text, result: child! }
							: { ok: false, result: child! };
					}, workflowSignal);
				} finally {
					if (workflow.mode === "chain" && (workflowSignal?.aborted
						|| [...states.values()].some(({ status }) => status === "failed" || status === "rejected"))) {
						for (const [id, state] of states) {
							if (state.status === "pending") states.set(id, { ...state, status: "skipped" });
						}
					}
				}
			};

			const recordInfrastructureFailure = (error: unknown) => {
				if ([...states.values()].some(({ status }) => status === "failed" || status === "rejected")) return;
				const target = [...states.values()].find(({ status }) => status === "pending" || status === "running")
					?? [...states.values()].at(-1)!;
				states.set(target.id, {
					id: target.id,
					index: target.index,
					role: target.role,
					...(target.model === undefined ? {} : { model: target.model }),
					...(target.thinkingLevel === undefined ? {} : { thinkingLevel: target.thinkingLevel }),
					...(target.worktreePayload === undefined ? {} : { worktreePayload: target.worktreePayload }),
					...(target.usage === undefined ? {} : { usage: target.usage }),
					status: "rejected",
					failure: capOutput(error instanceof Error ? error.message : String(error)),
				});
			};

			throwIfAborted();
			if (workflow.background) {
				const taskId = `bg-${++backgroundSequence}-${Date.now().toString(36)}`;
				const controller = new AbortController();
				// Freeze the launching session now: a task that settles after a
				// reload must not deliver into whichever session is active then.
				const launchEpoch = sessionEpoch;
				const settled = (async () => {
					try {
						// Let the acknowledgement resolve before any route, Skill, worktree,
						// permit, or child work starts.
						await new Promise<void>((resolve) => setImmediate(resolve));
						try {
							await runWorkflow(controller.signal, false);
						} catch (error) {
							if (!controller.signal.aborted) recordInfrastructureFailure(error);
						}
						reportBackground(launchEpoch, taskId, workflow.mode, [...states.values()], setupRecoveries);
					} finally {
						backgroundTasks.delete(taskId);
					}
				})();
				backgroundTasks.set(taskId, { controller, settled });
				void settled;
				const acknowledgement = capOutput([
					`Background workflow ${taskId} accepted.`,
					`Mode: ${workflow.mode}`,
					"Entries:",
					...entries.map((entry) =>
						`- [${entry.index}] id=${JSON.stringify(entry.id)} role=${JSON.stringify(entry.delegation.role)}`),
					"The aggregate outcome arrives as one message; keep working or end your turn.",
				].join("\n"));
				return {
					content: [{ type: "text" as const, text: acknowledgement }],
					details: {
						taskId,
						background: true,
						mode: workflow.mode,
						entries: entries.map((entry) => ({ id: entry.id, index: entry.index, role: entry.delegation.role })),
					},
				};
			}

			let outcomes: Awaited<ReturnType<typeof runWorkflow>>;
			try {
				outcomes = await runWorkflow(signal, true);
			} catch (error) {
				if (!signal?.aborted) throw error;
				const aborted = new WorkflowAbortedError(workflow.mode, [...states.values()], signal.reason);
				failedToolPatches.set(toolCallId, failedToolPatch(aborted));
				throw aborted;
			}
			if (outcomes.some(({ status }) => status === "failed" || status === "rejected")) {
				const failure = new WorkflowFailureError(workflow.mode, [...states.values()]);
				failedToolPatches.set(toolCallId, failedToolPatch(failure));
				throw failure;
			}
			const result = formatWorkflowResult(workflow.mode, [...states.values()]);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: result.details,
				...(result.usage === undefined ? {} : { usage: result.usage }),
			};
		},
	});
}

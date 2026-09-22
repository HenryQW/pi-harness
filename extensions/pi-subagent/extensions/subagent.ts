import { basename } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	availableTaskModels,
	loadTaskModelsConfig,
	modelReference,
	registerModelTask,
	resolveAvailableModel,
	type ResolvedTaskRoute,
	taskThinkingLevels,
} from "@henryqw/pi-task-models";
import {
	capEphemeralSubagentOutput as capOutput,
	captureWorkingCheckoutBaseline,
	captureWorkingCheckoutState,
	createEphemeralSubagentExecutor,
	DELEGATE_TASK,
	EphemeralSubagentError,
	finalizeRoleLaunch,
	formatDuration,
	loadRoles,
	prepareRoleLaunch,
	prepareWorkingChangeEvidence,
	ROLE_TOOL_POLICY_FLAG,
	sameWorkingCheckoutState,
	sameWorkingSnapshot,
	type EphemeralSubagentActivityEvent,
	type EphemeralSubagentResult,
	type EphemeralSubagentTimeout,
	type Role,
	type WorkingCheckoutBaseline,
	type WorkingCheckoutState,
} from "@henryqw/pi-subagent";
import {
	DEFAULT_EXECUTION_POLICY,
	DEFAULT_TIMEOUT_CONFIG,
	readSubagentConfig,
	resolveExecutionPolicy,
	type EffectiveExecutionPolicy,
	type SubagentTimeoutConfig,
} from "./config.ts";
import { createCheckoutAdmission, roleCanWrite } from "./admission.ts";
import { registerIsolatedExtension } from "./isolated.ts";
import { MODEL_CLASS_GUIDANCE } from "./model-class-policy.ts";
import {
	formatBackgroundWorkflowResult,
	formatWorkflowResult,
	formatWorkflowUpdate,
	presentWorkflowEntryStatus,
	WorkflowAbortedError,
	WorkflowFailureError,
	type BackgroundWorkflowTransportDetails,
	type WorkflowTransportEntry,
} from "./result-transport.ts";
import {
	DelegateTaskSchema,
	identifyWorkflowEntries,
	parseDelegateTask,
	runForegroundWorkflow,
	type Delegation,
	type ParsedWorkflow,
	type WorkflowEntry,
} from "./workflow.ts";
const WIDGET_KEY = "subagent-status";
const WIDGET_INTERVAL_MS = 80;
const MAX_WIDGET_ITEMS = 8;
const MAX_WIDGET_LINES = 6;
const MAX_WIDGET_GROUP_ROWS = 3;
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
	taskId: string;
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
	if (!ordered.length) return [];
	const groups = new Map<string, { name: string; items: WidgetItem[] }>();
	for (const item of ordered) {
		const group = groups.get(item.taskId);
		if (group) group.items.push(item);
		else groups.set(item.taskId, { name: item.name, items: [item] });
	}
	const maxVisibleLines = ordered.length + groups.size > MAX_WIDGET_LINES ? MAX_WIDGET_LINES - 1 : MAX_WIDGET_LINES;
	const workingGroups = [...groups.values()].filter(({ items }) => items.some(({ status }) => status === "working"));
	const visibleWorkingGroups = new Set(workingGroups.slice(0, Math.floor(maxVisibleLines / 2)));
	let remainingWorkingGroups = visibleWorkingGroups.size;
	const visible = new Set<WidgetItem>();
	const lines: string[] = [];
	for (const group of groups.values()) {
		const working = group.items.some(({ status }) => status === "working");
		if (working && !visibleWorkingGroups.has(group)) continue;
		const reservedLines = working ? --remainingWorkingGroups * 2 : 0;
		const childCount = Math.min(MAX_WIDGET_GROUP_ROWS, group.items.length, maxVisibleLines - lines.length - reservedLines - 1);
		if (childCount < 1) continue;
		lines.push(truncateToWidth(theme.fg("text", group.name), width));
		for (const item of group.items.slice(0, childCount)) {
			visible.add(item);
			lines.push(truncateToWidth(
				`  ${statusGlyph(item.status, spinnerIndex, theme)} ${theme.fg("accent", item.role)} ${theme.fg("text", activityLabel(item, now))} · ${theme.fg("muted", activityMetrics(item, now))}`,
				width,
			));
		}
	}
	const hidden = ordered.filter((item) => !visible.has(item));
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

function replaceRouteModel(ctx: ExtensionContext, reference: string, route: ResolvedTaskRoute): ResolvedTaskRoute {
	const models = availableTaskModels(ctx);
	const model = resolveAvailableModel(models, reference, ctx.model?.provider);
	if (!model) {
		throw new Error(`Unknown delegate_task model: ${reference}. Available models: ${models.map((candidate) => modelReference(candidate)).join(", ") || "none"}.`);
	}
	const levels = taskThinkingLevels(ctx, model);
	if (!levels.includes(route.thinkingLevel)) {
		throw new Error(`delegate_task model ${modelReference(model)} cannot use route thinking ${route.thinkingLevel} in this session. Usable levels here: ${levels.join(", ") || "none"}.`);
	}
	return { model, thinkingLevel: route.thinkingLevel };
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
		return loadRoles().map((role) => `${role.name}: ${role.description}${role.modelClass === undefined ? "" : ` (modelClass: ${role.modelClass})`}`).join("; ");
	} catch (error) {
		return `configuration error: ${error instanceof Error ? error.message : String(error)}`;
	}
};

export default function subagentExtension(
	pi: ExtensionAPI,
	overrideTimeoutPolicy?: TimeoutPolicy,
): void {
	if (process.argv.includes(`--${ROLE_TOOL_POLICY_FLAG}`)) return;
	registerModelTask(pi, DELEGATE_TASK);
	pi.registerMessageRenderer(BACKGROUND_RESULT_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as BackgroundWorkflowTransportDetails | undefined;
		const content = typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		if (!details?.entries) return new Text(content, outputPad, 0);
		const count = details.entries.length;
		const subject = count === 1 ? "Background subagent" : `${count} background subagents`;
		const state = details.recovery ? "stopped; recovery needed"
			: details.outcome === "completed" ? "completed"
				: details.outcome === "failed" ? "failed" : "stopped";
		const glyph = details.recovery || details.outcome === "aborted" ? "■" : details.outcome === "completed" ? "✓" : "✗";
		const color = details.recovery || details.outcome === "aborted" ? "warning" : details.outcome === "completed" ? "success" : "error";
		const rows = details.entries.map(({ name, role, status, summary }) => {
			const { glyph, fallback } = presentWorkflowEntryStatus(status);
			return `${glyph} ${name} · ${role} — ${details.recovery ? fallback : summary || fallback}`;
		});
		const raw = content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
		return new Text([
			theme.fg(color, `${glyph} ${subject} ${state}`),
			...rows,
			...(expanded ? ["", raw] : []),
		].join("\n"), outputPad, 0);
	});
	const widgetItems = new Map<string, WidgetItem>();
	const loadedConfig = readSubagentConfig();
	let initialPolicy: EffectiveExecutionPolicy;
	try {
		initialPolicy = resolveExecutionPolicy(loadedConfig);
	} catch {
		initialPolicy = {
			maxSubagents: DEFAULT_EXECUTION_POLICY.maxSubagents,
			maxTurns: DEFAULT_EXECUTION_POLICY.maxTurns,
			childIdleMs: DEFAULT_TIMEOUT_CONFIG.idleMinutes * 60_000,
			childMaxMs: DEFAULT_TIMEOUT_CONFIG.maxMinutes * 60_000,
			maxCorrections: DEFAULT_EXECUTION_POLICY.maxCorrections,
		};
	}
	const timeoutPolicy: TimeoutPolicy = overrideTimeoutPolicy ?? {
		idleMs: initialPolicy.childIdleMs,
		maxMs: initialPolicy.childMaxMs,
	};
	const effectiveInitialPolicy: EffectiveExecutionPolicy = {
		...initialPolicy,
		childIdleMs: timeoutPolicy.idleMs,
		childMaxMs: timeoutPolicy.maxMs ?? initialPolicy.childMaxMs,
	};
	const executor = createEphemeralSubagentExecutor({
		maxConcurrency: effectiveInitialPolicy.maxSubagents,
		maxTurns: effectiveInitialPolicy.maxTurns,
		maxTokens: effectiveInitialPolicy.maxTokens,
		timeout: timeoutPolicy,
	});
	const currentPolicy = (): EffectiveExecutionPolicy => resolveExecutionPolicy(readSubagentConfig());
	const canWrite = (input: unknown): boolean => {
		try {
			const parsed = parseDelegateTask(input);
			if (parsed.mode === "isolated") return true;
			const roles = new Map(loadRoles().map((role) => [role.name, role]));
			return parsed.workflow.delegations.some((delegation) => delegation.kind === "changeset"
				|| roleCanWrite(roles.get(delegation.role) ?? { name: delegation.role } as Role));
		} catch {
			return true;
		}
	};
	const admission = createCheckoutAdmission();
	admission.register(pi, canWrite);
	const isolatedSurface = registerIsolatedExtension(pi, {
		executor,
		policy: effectiveInitialPolicy,
		currentPolicy,
	});
	let backgroundSequence = 0;
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
		taskId: string,
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
				if (item.status === "working" || item.taskId === taskId) continue;
				widgetItems.delete(oldestId);
				if (widgetItems.size < MAX_WIDGET_ITEMS) break;
			}
		}
		widgetItems.set(id, {
			role: roleBadge(role),
			model,
			thinkingLevel: thinkingLevel ?? "default",
			taskId,
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
		const recoveries = entries.flatMap((entry) => {
			const worktree = entry.worktreePayload;
			return worktree === undefined || worktree.outcome === "pruned" ? [] : [{ entry, worktree }];
		});
		if (stale && !recoveries.length && !setupRecoveries.size) return;
		const transport = formatBackgroundWorkflowResult(mode, entries);
		const outcome: BackgroundWorkflowTransportDetails["outcome"] = stale ? "aborted" : transport.failed ? "failed" : "completed";
		const content = stale
			? capOutput([
				"Background workflow left recoverable isolated work after session shutdown.",
				`Task ID: ${taskId}`,
				`Mode: ${mode}`,
				"Recovery locations:",
				...recoveries.map(({ entry, worktree }) =>
					`- [${entry.index}] worktree path=${JSON.stringify(worktree.path)} branch=${JSON.stringify(worktree.branch)}`),
				...[...setupRecoveries].map(([id, recovery]) => {
					const entry = entries.find((candidate) => candidate.id === id)!;
					return `- [${entry.index}] setup state: ${recovery}`;
				}),
				"Evidence:",
				...recoveries.flatMap(({ entry, worktree }) => {
					const measurements = [
						...(worktree.commits === undefined ? [] : [`commits=${worktree.commits}`]),
						...(worktree.dirty === undefined ? [] : [`dirty=${worktree.dirty}`]),
					];
					return [
						`- [${entry.index}] ${worktree.outcome} worktree${measurements.length ? ` ${measurements.join(" ")}` : ""}`,
						...(worktree.outcome === "recovery" ? [`  ${worktree.note}`] : []),
					];
				}),
				...[...setupRecoveries].map(([id, recovery]) => {
					const entry = entries.find((candidate) => candidate.id === id)!;
					return `- [${entry.index}] recoverable WorktreeSetupError: ${recovery}`;
				}),
			].join("\n"))
			: transport.text;
		const details: BackgroundWorkflowTransportDetails = {
			...transport.details,
			taskId,
			outcome,
			...(transport.usage === undefined ? {} : { usage: transport.usage }),
			...(stale ? { recovery: true } : {}),
		};
		try {
			// Custom messages convert to user-role LLM messages, so the parent agent
			// sees the aggregate on its next turn without forcing one now.
			pi.sendMessage({
				customType: BACKGROUND_RESULT_TYPE,
				content,
				display: true,
				details,
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

	pi.registerTool({
		name: "delegate_task",
		label: "Subagent",
		description: `Delegate compact direct work or a durable checked isolated graph to Pi Roles. Roles: ${roleSummary()}.`,
		promptSnippet: "Delegate direct work or a checked isolated task graph",
		promptGuidelines: [
			"Keep trivial mechanically verifiable work in Main. Use mode direct for bounded research, analysis, review, or tightly coupled implementation. Use mode isolated for independently implementable checked changes, an exploratory candidate, or when Main must remain undisturbed; explicit mode never falls back.",
			"Authorize outcome, scope, exclusions, local delegation/check/review/integration, and external actions once. Scoped isolation records exact checked-candidate acceptance automatically; supervised isolation waits for /subagent-accept. Ask again only for material scope change, missing authorization, user-owned conflict, or a consequential external action.",
			"Direct requests use one compact role/name/task packet, tasks for independent packets, or chain with {previous}. Mark mutation as kind changeset and provide direct command/argv checks. Background is only for provably read-only direct work.",
			"Isolation uses typed tasks and dependencies. Keep tightly coupled changes with one owner; do not split by file count. Failures, ambiguity, limits, and conflicts retain work and never waive checks or identity guards.",
			`For delegate_task, ${MODEL_CLASS_GUIDANCE} A direct model replaces only the selected route's model; its thinking level stays unchanged.`,
		],
		parameters: DelegateTaskSchema,
		prepareArguments(args) {
			try {
				const parsed = parseDelegateTask(args);
				if (parsed.mode === "isolated") return parsed.request;
				const workflow = parsed.workflow;
				if (workflow.mode === "single") return { mode: "direct" as const, ...workflow.delegations[0], background: workflow.background };
				if (workflow.mode === "parallel") return { mode: "direct" as const, tasks: workflow.delegations, background: workflow.background };
				return { mode: "direct" as const, chain: workflow.delegations, background: workflow.background };
			} catch (error) {
				throw boundedError(error);
			}
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const throwIfAborted = (activeSignal = signal) => {
				if (activeSignal?.aborted) throw new EphemeralSubagentError("aborted", "Subagent was aborted.", activeSignal.reason);
			};
			throwIfAborted();
			let workflow: ParsedWorkflow;
			let roles: Role[];
			let policy: EffectiveExecutionPolicy;
			try {
				policy = currentPolicy();
				const parsed = parseDelegateTask(params);
				if (parsed.mode === "isolated") return await isolatedSurface.execute(parsed.request, signal, ctx);
				workflow = parsed.workflow;
				roles = loadRoles();
				const knownRoles = new Set(roles.map(({ name }) => name));
				for (const delegation of workflow.delegations) {
					for (const role of [delegation.role, delegation.judgment?.role].filter((value): value is string => value !== undefined)) {
						if (!knownRoles.has(role)) {
							throw new Error(`Unknown Subagent role: ${role}. Available roles: ${roles.map(({ name }) => name).join(", ") || "none"}.`);
						}
					}
				}
			} catch (error) {
				throw boundedError(error);
			}
			throwIfAborted();
			const reloadRole = (name: string): Role => {
				let freshRoles: Role[];
				try {
					freshRoles = loadRoles();
				} catch (error) {
					throw boundedError(new Error(
						`Couldn't reload Subagent role ${JSON.stringify(name)} after it waited for an executor permit. Fix the Role configuration and retry: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					));
				}
				const role = freshRoles.find((candidate) => candidate.name === name);
				if (role) return role;
				throw boundedError(new Error(
					`Subagent role ${JSON.stringify(name)} disappeared while waiting for an executor permit. Restore it and retry. Available roles: ${freshRoles.map(({ name: available }) => available).join(", ") || "none"}.`,
				));
			};

			// Resolve against the latest known session context after each FIFO permit.
			const launchCtx = () => latestCtx ?? ctx;
			const prepareLaunch = (role: Role, delegation: Delegation) => {
				const context = launchCtx();
				const launch = prepareRoleLaunch(pi, context, {
					role,
					task: DELEGATE_TASK,
					...(delegation.modelClass === undefined ? {} : { modelClass: delegation.modelClass }),
				});
				if (delegation.model === undefined) return launch;
				return prepareRoleLaunch(pi, context, {
					role,
					route: replaceRouteModel(context, delegation.model, launch),
				});
			};
			const roleByName = new Map(roles.map((role) => [role.name, role]));
			const canMutate = (delegation: Delegation): boolean => delegation.kind === "changeset"
				|| roleCanWrite(roleByName.get(delegation.role)!);
			const serializeWriters = workflow.delegations.some(canMutate);
			if (workflow.background && serializeWriters) {
				throw new Error("Background direct delegation is limited to text tasks whose Roles expose only known read-only tools and no extensions or MCP servers.");
			}
			const baseline: WorkingCheckoutBaseline | undefined = workflow.delegations.some(({ kind }) => kind === "changeset")
				? await captureWorkingCheckoutBaseline(ctx.cwd, signal)
				: undefined;
			const directSignal = signal;
			throwIfAborted(directSignal);
			const maybeWorkingState = async (activeSignal: AbortSignal | undefined): Promise<WorkingCheckoutState | undefined> => {
				try {
					return await captureWorkingCheckoutState(ctx.cwd, activeSignal);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (/not a git repository|rev-parse --verify HEAD failed/i.test(message)) return undefined;
					throw error;
				}
			};
			const runDirectChecks = async (
				checks: readonly { command: string; args: string[] }[],
				expected: Awaited<ReturnType<typeof prepareWorkingChangeEvidence>>["identity"],
				activeSignal: AbortSignal | undefined,
			): Promise<void> => {
				for (const check of checks) {
					throwIfAborted(activeSignal);
					const result = await pi.exec(check.command, check.args, {
						cwd: ctx.cwd,
						signal: activeSignal,
						timeout: policy.childMaxMs,
					});
					if (result.code !== 0 || result.killed) {
						const command = [check.command, ...check.args.map((arg) => JSON.stringify(arg))].join(" ");
						const diagnostic = capOutput([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"));
						throw new Error(`Direct check failed (${command})${result.killed ? " (killed)" : ` with exit ${result.code}`}${diagnostic ? `:\n${diagnostic}` : "."}`);
					}
				}
				const after = await prepareWorkingChangeEvidence(baseline!, activeSignal);
				try {
					if (!sameWorkingSnapshot(expected, after.identity)) {
						throw new Error("A direct check changed the checked working snapshot; validation is invalid and the working files were retained.");
					}
				} finally {
					await after.cleanup();
				}
			};
			const validateDirectChangeset = async (
				entry: WorkflowEntry,
				before: Awaited<ReturnType<typeof prepareWorkingChangeEvidence>>["identity"],
				activeSignal: AbortSignal | undefined,
			): Promise<void> => {
				const evidence = await prepareWorkingChangeEvidence(baseline!, activeSignal);
				try {
					if (sameWorkingSnapshot(before, evidence.identity)) {
						throw new Error(`Direct changeset ${entry.delegation.name} produced no working change; commits and worktrees are not accepted as direct evidence.`);
					}
					await runDirectChecks(entry.delegation.checks!, evidence.identity, activeSignal);
					const judgment = entry.delegation.judgment;
					if (!judgment) return;
					const reviewer = reloadRole(judgment.role);
					const prepared = prepareRoleLaunch(pi, launchCtx(), {
						role: reviewer,
						task: DELEGATE_TASK,
						modelClass: judgment.modelClass,
					});
					const result = await executor.run({
						signal: activeSignal,
						prepare: async () => ({
							launch: finalizeRoleLaunch(prepared),
							cwd: baseline!.worktree,
							task: [
								"Review this exact direct working snapshot. Do not modify any file.",
								`Patch: ${evidence.patchPath}`,
								`Raw manifest: ${evidence.rawEvidencePath}`,
								`Identity: ${JSON.stringify(evidence.identity)}`,
								`Criterion: ${judgment.criterion}`,
								"Return exactly PASS only if the supplied snapshot satisfies the criterion; otherwise return actionable findings.",
							].join("\n"),
						}),
					});
					if (result.outcome !== "success" || result.output.trim() !== "PASS") {
						throw new Error(`Direct judgment failed: ${capOutput(result.output || result.errorMessage || result.stderr || "no verdict")}`);
					}
					const after = await prepareWorkingChangeEvidence(baseline!, activeSignal);
					try {
						if (!sameWorkingSnapshot(evidence.identity, after.identity)) {
							throw new Error("The direct judgment changed the checked working snapshot; its verdict is invalid and the working files were retained.");
						}
					} finally {
						await after.cleanup();
					}
				} finally {
					await evidence.cleanup();
				}
			};
			const foregroundWorkflow: ParsedWorkflow = { ...workflow, background: false };
			const entries = identifyWorkflowEntries(toolCallId, foregroundWorkflow);
			const states = new Map<string, WorkflowTransportEntry>(entries.map((entry) => [entry.id, {
				id: entry.id,
				index: entry.index,
				name: entry.delegation.name,
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
					let model: string | undefined;
					let thinkingLevel: string | undefined;
					let child: EphemeralSubagentResult | undefined;
					let beforeChangeset: Awaited<ReturnType<typeof prepareWorkingChangeEvidence>>["identity"] | undefined;
					let beforeText: WorkingCheckoutState | undefined;
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
							name: entry.delegation.name,
							role: entry.delegation.role,
							...(model === undefined ? {} : { model }),
							...(thinkingLevel === undefined ? {} : { thinkingLevel }),
							...(usage === undefined ? {} : { usage }),
						};
						states.set(entry.id, nextStatus === "failed" || nextStatus === "rejected"
							? { ...base, status: nextStatus, failure: nextText }
							: { ...base, status: nextStatus, assistantOutput: nextText });
					};
					try {
						if (entry.delegation.kind === "changeset") {
							const before = await prepareWorkingChangeEvidence(baseline!, workflowSignal);
							try { beforeChangeset = before.identity; } finally { await before.cleanup(); }
						} else if (canMutate(entry.delegation)) {
							beforeText = await maybeWorkingState(workflowSignal);
						}
						child = await executor.run({
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
								const role = reloadRole(entry.delegation.role);
								if (workflow.background && roleCanWrite(role)) {
									throw new Error(`Role ${role.name} became writer-capable after admission; retry the direct request in the foreground.`);
								}
								const preparedLaunch = prepareLaunch(role, entry.delegation);
								model = modelReference(preparedLaunch.model);
								thinkingLevel = preparedLaunch.thinkingLevel;
								startWidgetItem(entry.id, entry.id, preparedLaunch.role, preparedLaunch.model.id, preparedLaunch.thinkingLevel, entry.delegation.name, ctx);
								setState("running", "");
								emitUpdate(emitToolUpdates);
								const boundary = entry.delegation.kind === "changeset"
									? "\n\nDirect changeset boundary: work only in this exact checkout. Leave all changes uncommitted. Do not commit, create a branch or worktree, stash, reset, clean, push, publish, or deploy."
									: "\n\nDirect text boundary: inspect only. Do not modify files, the Git index, HEAD, branches, or worktrees.";
								return { launch: finalizeRoleLaunch(preparedLaunch), task: `${entry.delegation.task}${boundary}`, cwd: ctx.cwd };
							},
						});
						if (child.outcome === "failure") {
							status = "failed";
							text = capOutput(child.errorMessage || child.stderr.trim() || child.output || `Subagent exited with code ${child.exitCode}.`);
						} else {
							status = "succeeded";
							text = child.output;
							if (entry.delegation.kind === "changeset") {
								await validateDirectChangeset(entry, beforeChangeset!, workflowSignal);
							} else if (beforeText) {
								const afterText = await maybeWorkingState(workflowSignal);
								if (!afterText || !sameWorkingCheckoutState(beforeText, afterText)) {
									throw new Error("A direct text task unexpectedly changed the checkout; the changes were retained and the task did not pass.");
								}
							}
						}
					} catch (error) {
						rejected = error;
						aborted = error instanceof EphemeralSubagentError && error.code === "aborted";
						rejectedUsage = error instanceof EphemeralSubagentError
							? (error as EphemeralSubagentError & { usage?: Usage }).usage
							: undefined;
						text = capOutput(error instanceof Error ? error.message : String(error));
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
					}, workflowSignal, serializeWriters);
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
					name: target.name,
					role: target.role,
					...(target.model === undefined ? {} : { model: target.model }),
					...(target.thinkingLevel === undefined ? {} : { thinkingLevel: target.thinkingLevel }),
					...(target.worktreePayload === undefined ? {} : { worktreePayload: target.worktreePayload }),
					...(target.usage === undefined ? {} : { usage: target.usage }),
					status: "rejected",
					failure: capOutput(error instanceof Error ? error.message : String(error)),
				});
			};

			throwIfAborted(directSignal);
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
						const backgroundSignal = directSignal
							? AbortSignal.any([controller.signal, directSignal])
							: controller.signal;
						try {
							await runWorkflow(backgroundSignal, false);
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
				const title = workflow.mode === "single" ? "Background delegation"
					: workflow.mode === "parallel" ? "Background parallel delegation" : "Background delegation chain";
				const acknowledgement = capOutput([
					`${title} started${entries.length === 1 ? "" : ` · ${entries.length} tasks`}`,
					...entries.map((entry, index) =>
						`○ [${index + 1}/${entries.length}] ${entry.delegation.name} · ${entry.delegation.role}`),
					"Results will arrive in one message.",
				].join("\n"));
				return {
					content: [{ type: "text" as const, text: acknowledgement }],
					details: {
						taskId,
						background: true,
						mode: workflow.mode,
						entries: entries.map((entry) => ({ id: entry.id, index: entry.index, name: entry.delegation.name, role: entry.delegation.role })),
					},
				};
			}

			let outcomes: Awaited<ReturnType<typeof runWorkflow>>;
			try {
				outcomes = await runWorkflow(directSignal, true);
			} catch (error) {
				if (!directSignal?.aborted) throw error;
				const aborted = new WorkflowAbortedError(workflow.mode, [...states.values()], directSignal.reason);
				failedToolPatches.set(toolCallId, failedToolPatch(aborted));
				throw aborted;
			}
			if (outcomes.some(({ status }) => status === "failed" || status === "rejected")) {
				const failure = new WorkflowFailureError(workflow.mode, [...states.values()]);
				failedToolPatches.set(toolCallId, failedToolPatch(failure));
				throw failure;
			}
			if (baseline) {
				const finalEvidence = await prepareWorkingChangeEvidence(baseline, directSignal);
				try {
					const finalChecks = workflow.delegations.flatMap(({ kind, checks }) => kind === "changeset" ? checks! : []);
					await runDirectChecks(finalChecks, finalEvidence.identity, directSignal);
				} finally {
					await finalEvidence.cleanup();
				}
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

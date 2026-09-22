import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { availableTaskModels, loadTaskModelsConfig, modelReference, registerModelTask, resolveAvailableModel, type ResolvedTaskRoute, taskThinkingLevels } from "@henryqw/pi-task-models";
import { capEphemeralSubagentOutput as capOutput, createEphemeralSubagentExecutor, DELEGATE_TASK, formatDuration, loadRoles, prepareRoleLaunch, finalizeRoleLaunch, ROLE_TOOL_POLICY_FLAG, type EphemeralSubagentTimeout, type Role } from "@henryqw/pi-subagent";
import { DEFAULT_EXECUTION_POLICY, DEFAULT_TIMEOUT_CONFIG, readSubagentConfig, resolveExecutionPolicy, type EffectiveExecutionPolicy, type SubagentTimeoutConfig } from "./config.ts";
import { createCheckoutAdmission, roleCanWrite } from "./admission.ts";
import { registerIsolatedExtension } from "./isolated.ts";
import { MODEL_CLASS_GUIDANCE } from "./model-class-policy.ts";
import { formatWorkflowResult, presentWorkflowEntryStatus, type BackgroundWorkflowTransportDetails, type WorkflowTransportEntry } from "./result-transport.ts";
import { DelegateTaskSchema, identifyWorkflowEntries, parseDelegateTask, runForegroundWorkflow, type Delegation, type ParsedWorkflow, type WorkflowEntry } from "./workflow.ts";
import { createDirectHerdr, type DirectHandle } from "../src/direct-herdr.ts";
const WIDGET_KEY = "subagent-status";
const WIDGET_INTERVAL_MS = 80;
const MAX_WIDGET_ITEMS = 8;
const MAX_WIDGET_LINES = 6;
const MAX_WIDGET_GROUP_ROWS = 3;
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
type WidgetItem = {
	role: string;
	model: string;
	thinkingLevel: string;
	taskId: string;
	name: string;
	startedAt: number;
	status: WidgetStatus;
	finishedAt?: number;
};

function roleBadge(role: string): string {
	const initial = Array.from(role)[0]!.toUpperCase();
	return `[${Array.from(initial)[0]!}]`;
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

function activityLabel(item: WidgetItem): string {
	if (item.status === "success") return "Done";
	if (item.status === "failure") return "Failed";
	if (item.status === "aborted") return "Stopped";
	return "working…";
}

function activityMetrics(item: WidgetItem, now: number): string {
	return `${item.model}·${item.thinkingLevel} · ${formatDuration((item.finishedAt ?? now) - item.startedAt)}`;
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
				`  ${statusGlyph(item.status, spinnerIndex, theme)} ${theme.fg("accent", item.role)} ${theme.fg("text", activityLabel(item))} · ${theme.fg("muted", activityMetrics(item, now))}`,
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

const DIRECT_RESULT_TYPE = "subagent-direct-result";

function boundedError(error: unknown): Error {
	const message = capOutput(error instanceof Error ? error.message : String(error));
	return error instanceof Error && error.message === message ? error : new Error(message, { cause: error });
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
	pi.registerMessageRenderer(DIRECT_RESULT_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as BackgroundWorkflowTransportDetails | undefined;
		const content = typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		if (!details?.entries) return new Text(content, outputPad, 0);
		const count = details.entries.length;
		const subject = count === 1 ? "Direct subagent" : `${count} direct subagents`;
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
	let directSequence = 0;
	const directTasks = new Map<string, { controller: AbortController; settled: Promise<void>; handles: DirectHandle[] }>();
	let latestCtx: ExtensionContext | undefined;
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
			startedAt: Date.now(),
			status: "working",
		});
		startWidgetTimer();
		requestWidgetRender();
	};

	const finishWidgetItem = (id: string, status: Exclude<WidgetStatus, "working">) => {
		const item = widgetItems.get(id);
		if (!item) return;
		item.status = status;
		item.finishedAt = Date.now();
		if (![...widgetItems.values()].some(({ status }) => status === "working")) stopWidgetTimer();
		requestWidgetRender();
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionEpoch += 1;
		if (latestCtx) {
			const previous = [...directTasks.values()];
			for (const { controller, handles } of previous) {
				controller.abort();
				await Promise.allSettled(handles.map((handle) => handle.cancel()));
			}
			await Promise.allSettled(previous.map(({ settled }) => settled));
		}
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
		stopWidgetTimer();
		widgetItems.clear();
		activeTui = undefined;
		widgetInstalled = false;
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		// Invalidate ordinary outcomes, abort children, then let preserved isolated
		// work report into the outgoing session before Pi tears it down.
		sessionEpoch += 1;
		const tasks = [...directTasks.values()];
		for (const { controller, handles } of tasks) {
			controller.abort();
			await Promise.allSettled(handles.map((handle) => handle.cancel()));
		}
		await Promise.allSettled(tasks.map(({ settled }) => settled));
		directTasks.clear();
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

	const reportDirect = (
		launchEpoch: number,
		taskId: string,
		mode: ParsedWorkflow["mode"],
		entries: readonly WorkflowTransportEntry[],
	): void => {
		const stale = launchEpoch !== sessionEpoch;
		if (stale) return;
		const transport = formatWorkflowResult(mode, entries);
		const outcome: BackgroundWorkflowTransportDetails["outcome"] = transport.failed ? "failed" : "completed";
		const content = transport.text;
		const details: BackgroundWorkflowTransportDetails = {
			...transport.details,
			taskId,
			outcome,
			...(transport.usage === undefined ? {} : { usage: transport.usage }),
		};
		try {
			// Queue behind the current turn, then trigger one follow-up turn.
			pi.sendMessage({
				customType: DIRECT_RESULT_TYPE,
				content,
				display: true,
				details,
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch (error) {
			// Delivery can disappear during teardown; only an active UI gets a visible failure.
			if (latestCtx?.hasUI) {
				latestCtx.ui.notify(boundedError(new Error(
					`Direct workflow ${taskId} result delivery failed: ${error instanceof Error ? error.message : String(error)}`,
				)).message, "error");
			}
		}
	};

	pi.registerTool({
		name: "delegate_task",
		label: "Subagent",
		description: `Delegate read-only direct work in Herdr or a durable checked isolated graph to Pi Roles. Roles: ${roleSummary()}.`,
		promptSnippet: "Delegate read-only direct work or a checked isolated task graph",
		promptGuidelines: [
			"Keep trivial mechanically verifiable work in Main. Use mode direct only for read-only research, analysis, or review in the current workspace. Use mode isolated for any implementation, write-capable Role, or checked changeset; explicit mode never falls back.",
			"Direct requests use one compact role/name/task packet, tasks for independent packets, or chain with {previous}. Direct work returns a Herdr handle after launch; results arrive as one follow-up message.",
			"Isolation uses typed tasks and dependencies. Keep tightly coupled changes with one owner; do not split by file count. Failures, ambiguity, limits, and conflicts retain work and never waive checks or identity guards.",
			`For delegate_task, ${MODEL_CLASS_GUIDANCE} A direct model replaces only the selected route's model; its thinking level stays unchanged.`,
		],
		parameters: DelegateTaskSchema,
		prepareArguments(args) {
			try {
				const parsed = parseDelegateTask(args);
				if (parsed.mode === "isolated") return parsed.request;
				const workflow = parsed.workflow;
				if (workflow.mode === "single") return { mode: "direct" as const, ...workflow.delegations[0] };
				if (workflow.mode === "parallel") return { mode: "direct" as const, tasks: workflow.delegations };
				return { mode: "direct" as const, chain: workflow.delegations };
			} catch (error) { throw boundedError(error); }
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const parsed = parseDelegateTask(params);
			if (parsed.mode === "isolated") return await isolatedSurface.execute(parsed.request, signal, ctx);
			const workflow = parsed.workflow;
			const roles = new Map(loadRoles().map((role) => [role.name, role]));
			for (const delegation of workflow.delegations) {
				const role = roles.get(delegation.role);
				if (!role) throw boundedError(new Error(`Unknown Subagent role: ${delegation.role}. Available roles: ${[...roles.keys()].join(", ") || "none"}.`));
				if (roleCanWrite(role)) throw new Error(`Role ${role.name} exposes write-capable or unverified resources. Use mode isolated for this Role; direct is read-only.`);
			}
			const policy = currentPolicy();
			const herdr = createDirectHerdr(pi, ctx.cwd);
			const entries = identifyWorkflowEntries(toolCallId, workflow);
			const states = new Map<string, WorkflowTransportEntry>(entries.map((entry) => [entry.id, {
				id: entry.id, index: entry.index, name: entry.delegation.name, role: entry.delegation.role, status: "pending",
			}]));
			const taskId = `direct-${++directSequence}-${Date.now().toString(36)}`;
			const controller = new AbortController();
			const launchEpoch = sessionEpoch;
			const handles: DirectHandle[] = [];
			const handleByEntry = new Map<string, DirectHandle>();
			const launch = async (entry: WorkflowEntry, activeSignal: AbortSignal) => {
				activeSignal.throwIfAborted();
				const role = loadRoles().find((candidate) => candidate.name === entry.delegation.role);
				if (!role || roleCanWrite(role)) throw new Error(`Role ${entry.delegation.role} disappeared or became write-capable; use mode isolated.`);
				const context = latestCtx ?? ctx;
				const route = prepareRoleLaunch(pi, context, { role, task: DELEGATE_TASK,
					...(entry.delegation.modelClass === undefined ? {} : { modelClass: entry.delegation.modelClass }) });
				const prepared = entry.delegation.model === undefined ? route : prepareRoleLaunch(pi, context, {
					role, route: replaceRouteModel(context, entry.delegation.model, route),
				});
				const base = states.get(entry.id)!;
				states.set(entry.id, { id: base.id, index: base.index, name: base.name, role: base.role,
				model: modelReference(prepared.model), thinkingLevel: prepared.thinkingLevel, status: "running", assistantOutput: "" });
				startWidgetItem(entry.id, taskId, role.name, prepared.model.id, prepared.thinkingLevel, entry.delegation.name, ctx);
				const handle = await herdr.start(finalizeRoleLaunch(prepared), `d-${randomUUID().replaceAll("-", "").slice(0, 24)}`, entry.delegation.name, entry.delegation.task, activeSignal);
				handles.push(handle);
				handleByEntry.set(entry.id, handle);
				return handle;
			};
			// The first tab is verified before returning a handle; subsequent independent
			// entries launch asynchronously and retain chain/parallel dependency semantics.
			let first: DirectHandle;
			const abortLaunch = () => controller.abort(signal?.reason);
			signal?.addEventListener("abort", abortLaunch, { once: true });
			try { first = await launch(workflow.mode === "chain" ? {
				...entries[0]!, delegation: { ...entries[0]!.delegation, task: entries[0]!.delegation.task.replaceAll("{previous}", "") },
			} : entries[0]!, controller.signal); }
			catch (error) { controller.abort(); finishWidgetItem(entries[0]!.id, "failure"); throw boundedError(error); }
			finally { signal?.removeEventListener("abort", abortLaunch); }
			if (launchEpoch !== sessionEpoch || controller.signal.aborted) {
				await first.cancel();
				throw new Error(`Launching session changed during direct start; inspect Herdr tab ${first.tabId}.`);
			}
			const settled = (async () => {
				try {
					await new Promise<void>((resolve) => setImmediate(resolve));
					let active = 0;
					const queue: Array<() => void> = [];
					const permit = async () => {
						if (active >= policy.maxSubagents) await new Promise<void>((resolve) => queue.push(resolve));
						active++;
						return () => { active--; queue.shift()?.(); };
					};
					await runForegroundWorkflow<string>(toolCallId, workflow, async (entry) => {
						const release = await permit();
						try {
							controller.signal.throwIfAborted();
							const handle = entry.index === 0 ? first : await launch(entry, controller.signal);
							const answer = await handle.answer(Math.floor(40 * 1024 / entries.length));
							const base = states.get(entry.id)!;
							states.set(entry.id, { id: base.id, index: base.index, name: base.name, role: base.role,
								...(base.model ? { model: base.model } : {}), ...(base.thinkingLevel ? { thinkingLevel: base.thinkingLevel } : {}),
								status: "succeeded", assistantOutput: answer });
							finishWidgetItem(entry.id, "success");
							return { ok: true, assistantOutput: answer, result: answer };
						} catch (error) {
							const base = states.get(entry.id)!;
							states.set(entry.id, { id: base.id, index: base.index, name: base.name, role: base.role,
								...(base.model ? { model: base.model } : {}), ...(base.thinkingLevel ? { thinkingLevel: base.thinkingLevel } : {}),
								status: "rejected", failure: capOutput(`${error instanceof Error ? error.message : String(error)}${handleByEntry.has(entry.id) ? `; recover from Herdr tab ${handleByEntry.get(entry.id)!.tabId} or ${handleByEntry.get(entry.id)!.sessionFile}` : ""}`) });
							finishWidgetItem(entry.id, "failure");
							throw error;
						} finally { release(); }
					}, controller.signal);
				} catch (error) {
					if (!controller.signal.aborted) {
						const state = [...states.values()].find(({ status }) => status === "running" || status === "pending");
						if (state) states.set(state.id, { id: state.id, index: state.index, name: state.name, role: state.role, status: "rejected", failure: capOutput(String(error)) });
					}
				} finally {
					for (const [id, state] of states) {
						if (state.status === "pending" || state.status === "running") states.set(id, {
							id: state.id, index: state.index, name: state.name, role: state.role,
							status: "skipped",
						});
					}
					if (!controller.signal.aborted) reportDirect(launchEpoch, taskId, workflow.mode, [...states.values()]);
					directTasks.delete(taskId);
				}
			})();
			directTasks.set(taskId, { controller, settled, handles });
			return {
				content: [{ type: "text" as const, text: capOutput(`Direct delegation started · ${taskId}\nHerdr tab: ${first.tabId} · agent: ${first.name}\nExact session: ${first.sessionFile}\n${entries.length} task(s); result will arrive in one follow-up message.`) }],
				details: { taskId, mode: workflow.mode, tabId: first.tabId, sessionFile: first.sessionFile,
					entries: entries.map(({ id, index, delegation }) => ({ id, index, name: delegation.name, role: delegation.role })) },
			};
		},
	});
}

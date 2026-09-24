import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { availableTaskModels, loadTaskModelsConfig, modelReference, registerModelTask, resolveAvailableModel, type ResolvedTaskRoute, taskThinkingLevels } from "@henryqw/pi-task-models";
import { capEphemeralSubagentOutput as capOutput, createEphemeralSubagentExecutor, DELEGATE_TASK, formatDuration, loadRoles, prepareRoleLaunch, ROLE_TOOL_POLICY_FLAG, type EphemeralSubagentTimeout, type Role } from "@henryqw/pi-subagent";
import { DEFAULT_EXECUTION_POLICY, DEFAULT_TIMEOUT_CONFIG, readSubagentConfig, resolveExecutionPolicy, type EffectiveExecutionPolicy } from "./config.ts";
import { createCheckoutAdmission, roleCanWrite } from "./admission.ts";
import { registerIsolatedExtension } from "./isolated.ts";
import { registerSubagentCommand, type DirectTask } from "./subagent-command.ts";
import { MODEL_CLASS_GUIDANCE } from "./model-class-policy.ts";
import { formatWorkflowResult, presentWorkflowEntryStatus, type BackgroundWorkflowTransportDetails, type WorkflowTransportEntry } from "./result-transport.ts";
import { DelegateTaskSchema, identifyWorkflowEntries, parseDelegateTask, runForegroundWorkflow, type Delegation, type ParsedWorkflow, type WorkflowEntry } from "./workflow.ts";
import { createDirectHerdr, type DirectHandle, type DirectTab } from "../dist/direct-herdr.js";
import { materializeTransientLaunch } from "../dist/launch-runtime.js";
const WIDGET_KEY = "subagent-status";
const WIDGET_INTERVAL_MS = 1_000;
const MAX_WIDGET_ITEMS = 8;
const MAX_WIDGET_LINES = 6;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type TimeoutPolicy = EphemeralSubagentTimeout;
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
	tokens?: number;
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

function tokenLabel(tokens: number | undefined): string {
	return tokens === undefined ? "— tok" : `${tokens < 1_000 ? tokens : `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`} tok`;
}

function renderWidgetRows(
	items: WidgetItem[],
	width: number,
	now: number,
	spinnerIndex: number,
	theme: Theme,
): string[] {
	const ordered = [...items].sort((a, b) =>
		(a.status === "failure" ? 0 : a.status === "working" ? 1 : 2)
		- (b.status === "failure" ? 0 : b.status === "working" ? 1 : 2));
	const visible = ordered.slice(0, ordered.length > MAX_WIDGET_LINES ? MAX_WIDGET_LINES - 1 : MAX_WIDGET_LINES);
	const lines = visible.map((item) => {
		const prefix = `${statusGlyph(item.status, spinnerIndex, theme)} ${theme.fg("accent", `D ${item.role}`)} ${item.status === "working" ? "" : `${statusLabel(item.status)} · `}`;
		const metrics = [
			`${item.model}/${item.thinkingLevel}`,
			tokenLabel(item.tokens),
			formatDuration((item.finishedAt ?? now) - item.startedAt),
		];
		while (metrics.length && width - visibleWidth(prefix) - visibleWidth(` · ${metrics.join(" · ")}`) < 8) {
			if (metrics.length === 2) metrics.shift(); // Preserve measured tokens ahead of route details.
			else metrics.pop();
		}
		const suffix = metrics.length ? ` · ${theme.fg("muted", metrics.join(" · "))}` : "";
		const name = truncateToWidth(theme.fg("text", item.name), Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix)));
		return truncateToWidth(`${prefix}${name}${suffix}`, width);
	});
	const hidden = ordered.slice(visible.length);
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
const DIRECT_TAB_TYPE = "subagent-direct-tab";
type DirectTabRecord = DirectTab & { taskId: string; entryId: string };

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
		const details = message.details as (BackgroundWorkflowTransportDetails & { tabs?: readonly DirectTabRecord[] }) | undefined;
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
			...(details.tabs?.length ? ["Recovery: /subagent (exact tabs and sessions)"] : []),
			...(expanded ? ["", raw] : []),
		].join("\n"), outputPad, 0);
	});
	const widgetItems = new Map<string, WidgetItem>();
	const tokenHandles = new Map<string, DirectHandle>();
	const samplingTokens = new Set<string>();
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
			return parsed.workflow.delegations.some((delegation) => roleCanWrite(roles.get(delegation.role) ?? { name: delegation.role } as Role));
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
	const directTasks = new Map<string, { controller: AbortController; settled: Promise<void>; handles: DirectHandle[]; tabs: DirectTabRecord[] }>();
	let latestCtx: ExtensionContext | undefined;
	let sessionEpoch = 0;
	registerSubagentCommand(pi, {
		direct(ctx): DirectTask[] {
			const grouped = new Map<string, DirectTask & { tabs: Array<DirectTask["tabs"][number]> }>();
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== DIRECT_TAB_TYPE || !entry.data) continue;
				const tab = entry.data as DirectTabRecord;
				const observed = directTasks.has(tab.taskId);
				const existing = grouped.get(tab.taskId);
				const record = { entryId: tab.entryId, name: tab.name, tabId: tab.tabId, paneId: tab.paneId, sessionFile: tab.sessionFile };
				if (existing) {
					if (!existing.tabs.some((item) => item.tabId === tab.tabId)) existing.tabs.push(record);
				} else grouped.set(tab.taskId, { id: tab.taskId, name: tab.name, status: observed ? "observed locally" : "recorded (not observed)", tabs: [record] });
			}
			return [...grouped.values()];
		},
		isolated: (cwd) => isolatedSurface.inventory(cwd),
		inspect: (root, id) => isolatedSurface.inspect(root, id),
		canFollowup: (root, id, task) => isolatedSurface.canFollowup(root, id, task),
		enqueue: (root, id, task, text, current) => isolatedSurface.enqueue(root, id, task, text, current),
		drain: (root, id, task, current) => isolatedSurface.drain(root, id, task, current),
		epoch: () => sessionEpoch,
	});
	let widgetInstalled = false;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerIndex = 0;
	let widgetTicks = 0;
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
			if (++widgetTicks % 2 !== 0) return;
			for (const [id, handle] of tokenHandles) {
				if (samplingTokens.has(id)) continue;
				samplingTokens.add(id);
				void handle.usageTokens().then((tokens) => {
					const item = widgetItems.get(id);
					if (tokens !== undefined && item?.status === "working" && tokenHandles.get(id) === handle) {
						item.tokens = tokens;
						requestWidgetRender();
					}
				}).catch(() => { /* Usage is optional; never interrupt work for telemetry. */ })
					.finally(() => samplingTokens.delete(id));
			}
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
		tokenHandles.delete(id);
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
			// A switch discards the old session's ordinary follow-up. Carry exact
			// recovery identities into the new branch as well as the original one.
			const recorded = new Set(ctx.sessionManager.getBranch().flatMap((entry) =>
				entry.type === "custom" && entry.customType === DIRECT_TAB_TYPE && entry.data
					? [(entry.data as DirectTabRecord).tabId] : []));
			for (const { tabs } of previous) for (const tab of tabs) {
				if (!recorded.has(tab.tabId)) {
					pi.appendEntry(DIRECT_TAB_TYPE, tab);
					recorded.add(tab.tabId);
				}
			}
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
		tokenHandles.clear();
		samplingTokens.clear();
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
		tabs: readonly DirectTabRecord[],
	): void => {
		const stale = launchEpoch !== sessionEpoch;
		if (stale) return;
		const transport = formatWorkflowResult(mode, entries);
		const outcome: BackgroundWorkflowTransportDetails["outcome"] = transport.failed ? "failed" : "completed";
		const content = [transport.text, ...(tabs.length ? ["Recovery (also available via /subagent):", ...tabs.map(({ taskId, entryId, name, tabId, paneId, sessionFile }) =>
			`- ${taskId} · ${entryId} · tab ${tabId} · pane ${paneId} · agent ${name} · session ${sessionFile}`)] : [])].join("\n");
		const details: BackgroundWorkflowTransportDetails & { tabs: readonly DirectTabRecord[] } = {
			...transport.details,
			taskId,
			outcome,
			tabs: [...tabs],
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
			const herdr = createDirectHerdr(pi, ctx.cwd, policy.childIdleMs);
			const entries = identifyWorkflowEntries(toolCallId, workflow);
			const states = new Map<string, WorkflowTransportEntry>(entries.map((entry) => [entry.id, {
				id: entry.id, index: entry.index, name: entry.delegation.name, role: entry.delegation.role, status: "pending",
			}]));
			const taskId = `direct-${++directSequence}-${Date.now().toString(36)}`;
			const controller = new AbortController();
			const launchEpoch = sessionEpoch;
			const handles: DirectHandle[] = [];
			const tabs: DirectTabRecord[] = [];
			const tabByEntry = new Map<string, DirectTabRecord>();
			let resolveSettled!: () => void;
			const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
			// Register before Herdr can create a tab: session switches must await this
			// launch, including its identity callback, before copying recovery records.
			directTasks.set(taskId, { controller, settled, handles, tabs });
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
				const transient = await materializeTransientLaunch({ launch: prepared, prompt: prepared.systemPrompt,
					promptArgIndex: prepared.promptArgIndex }, activeSignal);
				let handle: DirectHandle;
				try {
					handle = await herdr.start({ ...prepared, args: [...transient.launch.args] },
						`d-${randomUUID().replaceAll("-", "").slice(0, 24)}`, entry.delegation.name, entry.delegation.task, activeSignal, (tab) => {
							const record = { taskId, entryId: entry.id, ...tab };
							// Persist before agent start, including launches interrupted by a session switch.
							pi.appendEntry(DIRECT_TAB_TYPE, record);
							tabs.push(record);
							tabByEntry.set(entry.id, record);
						});
				} catch (error) {
					// A failed start can still be in flight. Keep its private prompt for recovery.
					throw new Error(`${error instanceof Error ? error.message : String(error)}. Direct Role prompt retained at ${transient.launch.args[prepared.promptArgIndex + 1]} after uncertain start.`, { cause: error });
				}
				await transient.cleanup();
				handles.push(handle);
				if (widgetItems.has(entry.id)) tokenHandles.set(entry.id, handle);
				return handle;
			};
			// The first tab is verified before returning a handle; subsequent independent
			// entries launch asynchronously and retain chain/parallel dependency semantics.
			let first: DirectHandle;
			const abortLaunch = () => controller.abort(signal?.reason);
			signal?.addEventListener("abort", abortLaunch, { once: true });
			try {
				first = await launch(workflow.mode === "chain" ? {
					...entries[0]!, delegation: { ...entries[0]!.delegation, task: entries[0]!.delegation.task.replaceAll("{previous}", "") },
				} : entries[0]!, controller.signal);
				if (launchEpoch !== sessionEpoch || controller.signal.aborted) {
					await first.cancel();
					throw new Error(`Launching session changed during direct start; inspect Herdr tab ${first.tabId}.`);
				}
			} catch (error) {
				controller.abort();
				finishWidgetItem(entries[0]!.id, "failure");
				directTasks.delete(taskId);
				resolveSettled();
				throw boundedError(error);
			} finally { signal?.removeEventListener("abort", abortLaunch); }
			void (async () => {
				try {
					await new Promise<void>((resolve) => setImmediate(resolve));
					let active = 0;
					const queue: Array<() => void> = [];
					const permit = async () => {
						if (active >= policy.maxSubagents) await new Promise<void>((resolve) => queue.push(resolve));
						active++;
						return () => { active--; queue.shift()?.(); };
					};
					await runForegroundWorkflow(workflow.mode, entries, async (entry) => {
						const release = await permit();
						try {
							controller.signal.throwIfAborted();
							const handle = entry.index === 0 ? first : await launch(entry, controller.signal);
							const answer = await handle.answer(Math.floor(40 * 1024 / entries.length));
							try {
								const tokens = await handle.usageTokens();
								if (tokens !== undefined && widgetItems.has(entry.id)) widgetItems.get(entry.id)!.tokens = tokens;
							} catch { /* Optional telemetry. */ }
							const base = states.get(entry.id)!;
							states.set(entry.id, { id: base.id, index: base.index, name: base.name, role: base.role,
								...(base.model ? { model: base.model } : {}), ...(base.thinkingLevel ? { thinkingLevel: base.thinkingLevel } : {}),
								status: "succeeded", assistantOutput: answer });
							finishWidgetItem(entry.id, "success");
							return answer;
						} catch (error) {
							const base = states.get(entry.id)!;
							states.set(entry.id, { id: base.id, index: base.index, name: base.name, role: base.role,
								...(base.model ? { model: base.model } : {}), ...(base.thinkingLevel ? { thinkingLevel: base.thinkingLevel } : {}),
								status: "rejected", failure: `${tabByEntry.has(entry.id) ? `recover from Herdr tab ${tabByEntry.get(entry.id)!.tabId}, agent ${tabByEntry.get(entry.id)!.name}, session ${tabByEntry.get(entry.id)!.sessionFile}: ` : ""}${capOutput(error instanceof Error ? error.message : String(error))}` });
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
					if (!controller.signal.aborted) reportDirect(launchEpoch, taskId, workflow.mode, [...states.values()], tabs);
					directTasks.delete(taskId);
					resolveSettled();
				}
			})();
			return {
				content: [{ type: "text" as const, text: capOutput(`Direct delegation started · ${taskId}\nHerdr tab: ${first.tabId} · pane: ${first.paneId} · agent: ${first.name}\nExact session: ${first.sessionFile}\nAll launched tabs: /subagent (on this session branch).\n${entries.length} task(s); result will arrive in one follow-up message.`) }],
				details: { taskId, mode: workflow.mode, tabId: first.tabId, sessionFile: first.sessionFile,
					entries: entries.map(({ id, index, delegation }) => ({ id, index, name: delegation.name, role: delegation.role })) },
			};
		},
	});
}

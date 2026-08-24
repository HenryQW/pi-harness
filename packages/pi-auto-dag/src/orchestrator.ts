import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listManagedSubagents, loadRoles, resolveRoleLaunch, type ResolveRoleLaunchInput, type ResolvedRoleLaunch } from "@henryqw/pi-subagent";
import { errorMessage, runCommand, type CommandRunner } from "./command.ts";
import { isRetryableFinalGate, requiredGateCommandAmendmentRequest, retryableFinalGate } from "./final-gate.ts";
import { deriveDependencyWaves, FINAL_CHECK_ID, hashDeliveryGraph, parseDeliveryGraph } from "./graph.ts";
import { assertSameLocalRunBoundary, preflightLocalRun, type LocalRunPreflight } from "./intake.ts";
import { createCoreLifecycle, type CoreLifecycle } from "./lifecycle.ts";
import { actionTicketPath, readActionTicket, readWorkerReceipt, type ReviewTicketScope } from "./review-ticket.ts";
import type { DeliveryGraph, ProjectConfig, RunState, WorkerEnvelope } from "./model.ts";
import { parseWorkerEnvelope } from "./orchestration.ts";
import { nonEmptyString } from "./validate.ts";
import { createWorkerLaunch, workerHost, workerHostOptions, type RoleLaunchResolver, type WorkerRole } from "./worker.ts";

export const ORCHESTRATOR_TOOLS = {
	execute: "auto_dag_execute",
	status: "auto_dag_status",
	resume: "auto_dag_resume",
	retryGate: "auto_dag_retry_gate",
	resolve: "auto_dag_resolve",
	abort: "auto_dag_abort",
} as const;

export interface OrchestratorExtensionOptions {
	lifecycle?: CoreLifecycle;
	runner?: CommandRunner;
}

const WORKER_WIDGET = "auto-dag-workers";
const ORCHESTRATOR_TOOL_NAMES = new Set<string>(Object.values(ORCHESTRATOR_TOOLS));
const DELIVERY_GRAPH_PARAMETERS = Type.Object({
	graph: Type.Object({
		id: Type.String({ minLength: 1, pattern: "^[a-z](?:[a-z0-9]*)(?:-[a-z0-9]+)*$" }),
		goal: Type.String({ minLength: 1 }),
		constraints: Type.Array(Type.String({ minLength: 1 })),
		non_goals: Type.Array(Type.String({ minLength: 1 })),
		issues: Type.Array(Type.Object({
			id: Type.String({ minLength: 1, pattern: "^[a-z](?:[a-z0-9]*)(?:-[a-z0-9]+)*$" }),
			title: Type.String({ minLength: 1 }),
			objective: Type.String({ minLength: 1 }),
			acceptance: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			testing: Type.String({ minLength: 1 }),
			depends_on: Type.Array(Type.String({ minLength: 1 })),
		}, { additionalProperties: false }), { minItems: 1 }),
		final_check: Type.Object({
			acceptance: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			testing: Type.String({ minLength: 1 }),
		}, { additionalProperties: false }),
	}, { additionalProperties: false }),
}, { additionalProperties: false });

function quotedConfirmationValue(value: string): string {
	return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`);
}

/** The main integration extension exposes the public lifecycle surface and nothing else. */
export function createOrchestratorExtension(options: OrchestratorExtensionOptions = {}) {
	const runner = options.runner ?? runCommand;
	return (pi: ExtensionAPI) => {
		let liveContext: ExtensionContext | undefined;
		const resolveFor = (ctx: ExtensionContext, input: ResolveRoleLaunchInput): ResolvedRoleLaunch => {
			const launch = resolveRoleLaunch(pi, ctx, input);
			if (launch.missingSkills.length) {
				ctx.ui.notify(`Subagent Role ${input.role.name} skipped unavailable Skills: ${launch.missingSkills.join(", ")}`, "warning");
			}
			return launch;
		};
		const resolveLaunch: RoleLaunchResolver = (input) => {
			if (!liveContext) throw new Error("Auto DAG launch context is unavailable");
			return resolveFor(liveContext, input);
		};
		const lifecycle = options.lifecycle ?? createCoreLifecycle({
			mainPane: () => process.env.HERDR_PANE_ID,
			resolveLaunch,
		});
		let state: RunState | undefined;
		let liveAgents: Map<string, string> | undefined;
		let pendingHandoffs = new Set<string>();
		let widgetVisible = true;
		const dismissedWidgetEntries = new Set<string>();
		let renderingTimer: ReturnType<typeof setInterval> | undefined;
		let herdrTimer: ReturnType<typeof setInterval> | undefined;
		let readingHerdr = false;
		let herdrGeneration = 0;
		let notificationFlush: Promise<void> = Promise.resolve();
		const syncActiveTools = (): void => {
			const autoDagTools = state
				? [ORCHESTRATOR_TOOLS.status, ORCHESTRATOR_TOOLS.resume,
					...(isRetryableFinalGate(state) ? [ORCHESTRATOR_TOOLS.retryGate] : []),
					...(["aborted", "completed"].includes(state.phase) ? [] : [ORCHESTRATOR_TOOLS.abort]),
					...(hasActivePhaseBlock(state) ? [ORCHESTRATOR_TOOLS.resolve] : [])]
				: [ORCHESTRATOR_TOOLS.execute, ORCHESTRATOR_TOOLS.status];
			const active = pi.getActiveTools();
			const next = [...active.filter((name) => !ORCHESTRATOR_TOOL_NAMES.has(name)), ...autoDagTools];
			if (active.length !== next.length || active.some((name, index) => name !== next[index])) pi.setActiveTools(next);
		};
		const renderWorkerWidget = (ctx: ExtensionContext): void => {
			updateWorkerWidget(ctx, widgetVisible ? state : undefined, liveAgents, dismissedWidgetEntries, pendingHandoffs);
		};
		const refreshWorkerWidget = async (ctx: ExtensionContext): Promise<void> => {
			liveContext = ctx;
			try {
				state = await lifecycle.status(ctx.cwd);
			} catch (error) {
				state = undefined;
				if (errorMessage(error) !== "No active pi-auto-dag run") ctx.ui.notify(`Auto DAG status unavailable: ${errorMessage(error)}`, "warning");
			}
			syncActiveTools();
			pendingHandoffs = state ? await pendingWorkerHandoffs(state) : new Set();
			renderWorkerWidget(ctx);
		};
		const flushNotificationsNow = async (ctx: ExtensionContext): Promise<void> => {
			liveContext = ctx;
			let current: RunState | undefined;
			try {
				current = await lifecycle.status(ctx.cwd);
			} catch (error) {
				if (errorMessage(error) !== "No active pi-auto-dag run") throw error;
			}
			if (!current) {
				state = undefined;
				syncActiveTools();
				pendingHandoffs = new Set();
				renderWorkerWidget(ctx);
				return;
			}
			const pendingNotifications = current.notifications.filter((candidate) => !candidate.delivered_at);
			if (!pendingNotifications.length && ["aborted", "completed"].includes(current.phase)) {
				current = await lifecycle.settleTerminal(ctx.cwd);
			}
			for (const notification of pendingNotifications) {
				await pi.sendUserMessage(JSON.stringify({
					type: "auto_dag_notification",
					event_id: notification.event_id,
					kind: notification.kind,
					run_id: current.run_id,
					payload: notification.payload,
				}), { deliverAs: "followUp" });
				current = await lifecycle.acknowledgeNotification(ctx.cwd, notification.event_id);
			}
			state = runRemainsActive(current) ? current : undefined;
			syncActiveTools();
			pendingHandoffs = state ? await pendingWorkerHandoffs(state) : new Set();
			renderWorkerWidget(ctx);
		};
		const flushNotifications = async (ctx: ExtensionContext): Promise<void> => {
			const next = notificationFlush.then(async () => await flushNotificationsNow(ctx));
			notificationFlush = next.catch(() => {});
			try {
				await next;
			} catch (error) {
				ctx.ui.notify(`Auto DAG notification delivery failed: ${errorMessage(error)}`, "warning");
			}
		};
		const lifecycleResult = async (
			ctx: ExtensionContext,
			action: () => Promise<RunState | undefined>,
		) => {
			try {
				return stateResult(await action());
			} finally {
				await flushNotifications(ctx);
			}
		};
		const refreshHerdr = async (ctx: ExtensionContext): Promise<void> => {
			if (readingHerdr) return;
			if (!state || !workers(state).some((worker) => worker.activity !== "blocked")) {
				liveAgents = new Map();
				renderWorkerWidget(ctx);
				return;
			}
			readingHerdr = true;
			const generation = ++herdrGeneration;
			try {
				const agents = await listManagedSubagents(workerHost(state), workerHostOptions({ runner }));
				if (generation === herdrGeneration) {
					liveAgents = agents;
					pendingHandoffs = await pendingWorkerHandoffs(state);
				}
			} catch {
				if (generation === herdrGeneration) {
					liveAgents = undefined;
					pendingHandoffs = await pendingWorkerHandoffs(state);
				}
			} finally {
				readingHerdr = false;
				if (generation === herdrGeneration) renderWorkerWidget(ctx);
			}
		};

		pi.registerCommand("dag-widget", {
			description: "Show, hide, or fix the Auto DAG worker widget",
			getArgumentCompletions: (prefix) => {
				const matches = ["show", "hide", "fix"].filter((action) => action.startsWith(prefix.trim()));
				return matches.length ? matches.map((action) => ({ value: action, label: action })) : null;
			},
			handler: async (args, ctx) => {
				switch (args.trim()) {
					case "show":
						widgetVisible = true;
						await refreshWorkerWidget(ctx);
						if (ctx.mode === "tui") await refreshHerdr(ctx);
						return;
					case "hide":
						widgetVisible = false;
						renderWorkerWidget(ctx);
						return;
					case "fix": {
						await refreshWorkerWidget(ctx);
						const expected = state ? workers(state) : [];
						let agents: Map<string, string>;
						try {
							agents = !state || !expected.some((worker) => worker.activity !== "blocked")
								? new Map()
								: await listManagedSubagents(workerHost(state), workerHostOptions({ runner }));
						} catch (error) {
							ctx.ui.notify(`Auto DAG widget fix could not read Herdr worker status: ${errorMessage(error)}. No entries removed.`, "warning");
							return;
						}
						const current = new Set(state ? workers(state).map((worker) => worker.key) : []);
						if (current.size !== expected.length || expected.some((worker) => !current.has(worker.key))) {
							ctx.ui.notify("Auto DAG widget state changed during Herdr probe. No entries removed.", "warning");
							return;
						}
						herdrGeneration += 1;
						liveAgents = agents;
						let removed = 0;
						for (const worker of expected) {
							if (worker.activity === "blocked" || agents.has(worker.pane) || dismissedWidgetEntries.has(worker.key)) continue;
							dismissedWidgetEntries.add(worker.key);
							removed += 1;
						}
						renderWorkerWidget(ctx);
						ctx.ui.notify(`Removed ${removed} stuck Auto DAG widget ${removed === 1 ? "entry" : "entries"}.`, "info");
						return;
					}
					default:
						ctx.ui.notify("Usage: /dag-widget show|hide|fix", "warning");
				}
			},
		});
		pi.on("session_start", async (_event, ctx) => {
			await refreshWorkerWidget(ctx);
			await flushNotifications(ctx);
			if (ctx.mode === "tui") {
				await refreshHerdr(ctx);
				renderingTimer = setInterval(() => { if (widgetVisible) renderWorkerWidget(ctx); }, 1000);
				herdrTimer = setInterval(() => { if (widgetVisible) void refreshHerdr(ctx); }, 5000);
			}
		});
		pi.on("session_shutdown", () => {
			if (renderingTimer) clearInterval(renderingTimer);
			if (herdrTimer) clearInterval(herdrTimer);
			renderingTimer = undefined;
			herdrTimer = undefined;
		});
		pi.on("tool_execution_end", async (event, ctx) => {
			if (!ORCHESTRATOR_TOOL_NAMES.has(event.toolName)) return;
			await refreshWorkerWidget(ctx);
			await flushNotifications(ctx);
			if (ctx.mode === "tui" && widgetVisible) await refreshHerdr(ctx);
		});
		pi.on("input", async (event, ctx) => {
			liveContext = ctx;
			let envelope: WorkerEnvelope | undefined;
			try {
				envelope = workerEnvelopeInput(event.text);
				if (!envelope) return { action: "continue" as const };
				const result = await lifecycle.resume(ctx.cwd, envelope);
				state = runRemainsActive(result) ? result : undefined;
				pendingHandoffs = state ? await pendingWorkerHandoffs(state) : new Set();
				syncActiveTools();
				renderWorkerWidget(ctx);
				if (ctx.mode === "tui" && widgetVisible) void refreshHerdr(ctx);
				ctx.ui.notify(stateSummary(result), "info");
			} catch (error) {
				ctx.ui.notify(`Auto DAG worker event rejected: ${errorMessage(error)}`, "error");
			} finally {
				if (envelope) await flushNotifications(ctx);
			}
			return { action: "handled" as const };
		});

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.execute,
			label: "Execute Auto DAG",
			description: "Confirm and execute one exact Delivery Graph through integration PR creation.",
			parameters: DELIVERY_GRAPH_PARAMETERS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				liveContext = ctx;
				if (ctx.mode !== "tui") throw new Error("Auto DAG execution requires interactive TUI mode");
				const graph = parseDeliveryGraph(params.graph);
				const mainPane = nonEmptyString(process.env.HERDR_PANE_ID, "main Herdr pane");
				const boundary = await preflightLocalRun(ctx.cwd, runner);
				const roles = preflightFixedRoles(ctx, boundary.config, mainPane, resolveFor);
				const hash = hashDeliveryGraph(graph);
				const waves = deriveDependencyWaves(graph);
				const approved = await ctx.ui.confirm(
					"Execute Auto DAG Delivery Graph?",
					executionConfirmation(boundary, graph, hash, waves, roles),
				);
				if (!approved) return {
					content: [{ type: "text" as const, text: "Auto DAG execution cancelled." }],
					details: undefined,
				};
				assertSameLocalRunBoundary(boundary, await preflightLocalRun(ctx.cwd, runner));
				return await lifecycleResult(ctx, async () => await lifecycle.start(graph, boundary, mainPane));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.status,
			label: "Auto DAG status",
			description: "Read the sole active run, or one historical run by ID.",
			parameters: Type.Object({ run_id: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				liveContext = ctx;
				return await lifecycleResult(ctx, async () => await lifecycle.status(ctx.cwd, params.run_id));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.resume,
			label: "Resume Auto DAG",
			description: "Resume only the active run after rechecking frozen local inputs.",
			parameters: Type.Object({ envelope: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				liveContext = ctx;
				return await lifecycleResult(ctx, async () => await lifecycle.resume(ctx.cwd, params.envelope));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.retryGate,
			label: "Retry Auto DAG gate",
			description: "Interactively archive failed Final Check Required Gate evidence and rerun its exact frozen command and commit in a fresh environment.",
			parameters: Type.Object({ reason: Type.String() }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				liveContext = ctx;
				if (ctx.mode !== "tui") throw new Error("Required Gate infrastructure retry requires interactive TUI mode");
				const reason = nonEmptyString(params.reason, "infrastructure retry reason");
				const candidate = await lifecycle.status(ctx.cwd);
				if (!candidate) throw new Error("No active pi-auto-dag run");
				const { evidence } = retryableFinalGate(candidate);
				const approved = await ctx.ui.confirm("Retry failed Final Check Required Gate?", [
					`Commit: ${quotedConfirmationValue(evidence.commit)}`,
					`Command: ${quotedConfirmationValue(evidence.command)}`,
					`Failed exit: ${evidence.exit_code}`,
					`Invalidation reason: ${quotedConfirmationValue(reason)}`,
					"Old evidence will remain archived. Command and commit cannot be changed.",
				].join("\n"));
				if (!approved) return {
					content: [{ type: "text" as const, text: "Required Gate infrastructure retry cancelled." }],
					details: candidate,
				};
				return await lifecycleResult(ctx, async () => await lifecycle.retryGate(ctx.cwd, reason, evidence));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.resolve,
			label: "Resolve Auto DAG task",
			description: "Record a user-approved resolution for one Local Issue; optionally confirm an exact replacement for its failed Required Gate command.",
			parameters: Type.Object({
				issue_id: Type.String(),
				resolution: Type.String(),
				replacement_command: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				liveContext = ctx;
				if (params.replacement_command === undefined) {
					return await lifecycleResult(ctx, async () => await lifecycle.resolve(ctx.cwd, params.issue_id, params.resolution));
				}
				if (ctx.mode !== "tui") throw new Error("Required Gate command amendment requires interactive TUI mode");
				const current = await lifecycle.status(ctx.cwd);
				if (!current) throw new Error("No active pi-auto-dag run");
				const amendment = requiredGateCommandAmendmentRequest(current, params.issue_id, params.replacement_command);
				const approved = await ctx.ui.confirm("Amend Required Gate command?", [
					`Run: ${quotedConfirmationValue(current.run_id)}`,
					`Local Issue: ${quotedConfirmationValue(params.issue_id)}`,
					`Failed commit: ${quotedConfirmationValue(amendment.expected_commit)}`,
					`Current command: ${quotedConfirmationValue(amendment.expected_command)}`,
					`Replacement command: ${quotedConfirmationValue(amendment.replacement_command)}`,
					`Reason: ${quotedConfirmationValue(params.resolution)}`,
				].join("\n"));
				if (!approved) return stateResult(current);
				return await lifecycleResult(ctx, async () => await lifecycle.resolve(ctx.cwd, params.issue_id, params.resolution, amendment));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.abort,
			label: "Abort Auto DAG",
			description: "Abort only the active run after retaining its durable evidence.",
			parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				liveContext = ctx;
				return await lifecycleResult(ctx, async () => await lifecycle.abort(ctx.cwd, params.reason));
			},
		}));
	};
}

interface FixedRoles {
	implementer: string;
	reviewer: string;
}

function preflightFixedRoles(
	ctx: ExtensionContext,
	config: ProjectConfig,
	mainPane: string,
	resolveFor: (ctx: ExtensionContext, input: ResolveRoleLaunchInput) => ResolvedRoleLaunch,
): FixedRoles {
	const registry = loadRoles();
	const resolve = (roleName: WorkerRole): string => {
		const role = registry.find((candidate) => candidate.name === roleName);
		if (!role) throw new Error(`Required Subagent Role is unavailable: ${roleName}`);
		createWorkerLaunch({
			resolveLaunch: (input) => resolveFor(ctx, input),
			workerRole: roleName,
			role,
			run_id: "00000000-0000-4000-8000-000000000000",
			issue_id: roleName === "implementer" ? "preflight-issue" : FINAL_CHECK_ID,
			main_pane: mainPane,
			action_ticket: "preflight-action-ticket",
			required_gate_timeout_ms: config.required_gate_timeout_ms,
		});
		return role.name;
	};
	return { implementer: resolve("implementer"), reviewer: resolve("reviewer") };
}

function executionConfirmation(
	boundary: LocalRunPreflight,
	graph: DeliveryGraph,
	hash: string,
	waves: readonly (readonly string[])[],
	roles: FixedRoles,
): string {
	const issues = new Map(graph.issues.map((issue) => [issue.id, issue]));
	const lines = [
		`Repository: ${quotedConfirmationValue(boundary.main_worktree)}`,
		`Branch: ${quotedConfirmationValue(boundary.branch)}`,
		`Graph ID: ${quotedConfirmationValue(graph.id)}`,
		`Goal: ${quotedConfirmationValue(graph.goal)}`,
		`Graph SHA-256: ${quotedConfirmationValue(hash)}`,
		`Implementer Role: ${quotedConfirmationValue(roles.implementer)}`,
		`Reviewer Role: ${quotedConfirmationValue(roles.reviewer)}`,
	];
	for (const [index, wave] of waves.entries()) {
		lines.push(`Wave ${index + 1}:`);
		for (const issueId of wave) {
			const issue = issues.get(issueId)!;
			lines.push(
				`- Issue ${quotedConfirmationValue(issue.id)}: ${quotedConfirmationValue(issue.title)}`,
				`  Testing (${quotedConfirmationValue(roles.implementer)}): ${quotedConfirmationValue(issue.testing)}`,
			);
		}
	}
	lines.push(
		"Final Check:",
		`  Testing (${quotedConfirmationValue(roles.reviewer)}): ${quotedConfirmationValue(graph.final_check.testing)}`,
	);
	return lines.join("\n");
}

interface WorkerWidgetEntry {
	key: string;
	issue: string;
	activity: string;
	pane: string;
	startedAt: string;
	role: WorkerRole;
	scope: ReviewTicketScope;
	reason?: string;
}

function updateWorkerWidget(
	ctx: ExtensionContext,
	state: RunState | undefined,
	liveAgents: Map<string, string> | undefined,
	dismissed: Set<string>,
	pendingHandoffs: Set<string>,
): void {
	if (!state) {
		ctx.ui.setWidget(WORKER_WIDGET, undefined);
		return;
	}
	const active = workers(state);
	const current = new Set(active.map((worker) => worker.key));
	for (const key of dismissed) if (!current.has(key)) dismissed.delete(key);
	if (liveAgents) for (const worker of active) if (liveAgents.has(worker.pane)) dismissed.delete(worker.key);
	const visible = active.filter((worker) => !dismissed.has(worker.key));
	ctx.ui.setWidget(WORKER_WIDGET, visible.length ? [
		ctx.ui.theme.fg("accent", "Auto DAG workers"),
		...visible.map(({ key, issue, activity, pane, startedAt, reason }) => {
			if (activity === "blocked") return `${ctx.ui.theme.fg("error", "!")} ${issue} · blocked · ${elapsed(startedAt)}${reason ? ` · ${reason}` : ""}`;
			const status = liveAgents ? liveAgents.get(pane) ?? "missing" : "unknown";
			const pending = status === "idle" && pendingHandoffs.has(key);
			const marker = status === "working" ? ctx.ui.theme.fg("success", "●") : status === "idle" ? ctx.ui.theme.fg("warning", "○") : status === "missing" ? ctx.ui.theme.fg("error", "!") : ctx.ui.theme.fg("muted", "?");
			return `${marker} ${issue} · ${activity} · ${status}${pending ? " · handoff pending" : ""} · ${elapsed(startedAt)}`;
		}),
	] : undefined);
}

function workers(state: RunState): WorkerWidgetEntry[] {
	const active: WorkerWidgetEntry[] = [];
	for (const [issue, task] of Object.entries(state.tasks)) {
		if (task.tab_cleanup_done) continue;
		const role: WorkerRole | undefined = task.status === "blocked" ? task.blocked_role : ["starting", "implementing", "repairing"].includes(task.status) ? "implementer" : ["reviewing", "repair_reviewing"].includes(task.status) ? "reviewer" : undefined;
		const scope: ReviewTicketScope = issue === FINAL_CHECK_ID ? "lifecycle" : "implementation";
		const pane = role === "implementer" ? task.implementer_pane : role === "reviewer" ? task.reviewer_pane : undefined;
		const activity = task.status === "blocked" ? "blocked" : task.status === "starting" ? "starting" : task.status === "implementing" ? "coding" : task.status === "repairing" ? "repairing" : role === "reviewer" ? "reviewing" : undefined;
		if (activity && pane && role && task.activity_started_at) active.push({
			key: `${state.run_id}:${issue}:${activity}:${pane}:${task.activity_started_at}`,
			issue,
			activity,
			pane,
			startedAt: task.activity_started_at,
			role,
			scope,
			reason: task.block_reason,
		});
	}
	return active;
}

async function pendingWorkerHandoffs(state: RunState): Promise<Set<string>> {
	const pending = new Set<string>();
	for (const worker of workers(state)) {
		if (worker.activity === "blocked") continue;
		const issueId = worker.issue;
		try {
			const ticket = await readActionTicket(actionTicketPath(state.main_worktree, state.run_id, issueId, worker.scope, worker.role));
			const receipt = await readWorkerReceipt(ticket.receipt_path);
			if (!receipt || receipt.status !== "accepted") pending.add(worker.key);
		} catch {
			// No ticket means no handoff to display.
		}
	}
	return pending;
}

function elapsed(startedAt: string): string {
	const total = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const seconds = total % 60;
	return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function stateResult(state: RunState | undefined) {
	return {
		content: [{ type: "text" as const, text: stateSummary(state) }],
		details: state,
	};
}

function stateSummary(state: RunState | undefined): string {
	if (!state) return "No active Auto DAG run.";
	const counts = new Map<string, number>();
	for (const current of Object.values(state.tasks)) counts.set(current.status, (counts.get(current.status) ?? 0) + 1);
	const statuses = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([status, count]) => `${status}:${count}`).join(", ");
	const blocked = state.block_reason ? ` Blocked: ${state.block_reason.slice(0, 240)}` : "";
	const pr = state.pr ? ` PR: ${state.pr.url}` : "";
	return `Auto DAG ${state.run_id}: ${state.phase}; tasks ${statuses || "none"}.${blocked}${pr}`;
}

function workerEnvelopeInput(text: string): WorkerEnvelope | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (input.type === "auto_dag_notification") return undefined;
	if (!["version", "type", "run_id", "issue_id", "role", "event_id", "attempt", "review_round", "receipt_path", "payload"].every((key) => key in input)) return undefined;
	return parseWorkerEnvelope(input);
}

function hasActivePhaseBlock(state: RunState): boolean {
	return Object.values(state.tasks).some((task) => task.status === "blocked"
		|| (state.phase === "blocked" && ["starting", "implementing", "reviewing", "repairing", "repair_reviewing"].includes(task.status)));
}

function runRemainsActive(state: RunState): boolean {
	if (state.phase !== "aborted" && state.phase !== "completed") return true;
	return Boolean(state.cleanup_blocks?.length || state.notifications.some((notification) => !notification.delivered_at));
}

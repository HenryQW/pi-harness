import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, runCommand, type CommandRunner } from "./command.ts";
import { executionIssues } from "./graph.ts";
import { createCoreLifecycle, type CoreLifecycle } from "./lifecycle.ts";
import { actionTicketPath, readActionTicket, readWorkerReceipt, type ReviewTicketScope } from "./review-ticket.ts";
import type { RunState, WorkerEnvelope } from "./model.ts";
import type { WorkerRole } from "./worker.ts";
import { parseWorkerEnvelope } from "./orchestration.ts";
import { registerPlanning } from "./planning.ts";
import { listWorkerAgents } from "./worker-host.ts";

export const ORCHESTRATOR_TOOLS = {
	start: "auto_dag_start",
	status: "auto_dag_status",
	resume: "auto_dag_resume",
	resolve: "auto_dag_resolve",
	abort: "auto_dag_abort",
	health: "auto_dag_health",
} as const;

export interface OrchestratorExtensionOptions {
	lifecycle?: CoreLifecycle;
	runner?: CommandRunner;
}

const WORKER_WIDGET = "auto-dag-workers";
const ORCHESTRATOR_TOOL_NAMES = new Set<string>(Object.values(ORCHESTRATOR_TOOLS));

/** The main integration extension exposes the public lifecycle surface and nothing else. */
export function createOrchestratorExtension(options: OrchestratorExtensionOptions = {}) {
	const lifecycle = options.lifecycle ?? createCoreLifecycle({ mainPane: () => process.env.HERDR_PANE_ID });
	const runner = options.runner ?? runCommand;
	return (pi: ExtensionAPI) => {
		registerPlanning(pi, runner);
		let state: RunState | undefined;
		let liveAgents: Map<string, string> | undefined;
		let pendingHandoffs = new Set<string>();
		let widgetVisible = true;
		const dismissedWidgetEntries = new Set<string>();
		let renderingTimer: ReturnType<typeof setInterval> | undefined;
		let herdrTimer: ReturnType<typeof setInterval> | undefined;
		let readingHerdr = false;
		let herdrGeneration = 0;
		const syncActiveTools = (): void => {
			const autoDagTools = state
				? [ORCHESTRATOR_TOOLS.status, ORCHESTRATOR_TOOLS.resume, ORCHESTRATOR_TOOLS.abort,
					...(hasBlockedTask(state) ? [ORCHESTRATOR_TOOLS.resolve] : []),
					...(state.health ? [ORCHESTRATOR_TOOLS.health] : [])]
				: [ORCHESTRATOR_TOOLS.start, ORCHESTRATOR_TOOLS.status, ORCHESTRATOR_TOOLS.health];
			const active = pi.getActiveTools();
			const next = [...active.filter((name) => !ORCHESTRATOR_TOOL_NAMES.has(name)), ...autoDagTools];
			if (active.length !== next.length || active.some((name, index) => name !== next[index])) pi.setActiveTools(next);
		};
		const renderWorkerWidget = (ctx: ExtensionContext): void => {
			updateWorkerWidget(ctx, widgetVisible ? state : undefined, liveAgents, dismissedWidgetEntries, pendingHandoffs);
		};
		const refreshWorkerWidget = async (ctx: ExtensionContext): Promise<void> => {
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
				const agents = await listWorkerAgents(state, { runner });
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
								: await listWorkerAgents(state, { runner });
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
			if (ctx.mode === "tui" && widgetVisible) await refreshHerdr(ctx);
		});
		pi.on("input", async (event, ctx) => {
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
			}
			return { action: "handled" as const };
		});

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.start,
			label: "Start Auto DAG",
			description: "Validate the approved local Delivery Graph and start its sole active run.",
			parameters: Type.Object({ main_pane: Type.Optional(Type.String()) }),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				return stateResult(await lifecycle.start(ctx.cwd, _params.main_pane ?? process.env.HERDR_PANE_ID));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.status,
			label: "Auto DAG status",
			description: "Read the sole active run, or one historical run by ID.",
			parameters: Type.Object({ run_id: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return stateResult(await lifecycle.status(ctx.cwd, params.run_id));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.resume,
			label: "Resume Auto DAG",
			description: "Resume only the active run after rechecking frozen local inputs.",
			parameters: Type.Object({ envelope: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return stateResult(await lifecycle.resume(ctx.cwd, params.envelope));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.resolve,
			label: "Resolve Auto DAG task",
			description: "Record a user-approved resolution for one Local Issue in the active run.",
			parameters: Type.Object({ issue_id: Type.String(), resolution: Type.String() }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return stateResult(await lifecycle.resolve(ctx.cwd, params.issue_id, params.resolution));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.abort,
			label: "Abort Auto DAG",
			description: "Abort only the active run after retaining its durable evidence.",
			parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return stateResult(await lifecycle.abort(ctx.cwd, params.reason));
			},
		}));

		pi.registerTool(defineTool({
			name: ORCHESTRATOR_TOOLS.health,
			label: "Auto DAG health",
			description: "Run explicit health handling for the required retained run ID.",
			parameters: Type.Object({ run_id: Type.String(), envelope: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return stateResult(await lifecycle.health(ctx.cwd, params.run_id, params.envelope));
			},
		}));
	};
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
		const scope: ReviewTicketScope = executionIssues(state.graph).find((candidate) => candidate.role === "final_check")?.id === issue ? "lifecycle" : "implementation";
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
	const health = state.health;
	if (health) {
		const role: WorkerRole | undefined = health.status === "blocked" ? health.blocked_role : health.status === "repairing" ? "implementer" : ["triaging", "reviewing"].includes(health.status) ? "reviewer" : undefined;
		const pane = role === "implementer" ? health.coder_pane : role === "reviewer" ? health.reviewer_pane : undefined;
		const activity = health.status === "blocked" ? "blocked" : health.status;
		if (role && pane && health.activity_started_at) active.push({
			key: `${state.run_id}:PR health:${activity}:${pane}:${health.activity_started_at}`,
			issue: "PR health",
			activity,
			pane,
			startedAt: health.activity_started_at,
			role,
			scope: "pr_health",
			reason: health.summary,
		});
	}
	return active;
}

async function pendingWorkerHandoffs(state: RunState): Promise<Set<string>> {
	const pending = new Set<string>();
	for (const worker of workers(state)) {
		if (worker.activity === "blocked") continue;
		const issueId = worker.scope === "pr_health"
			? executionIssues(state.graph).find((candidate) => candidate.role === "final_check")?.id
			: worker.issue;
		if (!issueId) continue;
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
	if (!["version", "type", "run_id", "issue_id", "role", "event_id", "attempt", "review_round", "receipt_path", "payload"].every((key) => key in input)) return undefined;
	return parseWorkerEnvelope(input);
}

function hasBlockedTask(state: RunState): boolean {
	return Object.values(state.tasks).some((task) => task.status === "blocked"
		|| (state.phase === "blocked" && ["starting", "implementing", "reviewing", "repairing", "repair_reviewing"].includes(task.status)));
}

function runRemainsActive(state: RunState): boolean {
	if (state.phase === "aborted") return Boolean(state.cleanup_blocks?.length);
	if (state.phase !== "completed") return true;
	return Boolean(state.health && state.health.status !== "completed");
}

import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, runCommand, type CommandRunner } from "./command.ts";
import { createCoreLifecycle, type CoreLifecycle } from "./lifecycle.ts";
import type { RunState, WorkerEnvelope } from "./model.ts";
import { parseWorkerEnvelope } from "./orchestration.ts";
import { registerPlanning } from "./planning.ts";
import { listWorkerAgents } from "./worker.ts";

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
		registerPlanning(pi);
		let state: RunState | undefined;
		let liveAgents: Map<string, string> | undefined;
		let renderingTimer: ReturnType<typeof setInterval> | undefined;
		let herdrTimer: ReturnType<typeof setInterval> | undefined;
		let readingHerdr = false;
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
		const refreshWorkerWidget = async (ctx: ExtensionContext): Promise<void> => {
			try {
				state = await lifecycle.status(ctx.cwd);
			} catch (error) {
				state = undefined;
				if (errorMessage(error) !== "No active pi-auto-dag run") ctx.ui.notify(`Auto DAG status unavailable: ${errorMessage(error)}`, "warning");
			}
			syncActiveTools();
			updateWorkerWidget(ctx, state, liveAgents);
		};
		const refreshHerdr = async (ctx: ExtensionContext): Promise<void> => {
			if (readingHerdr) return;
			if (!state || !workers(state).some((worker) => worker.activity !== "blocked")) {
				liveAgents = new Map();
				updateWorkerWidget(ctx, state, liveAgents);
				return;
			}
			readingHerdr = true;
			try {
				liveAgents = await listWorkerAgents(state, { runner });
			} catch {
				liveAgents = undefined;
			} finally {
				readingHerdr = false;
				updateWorkerWidget(ctx, state, liveAgents);
			}
		};
		pi.on("session_start", async (_event, ctx) => {
			await refreshWorkerWidget(ctx);
			if (ctx.mode === "tui") {
				await refreshHerdr(ctx);
				renderingTimer = setInterval(() => { updateWorkerWidget(ctx, state, liveAgents); }, 1000);
				herdrTimer = setInterval(() => { void refreshHerdr(ctx); }, 5000);
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
			if (ctx.mode === "tui") await refreshHerdr(ctx);
		});
		pi.on("input", async (event, ctx) => {
			let envelope: WorkerEnvelope | undefined;
			try {
				envelope = workerEnvelopeInput(event.text);
				if (!envelope) return { action: "continue" as const };
				const result = await lifecycle.resume(ctx.cwd, envelope);
				state = runRemainsActive(result) ? result : undefined;
				syncActiveTools();
				updateWorkerWidget(ctx, state, liveAgents);
				if (ctx.mode === "tui") await refreshHerdr(ctx);
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

function updateWorkerWidget(ctx: ExtensionContext, state: RunState | undefined, liveAgents: Map<string, string> | undefined): void {
	if (!state) {
		ctx.ui.setWidget(WORKER_WIDGET, undefined);
		return;
	}
	const active = workers(state);
	ctx.ui.setWidget(WORKER_WIDGET, active.length ? [
		ctx.ui.theme.fg("accent", "Auto DAG workers"),
		...active.map(({ issue, activity, pane, startedAt, reason }) => {
			if (activity === "blocked") return `${ctx.ui.theme.fg("error", "!")} ${issue} · blocked · ${elapsed(startedAt)}${reason ? ` · ${reason}` : ""}`;
			const status = liveAgents ? liveAgents.get(pane) ?? "missing" : "unknown";
			const marker = status === "working" ? ctx.ui.theme.fg("success", "●") : status === "idle" ? ctx.ui.theme.fg("warning", "○") : status === "missing" ? ctx.ui.theme.fg("error", "!") : ctx.ui.theme.fg("muted", "?");
			return `${marker} ${issue} · ${activity} · ${status} · ${elapsed(startedAt)}`;
		}),
	] : undefined);
}

function workers(state: RunState): Array<{ issue: string; activity: string; pane: string; startedAt: string; reason?: string }> {
	const active: Array<{ issue: string; activity: string; pane: string; startedAt: string; reason?: string }> = [];
	for (const [issue, task] of Object.entries(state.tasks)) {
		if (task.tab_cleanup_done) continue;
		const role = task.status === "blocked" ? task.blocked_role : ["starting", "implementing", "repairing"].includes(task.status) ? "implementer" : ["reviewing", "repair_reviewing"].includes(task.status) ? "reviewer" : undefined;
		const pane = role === "implementer" ? task.implementer_pane : role === "reviewer" ? task.reviewer_pane : undefined;
		const activity = task.status === "blocked" ? "blocked" : task.status === "starting" ? "starting" : task.status === "implementing" ? "coding" : task.status === "repairing" ? "repairing" : role === "reviewer" ? "reviewing" : undefined;
		if (activity && pane && task.activity_started_at) active.push({ issue, activity, pane, startedAt: task.activity_started_at, reason: task.block_reason });
	}
	const health = state.health;
	if (health) {
		const role = health.status === "blocked" ? health.blocked_role : health.status === "repairing" ? "implementer" : ["triaging", "reviewing"].includes(health.status) ? "reviewer" : undefined;
		const pane = role === "implementer" ? health.coder_pane : role === "reviewer" ? health.reviewer_pane : undefined;
		const activity = health.status === "blocked" ? "blocked" : health.status;
		if (role && pane && health.activity_started_at) active.push({ issue: "PR health", activity, pane, startedAt: health.activity_started_at, reason: health.summary });
	}
	return active;
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
	if (!["version", "type", "run_id", "issue_id", "role", "payload"].every((key) => key in input)) return undefined;
	return parseWorkerEnvelope(input);
}

function hasBlockedTask(state: RunState): boolean {
	return Object.values(state.tasks).some((task) => task.status === "blocked");
}

function runRemainsActive(state: RunState): boolean {
	if (state.phase === "aborted") return Boolean(state.cleanup_blocks?.length);
	if (state.phase !== "completed") return true;
	return Boolean(state.health && state.health.status !== "completed");
}

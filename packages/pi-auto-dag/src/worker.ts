import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandOutput, runCommand, type CommandRunner } from "./command.ts";
import type { DeliveryGraph, LocalIssue, ResolvedProfile, WorkerEnvelope } from "./model.ts";
import { planningReviewPath, PLANNING_REVIEW_TOOL, writePlanningReviewPass } from "./planning-review.ts";
import { readReviewTicket } from "./review-ticket.ts";
import { nonEmptyString, oneOf } from "./validate.ts";

export type WorkerRole = "implementer" | "reviewer";

export const WORKER_TOOLS = {
	request_review: "auto_dag_request_review",
	submit_review: "auto_dag_submit_review",
	submit_health: "auto_dag_submit_health",
	block_task: "auto_dag_block_task",
} as const;

export type WorkerEvent = keyof typeof WORKER_TOOLS;

export const WORKER_ROLE_EVENTS: Record<WorkerRole, WorkerEvent[]> = {
	implementer: ["request_review", "block_task"],
	reviewer: ["submit_review", "submit_health", "block_task"],
};

export interface WorkerLaunchInput {
	role: WorkerRole;
	events?: WorkerEvent[];
	profile: ResolvedProfile;
	run_id: string;
	issue_id: string;
	main_pane: string;
	review_ticket?: string;
}

export interface WorkerLaunch {
	env: Record<string, string>;
	args: string[];
}

export const WORKER_EXTENSION_PATH = fileURLToPath(new URL("../extensions/worker.ts", import.meta.url));

/** Profile owns baseline Pi resources; Auto DAG adds only its worker adapter and phase tools. */
export function createWorkerLaunch(input: WorkerLaunchInput): WorkerLaunch {
	const role = parseWorkerRole(input.role);
	const events = parseWorkerEvents(input.events ?? WORKER_ROLE_EVENTS[role], role);
	const reviewTicket = events.includes("submit_review")
		? nonEmptyString(input.review_ticket, "reviewer review ticket")
		: undefined;
	return {
		env: {
			PI_CODING_AGENT_DIR: nonEmptyString(input.profile.agent_dir, "worker profile agent_dir"),
			PI_AUTO_DAG_WORKER_ROLE: role,
			PI_AUTO_DAG_WORKER_EVENTS: events.join(","),
			PI_AUTO_DAG_RUN_ID: nonEmptyString(input.run_id, "worker run_id"),
			PI_AUTO_DAG_ISSUE_ID: nonEmptyString(input.issue_id, "worker issue_id"),
			PI_AUTO_DAG_MAIN_PANE: nonEmptyString(input.main_pane, "worker main_pane"),
			...(reviewTicket ? { PI_AUTO_DAG_REVIEW_TICKET: reviewTicket } : {}),
		},
		args: profileLaunchArgs(input.profile, events.map((event) => WORKER_TOOLS[event])),
	};
}

export function createPlanningReviewLaunch(profile: ResolvedProfile, mainWorktree: string): WorkerLaunch {
	return {
		env: {
			PI_CODING_AGENT_DIR: nonEmptyString(profile.agent_dir, "planning reviewer profile agent_dir"),
			PI_AUTO_DAG_PLANNING_ROOT: nonEmptyString(mainWorktree, "planning reviewer main worktree"),
		},
		args: profileLaunchArgs(profile, [PLANNING_REVIEW_TOOL]),
	};
}

function profileLaunchArgs(profile: ResolvedProfile, addedTools: string[]): string[] {
	return [
		"--offline",
		"--no-session",
		"--no-skills",
		...profile.skills.flatMap((path) => ["--skill", nonEmptyString(path, `profile ${profile.id} skill path`)]),
		"--extension",
		WORKER_EXTENSION_PATH,
		"--tools",
		[...new Set([...profile.tools, ...addedTools])].join(","),
	];
}

interface WorkerEnvironment {
	role: WorkerRole;
	events: WorkerEvent[];
	run_id: string;
	issue_id: string;
	main_pane: string;
	review_ticket?: string;
}

export function workerEnvironment(environment: NodeJS.ProcessEnv): WorkerEnvironment {
	const role = parseWorkerRole(environment.PI_AUTO_DAG_WORKER_ROLE);
	const events = parseWorkerEvents(environment.PI_AUTO_DAG_WORKER_EVENTS?.split(",") ?? WORKER_ROLE_EVENTS[role], role);
	return {
		role,
		events,
		run_id: nonEmptyString(environment.PI_AUTO_DAG_RUN_ID, "PI_AUTO_DAG_RUN_ID"),
		issue_id: nonEmptyString(environment.PI_AUTO_DAG_ISSUE_ID, "PI_AUTO_DAG_ISSUE_ID"),
		main_pane: nonEmptyString(environment.PI_AUTO_DAG_MAIN_PANE, "PI_AUTO_DAG_MAIN_PANE"),
		...(events.includes("submit_review") ? { review_ticket: nonEmptyString(environment.PI_AUTO_DAG_REVIEW_TICKET, "PI_AUTO_DAG_REVIEW_TICKET") } : {}),
	};
}

export async function sendWorkerEnvelope(
	worker: WorkerEnvironment,
	type: WorkerEvent,
	payload: Record<string, unknown>,
	runner: CommandRunner = runCommand,
	cwd = process.cwd(),
	reviewId?: string,
): Promise<WorkerEnvelope> {
	if (!worker.events.includes(type)) {
		throw new Error(`${worker.role} worker cannot send ${type}`);
	}
	const base = {
		version: 1 as const,
		run_id: worker.run_id,
		issue_id: worker.issue_id,
		payload,
	};
	const envelope: WorkerEnvelope = type === "submit_review"
		? { ...base, type, role: "reviewer", review_id: nonEmptyString(reviewId, "captured review_id") }
		: { ...base, type, role: worker.role };
	await commandOutput(runner, "herdr", ["agent", "prompt", worker.main_pane, JSON.stringify(envelope)], cwd);
	return envelope;
}

export interface WorkerExtensionOptions {
	environment?: NodeJS.ProcessEnv;
	runner?: CommandRunner;
	cwd?: string;
}

export function createWorkerExtension(options: WorkerExtensionOptions = {}) {
	return (pi: ExtensionAPI) => {
		const environment = options.environment ?? process.env;
		const runWorkerValues = [
			environment.PI_AUTO_DAG_WORKER_ROLE,
			environment.PI_AUTO_DAG_RUN_ID,
			environment.PI_AUTO_DAG_ISSUE_ID,
			environment.PI_AUTO_DAG_MAIN_PANE,
		];
		if (environment.PI_AUTO_DAG_PLANNING_ROOT !== undefined) {
			if (runWorkerValues.some((value) => value !== undefined)) throw new Error("Planning reviewer cannot also be a run worker");
			registerPlanningReviewTool(pi, nonEmptyString(environment.PI_AUTO_DAG_PLANNING_ROOT, "PI_AUTO_DAG_PLANNING_ROOT"));
			return;
		}
		if (runWorkerValues.every((value) => value === undefined)) return;
		const worker = workerEnvironment(environment);
		const runner = options.runner ?? runCommand;
		const cwd = options.cwd ?? process.cwd();
		let capturedReviewId: string | undefined;
		if (worker.events.includes("submit_review")) {
			pi.on("before_agent_start", async () => {
				try {
					capturedReviewId = await readReviewTicket(nonEmptyString(worker.review_ticket, "review ticket path"));
				} catch (error) {
					if (!worker.events.includes("submit_health") || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					capturedReviewId = undefined;
				}
			});
		}
		for (const type of worker.events) registerWorkerTool(pi, worker, type, runner, cwd, () => capturedReviewId);
	};
}

function registerPlanningReviewTool(pi: ExtensionAPI, mainWorktree: string): void {
	pi.registerTool(defineTool({
		name: PLANNING_REVIEW_TOOL,
		label: "Submit planning review",
		description: "Record PASS for exact current draft after independent semantic review. Call only when no material blockers remain.",
		parameters: Type.Object({}),
		async execute() {
			return withFileMutationQueue(planningReviewPath(mainWorktree), async () => {
				const pass = await writePlanningReviewPass(mainWorktree);
				return { content: [{ type: "text", text: `Recorded reviewer PASS for ${pass.graph_id} at ${pass.graph_hash}.` }], details: pass, terminate: true };
			});
		},
	}));
}

function registerWorkerTool(
	pi: ExtensionAPI,
	worker: WorkerEnvironment,
	type: WorkerEvent,
	runner: CommandRunner,
	cwd: string,
	capturedReviewId: () => string | undefined,
): void {
	const definition = eventDefinition(type);
	pi.registerTool(defineTool({
		name: WORKER_TOOLS[type],
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments(args) {
			if (type !== "request_review" || !args || typeof args !== "object" || Array.isArray(args)) return args as Record<PropertyKey, unknown>;
			const { commit: _commit, ...prepared } = args as Record<string, unknown>;
			return prepared;
		},
		async execute(_toolCallId, params) {
			const payload = definition.payload(params as Record<string, unknown>);
			if (type === "request_review") payload.commit = await commandOutput(runner, "git", ["rev-parse", "HEAD"], cwd);
			const envelope = await sendWorkerEnvelope(worker, type, payload, runner, cwd, capturedReviewId());
			return { content: [{ type: "text", text: `Sent ${type} for ${worker.issue_id}.` }], details: envelope, terminate: true };
		},
	}));
}

function eventDefinition(type: WorkerEvent): {
	label: string;
	description: string;
	parameters: ReturnType<typeof Type.Object>;
	payload: (params: Record<string, unknown>) => Record<string, unknown>;
} {
	switch (type) {
		case "request_review":
			return { label: "Request review", description: "Request reviewer dispatch for current worktree HEAD at the prompted attempt and review round.", parameters: Type.Object({ attempt: Type.Integer({ minimum: 1 }), review_round: Type.Integer({ minimum: 1 }), summary: Type.Optional(Type.String()) }), payload: (params) => params };
		case "submit_review":
			return { label: "Submit review", description: "Submit independent reviewer verdict and findings. Auto DAG owns required-gate evidence.", parameters: Type.Object({ verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested"), Type.Literal("blocked")]), findings: Type.Array(Type.String()) }), payload: (params) => params };
		case "submit_health":
			return { label: "Submit health", description: "Submit explicit PR-health evidence for the prompted attempt and review round.", parameters: Type.Object({ summary: Type.String(), actionable: Type.Boolean(), attempt: Type.Integer({ minimum: 1 }), review_round: Type.Integer({ minimum: 1 }), thread_ids: Type.Optional(Type.Array(Type.String())), checks: Type.Optional(Type.Array(Type.Object({ name: Type.String(), link: Type.Optional(Type.String()), output: Type.Optional(Type.String()) }))) }), payload: (params) => params };
		case "block_task":
			return { label: "Block task", description: "Report a blocker for the prompted task attempt and review round.", parameters: Type.Object({ reason: Type.String(), attempt: Type.Integer({ minimum: 1 }), review_round: Type.Integer({ minimum: 1 }) }), payload: (params) => params };
	}
}

export function workerDeliveryContext(graph: DeliveryGraph): Record<string, unknown> {
	return { goal: graph.goal, constraints: graph.constraints, non_goals: graph.non_goals };
}

export function workerIssueContext(issue: LocalIssue, includeTesting: boolean): Record<string, unknown> {
	return {
		id: issue.id,
		title: issue.title,
		purpose: issue.purpose,
		acceptance: issue.acceptance,
		...(includeTesting ? { testing: issue.testing } : {}),
	};
}

function parseWorkerEvents(value: unknown, role: WorkerRole): WorkerEvent[] {
	if (!Array.isArray(value) || !value.length) throw new Error("worker events must be a non-empty array");
	const events = [...new Set(value.map((event) => oneOf(event, Object.keys(WORKER_TOOLS) as WorkerEvent[], "worker event")))];
	for (const event of events) {
		if (!WORKER_ROLE_EVENTS[role].includes(event)) throw new Error(`${role} worker cannot send ${event}`);
	}
	return events;
}

function parseWorkerRole(value: unknown): WorkerRole {
	return oneOf(value, ["implementer", "reviewer"] as const, "worker role");
}

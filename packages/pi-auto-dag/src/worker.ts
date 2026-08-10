import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandOutput, runCommand, type CommandRunner } from "./command.ts";
import type { DeliveryGraph, LocalIssue, ResolvedProfile, WorkerEnvelope } from "./model.ts";
import { planningReviewPath, PLANNING_REVIEW_TOOL, writePlanningReviewPass } from "./planning-review.ts";
import { readActionTicket, readWorkerReceipt, type ActionTicket } from "./review-ticket.ts";
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
	action_ticket: string;
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
	return {
		env: {
			PI_CODING_AGENT_DIR: nonEmptyString(input.profile.agent_dir, "worker profile agent_dir"),
			PI_AUTO_DAG_WORKER_ROLE: role,
			PI_AUTO_DAG_WORKER_EVENTS: events.join(","),
			PI_AUTO_DAG_RUN_ID: nonEmptyString(input.run_id, "worker run_id"),
			PI_AUTO_DAG_ISSUE_ID: nonEmptyString(input.issue_id, "worker issue_id"),
			PI_AUTO_DAG_MAIN_PANE: nonEmptyString(input.main_pane, "worker main_pane"),
			PI_AUTO_DAG_ACTION_TICKET: nonEmptyString(input.action_ticket, "worker action ticket"),
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
	action_ticket: string;
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
		action_ticket: nonEmptyString(environment.PI_AUTO_DAG_ACTION_TICKET, "worker action ticket"),
	};
}

export interface WorkerDeliveryOptions {
	deliveryAttempts?: number;
	delay?: (milliseconds: number) => Promise<void>;
}

export async function sendWorkerEnvelope(
	worker: WorkerEnvironment,
	type: WorkerEvent,
	payload: Record<string, unknown>,
	runner: CommandRunner = runCommand,
	cwd = process.cwd(),
	delivery: WorkerDeliveryOptions = {},
): Promise<WorkerEnvelope> {
	if (!worker.events.includes(type)) throw new Error(`${worker.role} worker cannot send ${type}`);
	const ticket = await readActionTicket(worker.action_ticket);
	if (ticket.role !== worker.role) throw new Error(`Action ticket role ${ticket.role} does not match ${worker.role} worker`);
	const envelope = await buildWorkerEnvelope(worker, type, payload, ticket, runner, cwd);
	const existing = await readWorkerReceipt(ticket.receipt_path);
	if (existing) return requireReceipt(envelope, existing);

	const attempts = delivery.deliveryAttempts ?? 3;
	if (!Number.isInteger(attempts) || attempts < 1) throw new Error("worker deliveryAttempts must be a positive integer");
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await commandOutput(runner, "herdr", ["agent", "prompt", worker.main_pane, JSON.stringify(envelope)], cwd);
		} catch (error) {
			lastError = error;
			if (attempt < attempts) {
				await (delivery.delay ?? defaultDelay)(50);
				continue;
			}
			break;
		}
		const receipt = await waitForReceipt(ticket.receipt_path, delivery.delay);
		if (receipt) return requireReceipt(envelope, receipt);
		lastError = new Error(`Auto DAG event ${ticket.event_id} was delivered but lifecycle acceptance receipt was not observed`);
		if (attempt < attempts) await (delivery.delay ?? defaultDelay)(50);
	}
	throw lastError ?? new Error(`Auto DAG event ${ticket.event_id} was not accepted`);
}

async function buildWorkerEnvelope(
	worker: WorkerEnvironment,
	type: WorkerEvent,
	payload: Record<string, unknown>,
	ticket: ActionTicket,
	runner: CommandRunner,
	cwd: string,
): Promise<WorkerEnvelope> {
	const base = {
		version: 1 as const,
		run_id: worker.run_id,
		issue_id: worker.issue_id,
		event_id: ticket.event_id,
		attempt: ticket.attempt,
		review_round: ticket.review_round,
		receipt_path: ticket.receipt_path,
		payload,
	};
	if (type === "request_review") {
		return {
			...base,
			type,
			role: "implementer",
			commit: await commandOutput(runner, "git", ["rev-parse", "HEAD"], cwd),
		};
	}
	if (type === "submit_review") {
		return {
			...base,
			type,
			role: "reviewer",
			review_id: nonEmptyString(ticket.review_id, "action ticket review_id"),
		};
	}
	return { ...base, type, role: worker.role };
}

function requireReceipt(envelope: WorkerEnvelope, receipt: NonNullable<Awaited<ReturnType<typeof readWorkerReceipt>>>): WorkerEnvelope {
	if (receipt.event_id !== envelope.event_id) throw new Error(`Worker receipt belongs to another event: ${receipt.event_id}`);
	if (receipt.status === "rejected") throw new Error(`Auto DAG event ${envelope.event_id} rejected: ${receipt.reason ?? "lifecycle rejected event"}`);
	return envelope;
}

async function waitForReceipt(path: string, delay: WorkerDeliveryOptions["delay"]): Promise<Awaited<ReturnType<typeof readWorkerReceipt>>> {
	for (let poll = 0; poll < 10; poll += 1) {
		const receipt = await readWorkerReceipt(path);
		if (receipt) return receipt;
		if (poll < 9) await (delay ?? defaultDelay)(50);
	}
	return undefined;
}

export interface WorkerExtensionOptions extends WorkerDeliveryOptions {
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
		let compacting = false;
		pi.on("tool_call", (event, ctx) => {
			if (!Object.values(WORKER_TOOLS).includes(event.toolName as typeof WORKER_TOOLS[WorkerEvent])) return;
			const usage = ctx.getContextUsage();
			if (compacting || usage?.percent == null || usage.percent <= 75) return;
			compacting = true;
			ctx.compact({
				customInstructions: "Preserve current task, worker action intent, and retry submission after compaction.",
				onComplete: () => { compacting = false; },
				onError: () => { compacting = false; },
			});
			return { block: true, terminate: true, reason: "Auto-compact ran before worker event submission; retry event." };
		});
		for (const type of worker.events) registerWorkerTool(pi, worker, type, runner, cwd, options);
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
	delivery: WorkerDeliveryOptions,
): void {
	const definition = eventDefinition(type);
	pi.registerTool(defineTool({
		name: WORKER_TOOLS[type],
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		async execute(_toolCallId, params) {
			const payload = definition.payload(params as Record<string, unknown>);
			const envelope = await sendWorkerEnvelope(worker, type, payload, runner, cwd, delivery);
			return {
				content: [{ type: "text", text: `Accepted ${type} for ${worker.issue_id}.` }],
				details: { status: "accepted" },
				terminate: true,
			};
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
			return { label: "Request review", description: "Request reviewer dispatch for current worktree HEAD.", parameters: Type.Object({ summary: Type.Optional(Type.String()) }), payload: (params) => params.summary === undefined ? {} : { summary: params.summary } };
		case "submit_review":
			return { label: "Submit review", description: "Submit independent reviewer verdict and findings.", parameters: Type.Object({ verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested"), Type.Literal("blocked")]), findings: Type.Array(Type.String()) }), payload: (params) => ({ verdict: params.verdict, findings: params.findings }) };
		case "submit_health":
			return { label: "Submit health", description: "Submit PR-health summary and evidence.", parameters: Type.Object({ summary: Type.String(), actionable: Type.Boolean(), thread_ids: Type.Optional(Type.Array(Type.String())), checks: Type.Optional(Type.Array(Type.Object({ name: Type.String(), link: Type.Optional(Type.String()), output: Type.Optional(Type.String()) }))) }), payload: (params) => ({ summary: params.summary, actionable: params.actionable, ...(params.thread_ids === undefined ? {} : { thread_ids: params.thread_ids }), ...(params.checks === undefined ? {} : { checks: params.checks }) }) };
		case "block_task":
			return { label: "Block task", description: "Report blocker for current task.", parameters: Type.Object({ reason: Type.String() }), payload: (params) => ({ reason: params.reason }) };
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

async function defaultDelay(milliseconds: number): Promise<void> {
	await new Promise<void>((done) => { setTimeout(done, milliseconds); });
}

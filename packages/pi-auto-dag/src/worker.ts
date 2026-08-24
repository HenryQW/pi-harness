import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	managedSubagentName,
	type ManagedSubagentHost,
	type ManagedSubagentHostOptions,
	type PiLaunch,
	type ResolveRoleLaunchInput,
	type Role,
} from "@henryqw/pi-subagent";
import { commandFailure, commandOutput, runCommand, type CommandRunner } from "./command.ts";
import { DEFAULT_REQUIRED_GATE_TIMEOUT_MS, type DeliveryGraph, type LocalIssue, type WorkerEnvelope } from "./model.ts";
import { readActionTicket, readWorkerReceipt, type ActionTicket } from "./review-ticket.ts";
import { nonEmptyString, oneOf, positiveInteger } from "./validate.ts";

export type WorkerRole = "implementer" | "reviewer";

export const WORKER_TOOLS = {
	request_review: "auto_dag_request_review",
	submit_review: "auto_dag_submit_review",
	block_task: "auto_dag_block_task",
} as const;

export type WorkerEvent = keyof typeof WORKER_TOOLS;

export const WORKER_ROLE_EVENTS: Record<WorkerRole, WorkerEvent[]> = {
	implementer: ["request_review", "block_task"],
	reviewer: ["submit_review", "block_task"],
};

export type WorkerLaunch = PiLaunch;
export type RoleLaunchResolver = (input: ResolveRoleLaunchInput) => WorkerLaunch;

export interface WorkerLaunchInput {
	resolveLaunch: RoleLaunchResolver;
	workerRole: WorkerRole;
	role: Role;
	events?: WorkerEvent[];
	run_id: string;
	issue_id: string;
	main_pane: string;
	action_ticket: string;
	required_gate_timeout_ms: number;
}

export const WORKER_EXTENSION_PATH = fileURLToPath(new URL("../extensions/worker.ts", import.meta.url));
export const AUTO_DAG_TASK_IDS = {
	implement: "pi-auto-dag/implement",
	review: "pi-auto-dag/review",
} as const;
const WORKER_DELIVERY_MARGIN_MS = 60_000;

/** A Role owns launch policy; Auto DAG contributes only its protocol adapter, phase tools, and action identity. */
export function createWorkerLaunch(input: WorkerLaunchInput): WorkerLaunch {
	const workerRole = parseWorkerRole(input.workerRole);
	const events = parseWorkerEvents(input.events ?? WORKER_ROLE_EVENTS[workerRole], workerRole);
	return input.resolveLaunch({
		role: input.role,
		taskId: workerRole === "reviewer" ? AUTO_DAG_TASK_IDS.review : AUTO_DAG_TASK_IDS.implement,
		extensions: [WORKER_EXTENSION_PATH],
		tools: events.map((event) => WORKER_TOOLS[event]),
		env: {
			PI_AUTO_DAG_WORKER_ROLE: workerRole,
			PI_AUTO_DAG_WORKER_EVENTS: events.join(","),
			PI_AUTO_DAG_RUN_ID: nonEmptyString(input.run_id, "worker run_id"),
			PI_AUTO_DAG_ISSUE_ID: nonEmptyString(input.issue_id, "worker issue_id"),
			PI_AUTO_DAG_MAIN_PANE: nonEmptyString(input.main_pane, "worker main_pane"),
			PI_AUTO_DAG_ACTION_TICKET: nonEmptyString(input.action_ticket, "worker action ticket"),
			PI_AUTO_DAG_DELIVERY_TIMEOUT_MS: String(positiveInteger(input.required_gate_timeout_ms, "worker required gate timeout") + WORKER_DELIVERY_MARGIN_MS),
		},
	});
}

export function workerAgentName(workspaceId: string, runId: string, roleKey: string, role: WorkerRole): string {
	const suffix = role === "implementer" ? "-i" : "-r";
	return `${managedSubagentName(workspaceId, "pi-auto-dag", runId, roleKey, role).slice(0, -suffix.length)}${suffix}`;
}

export function workerHost(state: { main_worktree: string; workspace_id: string }): ManagedSubagentHost {
	return { cwd: state.main_worktree, workspaceId: state.workspace_id };
}

export function workerHostOptions(options: { runner: CommandRunner; delay?: (milliseconds: number) => Promise<void> }): ManagedSubagentHostOptions {
	return { execute: options.runner, ...(options.delay ? { delay: options.delay } : {}) };
}

interface WorkerEnvironment {
	role: WorkerRole;
	events: WorkerEvent[];
	run_id: string;
	issue_id: string;
	main_pane: string;
	action_ticket: string;
	delivery_timeout_ms: number;
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
		delivery_timeout_ms: environment.PI_AUTO_DAG_DELIVERY_TIMEOUT_MS === undefined
			? DEFAULT_DELIVERY_TIMEOUT_MS
			: positiveInteger(Number(environment.PI_AUTO_DAG_DELIVERY_TIMEOUT_MS), "worker delivery timeout"),
	};
}

export interface WorkerDeliveryOptions {
	deliveryAttempts?: number;
	deliveryTimeoutMs?: number;
	delay?: (milliseconds: number) => Promise<void>;
	ticket?: ActionTicket | Promise<ActionTicket>;
}

const DEFAULT_DELIVERY_TIMEOUT_MS = DEFAULT_REQUIRED_GATE_TIMEOUT_MS + WORKER_DELIVERY_MARGIN_MS;
const COMPACT_RESUME_MESSAGE = "Auto-compact completed. Retry worker event submission now.";

export async function sendWorkerEnvelope(
	worker: WorkerEnvironment,
	type: WorkerEvent,
	payload: Record<string, unknown>,
	runner: CommandRunner = runCommand,
	cwd = process.cwd(),
	delivery: WorkerDeliveryOptions = {},
): Promise<WorkerEnvelope> {
	if (!worker.events.includes(type)) throw new Error(`${worker.role} worker cannot send ${type}`);
	let ticket = await (delivery.ticket ?? readWorkerActionTicket(worker));
	if (ticket.role !== worker.role) throw new Error(`Action ticket role ${ticket.role} does not match ${worker.role} worker`);
	let envelope = await buildWorkerEnvelope(worker, type, payload, ticket, runner, cwd);
	let existing = await readWorkerReceipt(ticket.receipt_path);
	if (existing?.status === "rejected") {
		const replacement = await readWorkerActionTicket(worker);
		if (sameAction(ticket, replacement)) {
			if (replacement.event_id === ticket.event_id) existing = undefined;
			else {
				ticket = replacement;
				envelope = await buildWorkerEnvelope(worker, type, payload, ticket, runner, cwd);
				existing = await readWorkerReceipt(ticket.receipt_path);
			}
		}
	}
	if (existing) return requireReceipt(envelope, existing);

	const attempts = delivery.deliveryAttempts ?? 3;
	const timeoutMs = delivery.deliveryTimeoutMs ?? worker.delivery_timeout_ms;
	if (!Number.isInteger(attempts) || attempts < 1) throw new Error("worker deliveryAttempts must be a positive integer");
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("worker deliveryTimeoutMs must be a positive integer");
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const args = ["agent", "prompt", worker.main_pane, JSON.stringify(envelope), "--wait", "--timeout", String(timeoutMs)];
			const result = await runner("herdr", args, { cwd });
			if (result.code !== 0) throw new Error(commandFailure("herdr", args, result));
		} catch (error) {
			lastError = error;
			const receipt = await waitForReceipt(ticket.receipt_path, delivery.delay);
			if (receipt) return requireReceipt(envelope, receipt);
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

async function readWorkerActionTicket(worker: WorkerEnvironment): Promise<ActionTicket> {
	const ticket = await readActionTicket(worker.action_ticket);
	if (ticket.role !== worker.role) throw new Error(`Action ticket role ${ticket.role} does not match ${worker.role} worker`);
	return ticket;
}

function sameAction(left: ActionTicket, right: ActionTicket): boolean {
	return left.attempt === right.attempt
		&& left.review_round === right.review_round
		&& left.role === right.role
		&& left.review_id === right.review_id;
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

type WorkerTurn = { ticket?: Promise<ActionTicket>; reported: boolean };

export function createWorkerExtension(options: WorkerExtensionOptions = {}) {
	return (pi: ExtensionAPI) => {
		const environment = options.environment ?? process.env;
		const runWorkerValues = [
			environment.PI_AUTO_DAG_WORKER_ROLE,
			environment.PI_AUTO_DAG_RUN_ID,
			environment.PI_AUTO_DAG_ISSUE_ID,
			environment.PI_AUTO_DAG_MAIN_PANE,
		];
		if (runWorkerValues.every((value) => value === undefined)) return;
		const worker = workerEnvironment(environment);
		const runner = options.runner ?? runCommand;
		const cwd = options.cwd ?? process.cwd();
		let compacting = false;
		let turn: WorkerTurn = { reported: false };
		pi.on("input", async () => {
			const current = { reported: false, ticket: readWorkerActionTicket(worker) };
			turn = current;
			await current.ticket;
		});
		pi.on("tool_call", (event, ctx) => {
			if (!Object.values(WORKER_TOOLS).includes(event.toolName as typeof WORKER_TOOLS[WorkerEvent])) return;
			const usage = ctx.getContextUsage();
			if (compacting || usage?.percent == null || usage.percent <= 75) return;
			compacting = true;
			ctx.compact({
				customInstructions: "Preserve current task, worker action intent, and retry submission after compaction.",
				onComplete: () => {
					compacting = false;
					setImmediate(() => {
						if (ctx.isIdle()) pi.sendUserMessage(COMPACT_RESUME_MESSAGE, { deliverAs: "followUp" });
					});
				},
				onError: () => { compacting = false; },
			});
			return { block: true, terminate: true, reason: "Auto-compact ran before worker event submission; retry event." };
		});
		for (const type of worker.events) registerWorkerTool(pi, worker, type, runner, cwd, () => turn, options);
	};
}

function registerWorkerTool(
	pi: ExtensionAPI,
	worker: WorkerEnvironment,
	type: WorkerEvent,
	runner: CommandRunner,
	cwd: string,
	turn: () => WorkerTurn,
	delivery: WorkerDeliveryOptions,
): void {
	const definition = eventDefinition(type);
	pi.registerTool(defineTool({
		name: WORKER_TOOLS[type],
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		async execute(_toolCallId, params) {
			const current = turn();
			if (current.reported) throw new Error("Worker turn already submitted a terminal report");
			current.reported = true;
			try {
				const payload = definition.payload(params as Record<string, unknown>);
				await sendWorkerEnvelope(worker, type, payload, runner, cwd, current.ticket ? { ...delivery, ticket: current.ticket } : delivery);
				return {
					content: [{ type: "text", text: `Accepted ${type} for ${worker.issue_id}.` }],
					details: { status: "accepted" },
					terminate: true,
				};
			} catch (error) {
				current.reported = false;
				throw error;
			}
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

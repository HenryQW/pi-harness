import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runDirectory, type Uuid } from "./state.ts";
import { exactKeys, nonEmptyString, object, oneOf, positiveInteger } from "./validate.ts";

export type ReviewKind = "implementation" | "final_check" | "final_repair";
export type ReviewTicketScope = "implementation" | "lifecycle";
export type ActionTicketRole = "implementer" | "reviewer";

export interface ReviewIdentity {
	run_id: string;
	kind: ReviewKind;
	issue_id: string;
	commit: string;
	attempt: number;
	review_round: number;
}

export function reviewId(identity: ReviewIdentity): string {
	return createHash("sha256").update(JSON.stringify([
		identity.run_id,
		identity.kind,
		identity.issue_id,
		identity.commit,
		identity.attempt,
		identity.review_round,
	])).digest("hex");
}

export interface ActionTicket {
	version: 1;
	event_id: string;
	attempt: number;
	review_round: number;
	role: ActionTicketRole;
	receipt_path: string;
	review_id?: string;
}

export interface WorkerReceipt {
	version: 1;
	event_id: string;
	status: "accepted" | "rejected";
	reason?: string;
}

export class WorkerEnvelopeRejectedError extends Error {
	override name = "WorkerEnvelopeRejectedError";
}

export async function rejectWorkerEnvelope(
	receiptPath: string | undefined,
	eventId: string,
	reason: string,
	uuid: Uuid = randomUUID,
): Promise<never> {
	if (receiptPath && !(await readWorkerReceipt(receiptPath))) {
		await writeWorkerReceipt(receiptPath, { event_id: eventId, status: "rejected", reason }, uuid);
	}
	throw new WorkerEnvelopeRejectedError(reason);
}

export function actionTicketPath(
	mainWorktree: string,
	runId: string,
	issueId: string,
	scope: ReviewTicketScope,
	role: ActionTicketRole,
): string {
	return join(runDirectory(mainWorktree, runId), "action-tickets", `${issueId}-${scope}-${role}.json`);
}

export function eventReceiptPath(mainWorktree: string, runId: string, eventId: string): string {
	const id = nonEmptyString(eventId, "worker event_id");
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("worker event_id contains unsafe path characters");
	return join(runDirectory(mainWorktree, runId), "event-receipts", `${id}.json`);
}

export async function writeActionTicket(path: string, ticket: ActionTicket, uuid: Uuid = randomUUID): Promise<void> {
	const value = parseActionTicket(ticket);
	await mkdir(dirname(path), { recursive: true });
	await unlink(value.receipt_path).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
	const temporary = `${path}.${uuid()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

export async function readActionTicket(path: string): Promise<ActionTicket> {
	return parseActionTicket(JSON.parse(await readFile(path, "utf8")));
}

export async function assertActiveActionTicket(path: string, action: ActionTicket): Promise<void> {
	let ticket: ActionTicket;
	try {
		ticket = await readActionTicket(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new WorkerEnvelopeRejectedError(`Worker event ${action.event_id} does not match active action ticket`);
		}
		throw error;
	}
	if (
		ticket.event_id !== action.event_id
		|| ticket.attempt !== action.attempt
		|| ticket.review_round !== action.review_round
		|| ticket.role !== action.role
		|| ticket.receipt_path !== action.receipt_path
		|| (action.review_id !== undefined && ticket.review_id !== action.review_id)
	) throw new WorkerEnvelopeRejectedError(`Worker event ${action.event_id} does not match active action ticket`);
}

export async function ensureActionTicket(
	path: string,
	input: Omit<ActionTicket, "version" | "event_id" | "receipt_path">,
	mainWorktree: string,
	runId: string,
	uuid: Uuid,
	eventUuid: () => string = randomUUID,
): Promise<ActionTicket> {
	try {
		const current = await readActionTicket(path);
		if (current.attempt === input.attempt && current.review_round === input.review_round && current.role === input.role && current.review_id === input.review_id) {
			const receipt = await readWorkerReceipt(current.receipt_path);
			if (!receipt) return current;
			if (receipt.event_id !== current.event_id) throw new Error("Worker receipt belongs to another event");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const event_id = eventUuid();
	const ticket: ActionTicket = {
		version: 1,
		event_id,
		attempt: input.attempt,
		review_round: input.review_round,
		role: input.role,
		receipt_path: eventReceiptPath(mainWorktree, runId, event_id),
		...(input.review_id === undefined ? {} : { review_id: input.review_id }),
	};
	await writeActionTicket(path, ticket, uuid);
	return ticket;
}

export async function rotateRejectedActionTicket(
	path: string,
	eventId: string,
	mainWorktree: string,
	runId: string,
	uuid: Uuid,
): Promise<ActionTicket | undefined> {
	let current: ActionTicket;
	try {
		current = await readActionTicket(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (current.event_id !== eventId) return undefined;
	return await ensureActionTicket(path, {
		attempt: current.attempt,
		review_round: current.review_round,
		role: current.role,
		...(current.review_id === undefined ? {} : { review_id: current.review_id }),
	}, mainWorktree, runId, uuid);
}

export async function writeWorkerReceipt(path: string, receipt: Omit<WorkerReceipt, "version"> & { version?: 1 }, uuid: Uuid = randomUUID): Promise<void> {
	const value = parseWorkerReceipt({ version: 1, ...receipt });
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${uuid()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

export async function readWorkerReceipt(path: string): Promise<WorkerReceipt | undefined> {
	try {
		return parseWorkerReceipt(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function parseActionTicket(value: unknown): ActionTicket {
	const input = object(value, "action ticket");
	exactKeys(input, input.review_id === undefined
		? ["version", "event_id", "attempt", "review_round", "role", "receipt_path"]
		: ["version", "event_id", "attempt", "review_round", "role", "receipt_path", "review_id"], "action ticket");
	if (input.version !== 1) throw new Error(`Unsupported action ticket version: ${String(input.version)}`);
	return {
		version: 1,
		event_id: nonEmptyString(input.event_id, "action ticket event_id"),
		attempt: positiveInteger(input.attempt, "action ticket attempt"),
		review_round: positiveInteger(input.review_round, "action ticket review_round"),
		role: oneOf(input.role, ["implementer", "reviewer"] as const, "action ticket role"),
		receipt_path: nonEmptyString(input.receipt_path, "action ticket receipt_path"),
		...(input.review_id === undefined ? {} : { review_id: nonEmptyString(input.review_id, "action ticket review_id") }),
	};
}

function parseWorkerReceipt(value: unknown): WorkerReceipt {
	const input = object(value, "worker receipt");
	exactKeys(input, input.reason === undefined ? ["version", "event_id", "status"] : ["version", "event_id", "status", "reason"], "worker receipt");
	if (input.version !== 1) throw new Error(`Unsupported worker receipt version: ${String(input.version)}`);
	const status = oneOf(input.status, ["accepted", "rejected"] as const, "worker receipt status");
	return {
		version: 1,
		event_id: nonEmptyString(input.event_id, "worker receipt event_id"),
		status,
		...(input.reason === undefined ? {} : { reason: nonEmptyString(input.reason, "worker receipt reason") }),
	};
}

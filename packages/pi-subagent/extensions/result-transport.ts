import type { Usage } from "@earendil-works/pi-ai";
import {
	capEphemeralSubagentOutput,
	type EphemeralSubagentResult,
	type WorktreePayload,
} from "@henryqw/pi-subagent";
import type { WorkflowEntry, WorkflowMode } from "./workflow.ts";

const EVIDENCE_PREVIEW_CODE_POINTS = 256;

export type WorkflowTransportStatus = "pending" | "running" | "succeeded" | "failed" | "rejected" | "skipped";

type TransportEntryBase = {
	id: WorkflowEntry["id"];
	index: WorkflowEntry["index"];
	role: WorkflowEntry["delegation"]["role"];
	model?: string;
	thinkingLevel?: string;
	worktreePayload?: WorktreePayload;
	usage?: Usage;
};

export type WorkflowTransportEntry =
	| TransportEntryBase & { status: "pending" | "skipped"; assistantOutput?: never; failure?: never }
	| TransportEntryBase & {
		status: "running" | "succeeded";
		assistantOutput: EphemeralSubagentResult["output"];
		failure?: never;
	}
	| TransportEntryBase & { status: "failed" | "rejected"; assistantOutput?: never; failure: string };

export type WorkflowTransportEntryDetails = {
	id: string;
	index: number;
	role: string;
	status: WorkflowTransportStatus;
	model?: string;
	thinkingLevel?: string;
	worktree?: WorktreePayload;
};

export type WorkflowTransportDetails = {
	mode: WorkflowMode;
	entries: WorkflowTransportEntryDetails[];
};

export type WorkflowTransport = {
	text: string;
	details: WorkflowTransportDetails;
	usage?: Usage;
	failed: boolean;
};

type TransportKind = "result" | "update" | "background" | "abort";
type Evidence = { heading: string; preview: string; remainder: string };

function compareEntries(left: WorkflowTransportEntry, right: WorkflowTransportEntry): number {
	return left.index - right.index || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function splitEvidence(text: string): [string, string] {
	const preview = Array.from(text).slice(0, EVIDENCE_PREVIEW_CODE_POINTS).join("");
	return [preview, text.slice(preview.length)];
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
	return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function addUsage(left: Usage | undefined, right: Usage): Usage {
	const cacheWrite1h = sumOptional(left?.cacheWrite1h, right.cacheWrite1h);
	const reasoning = sumOptional(left?.reasoning, right.reasoning);
	return {
		input: (left?.input ?? 0) + right.input,
		output: (left?.output ?? 0) + right.output,
		cacheRead: (left?.cacheRead ?? 0) + right.cacheRead,
		cacheWrite: (left?.cacheWrite ?? 0) + right.cacheWrite,
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: (left?.totalTokens ?? 0) + right.totalTokens,
		cost: {
			input: (left?.cost.input ?? 0) + right.cost.input,
			output: (left?.cost.output ?? 0) + right.cost.output,
			cacheRead: (left?.cost.cacheRead ?? 0) + right.cost.cacheRead,
			cacheWrite: (left?.cost.cacheWrite ?? 0) + right.cost.cacheWrite,
			total: (left?.cost.total ?? 0) + right.cost.total,
		},
	};
}

function label(kind: TransportKind, failed: boolean): string {
	if (kind === "update") return "Workflow update.";
	if (kind === "background") return `Background workflow ${failed ? "failed" : "succeeded"}.`;
	if (kind === "abort") return "Workflow aborted.";
	return `Workflow ${failed ? "failed" : "succeeded"}.`;
}

function evidenceFor(entry: WorkflowTransportEntry): Evidence | undefined {
	if (entry.status === "pending" || entry.status === "skipped") return;
	const source = entry.status === "failed" || entry.status === "rejected" ? entry.failure : entry.assistantOutput;
	const [preview, remainder] = splitEvidence(source || (entry.status === "running" ? "(no output yet)" : "(no output)"));
	return {
		heading: `- [${entry.index}] ${JSON.stringify(entry.id)} ${entry.status === "failed" || entry.status === "rejected" ? "failure" : "assistant"}:`,
		preview,
		remainder,
	};
}

function formatWorkflowTransport(
	mode: WorkflowMode,
	entries: readonly WorkflowTransportEntry[],
	kind: TransportKind,
): WorkflowTransport {
	const ordered = [...entries].sort(compareEntries);
	if (kind !== "update" && ordered.some(({ status }) => status === "pending" || status === "running")) {
		throw new TypeError("Final workflow transport requires terminal entry states.");
	}
	const failed = ordered.some(({ status }) => status === "failed" || status === "rejected");
	const recoveries = ordered.filter(({ worktreePayload }) => worktreePayload && !worktreePayload.pruned);
	const evidence = ordered.flatMap((entry) => {
		const value = evidenceFor(entry);
		return value ? [value] : [];
	});
	const lines = [
		label(kind, failed),
		`Mode: ${mode}`,
		"Entries:",
		...ordered.map((entry) =>
			`- [${entry.index}] id=${JSON.stringify(entry.id)} role=${JSON.stringify(entry.role)} status=${entry.status}`),
		...(recoveries.length ? [
			"Retained worktrees:",
			...recoveries.map((entry) =>
				`- [${entry.index}] path=${JSON.stringify(entry.worktreePayload!.path)} branch=${JSON.stringify(entry.worktreePayload!.branch)}`),
		] : []),
		...(evidence.length ? [
			"Evidence:",
			...evidence.flatMap(({ heading, preview }) => [heading, preview]),
			...(evidence.some(({ remainder }) => remainder) ? [
				"Continued evidence:",
				...evidence.flatMap(({ heading, remainder }) => remainder ? [heading, remainder] : []),
			] : []),
		] : []),
	];
	let usage: Usage | undefined;
	for (const entry of ordered) if (entry.usage) usage = addUsage(usage, entry.usage);
	return {
		text: capEphemeralSubagentOutput(lines.join("\n")),
		details: {
			mode,
			entries: ordered.map((entry) => ({
				id: entry.id,
				index: entry.index,
				role: entry.role,
				status: entry.status,
				...(entry.model === undefined ? {} : { model: entry.model }),
				...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
				...(entry.worktreePayload === undefined ? {} : { worktree: { ...entry.worktreePayload } }),
			})),
		},
		...(usage === undefined ? {} : { usage }),
		failed,
	};
}

export function formatWorkflowResult(
	mode: WorkflowMode,
	entries: readonly WorkflowTransportEntry[],
): WorkflowTransport {
	return formatWorkflowTransport(mode, entries, "result");
}

export function formatWorkflowUpdate(
	mode: WorkflowMode,
	entries: readonly WorkflowTransportEntry[],
): WorkflowTransport {
	return formatWorkflowTransport(mode, entries, "update");
}

export function formatBackgroundWorkflowResult(
	mode: WorkflowMode,
	entries: readonly WorkflowTransportEntry[],
): WorkflowTransport {
	return formatWorkflowTransport(mode, entries, "background");
}

export class WorkflowFailureError extends Error {
	override name = "WorkflowFailureError";
	readonly details: WorkflowTransportDetails;
	readonly usage?: Usage;
	readonly failed = true;

	constructor(mode: WorkflowMode, entries: readonly WorkflowTransportEntry[]) {
		const transport = formatWorkflowResult(mode, entries);
		if (!transport.failed) throw new TypeError("WorkflowFailureError requires a failed or rejected entry.");
		super(transport.text);
		this.details = transport.details;
		this.usage = transport.usage;
	}
}

export class WorkflowAbortedError extends Error {
	override name = "AbortError";
	readonly details: WorkflowTransportDetails;
	readonly usage?: Usage;
	readonly failed = true;

	constructor(mode: WorkflowMode, entries: readonly WorkflowTransportEntry[], cause: unknown) {
		const transport = formatWorkflowTransport(mode, entries, "abort");
		super(transport.text, { cause });
		this.details = transport.details;
		this.usage = transport.usage;
	}
}

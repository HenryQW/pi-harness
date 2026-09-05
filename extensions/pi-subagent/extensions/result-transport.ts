import type { Usage } from "@earendil-works/pi-ai";
import {
	addUsage,
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
	name: WorkflowEntry["delegation"]["name"];
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
	name: string;
	role: string;
	status: WorkflowTransportStatus;
	summary?: string;
	model?: string;
	thinkingLevel?: string;
	worktree?: WorktreePayload;
};

export type WorkflowTransportDetails = {
	mode: WorkflowMode;
	entries: WorkflowTransportEntryDetails[];
};

export type BackgroundWorkflowTransportDetails = WorkflowTransportDetails & {
	taskId: string;
	outcome: "completed" | "failed" | "aborted";
	recovery?: true;
	usage?: Usage;
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

function workflowTitle(mode: WorkflowMode): string {
	if (mode === "single") return "Delegation";
	if (mode === "parallel") return "Parallel delegation";
	return "Delegation chain";
}

function statusCounts(entries: readonly WorkflowTransportEntry[], kind: TransportKind): string[] {
	const count = (statuses: WorkflowTransportStatus[]) => entries.filter(({ status }) => statuses.includes(status)).length;
	const labels = kind === "update"
		? [["running"], ["succeeded"], ["failed", "rejected"], ["pending"], ["skipped"]] as const
		: [["failed", "rejected"], ["succeeded"], ["skipped"]] as const;
	const words = kind === "update" ? ["running", "completed", "failed", "queued", "skipped"] : ["failed", "completed", "skipped"];
	return labels.flatMap((statuses, index) => {
		const total = count([...statuses]);
		return total ? [`${total} ${words[index]}`] : [];
	});
}

function heading(mode: WorkflowMode, entries: readonly WorkflowTransportEntry[], kind: TransportKind, failed: boolean): string {
	const title = kind === "background" ? `Background ${workflowTitle(mode).toLowerCase()}` : workflowTitle(mode);
	if (kind === "update") return [title, ...statusCounts(entries, kind)].join(" · ");
	const outcome = kind === "abort" ? "stopped" : failed ? "failed" : "completed";
	return [`${title} ${outcome}`, ...statusCounts(entries, kind)].join(" · ");
}

export function displaySummary(text: string): string {
	const line = text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "";
	const normalized = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().replace(/^[-*+]\s+/, "").split(/\s+/).join(" ");
	return Array.from(normalized).slice(0, 160).join("");
}

export type WorkflowEntryStatusPresentation = { glyph: string; fallback: string };

const ENTRY_STATUS_PRESENTATION = {
	pending: { glyph: "○", fallback: "queued" },
	running: { glyph: "◌", fallback: "working" },
	succeeded: { glyph: "✓", fallback: "completed" },
	failed: { glyph: "✗", fallback: "failed" },
	rejected: { glyph: "✗", fallback: "failed" },
	skipped: { glyph: "–", fallback: "skipped" },
} as const satisfies Record<WorkflowTransportEntryDetails["status"], WorkflowEntryStatusPresentation>;

export function presentWorkflowEntryStatus(status: WorkflowTransportEntryDetails["status"]): WorkflowEntryStatusPresentation {
	return ENTRY_STATUS_PRESENTATION[status];
}

function sourceFor(entry: WorkflowTransportEntry): string | undefined {
	if (entry.status === "failed" || entry.status === "rejected") return entry.failure;
	if (entry.status === "running" || entry.status === "succeeded") return entry.assistantOutput;
}

function evidenceFor(entry: WorkflowTransportEntry, position: number, total: number): Evidence | undefined {
	const source = sourceFor(entry);
	if (source === undefined || !source) return;
	const [preview, remainder] = splitEvidence(source);
	return {
		heading: `- [${position}/${total}] ${entry.name} · ${entry.role} · ${entry.status === "failed" || entry.status === "rejected" ? "failure" : "result"}:`,
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
	const positioned = ordered.map((entry, index) => ({ entry, position: index + 1 }));
	const recoveries = positioned.flatMap(({ entry, position }) => {
		const worktree = entry.worktreePayload;
		return worktree === undefined || worktree.outcome === "pruned" ? [] : [{ entry, position, worktree }];
	});
	const evidence = kind === "update" ? [] : positioned.flatMap(({ entry, position }) => {
		const value = evidenceFor(entry, position, ordered.length);
		return value ? [value] : [];
	});
	const lines = [
		heading(mode, ordered, kind, failed),
		...positioned.map(({ entry, position }) => {
			const { glyph, fallback } = presentWorkflowEntryStatus(entry.status);
			const summary = displaySummary(sourceFor(entry) ?? "") || fallback;
			return `${glyph} [${position}/${ordered.length}] ${entry.name} · ${entry.role} — ${summary}`;
		}),
		...(recoveries.length ? [
			"Recovery:",
			...recoveries.map(({ entry, position, worktree }) =>
				`- [${position}/${ordered.length}] ${entry.name} · worktree ${JSON.stringify(worktree.path)} · branch ${JSON.stringify(worktree.branch)}`),
		] : []),
		...(evidence.length ? [
			"Results:",
			...evidence.flatMap(({ heading, preview }) => [heading, preview]),
			...(evidence.some(({ remainder }) => remainder) ? [
				"More detail:",
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
			entries: ordered.map((entry) => {
				const source = sourceFor(entry);
				return {
					id: entry.id,
					index: entry.index,
					name: entry.name,
					role: entry.role,
					status: entry.status,
					...(source === undefined ? {} : { summary: displaySummary(source) }),
					...(entry.model === undefined ? {} : { model: entry.model }),
					...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
					...(entry.worktreePayload === undefined ? {} : { worktree: { ...entry.worktreePayload } }),
				};
			}),
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

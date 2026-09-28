import { capEphemeralSubagentOutput } from "@henryqw/pi-subagent";
import type { WorkflowEntry, WorkflowMode } from "./workflow.ts";

const EVIDENCE_PREVIEW_CODE_POINTS = 256;

export type WorkflowTransportStatus = "pending" | "running" | "succeeded" | "rejected" | "skipped";

/** `assistantOutput` is read for running/succeeded entries and `failure` for rejected ones. */
export type WorkflowTransportEntry = {
	id: WorkflowEntry["id"];
	index: WorkflowEntry["index"];
	name: WorkflowEntry["delegation"]["name"];
	role: WorkflowEntry["delegation"]["role"];
	model?: string;
	thinkingLevel?: string;
	status: WorkflowTransportStatus;
	assistantOutput?: string;
	failure?: string;
};

export type WorkflowTransportEntryDetails = Omit<WorkflowTransportEntry, "assistantOutput" | "failure"> & { summary?: string };

export type WorkflowTransportDetails = {
	mode: WorkflowMode;
	entries: WorkflowTransportEntryDetails[];
};

export type BackgroundWorkflowTransportDetails = WorkflowTransportDetails & {
	taskId: string;
	outcome: "completed" | "failed";
	recovery?: true;
};

export type WorkflowTransport = {
	text: string;
	details: WorkflowTransportDetails;
	failed: boolean;
};

type Evidence = { heading: string; preview: string; remainder: string };

function splitEvidence(text: string): [string, string] {
	const preview = Array.from(text).slice(0, EVIDENCE_PREVIEW_CODE_POINTS).join("");
	return [preview, text.slice(preview.length)];
}

function workflowTitle(mode: WorkflowMode): string {
	if (mode === "single") return "Delegation";
	if (mode === "parallel") return "Parallel delegation";
	return "Delegation chain";
}

function statusCounts(entries: readonly WorkflowTransportEntry[]): string[] {
	const count = (status: WorkflowTransportStatus) => entries.filter((entry) => entry.status === status).length;
	return [
		...(count("rejected") ? [`${count("rejected")} failed`] : []),
		...(count("succeeded") ? [`${count("succeeded")} completed`] : []),
		...(count("skipped") ? [`${count("skipped")} skipped`] : []),
	];
}

export function displaySummary(text: string): string {
	const line = text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "";
	const normalized = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().replace(/^[-*+]\s+/, "").split(/\s+/).join(" ");
	return Array.from(normalized).slice(0, 160).join("");
}

export type WorkflowEntryStatusPresentation = { glyph: string; fallback: string };

export const ENTRY_STATUS_PRESENTATION = {
	pending: { glyph: "○", fallback: "queued" },
	running: { glyph: "◌", fallback: "working" },
	succeeded: { glyph: "✓", fallback: "completed" },
	rejected: { glyph: "✗", fallback: "failed" },
	skipped: { glyph: "–", fallback: "skipped" },
} as const satisfies Record<WorkflowTransportStatus, WorkflowEntryStatusPresentation>;

function sourceFor(entry: WorkflowTransportEntry): string | undefined {
	if (entry.status === "rejected") return entry.failure;
	if (entry.status === "running" || entry.status === "succeeded") return entry.assistantOutput;
}

function evidenceFor(entry: WorkflowTransportEntry, position: number, total: number): Evidence | undefined {
	const source = sourceFor(entry);
	if (source === undefined || !source) return;
	const [preview, remainder] = splitEvidence(source);
	return {
		heading: `- [${position}/${total}] ${entry.name} · ${entry.role} · ${entry.status === "rejected" ? "failure" : "result"}:`,
		preview,
		remainder,
	};
}

export function formatWorkflowResult(mode: WorkflowMode, entries: readonly WorkflowTransportEntry[]): WorkflowTransport {
	const ordered = [...entries].sort((left, right) => left.index - right.index);
	if (ordered.some(({ status }) => status === "pending" || status === "running")) {
		throw new TypeError("Final workflow transport requires terminal entry states.");
	}
	const failed = ordered.some(({ status }) => status === "rejected");
	const positioned = ordered.map((entry, index) => ({ entry, position: index + 1 }));
	const evidence = positioned.flatMap(({ entry, position }) => {
		const value = evidenceFor(entry, position, ordered.length);
		return value ? [value] : [];
	});
	const lines = [
		[`${workflowTitle(mode)} ${failed ? "failed" : "completed"}`, ...statusCounts(ordered)].join(" · "),
		...positioned.map(({ entry, position }) => {
			const { glyph, fallback } = ENTRY_STATUS_PRESENTATION[entry.status];
			const summary = displaySummary(sourceFor(entry) ?? "") || fallback;
			return `${glyph} [${position}/${ordered.length}] ${entry.name} · ${entry.role} — ${summary}`;
		}),
		...(evidence.length ? [
			"Results:",
			...evidence.flatMap(({ heading, preview }) => [heading, preview]),
			...(evidence.some(({ remainder }) => remainder) ? [
				"More detail:",
				...evidence.flatMap(({ heading, remainder }) => remainder ? [heading, remainder] : []),
			] : []),
		] : []),
	];
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
				};
			}),
		},
		failed,
	};
}

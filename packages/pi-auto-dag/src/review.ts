import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequiredGateEvidence } from "./command.ts";
import type { DeliveryGraph, LocalIssue, RunState } from "./model.ts";
import { runDirectory, type Uuid } from "./state.ts";
import { workerDeliveryContext, workerIssueContext } from "./worker.ts";

const OUTPUT_EXCERPT_CHARACTERS = 8 * 1024;
const OUTPUT_EXCERPT_HEAD = 2 * 1024;

export type ReviewKind = "implementation" | "final_check" | "final_repair" | "pr_health_repair";
export type ReviewPromptMode = "full" | "update" | "resend";

export interface ReviewPromptInput {
	kind: ReviewKind;
	graph: DeliveryGraph;
	issue: LocalIssue;
	worktree: string;
	base: string;
	gate: RequiredGateEvidence;
	main_worktree: string;
	run_id: string;
	prior_findings?: string[];
	resolution?: unknown;
	context?: Record<string, unknown>;
}

interface OutputReference {
	path: string;
	sha256: string;
}

/** Full gate output stays outside model context but remains available to its reviewer. */
export async function persistGateOutput(
	state: RunState,
	gateOwnerId: string,
	evidence: RequiredGateEvidence,
	uuid: Uuid,
): Promise<void> {
	const streams = (["stdout", "stderr"] as const).filter((stream) => evidence.output[stream].length > OUTPUT_EXCERPT_CHARACTERS);
	if (!streams.length) return;
	const references = gateOutputReferences(state.main_worktree, state.run_id, gateOwnerId, evidence);
	await mkdir(join(runDirectory(state.main_worktree, state.run_id), "gate-output", gateOwnerId, evidence.commit), { recursive: true });
	await Promise.all(streams.map(async (stream) => {
		await atomicWrite(references[stream].path, evidence.output[stream], `${stream}-${uuid()}`);
	}));
}

export function reviewPrompt(input: ReviewPromptInput, mode: ReviewPromptMode): Record<string, unknown> {
	if (mode === "resend") return { type: "auto_dag_resend" };
	const gate = gatePromptEvidence(input);
	if (mode === "update") return {
		type: "auto_dag_review_update",
		gate,
		...(input.prior_findings?.length ? { prior_findings: input.prior_findings } : {}),
		...(input.resolution === undefined ? {} : { resolution: input.resolution }),
	};
	return {
		type: "auto_dag_review",
		kind: input.kind,
		delivery: workerDeliveryContext(input.graph),
		issue: workerIssueContext(input.issue, false),
		worktree: input.worktree,
		base: input.base,
		gate,
		...(input.prior_findings?.length ? { prior_findings: input.prior_findings } : {}),
		...(input.resolution === undefined ? {} : { resolution: input.resolution }),
		...(input.context ? { context: input.context } : {}),
		instruction: "Inspect diff against acceptance and gate evidence. Auto DAG already verified worktree, base, and commit and ran frozen gate. Extra checks cannot replace gate. Submit only verdict and findings.",
	};
}

function gatePromptEvidence(input: ReviewPromptInput): Record<string, unknown> {
	const references = gateOutputReferences(input.main_worktree, input.run_id, input.issue.id, input.gate);
	return {
		command: input.gate.command,
		commit: input.gate.commit,
		exit_code: input.gate.exit_code,
		output: {
			stdout: outputExcerpt(input.gate.output.stdout, references.stdout),
			stderr: outputExcerpt(input.gate.output.stderr, references.stderr),
		},
	};
}

function outputExcerpt(output: string, reference: OutputReference): Record<string, unknown> {
	const truncated = output.length > OUTPUT_EXCERPT_CHARACTERS;
	if (!truncated) return { excerpt: output, bytes: Buffer.byteLength(output), truncated: false };
	const omitted = output.length - OUTPUT_EXCERPT_CHARACTERS;
	return {
		excerpt: `${output.slice(0, OUTPUT_EXCERPT_HEAD)}\n... ${omitted} characters omitted ...\n${output.slice(-(OUTPUT_EXCERPT_CHARACTERS - OUTPUT_EXCERPT_HEAD))}`,
		bytes: Buffer.byteLength(output),
		truncated: true,
		full_output: reference,
	};
}

function gateOutputReferences(
	mainWorktree: string,
	runId: string,
	gateOwnerId: string,
	evidence: RequiredGateEvidence,
): { stdout: OutputReference; stderr: OutputReference } {
	const directory = join(runDirectory(mainWorktree, runId), "gate-output", gateOwnerId, evidence.commit);
	return {
		stdout: outputReference(join(directory, "stdout.txt"), evidence.output.stdout),
		stderr: outputReference(join(directory, "stderr.txt"), evidence.output.stderr),
	};
}

function outputReference(path: string, output: string): OutputReference {
	return { path, sha256: createHash("sha256").update(output).digest("hex") };
}

async function atomicWrite(path: string, output: string, temporaryName: string): Promise<void> {
	const temporary = join(path, "..", `.${temporaryName}.tmp`);
	await writeFile(temporary, output, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

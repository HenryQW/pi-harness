import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RequiredGateExecution } from "./command.ts";
import type { DeliveryGraph, GateOutputEvidence, GateOutputReference, LocalIssue, RequiredGateEvidence, RunState } from "./model.ts";
import type { ReviewKind } from "./review-ticket.ts";
import { runDirectory, type Uuid } from "./state.ts";
import { workerDeliveryContext, workerIssueContext } from "./worker.ts";

const OUTPUT_EXCERPT_CHARACTERS = 8 * 1024;
const OUTPUT_EXCERPT_HEAD = 2 * 1024;

export type ReviewPromptMode = "full" | "update" | "resend";

export interface ReviewPromptInput {
	kind: ReviewKind;
	graph: DeliveryGraph;
	issue: LocalIssue;
	worktree: string;
	base: string;
	gate: RequiredGateEvidence;
	prior_findings?: string[];
	resolution?: unknown;
	context?: Record<string, unknown>;
}

/** Full gate output stays outside Run State and model context but remains available to its reviewer. */
export async function persistGateOutput(
	state: RunState,
	gateOwnerId: string,
	execution: RequiredGateExecution,
	uuid: Uuid,
): Promise<RequiredGateEvidence> {
	const references = gateOutputReferences(state.main_worktree, state.run_id, gateOwnerId, execution);
	const streams = ["stdout", "stderr"] as const;
	const output = Object.fromEntries(await Promise.all(streams.map(async (stream) => [
		stream,
		await persistOutput(execution.output[stream], references[stream], `${stream}-${uuid()}`),
	]))) as { stdout: GateOutputEvidence; stderr: GateOutputEvidence };
	return { command: execution.command, commit: execution.commit, exit_code: execution.exit_code, output };
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
	return {
		command: input.gate.command,
		commit: input.gate.commit,
		exit_code: input.gate.exit_code,
		output: input.gate.output,
	};
}

async function persistOutput(output: string, reference: GateOutputReference, temporaryName: string): Promise<GateOutputEvidence> {
	if (output.length <= OUTPUT_EXCERPT_CHARACTERS) {
		return { excerpt: output, bytes: Buffer.byteLength(output), truncated: false };
	}
	await mkdir(dirname(reference.path), { recursive: true });
	await atomicWrite(reference.path, output, temporaryName);
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
	evidence: RequiredGateExecution,
): { stdout: GateOutputReference; stderr: GateOutputReference } {
	const directory = join(runDirectory(mainWorktree, runId), "gate-output", gateOwnerId, evidence.commit);
	return {
		stdout: outputReference(join(directory, "stdout.txt"), evidence.output.stdout),
		stderr: outputReference(join(directory, "stderr.txt"), evidence.output.stderr),
	};
}

function outputReference(path: string, output: string): GateOutputReference {
	return { path, sha256: createHash("sha256").update(output).digest("hex") };
}

async function atomicWrite(path: string, output: string, temporaryName: string): Promise<void> {
	const temporary = join(path, "..", `.${temporaryName}.tmp`);
	await writeFile(temporary, output, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

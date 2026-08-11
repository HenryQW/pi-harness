import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acknowledgeRequiredGate, gateEvidenceRecord, requiredGateProcessPath, type GateEvidenceTarget, type RequiredGateExecution } from "./command.ts";
import type { DeliveryGraph, GateOutputEvidence, GateOutputReference, LocalIssue, RequiredGateEvidence, RunState } from "./model.ts";
import type { ReviewKind } from "./review-ticket.ts";
import { replaceTask, runDirectory, writeRunState, type Uuid } from "./state.ts";
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
	const executionId = createHash("sha256").update(execution.handoff?.launch_id ?? uuid()).digest("hex");
	const paths = gateOutputPaths(state.main_worktree, state.run_id, gateOwnerId, execution.commit, executionId);
	const streams = ["stdout", "stderr"] as const;
	const output = Object.fromEntries(await Promise.all(streams.map(async (stream) => [
		stream,
		await persistOutput(execution.output[stream], execution.output_files?.[stream], paths[stream], `${stream}-${uuid()}`),
	]))) as { stdout: GateOutputEvidence; stderr: GateOutputEvidence };
	return { command: execution.command, commit: execution.commit, exit_code: execution.exit_code, output };
}

export async function recordGateExecution(
	state: RunState,
	target: GateEvidenceTarget,
	execution: RequiredGateExecution,
	uuid: Uuid,
): Promise<RunState> {
	if (execution.handoff && (
		execution.handoff.target.kind !== target.kind
		|| execution.handoff.target.issue_id !== target.issue_id
	)) throw new Error("Required gate handoff evidence target changed before persistence");
	if (target.kind === "task" && !state.tasks[target.issue_id]) throw new Error(`Required gate target task is missing: ${target.issue_id}`);
	if (target.kind === "health" && !state.health) throw new Error("Required gate target health state is missing");
	const evidence = await persistGateOutput(state, target.issue_id, execution, uuid);
	const next = target.kind === "task"
		? replaceTask(state, target.issue_id, { ...state.tasks[target.issue_id], ...gateEvidenceRecord(evidence) })
		: { ...state, health: { ...state.health!, ...gateEvidenceRecord(evidence) } };
	await writeRunState(state.main_worktree, next, uuid);
	await acknowledgeRequiredGate(requiredGateProcessPath(state.main_worktree, state.run_id), execution);
	return next;
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
		instruction: "Inspect diff against acceptance and gate evidence. Auto DAG already verified worktree, base, and commit and ran exact approved gate. Extra checks cannot replace gate. Submit only verdict and findings.",
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

async function persistOutput(
	output: string,
	spooledPath: string | undefined,
	path: string,
	temporaryName: string,
): Promise<GateOutputEvidence> {
	if (spooledPath) {
		const contents = await readFile(spooledPath);
		if (contents.length <= OUTPUT_EXCERPT_CHARACTERS) {
			return { excerpt: contents.toString("utf8"), bytes: contents.length, truncated: false };
		}
		await mkdir(dirname(path), { recursive: true });
		await atomicWrite(path, contents, temporaryName);
		const omitted = contents.length - OUTPUT_EXCERPT_CHARACTERS;
		return {
			excerpt: `${contents.subarray(0, OUTPUT_EXCERPT_HEAD).toString("utf8")}\n... ${omitted} bytes omitted ...\n${contents.subarray(-(OUTPUT_EXCERPT_CHARACTERS - OUTPUT_EXCERPT_HEAD)).toString("utf8")}`,
			bytes: contents.length,
			truncated: true,
			full_output: outputReference(path, contents),
		};
	}
	if (output.length <= OUTPUT_EXCERPT_CHARACTERS) {
		return { excerpt: output, bytes: Buffer.byteLength(output), truncated: false };
	}
	await mkdir(dirname(path), { recursive: true });
	await atomicWrite(path, output, temporaryName);
	const omitted = output.length - OUTPUT_EXCERPT_CHARACTERS;
	return {
		excerpt: `${output.slice(0, OUTPUT_EXCERPT_HEAD)}\n... ${omitted} characters omitted ...\n${output.slice(-(OUTPUT_EXCERPT_CHARACTERS - OUTPUT_EXCERPT_HEAD))}`,
		bytes: Buffer.byteLength(output),
		truncated: true,
		full_output: outputReference(path, output),
	};
}

function gateOutputPaths(
	mainWorktree: string,
	runId: string,
	gateOwnerId: string,
	commit: string,
	executionId: string,
): { stdout: string; stderr: string } {
	const directory = join(runDirectory(mainWorktree, runId), "gate-output", gateOwnerId, commit, executionId);
	return {
		stdout: join(directory, "stdout.txt"),
		stderr: join(directory, "stderr.txt"),
	};
}

function outputReference(path: string, output: string | Buffer): GateOutputReference {
	return { path, sha256: createHash("sha256").update(output).digest("hex") };
}

async function atomicWrite(path: string, output: string | Buffer, temporaryName: string): Promise<void> {
	const temporary = join(path, "..", `.${temporaryName}.tmp`);
	await writeFile(temporary, output, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

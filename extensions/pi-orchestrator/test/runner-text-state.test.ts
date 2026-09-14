import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	OrchestratorRunner,
	type GitRuntime,
	type OrchestratorRuntime,
	type TaskCandidateInspector,
} from "../src/runner.ts";
import type { ExecuteRequest, TextTaskState, WorkspaceIdentity } from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

function mainIdentity(): WorkspaceIdentity {
	const oid = "a".repeat(40);
	return { branch: "refs/heads/main", head: oid, index: oid, tree: oid };
}

type AttentionRunner = {
	attention(task: TextTaskState, failure: string): void;
};

function markAttention(task: TextTaskState, failure: string): void {
	const runner = new OrchestratorRunner(
		{} as OrchestratorRuntime,
		{} as GitRuntime & TaskCandidateInspector,
	);
	(runner as unknown as AttentionRunner).attention(task, failure);
}

test("text attention fails a running latest attempt despite pending task state", () => {
	const failure = "Task execution stopped.";
	const task: TextTaskState = {
		taskId: "research",
		kind: "text",
		status: "pending",
		attempts: [{ number: 1, status: "running" }],
	};

	markAttention(task, failure);

	assert.deepEqual(task, {
		taskId: "research",
		kind: "text",
		status: "needs_attention",
		attempts: [{ number: 1, status: "failed", failure }],
		failure,
	});
});

test("text attention appends a failure despite running task state without a running latest attempt", () => {
	const failure = "Task execution stopped.";
	const task: TextTaskState = {
		taskId: "research",
		kind: "text",
		status: "running",
		attempts: [{ number: 1, status: "failed", failure: "Earlier attempt stopped." }],
	};

	markAttention(task, failure);

	assert.deepEqual(task, {
		taskId: "research",
		kind: "text",
		status: "needs_attention",
		attempts: [
			{ number: 1, status: "failed", failure: "Earlier attempt stopped." },
			{ number: 2, status: "failed", failure },
		],
		failure,
	});
});

test("text dispatch failure persists its failed running attempt", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-text-state-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	await mkdir(root);
	const store = new FileRunStore(join(directory, "agent"));
	const runner = new OrchestratorRunner(
		{
			now: () => 1,
			randomToken: () => "token-0000000000000001",
			preflight: async (input: { cwd: string }) => ({ root: input.cwd, main: mainIdentity() }),
		} as unknown as OrchestratorRuntime,
		{
			inspectMain: async () => mainIdentity(),
		} as unknown as GitRuntime & TaskCandidateInspector,
		store,
	);
	const request: ExecuteRequest = {
		id: "text-failure",
		goal: "Retain failed text-task state.",
		budgetMs: 1_000,
		tasks: [{
			id: "research",
			kind: "text",
			role: "researcher",
			modelClass: "fast",
			requirements: "Research the implementation.",
			deliverable: "Return the result.",
			dependsOn: [],
			contextFrom: [],
		}],
		finalChecks: [{ command: "true", args: [] }],
	};

	const result = await runner.execute(request, root);
	const task = result.state.tasks[0]!;
	if (task.kind !== "text") throw new Error("Expected a text task.");

	assert.equal(result.state.status, "needs_attention");
	assert.equal(task.status, "needs_attention");
	assert.equal(task.failure, "Execution was interrupted: Text task dispatch is not implemented.");
	assert.equal(task.attempts.at(-1)!.status, "failed");
	assert.equal(task.attempts.at(-1)!.failure, task.failure);
	assert.deepEqual((await store.load(root, request.id)).state.tasks[0], task);
});

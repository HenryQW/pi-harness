import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	MAX_TASKS,
	parseIntegrationState,
	parseIntegrationAction,
	integrationGenerationPasses,
	parseExecuteRequest,
	parseIdOnly,
	parseResumeRequest,
	parseRunState,
	RUN_STATE_VERSION,
	taskDependencies,
	type ChangesetTaskAttempt,
	type ChangesetTaskRequest,
	type ChangesetTaskState,
	type ExecuteRequest,
	type IntegrationState,
	type RunState,
	type TaskRequest,
	type TextTaskAttempt,
	type TextTaskRequest,
	type TextTaskState,
	type WorkspaceIdentity,
} from "../src/schema.ts";

type TaskOptions = {
	dependsOn?: string[];
	contextFrom?: string[];
	role?: string;
};

function textTask(id: string, options: TaskOptions = {}): TextTaskRequest {
	return {
		id,
		kind: "text",
		role: options.role ?? "researcher",
		modelClass: "fast",
		requirements: `Research ${id}.`,
		deliverable: `Explain ${id}.`,
		dependsOn: options.dependsOn ?? [],
		contextFrom: options.contextFrom ?? [],
	};
}

function changesetTask(id: string, options: TaskOptions & { judgment?: ChangesetTaskRequest["judgment"] } = {}): ChangesetTaskRequest {
	return {
		id,
		kind: "changeset",
		role: options.role ?? "implementer",
		modelClass: "balanced",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: options.dependsOn ?? [],
		contextFrom: options.contextFrom ?? [],
		checks: [{ command: `check-${id}`, args: [] }],
		...(options.judgment ? { judgment: options.judgment } : {}),
	};
}

function request(tasks: TaskRequest[], finalJudgment?: ExecuteRequest["finalJudgment"]): ExecuteRequest {
	return {
		id: "request-one",
		goal: "Deliver checked work.",
		mode: "isolated",
		tasks,
		finalChecks: [{ command: "check-final", args: [] }],
		...(finalJudgment ? { finalJudgment } : {}),
	};
}

function identity(): WorkspaceIdentity {
	return {
		branch: "refs/heads/main",
		head: "a".repeat(40),
		index: "a".repeat(40),
		tree: "a".repeat(40),
	};
}

function state(requestValue: ExecuteRequest): RunState {
	const main = identity();
	return {
		version: RUN_STATE_VERSION,
		request: requestValue,
		policy: {
			maxSubagents: 5,
			maxTurns: 50,
			childIdleMs: 600_000,
			childMaxMs: 1_800_000,
			maxCorrections: 1,
		},
		correctionCount: 0,
		root: "/repo",
		requestStartMain: main,
		main,
		status: "pending",
		tasks: requestValue.tasks.map((task): RunState["tasks"][number] => task.kind === "text"
			? {
				taskId: task.id,
				kind: "text",
				status: "completed",
				attempts: [{ number: 1, status: "completed", output: { text: "Research result." } }],
			}
			: { taskId: task.id, kind: "changeset", status: "pending", attempts: [] }),
		waves: [],
		integration: { candidates: [], generations: [] },
		final: { status: "pending" },
		accepted: false,
		createdAt: 1,
		updatedAt: 1,
	};
}

function completedChangesetState(): RunState {
	const definition = parseExecuteRequest(request([changesetTask("change", {
		judgment: { role: "reviewer", modelClass: "frontier", criterion: "Review the exact candidate." },
	})]));
	const task = definition.tasks[0];
	if (task?.kind !== "changeset" || !task.judgment) throw new Error("Expected a judged changeset task.");
	const base = identity();
	const worktreeBase = { ...base, branch: "refs/heads/subagent/change" };
	const revision = "b".repeat(40);
	const candidate: WorkspaceIdentity = { ...worktreeBase, head: revision, index: revision, tree: revision };
	const mainAfter: WorkspaceIdentity = { ...candidate, branch: base.branch };
	const correlationToken = "completed-change-token";
	const attempt: ChangesetTaskAttempt = {
		number: 1,
		waveNumber: 1,
		waveBase: base,
		correlationToken,
		allocationGeneration: 1,
		allocations: [
			{
				kind: "worktree",
				generation: 1,
				token: correlationToken,
				status: "owned",
				worktree: {
					path: "/repo/.worktrees/change",
					cwd: "/repo/.worktrees/change",
					branch: worktreeBase.branch,
					repoRoot: "/repo",
					baseCommit: base.head,
				},
			},
			{
				kind: "workspace",
				generation: 1,
				token: correlationToken,
				status: "owned",
				label: "change workspace",
				worktreeCwd: "/repo/.worktrees/change",
				mainRoot: "/repo",
				repoKey: "/repo",
				herdrRepoRoot: "/repo",
				workspaceId: "workspace-change",
				rootTabId: "root-tab-change",
				rootPaneId: "root-pane-change",
			},
			{
				kind: "worker_tab",
				generation: 1,
				token: correlationToken,
				status: "owned",
				label: "change worker",
				workspaceId: "workspace-change",
				workspaceRootTabId: "root-tab-change",
				workspaceRootPaneId: "root-pane-change",
				worktreeCwd: "/repo/.worktrees/change",
				leasePath: "/repo/.worktrees/change/.lease",
				tabId: "worker-tab-change",
				paneId: "worker-pane-change",
			},
			{
				kind: "agent",
				generation: 1,
				token: correlationToken,
				status: "owned",
				agentName: "worker-change",
				workspaceId: "workspace-change",
				tabId: "worker-tab-change",
				paneId: "worker-pane-change",
				worktreeCwd: "/repo/.worktrees/change",
				leasePath: "/repo/.worktrees/change/.lease",
			},
		],
		prompts: [{ kind: "initial", status: "settled", preCandidate: worktreeBase, candidate, at: 2 }],
		candidate,
		candidateBase: base,
		preliminaryChecks: {
			phase: "preliminary",
			candidate,
			identityAfter: candidate,
			results: [{ ...task.checks[0]!, code: 0, killed: false, stdout: "", stderr: "" }],
			passed: true,
			at: 2,
		},
		readiness: { candidate, base, at: 3 },
		transitions: [{ kind: "rebase", status: "rebased", sourceBase: base, from: candidate, onto: base, to: candidate, at: 10 }],
		termination: { status: "terminated", workerId: "worker-change", candidate, at: 6 },
		integrationBase: base,
		integrationCandidate: candidate,
		authoritativeChecks: {
			phase: "authoritative",
			candidate,
			identityAfter: candidate,
			results: [{ ...task.checks[0]!, code: 0, killed: false, stdout: "", stderr: "" }],
			passed: true,
			at: 4,
		},
		authoritativeReview: {
			phase: "authoritative",
			criterion: task.judgment.criterion,
			base,
			tip: candidate,
			identityAfter: candidate,
			verdict: "PASS",
			passed: true,
			at: 5,
		},
		integration: { status: "integrated", expectedMain: base, candidate, mainAfter },
		cleanup: [
			{ kind: "worker_tab", status: "completed" },
			{ kind: "workspace", status: "completed" },
			{ kind: "worktree", status: "completed" },
			{ kind: "branch", status: "completed" },
		],
	};
	return {
		version: RUN_STATE_VERSION,
		request: definition,
		policy: {
			maxSubagents: 5,
			maxTurns: 50,
			childIdleMs: 600_000,
			childMaxMs: 1_800_000,
			maxCorrections: 1,
		},
		correctionCount: 0,
		root: "/repo",
		requestStartMain: base,
		main: mainAfter,
		status: "running",
		tasks: [{ taskId: task.id, kind: "changeset", status: "completed", attempts: [attempt] }],
		waves: [{ number: 1, base, taskIds: [task.id], status: "completed" }],
		integration: { candidates: [], generations: [] },
		final: { status: "pending" },
		accepted: false,
		createdAt: 1,
		updatedAt: 5,
	};
}

function completedChangesetTask(value: RunState): ChangesetTaskState {
	const task = value.tasks[0];
	if (task?.kind !== "changeset") throw new Error("Expected a changeset task.");
	return task;
}

function completedChangesetAttempt(value: RunState): ChangesetTaskAttempt {
	const attempt = completedChangesetTask(value).attempts.at(-1);
	if (!attempt) throw new Error("Expected a changeset attempt.");
	return attempt;
}

test("task variants require explicit Role names and preserve text context order", () => {
	const parsed = parseExecuteRequest(request([
		textTask("plan", { role: "  planner  " }),
		textTask("research", { role: "  custom role/v2  " }),
		textTask("notes"),
		changesetTask("change", {
			dependsOn: ["plan"],
			contextFrom: ["research", "notes"],
			role: "  maintainer  ",
			judgment: { role: "  reviewer  ", modelClass: "frontier", criterion: "Review exactly." },
		}),
	], { role: "  final reviewer  ", modelClass: "fav", criterion: "Accept only complete work." }));

	assert.equal(parsed.tasks[0]!.role, "planner");
	assert.equal(parsed.tasks[1]!.role, "custom role/v2");
	const change = parsed.tasks[3]!;
	assert.equal(change.kind, "changeset");
	if (change.kind !== "changeset") throw new Error("Expected a changeset task.");
	assert.equal(change.role, "maintainer");
	assert.equal(change.judgment?.role, "reviewer");
	assert.equal(parsed.finalJudgment?.role, "final reviewer");
	assert.deepEqual(change.contextFrom, ["research", "notes"]);
	assert.deepEqual(taskDependencies(change), ["plan", "research", "notes"]);

	const changeset = changesetTask("change");
	const { checks: _checks, ...changesetWithoutChecks } = changeset;
	const { role: _role, ...textWithoutRole } = textTask("text");
	const strictFailures: Array<{ value: unknown; path: RegExp }> = [
		{
			value: request([{ ...textTask("text"), checks: [{ command: "forbidden", args: [] }] } as unknown as TaskRequest]),
			path: / at \/tasks\/0\/checks:/,
		},
		{
			value: request([{ ...textTask("text"), judgment: { role: "reviewer", modelClass: "fast", criterion: "forbidden" } } as unknown as TaskRequest]),
			path: / at \/tasks\/0\/judgment:/,
		},
		{ value: request([changesetWithoutChecks as unknown as TaskRequest]), path: / at \/tasks\/0\/checks:/ },
		{ value: request([textWithoutRole as unknown as TaskRequest]), path: / at \/tasks\/0\/role:/ },
		{
			value: request([changesetTask("change", {
				judgment: { modelClass: "fast", criterion: "missing role" } as unknown as ChangesetTaskRequest["judgment"],
			})]),
			path: / at \/tasks\/0\/judgment\/role:/,
		},
		{
			value: request([textTask("text")], {
				modelClass: "fast",
				criterion: "missing role",
			} as unknown as ExecuteRequest["finalJudgment"]),
			path: / at \/finalJudgment\/role:/,
		},
		{
			value: { ...request([textTask("text")]), approval: "supervised" },
			path: / at \/approval:/,
		},
	];
	for (const { value, path } of strictFailures) {
		assert.throws(() => parseExecuteRequest(value), (error: unknown) => {
			assert.match(String(error), /strict task schema/);
			assert.match(String(error), path);
			return true;
		});
	}
	assert.throws(() => parseExecuteRequest(request([textTask("text", { role: "bad\nrole" })])), /name must not contain C0\/C1 control characters/);
});

test("tool request validation reports one bounded field path without echoing values", () => {
	const secret = "do-not-echo-this-value";
	assert.throws(() => parseIdOnly({ id: "Bad" }), (error: unknown) => {
		assert.match(String(error), / at \/id:/);
		assert.doesNotMatch(String(error), new RegExp(secret));
		return true;
	});
	assert.throws(() => parseResumeRequest({ id: "request-one", action: secret, taskId: "change" }), (error: unknown) => {
		assert.match(String(error), / at \/action:/);
		assert.doesNotMatch(String(error), new RegExp(secret));
		assert.ok(String(error).length < 700);
		return true;
	});
});

test("the graph rejects invalid context edges and detects context cycles", () => {
	const invalidGraphs: TaskRequest[][] = [
		Array.from({ length: MAX_TASKS + 1 }, (_, index) => textTask(`task-${index}`)),
		[textTask("duplicate"), changesetTask("duplicate")],
		[changesetTask("change", { dependsOn: ["missing"] })],
		[changesetTask("change", { contextFrom: ["missing"] })],
		[textTask("source"), changesetTask("change", { dependsOn: ["source", "source"] })],
		[textTask("source"), changesetTask("change", { contextFrom: ["source", "source"] })],
		[textTask("self", { dependsOn: ["self"] })],
		[textTask("self", { contextFrom: ["self"] })],
		[textTask("source"), changesetTask("change", { dependsOn: ["source"], contextFrom: ["source"] })],
		[changesetTask("source"), changesetTask("change", { contextFrom: ["source"] })],
		[textTask("first", { contextFrom: ["second"] }), textTask("second", { contextFrom: ["first"] })],
	];
	for (const tasks of invalidGraphs) assert.throws(() => parseExecuteRequest(request(tasks)));
});

test("follow-up prompt evidence requires exact bounded instructions", () => {
	const valid = completedChangesetState();
	const attempt = completedChangesetAttempt(valid);
	const candidate = attempt.candidate!;
	attempt.prompts.push({
		kind: "followup",
		status: "settled",
		preCandidate: candidate,
		candidate,
		instruction: "Revise the retained candidate.",
		at: 3,
	});
	assert.equal(parseRunState(structuredClone(valid)).tasks[0]?.status, "completed");

	for (const instruction of [" padded ", "bad\0instruction"]) {
		const invalid = structuredClone(valid);
		completedChangesetAttempt(invalid).prompts.at(-1)!.instruction = instruction;
		assert.throws(() => parseRunState(invalid), /Follow-up prompt instruction.*exact non-empty text/);
	}

	const repeatedCorrection = completedChangesetState();
	const repeatedAttempt = completedChangesetAttempt(repeatedCorrection);
	for (let index = 0; index < 2; index += 1) {
		repeatedAttempt.prompts.push({
			kind: "correction",
			status: "settled",
			preCandidate: repeatedAttempt.candidate!,
			candidate: repeatedAttempt.candidate!,
			at: 3 + index,
		});
	}
	repeatedCorrection.policy.maxCorrections = 2;
	repeatedCorrection.correctionCount = 2;
	assert.throws(() => parseRunState(repeatedCorrection), /repeated correction history/);
});

test("completed changesets require exact terminal evidence", () => {
	const valid = completedChangesetState();
	assert.equal(completedChangesetTask(parseRunState(structuredClone(valid))).status, "completed");

	const invalidStates: Array<{
		name: string;
		mutate: (value: RunState) => void;
		error: RegExp;
	}> = [
		{
			name: "worker termination names another agent",
			mutate: (value) => { completedChangesetAttempt(value).termination!.workerId = "other-agent"; },
			error: /does not match the exact owned agent/,
		},
		{
			name: "worker termination is not complete",
			mutate: (value) => {
				const termination = completedChangesetAttempt(value).termination;
				if (!termination) throw new Error("Expected worker termination evidence.");
				termination.status = "terminating";
				delete termination.at;
			},
			error: /no exact recorded worker termination/,
		},
		{
			name: "integrated task has no durable readiness",
			mutate: (value) => { delete completedChangesetAttempt(value).readiness; },
			error: /does not match its exact candidate lineage/,
		},
		{
			name: "integrated task ends with an unresolved rebase",
			mutate: (value) => {
				const transition = completedChangesetAttempt(value).transitions[0]!;
				transition.status = "rebasing";
				delete transition.to;
			},
			error: /does not match its exact candidate lineage/,
		},
		{
			name: "ready rebase lineage is disconnected",
			mutate: (value) => {
				completedChangesetAttempt(value).transitions[0]!.from = { ...identity(), head: "c".repeat(40), index: "c".repeat(40), tree: "c".repeat(40) };
			},
			error: /breaks exact lineage/,
		},
		{
			name: "authoritative checks do not pass",
			mutate: (value) => {
				const checks = completedChangesetAttempt(value).authoritativeChecks;
				if (!checks) throw new Error("Expected authoritative checks.");
				checks.results[0]!.code = 1;
				checks.results[0]!.stderr = "check failed";
				checks.passed = false;
			},
			error: /lacks authoritative passing checks on its exact candidate/,
		},
		{
			name: "authoritative checks cover another candidate",
			mutate: (value) => {
				const checks = completedChangesetAttempt(value).authoritativeChecks;
				if (!checks) throw new Error("Expected authoritative checks.");
				const other = { ...checks.candidate, head: "c".repeat(40), index: "c".repeat(40), tree: "c".repeat(40) };
				checks.candidate = other;
				checks.identityAfter = other;
			},
			error: /lacks authoritative passing checks on its exact candidate/,
		},
		{
			name: "required judgment is missing",
			mutate: (value) => { delete completedChangesetAttempt(value).authoritativeReview; },
			error: /lacks an exact authoritative passing review/,
		},
		{
			name: "required judgment does not pass",
			mutate: (value) => {
				const review = completedChangesetAttempt(value).authoritativeReview;
				if (!review) throw new Error("Expected authoritative review.");
				review.verdict = "NEEDS_WORK";
				review.passed = false;
			},
			error: /lacks an exact authoritative passing review/,
		},
		{
			name: "integrated task identity is dirty",
			mutate: (value) => {
				const mainAfter = completedChangesetAttempt(value).integration?.mainAfter;
				if (!mainAfter) throw new Error("Expected final task identity.");
				mainAfter.index = "c".repeat(40);
			},
			error: /lacks exact integration evidence/,
		},
		{
			name: "integrated task identity does not match the candidate",
			mutate: (value) => {
				const mainAfter = completedChangesetAttempt(value).integration?.mainAfter;
				if (!mainAfter) throw new Error("Expected final task identity.");
				mainAfter.head = "c".repeat(40);
				mainAfter.index = mainAfter.head;
				mainAfter.tree = mainAfter.head;
			},
			error: /lacks exact integration evidence/,
		},
		{
			name: "latest attempt is still integrating",
			mutate: (value) => {
				const integration = completedChangesetAttempt(value).integration;
				if (!integration) throw new Error("Expected integration evidence.");
				integration.status = "integrating";
				delete integration.mainAfter;
			},
			error: /lacks exact integration evidence/,
		},
		{
			name: "cleanup is incomplete",
			mutate: (value) => { completedChangesetAttempt(value).cleanup[2]!.status = "pending"; },
			error: /has incomplete cleanup/,
		},
		{
			name: "completed task has no attempt",
			mutate: (value) => { completedChangesetTask(value).attempts = []; },
			error: /lacks an exact owned worktree record/,
		},
	];
	for (const { name, mutate, error } of invalidStates) {
		const candidate = structuredClone(valid);
		mutate(candidate);
		assert.throws(() => parseRunState(candidate), error, name);
	}

	const interruptedFinalization = structuredClone(valid);
	interruptedFinalization.status = "needs_attention";
	interruptedFinalization.accepted = false;
	const interruptedTask = completedChangesetTask(interruptedFinalization);
	interruptedTask.status = "needs_attention";
	interruptedTask.failure = "Finalization was interrupted.";
	delete completedChangesetAttempt(interruptedFinalization).integration!.mainAfter;
	assert.throws(() => parseRunState(interruptedFinalization), /lacks exact integration evidence/);
});

test("v5 state maps text task attempts exactly and rejects v4 and launch state", () => {
	const definition = parseExecuteRequest(request([
		textTask("research"),
		changesetTask("change", { contextFrom: ["research"] }),
	]));
	const valid = state(definition);
	const output = { text: "Research result." };
	type TextStateMapping = {
		name: string;
		status: TextTaskState["status"];
		attempts: TextTaskAttempt[];
		taskFailure?: string;
		accepted: boolean;
	};
	const mappings: TextStateMapping[] = [
		{ name: "pending with no attempts", status: "pending", attempts: [], accepted: true },
		{ name: "pending with a running attempt", status: "pending", attempts: [{ number: 1, status: "running" }], accepted: false },
		{ name: "pending with a completed attempt", status: "pending", attempts: [{ number: 1, status: "completed", output }], accepted: false },
		{ name: "pending with a failed attempt", status: "pending", attempts: [{ number: 1, status: "failed" }], accepted: false },
		{ name: "running with no attempts", status: "running", attempts: [], accepted: false },
		{ name: "running with a running attempt", status: "running", attempts: [{ number: 1, status: "running" }], accepted: true },
		{ name: "running with a completed attempt", status: "running", attempts: [{ number: 1, status: "completed", output }], accepted: false },
		{ name: "running with a failed attempt", status: "running", attempts: [{ number: 1, status: "failed" }], accepted: false },
		{ name: "completed with no attempts", status: "completed", attempts: [], accepted: false },
		{ name: "completed with a running attempt", status: "completed", attempts: [{ number: 1, status: "running" }], accepted: false },
		{ name: "completed with a completed attempt", status: "completed", attempts: [{ number: 1, status: "completed", output }], accepted: true },
		{ name: "completed with a failed attempt", status: "completed", attempts: [{ number: 1, status: "failed" }], accepted: false },
		{ name: "needs_attention with no attempts", status: "needs_attention", attempts: [], taskFailure: "Task failed.", accepted: false },
		{ name: "needs_attention with a running attempt", status: "needs_attention", attempts: [{ number: 1, status: "running" }], taskFailure: "Task failed.", accepted: false },
		{ name: "needs_attention with a completed attempt", status: "needs_attention", attempts: [{ number: 1, status: "completed", output }], taskFailure: "Task failed.", accepted: false },
		{ name: "needs_attention with a failed attempt", status: "needs_attention", attempts: [{ number: 1, status: "failed", failure: "Task failed." }], taskFailure: "Task failed.", accepted: true },
		{ name: "needs_attention with no latest attempt failure", status: "needs_attention", attempts: [{ number: 1, status: "failed" }], taskFailure: "Task failed.", accepted: false },
		{ name: "needs_attention with a mismatched latest attempt failure", status: "needs_attention", attempts: [{ number: 1, status: "failed", failure: "Attempt failed." }], taskFailure: "Task failed.", accepted: false },
		{ name: "pending with a task failure", status: "pending", attempts: [], taskFailure: "Unexpected failure.", accepted: false },
		{ name: "running with a task failure", status: "running", attempts: [{ number: 1, status: "running" }], taskFailure: "Unexpected failure.", accepted: false },
		{ name: "completed with a task failure", status: "completed", attempts: [{ number: 1, status: "completed", output }], taskFailure: "Unexpected failure.", accepted: false },
		{ name: "needs_attention without a task failure", status: "needs_attention", attempts: [{ number: 1, status: "failed" }], accepted: false },
		{ name: "running after a failed attempt", status: "running", attempts: [
			{ number: 1, status: "failed", failure: "First attempt failed." },
			{ number: 2, status: "running" },
		], accepted: true },
		{ name: "completed after a failed attempt", status: "completed", attempts: [
			{ number: 1, status: "failed" },
			{ number: 2, status: "completed", output },
		], accepted: true },
		{ name: "needs_attention after a failed attempt", status: "needs_attention", attempts: [
			{ number: 1, status: "failed" },
			{ number: 2, status: "failed", failure: "Retry failed." },
		], taskFailure: "Retry failed.", accepted: true },
		{ name: "running after a non-latest running attempt", status: "running", attempts: [
			{ number: 1, status: "running" },
			{ number: 2, status: "running" },
		], accepted: false },
		{ name: "completed after a non-latest completed attempt", status: "completed", attempts: [
			{ number: 1, status: "completed", output },
			{ number: 2, status: "completed", output },
		], accepted: false },
		{ name: "needs_attention after a non-latest failed output", status: "needs_attention", attempts: [
			{ number: 1, status: "failed", output },
			{ number: 2, status: "failed" },
		], taskFailure: "Retry failed.", accepted: false },
		{ name: "completed without output", status: "completed", attempts: [{ number: 1, status: "completed" }], accepted: false },
		{ name: "needs_attention with failed output", status: "needs_attention", attempts: [{ number: 1, status: "failed", output }], taskFailure: "Task failed.", accepted: false },
	];
	for (const mapping of mappings) {
		const candidate = structuredClone(valid);
		const task = candidate.tasks[0]!;
		if (task.kind !== "text") throw new Error("Expected a text task.");
		task.status = mapping.status;
		task.attempts = structuredClone(mapping.attempts);
		if (mapping.taskFailure === undefined) delete task.failure;
		else task.failure = mapping.taskFailure;
		if (mapping.accepted) assert.doesNotThrow(() => parseRunState(candidate), mapping.name);
		else assert.throws(() => parseRunState(candidate), (_error: unknown): true => true, mapping.name);
	}

	const oldTaskField = structuredClone(valid) as RunState & { tasks: Array<Record<string, unknown>> };
	oldTaskField.tasks[1]!.implementerLaunchKey = "implementer/balanced";
	assert.throws(() => parseRunState(oldTaskField), /Unsupported or malformed pi-subagent v5 state/);

	const oldLaunchState = { ...structuredClone(valid), launchRecords: {} };
	assert.throws(() => parseRunState(oldLaunchState), /Unsupported or malformed pi-subagent v5 state/);

	const v4 = { ...structuredClone(valid), version: 4 };
	assert.throws(() => parseRunState(v4), /Unsupported pi-subagent state version 4; expected 5/);
	const v2 = { ...structuredClone(valid), version: 2 };
	assert.throws(() => parseRunState(v2), /Unsupported pi-subagent state version 2; expected 5/);
	const v1 = { ...structuredClone(valid), version: 1, launchRecords: {} };
	assert.throws(() => parseRunState(v1), /Unsupported pi-subagent state version 1; expected 5/);
});

test("state bounds multibyte text task runtime fields by UTF-8 bytes", () => {
	const definition = parseExecuteRequest(request([textTask("research")]));
	const valid = state(definition);
	const character = "界";
	const repeated = character.repeat(Math.floor(MAX_PERSISTED_RUNTIME_TEXT_BYTES / Buffer.byteLength(character, "utf8")));
	const atLimit = `${repeated}${"a".repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES - Buffer.byteLength(repeated, "utf8"))}`;
	const tooLong = `${atLimit}${character}`;
	assert.equal(Buffer.byteLength(atLimit, "utf8"), MAX_PERSISTED_RUNTIME_TEXT_BYTES);
	assert.ok(tooLong.length <= MAX_PERSISTED_RUNTIME_TEXT_BYTES);

	const outputAtLimit = structuredClone(valid);
	const outputTask = outputAtLimit.tasks[0]!;
	if (outputTask.kind !== "text") throw new Error("Expected a text task.");
	outputTask.attempts[0]!.output = { text: atLimit };
	assert.doesNotThrow(() => parseRunState(outputAtLimit));

	const invalidFields: Array<{ name: string; mutate: (task: TextTaskState) => void }> = [
		{
			name: "attempt failure",
			mutate: (task) => {
				task.status = "needs_attention";
				task.attempts = [{ number: 1, status: "failed", failure: tooLong }];
				task.failure = "Task failed.";
			},
		},
		{
			name: "task failure",
			mutate: (task) => {
				task.status = "needs_attention";
				task.attempts = [{ number: 1, status: "failed" }];
				task.failure = tooLong;
			},
		},
		{
			name: "output",
			mutate: (task) => {
				task.status = "completed";
				task.attempts = [{ number: 1, status: "completed", output: { text: tooLong } }];
			},
		},
	];
	for (const { name, mutate } of invalidFields) {
		const candidate = structuredClone(valid);
		const task = candidate.tasks[0]!;
		if (task.kind !== "text") throw new Error("Expected a text task.");
		mutate(task);
		assert.throws(() => parseRunState(candidate), new RegExp(`exceeds ${MAX_PERSISTED_RUNTIME_TEXT_BYTES} UTF-8 bytes`), name);
	}
});

function integrationFixture(): { request: ExecuteRequest; state: IntegrationState } {
	const definition = parseExecuteRequest(request([changesetTask("first"), changesetTask("second")]));
	const main = identity();
	const workerBase = { ...main, branch: "refs/heads/worker-first" };
	const workerTip = { ...workerBase, head: "b".repeat(40), index: "b".repeat(40), tree: "b".repeat(40) };
	const secondBase = { ...main, branch: "refs/heads/worker-second" };
	const secondTip = { ...secondBase, head: "c".repeat(40), index: "c".repeat(40), tree: "c".repeat(40) };
	const integrationBase = { ...main, branch: "refs/heads/integration" };
	const firstTip = { ...integrationBase, head: "d".repeat(40), index: "d".repeat(40), tree: "d".repeat(40) };
	const combinedTip = { ...integrationBase, head: "e".repeat(40), index: "e".repeat(40), tree: "e".repeat(40) };
	const checks = (tip: WorkspaceIdentity, command: string, phase: "preliminary" | "final") => ({
		phase, candidate: tip, identityAfter: tip,
		results: [{ command, args: [], code: 0, killed: false, stdout: "", stderr: "" }],
		passed: true, at: 5,
	});
	return {
		request: definition,
		state: {
			candidates: [
				{ taskId: "first", attempt: 1, base: main, tip: workerTip, checks: checks(workerTip, "check-first", "preliminary"), worker: "retained" },
				{ taskId: "second", attempt: 1, base: main, tip: secondTip, checks: checks(secondTip, "check-second", "preliminary"), worker: "retained" },
			],
			generations: [{
				number: 1, status: "ready", expectedMain: main, integrationBase,
				order: ["first", "second"], stages: [
					{ taskId: "first", attempt: 1, source: workerTip, onto: integrationBase, status: "staged", tip: firstTip },
					{ taskId: "second", attempt: 1, source: secondTip, onto: firstTip, status: "staged", tip: combinedTip },
				],
				combinedTip, checks: checks(combinedTip, "check-final", "final"),
			}],
		},
	};
}

test("Main-owned integration accepts independently based candidates and ordered combined evidence", () => {
	const { request: definition, state: valid } = integrationFixture();
	assert.equal(parseIntegrationState(structuredClone(valid), definition).generations[0]?.status, "ready");
	assert.equal(integrationGenerationPasses(valid.generations[0]!, definition), true);
	const generation = valid.generations[0]!;
	generation.status = "promoting";
	generation.promotion = { status: "promoting", expectedMain: generation.expectedMain, tip: generation.combinedTip! };
	assert.doesNotThrow(() => parseIntegrationState(valid, definition));
	generation.status = "promoted";
	generation.promotion = {
		status: "promoted", expectedMain: generation.expectedMain, tip: generation.combinedTip!,
		mainAfter: { ...generation.combinedTip!, branch: generation.expectedMain.branch },
	};
	valid.candidates[0]!.worker = "release_pending";
	assert.doesNotThrow(() => parseIntegrationState(valid, definition));
});

test("integration recovery rejects disconnected, duplicated, stale or released evidence", () => {
	const { request: definition, state: valid } = integrationFixture();
	const altered = (mutate: (state: IntegrationState) => void, error: RegExp): void => {
		const state = structuredClone(valid);
		mutate(state);
		assert.throws(() => parseIntegrationState(state, definition), error);
	};
	const other = { ...identity(), head: "f".repeat(40), index: "f".repeat(40), tree: "f".repeat(40) };
	altered((state) => { state.generations[0]!.order = ["first", "first"]; }, /choose distinct ready candidates/);
	altered((state) => { state.generations[0]!.order.reverse(); }, /breaks generation.*lineage/);
	altered((state) => { state.generations[0]!.stages[1]!.onto = other; }, /breaks generation.*lineage/);
	altered((state) => { state.generations[0]!.stages[1]!.source = state.candidates[0]!.tip; }, /breaks generation.*lineage/);
	altered((state) => { state.generations[0]!.stages[1]!.taskId = "first"; }, /breaks generation.*lineage/);
	altered((state) => { state.generations[0]!.combinedTip = other; }, /combined tip breaks staged lineage/);
	altered((state) => { state.generations[0]!.checks!.identityAfter = other; }, /inconsistent pass result/);
	altered((state) => { state.generations[0]!.checks!.candidate = other; state.generations[0]!.checks!.identityAfter = other; }, /checks target another tip/);
	altered((state) => { state.generations[0]!.checks!.results[0]!.args = ["--different"]; }, /exact declared command and argv/);
	altered((state) => { state.candidates[0]!.checks.candidate = other; }, /inconsistent pass result/);
	altered((state) => { state.candidates[0]!.worker = "released"; }, /released an unpromoted worker/);
	altered((state) => {
		state.generations[0]!.status = "promoting";
		state.generations[0]!.promotion = { status: "promoting", expectedMain: other, tip: state.generations[0]!.combinedTip! };
	}, /promotion has stale evidence or lineage/);
	altered((state) => {
		state.generations[0]!.status = "promoted";
		state.generations[0]!.promotion = {
			status: "promoted", expectedMain: state.generations[0]!.expectedMain,
			tip: state.generations[0]!.combinedTip!, mainAfter: other,
		};
	}, /inconsistent promotion outcome/);
	altered((state) => { state.generations[0]!.status = "superseded"; }, /retains usable evidence or lacks its reason/);
	altered((state) => {
		state.generations[0]!.status = "superseded";
		state.generations[0]!.supersededFrom = "ready";
		state.generations[0]!.failure = "New staging requested.";
		delete state.generations[0]!.combinedTip;
		delete state.generations[0]!.checks;
		state.generations.push({ ...structuredClone(state.generations[0]!), number: 2, expectedMain: other });
	}, /invalid Main base/);
	altered((state) => { (state.generations[0] as object as Record<string, unknown>).path = "/arbitrary"; }, /Malformed integration state/);
});

test("superseded generations invalidate old gates before a new Main choice", () => {
	const { request: definition, state } = integrationFixture();
	const old = state.generations[0]!;
	old.status = "superseded";
	old.supersededFrom = "ready";
	old.failure = "Main chose a new integration order.";
	delete old.checks;
	delete old.combinedTip;
	const next = structuredClone(old);
	next.number = 2;
	next.status = "staging";
	delete next.supersededFrom;
	delete next.failure;
	next.stages.reverse();
	next.order.reverse();
	next.stages[0]!.onto = next.integrationBase;
	next.stages[0]!.status = "pending";
	delete next.stages[0]!.tip;
	next.stages.pop();
	state.generations.push(next);
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	next.stages = [];
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	state.generations[0]!.checks = structuredClone(integrationFixture().state.generations[0]!.checks);
	assert.throws(() => parseIntegrationState(state, definition), /evidence without a complete tip|retains usable evidence/);
});

test("a revised staged candidate requires a fresh generation, preserving the old stage and invalidating old gates", () => {
	const { request: definition, state } = integrationFixture();
	const old = state.generations[0]!;
	old.status = "superseded";
	old.supersededFrom = "ready";
	old.failure = "Main requested a revised first candidate.";
	delete old.combinedTip;
	delete old.checks;
	const first = state.candidates[0]!;
	const revisedTip = { ...first.tip, head: "f".repeat(40), index: "f".repeat(40), tree: "f".repeat(40) };
	state.candidates.push({ ...structuredClone(first), attempt: 2, tip: revisedTip, checks: {
		...structuredClone(first.checks), candidate: revisedTip, identityAfter: revisedTip,
	} });
	const next = {
		number: 2, status: "staging" as const, expectedMain: old.expectedMain, integrationBase: old.integrationBase,
		order: ["first", "second"], stages: [] as typeof old.stages,
	};
	state.generations.push(next);
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	next.stages.push({ taskId: "first", attempt: 2, source: revisedTip, onto: next.integrationBase, status: "pending" });
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	next.stages[0]!.source = first.tip;
	assert.throws(() => parseIntegrationState(state, definition), /breaks generation.*lineage/);
	next.stages[0]!.source = first.tip;
	next.stages[0]!.attempt = 1;
	assert.throws(() => parseIntegrationState(state, definition), /latest ready attempt/);
});

test("a refreshed integration generation may follow an advanced clean Main without reusing final gates", () => {
	const { request: definition, state } = integrationFixture();
	const old = state.generations[0]!;
	old.status = "superseded";
	old.supersededFrom = "ready";
	old.failure = "Main advanced before promotion.";
	delete old.combinedTip;
	delete old.checks;
	const advanced = { ...old.expectedMain, head: "f".repeat(40), index: "f".repeat(40), tree: "f".repeat(40) };
	state.generations.push({ number: 2, status: "staging", expectedMain: advanced,
		integrationBase: { ...advanced, branch: "refs/heads/refreshed-integration" },
		order: ["first", "second"], stages: [] });
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	state.generations[1]!.expectedMain.index = "a".repeat(40);
	assert.throws(() => parseIntegrationState(state, definition), /invalid Main base/);
});

test("candidate and combined judgments must cover their exact bases and tips", () => {
	const { state } = integrationFixture();
	const definition = parseExecuteRequest(request([
		changesetTask("first", { judgment: { role: "reviewer", modelClass: "frontier", criterion: "Check first change." } }),
		changesetTask("second"),
	], { role: "reviewer", modelClass: "frontier", criterion: "Check combined change." }));
	const first = state.candidates[0]!;
	first.review = {
		phase: "preliminary", criterion: "Check first change.", base: first.base, tip: first.tip,
		identityAfter: first.tip, verdict: "PASS", passed: true, at: 6,
	};
	const generation = state.generations[0]!;
	generation.review = {
		phase: "final", criterion: "Check combined change.", base: generation.expectedMain, tip: generation.combinedTip!,
		identityAfter: generation.combinedTip!, verdict: "PASS", passed: true, at: 7,
	};
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	first.review.tip = state.candidates[1]!.tip;
	assert.throws(() => parseIntegrationState(state, definition), /lacks exact passing evidence/);
	first.review.tip = first.tip;
	generation.review.identityAfter = generation.integrationBase;
	assert.throws(() => parseIntegrationState(state, definition), /invalid combined review evidence/);
	generation.review.identityAfter = generation.combinedTip!;
	generation.status = "conflict";
	generation.stages[1]!.status = "conflict";
	delete generation.stages[1]!.tip;
	generation.stages[1]!.failure = "Same-file conflict requires Main resolution.";
	generation.failure = "Resolve in owned integration worktree.";
	delete generation.combinedTip;
	delete generation.checks;
	delete generation.review;
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
});

test("refresh intent binds empty new generation to the new Main and invalidates previous gates", () => {
	const { request: definition, state } = integrationFixture();
	const old = state.generations[0]!;
	old.status = "superseded";
	old.supersededFrom = "ready";
	old.failure = "Main advanced; retain old checkout.";
	delete old.combinedTip;
	delete old.checks;
	const newMain = { ...old.expectedMain, head: "f".repeat(40), index: "f".repeat(40), tree: "f".repeat(40) };
	state.refresh = { from: old.expectedMain, to: newMain, generation: 2, status: "pending" };
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	const branch = "pi-subagent/subagent-123456789012345678901234";
	const path = "/repo/.worktrees/subagent-123456789012345678901234";
	state.generations.push({ number: 2, status: "staging", expectedMain: newMain,
		integrationBase: { ...newMain, branch: `refs/heads/${branch}` }, order: [], stages: [],
		worktree: { branch, path, cwd: path, repoRoot: "/repo", baseCommit: newMain.head } });
	state.refresh = { ...state.refresh, status: "unknown", failure: "Allocation uncertain." };
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	state.refresh = { ...state.refresh, status: "ready", failure: undefined };
	assert.doesNotThrow(() => parseIntegrationState(state, definition));
	state.generations[1]!.expectedMain = old.expectedMain;
	assert.throws(() => parseIntegrationState(state, definition), /invalid Main base|Refreshed generation/);
});

test("refresh action requires exact old/new identities and excludes unrelated fields", () => {
	const old = identity();
	const next = { ...old, head: "f".repeat(40), index: "f".repeat(40), tree: "f".repeat(40) };
	const action = { id: "request-one", generation: 1, action: "refresh", expectedTip: old,
		expectedMain: old, newMain: next };
	assert.deepEqual(parseIntegrationAction(action), action);
	assert.throws(() => parseIntegrationAction({ ...action, newMain: undefined }), /subagent_integrate/);
	assert.throws(() => parseIntegrationAction({ ...action, instruction: "ignore" }), /subagent_integrate/);
	assert.throws(() => parseIntegrationAction({ ...action, action: "promote" }), /subagent_integrate/);
});

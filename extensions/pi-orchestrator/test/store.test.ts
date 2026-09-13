import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CLEANUP_KINDS,
	launchKey,
	launchRecordFingerprint,
	MAX_EXECUTE_REQUEST_BYTES,
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	MAX_POSSIBLE_RESOURCES,
	MODEL_CLASSES,
	parseExecuteRequest,
	type CheckBatchEvidence,
	type CheckCommand,
	type ExecuteRequest,
	type ModelClass,
	type NormalizedLaunchRecord,
	type Role,
	type RunState,
	type TaskAttempt,
	type WorkspaceIdentity,
} from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

const INITIAL_STATE_MAX_BYTES = 2 * 1024 * 1024;
const STATE_MAX_BYTES = 128 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 96 * 1024 * 1024;
const ESCAPED_BYTE = "\u0001";
const RUNTIME_TEXT = ESCAPED_BYTE.repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES);
const ABSOLUTE_RUNTIME_TEXT = `/${ESCAPED_BYTE.repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES - 1)}`;
const WORKTREE_BRANCH = ESCAPED_BYTE.repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES);
const oid = (character: string): string => character.repeat(40);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function identity(branch = "refs/heads/main"): WorkspaceIdentity {
	return { branch, head: oid("a"), index: oid("a"), tree: oid("a") };
}

function launch(role: Role, modelClass: ModelClass): NormalizedLaunchRecord {
	const path = `/roles/${role}-${modelClass}.ts`;
	const value: Omit<NormalizedLaunchRecord, "fingerprint"> = {
		key: launchKey(role, modelClass),
		role,
		modelClass,
		roleFingerprint: sha256(`${role}/${modelClass} Role identity`),
		promptSha256: sha256(`${role}/${modelClass} Role prompt`),
		promptArgIndex: 0,
		model: "provider/model",
		thinkingLevel: "high",
		args: [],
		env: {},
		tools: [],
		roleExtensions: [path],
		roleSkills: [],
		resources: [{ kind: "extension", path, sha256: sha256(path) }],
	};
	return { ...value, fingerprint: launchRecordFingerprint(value) };
}

function fingerprint(record: NormalizedLaunchRecord): void {
	const { fingerprint: _old, ...value } = record;
	record.fingerprint = launchRecordFingerprint(value);
}

function maximumRequest(): ExecuteRequest {
	const taskChecks = Array.from({ length: 8 }, (_, taskIndex): CheckCommand[] =>
		Array.from({ length: 32 }, (_, checkIndex) => ({
			command: `check-${taskIndex}-${checkIndex}`,
			args: Array.from({ length: 128 }, () => ""),
		})));
	const value: ExecuteRequest = {
		id: "maximum-state",
		goal: "g",
		budgetMs: 1_000,
		tasks: taskChecks.map((checks, index) => ({
			id: `task-${index}`,
			modelClass: MODEL_CLASSES[index % MODEL_CLASSES.length]!,
			requirements: "r",
			deliverable: "d",
			dependsOn: [],
			checks,
			judgment: { criterion: "j", modelClass: MODEL_CLASSES[index % MODEL_CLASSES.length]! },
		})),
		finalChecks: Array.from({ length: 32 }, (_, index) => ({
			command: `final-${index}`,
			args: Array.from({ length: 128 }, () => ""),
		})),
		finalJudgment: { criterion: "f", modelClass: "fast" },
	};

	for (const task of value.tasks) {
		for (const check of task.checks) {
			for (let index = 0; index < check.args.length; index += 1) {
				const size = Buffer.byteLength(JSON.stringify(value), "utf8");
				const length = Math.min(16_000, Math.floor((MAX_EXECUTE_REQUEST_BYTES - size) / 6));
				if (length <= 0) return parseExecuteRequest(value);
				check.args[index] = ESCAPED_BYTE.repeat(length);
			}
		}
	}
	return parseExecuteRequest(value);
}

function initialState(root: string, request: ExecuteRequest): RunState {
	const main = identity(RUNTIME_TEXT);
	const required = new Map<string, NormalizedLaunchRecord>();
	for (const task of request.tasks) {
		const implementer = launch("implementer", task.modelClass);
		required.set(implementer.key, implementer);
		if (task.judgment) {
			const reviewer = launch("reviewer", task.judgment.modelClass);
			required.set(reviewer.key, reviewer);
		}
	}
	if (request.finalJudgment) {
		const reviewer = launch("reviewer", request.finalJudgment.modelClass);
		required.set(reviewer.key, reviewer);
	}
	const records = Object.fromEntries([...required].map(([key, record]) => [key, record]));
	const state: RunState = {
		version: 1,
		request,
		root,
		requestStartMain: main,
		main,
		deadlineStartedAt: 1,
		deadline: 1_001,
		launchRecords: records,
		status: "pending",
		tasks: request.tasks.map((task) => ({
			taskId: task.id,
			status: "pending",
			implementerLaunchKey: launchKey("implementer", task.modelClass),
			...(task.judgment ? { judgmentLaunchKey: launchKey("reviewer", task.judgment.modelClass) } : {}),
			attempts: [],
		})),
		waves: [],
		final: { status: "pending" },
		accepted: false,
		createdAt: 1,
		updatedAt: 1,
	};

	for (const record of Object.values(records)) {
		while (record.args.length < 256) {
			record.args.push(ESCAPED_BYTE.repeat(32_000));
			fingerprint(record);
			if (Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`, "utf8") <= INITIAL_STATE_MAX_BYTES) continue;
			record.args.pop();
			let low = 0;
			let high = 32_000;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				record.args.push(ESCAPED_BYTE.repeat(middle));
				fingerprint(record);
				const fits = Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`, "utf8") <= INITIAL_STATE_MAX_BYTES;
				record.args.pop();
				if (fits) low = middle;
				else high = middle - 1;
			}
			if (low) record.args.push(ESCAPED_BYTE.repeat(low));
			fingerprint(record);
			return state;
		}
	}
	return state;
}

function checkEvidence(phase: CheckBatchEvidence["phase"], checks: CheckCommand[], candidate: WorkspaceIdentity): CheckBatchEvidence {
	return {
		phase,
		candidate,
		identityAfter: candidate,
		results: checks.map((check, index) => ({
			command: check.command,
			args: [...check.args],
			code: index === 0 ? 1 : 0,
			killed: index === 0,
			stdout: index === 0 ? RUNTIME_TEXT : "",
			stderr: index === 0 ? RUNTIME_TEXT : "",
		})),
		passed: false,
		at: 2,
	};
}

function maximumAttempt(checks: CheckCommand[], criterion: string, modelClass: ModelClass, number: number): TaskAttempt {
	const candidate = identity(RUNTIME_TEXT);
	const token = "a".repeat(128);
	const workspace = () => ({
		kind: "workspace" as const,
		generation: 2 as const,
		token,
		status: "owned" as const,
		label: RUNTIME_TEXT,
		worktreeCwd: ABSOLUTE_RUNTIME_TEXT,
		mainRoot: ABSOLUTE_RUNTIME_TEXT,
		repoKey: ABSOLUTE_RUNTIME_TEXT,
		herdrRepoRoot: ABSOLUTE_RUNTIME_TEXT,
		workspaceId: RUNTIME_TEXT,
		rootTabId: RUNTIME_TEXT,
		rootPaneId: RUNTIME_TEXT,
		failure: RUNTIME_TEXT,
	});
	return {
		number,
		waveNumber: number,
		waveBase: candidate,
		correlationToken: token,
		allocationGeneration: 2,
		allocations: [
			{
				kind: "worktree", generation: 1, token, status: "owned", failure: RUNTIME_TEXT,
				worktree: {
					path: ABSOLUTE_RUNTIME_TEXT,
					cwd: ABSOLUTE_RUNTIME_TEXT,
					branch: WORKTREE_BRANCH,
					repoRoot: ABSOLUTE_RUNTIME_TEXT,
					baseCommit: candidate.head,
				},
			},
			workspace(),
			workspace(),
			workspace(),
			{
				kind: "worker_tab", generation: 2, token, status: "unknown",
				label: RUNTIME_TEXT,
				workspaceId: RUNTIME_TEXT,
				workspaceRootTabId: RUNTIME_TEXT,
				workspaceRootPaneId: RUNTIME_TEXT,
				worktreeCwd: ABSOLUTE_RUNTIME_TEXT,
				leasePath: ABSOLUTE_RUNTIME_TEXT,
				failure: RUNTIME_TEXT,
				possibleResources: Array.from({ length: MAX_POSSIBLE_RESOURCES }, () => RUNTIME_TEXT),
			},
		],
		prompts: [
			{ kind: "initial", status: "settled", preCandidate: candidate, candidate, failure: RUNTIME_TEXT, at: 2 },
			{ kind: "correction", status: "settled", preCandidate: candidate, candidate, failure: RUNTIME_TEXT, at: 2 },
		],
		candidate,
		preliminaryChecks: checkEvidence("preliminary", checks, candidate),
		termination: { status: "unknown", workerId: RUNTIME_TEXT, candidate, at: 2, failure: RUNTIME_TEXT },
		integrationBase: candidate,
		integrationCandidate: candidate,
		authoritativeChecks: checkEvidence("authoritative", checks, candidate),
		authoritativeReview: {
			phase: "authoritative",
			launchKey: launchKey("reviewer", modelClass),
			criterion,
			base: candidate,
			tip: candidate,
			identityAfter: candidate,
			verdict: RUNTIME_TEXT,
			passed: false,
			at: 2,
		},
		integration: {
			status: "unknown",
			expectedMain: candidate,
			candidate,
			mainAfter: candidate,
			failure: RUNTIME_TEXT,
		},
		cleanup: CLEANUP_KINDS.map((kind) => ({ kind, status: "pending", failure: RUNTIME_TEXT })),
	};
}

function maximumState(base: RunState): RunState {
	const state = structuredClone(base);
	state.status = "needs_attention";
	state.tasks = state.request.tasks.map((task) => ({
		taskId: task.id,
		status: "needs_attention",
		implementerLaunchKey: launchKey("implementer", task.modelClass),
		judgmentLaunchKey: launchKey("reviewer", task.judgment!.modelClass),
		attempts: [
			maximumAttempt(task.checks, task.judgment!.criterion, task.judgment!.modelClass, 1),
			maximumAttempt(task.checks, task.judgment!.criterion, task.judgment!.modelClass, 2),
		],
		failure: RUNTIME_TEXT,
	}));
	state.waves = Array.from({ length: 8 }, (_, index) => ({
		number: index + 1,
		base: identity(RUNTIME_TEXT),
		taskIds: state.tasks.map((task) => task.taskId),
		status: "needs_attention",
	}));
	const candidate = identity(RUNTIME_TEXT);
	state.final = {
		status: "interrupted",
		identity: candidate,
		checks: checkEvidence("final", state.request.finalChecks, candidate),
		review: {
			phase: "final",
			launchKey: launchKey("reviewer", state.request.finalJudgment!.modelClass),
			criterion: state.request.finalJudgment!.criterion,
			base: candidate,
			tip: candidate,
			identityAfter: candidate,
			verdict: RUNTIME_TEXT,
			passed: false,
			at: 2,
		},
		failure: RUNTIME_TEXT,
	};
	state.recovery = { kind: "cleanup_only", taskId: state.tasks[0]!.taskId, deadline: 2 };
	state.updatedAt = 2;
	return state;
}

test("the deterministic maximum-valid state stays below the finite state cap with headroom", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "pi-orchestrator-store-"));
	const plannedRoot = join(sandbox, "repo");
	const agentDir = join(sandbox, "agent");
	await mkdir(plannedRoot);
	const root = await realpath(plannedRoot);
	try {
		const request = maximumRequest();
		assert.ok(MAX_EXECUTE_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(request), "utf8") < 6);
		const base = initialState(root, request);
		const baseBytes = Buffer.byteLength(`${JSON.stringify(base, null, 2)}\n`, "utf8");
		assert.ok(INITIAL_STATE_MAX_BYTES - baseBytes < 64);

		const store = new FileRunStore(agentDir);
		const handle = await store.create(base);
		handle.state = maximumState(base);
		await handle.save();
		const size = (await stat(handle.path)).size;
		assert.ok(size > 64 * 1024 * 1024, `maximum-valid fixture is only ${size} bytes`);
		assert.ok(size <= MAX_FIXTURE_BYTES, `maximum-valid fixture is ${size} bytes`);
		assert.ok(size < STATE_MAX_BYTES);
		assert.equal((await store.load(root, request.id)).state.tasks.length, 8);
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("invalid and cap+1 state files are rejected without replacement", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "pi-orchestrator-store-"));
	const plannedRoot = join(sandbox, "repo");
	const agentDir = join(sandbox, "agent");
	await mkdir(plannedRoot);
	const root = await realpath(plannedRoot);
	try {
		const store = new FileRunStore(agentDir);
		const request: ExecuteRequest = {
			id: "request-one",
			goal: "Preserve invalid state files.",
			budgetMs: 1_000,
			tasks: [{
				id: "task-one",
				modelClass: "fast",
				requirements: "Run every check.",
				deliverable: "Persist every result.",
				dependsOn: [],
				checks: [{ command: "check", args: [] }],
			}],
			finalChecks: [{ command: "final-check", args: [] }],
		};
		const record = launch("implementer", "fast");
		const base = initialState(root, request);
		base.launchRecords = { [record.key]: record };
		const handle = await store.create(base);

		const malformedPath = store.statePath(root, "malformed");
		const malformed = "{}\n";
		await writeFile(malformedPath, malformed);
		await assert.rejects(store.load(root, "malformed"), /Unsupported or malformed pi-orchestrator v1 state/);
		assert.equal(await readFile(malformedPath, "utf8"), malformed);

		const unsupportedPath = store.statePath(root, "unsupported-state");
		const unsupportedState = JSON.stringify({ ...base, version: 2 });
		await writeFile(unsupportedPath, unsupportedState);
		await assert.rejects(store.load(root, "unsupported-state"), /Unsupported pi-orchestrator state version 2; expected 1/);
		assert.equal(await readFile(unsupportedPath, "utf8"), unsupportedState);

		const oversizedPath = store.statePath(root, "oversized");
		await writeFile(oversizedPath, "");
		await truncate(oversizedPath, STATE_MAX_BYTES + 1);
		await assert.rejects(store.load(root, "oversized"), new RegExp(`state exceeds ${STATE_MAX_BYTES} bytes`));
		assert.equal((await stat(oversizedPath)).size, STATE_MAX_BYTES + 1);
		assert.equal((await readFile(handle.path, "utf8")).includes("request-one"), true);
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

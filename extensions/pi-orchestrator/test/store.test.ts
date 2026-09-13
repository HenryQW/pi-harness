import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CLEANUP_KINDS,
	launchRecordFingerprint,
	type CheckBatchEvidence,
	type ExecuteRequest,
	type NormalizedLaunchRecord,
	type RunState,
	type WorkspaceIdentity,
} from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

const STATE_MAX_BYTES = 384 * 1024 * 1024;
const oid = (character: string): string => character.repeat(40);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function identity(): WorkspaceIdentity {
	return { branch: "refs/heads/main", head: oid("a"), index: oid("a"), tree: oid("a") };
}

function launch(): NormalizedLaunchRecord {
	const rawValue = "Implement the task.\nPreserve all evidence.";
	const path = "/private/implementer.prompt";
	const value: Omit<NormalizedLaunchRecord, "fingerprint"> = {
		key: "implementer/fast",
		role: "implementer",
		modelClass: "fast",
		model: "provider/model",
		thinkingLevel: "high",
		rawArgs: ["--append-system-prompt", rawValue],
		env: {},
		tools: [],
		roleExtensions: ["/roles/implementer.ts"],
		roleSkills: [],
		resources: [{ kind: "extension", path: "/roles/implementer.ts", sha256: "b".repeat(64) }],
		prompt: {
			rawValue,
			path,
			mode: 0o600,
			sha256: sha256(rawValue),
			finalArgs: ["--append-system-prompt", path],
		},
	};
	return { ...value, fingerprint: launchRecordFingerprint(value) };
}

function state(root: string, request: ExecuteRequest, record = launch()): RunState {
	const main = identity();
	return {
		version: 1,
		request,
		root,
		requestStartMain: main,
		main,
		deadlineStartedAt: 1,
		deadline: 1_001,
		launchRecords: { [record.key]: record },
		launchMaterialization: { status: "ready", at: 1 },
		status: "pending",
		tasks: [{
			taskId: request.tasks[0]!.id,
			status: "pending",
			implementerLaunchKey: record.key,
			attempts: [],
		}],
		waves: [],
		final: { status: "pending" },
		accepted: false,
		createdAt: 1,
		updatedAt: 1,
	};
}

test("the store reserves capacity for escaped evidence and rejects over-bound files", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "pi-orchestrator-store-"));
	const plannedRoot = join(sandbox, "repo");
	const agentDir = join(sandbox, "agent");
	await mkdir(plannedRoot);
	const root = await realpath(plannedRoot);
	try {
		const checks = Array.from({ length: 32 }, (_, index) => ({ command: `check-${index}`, args: [] }));
		const request: ExecuteRequest = {
			id: "request-one",
			goal: "Preserve escaped check evidence.",
			budgetMs: 1_000,
			tasks: [{
				id: "task-one",
				modelClass: "fast",
				requirements: "Run every check.",
				deliverable: "Persist every result.",
				dependsOn: [],
				checks,
			}],
			finalChecks: [{ command: "final-check", args: [] }],
		};
		const store = new FileRunStore(agentDir);
		const handle = await store.create(state(root, request));
		const escaped = "\u0001".repeat(8 * 1024);
		const candidate = identity();
		const evidence: CheckBatchEvidence = {
			phase: "preliminary",
			candidate,
			identityAfter: candidate,
			results: checks.map((check) => ({
				...check,
				code: 1,
				killed: false,
				stdout: escaped,
				stderr: escaped,
			})),
			passed: false,
			at: 2,
		};
		handle.state.status = "needs_attention";
		handle.state.tasks[0]!.status = "needs_attention";
		handle.state.tasks[0]!.attempts.push({
			number: 1,
			waveNumber: 1,
			waveBase: candidate,
			correlationToken: "abcdefghijklmnop",
			allocationGeneration: 1,
			allocations: [],
			prompts: [],
			preliminaryChecks: evidence,
			cleanup: CLEANUP_KINDS.map((kind) => ({ kind, status: "pending" })),
		});
		handle.state.updatedAt = 2;
		await handle.save();

		assert.ok((await stat(handle.path)).size > 2 * 1024 * 1024);
		const loaded = await store.load(root, request.id);
		assert.equal(loaded.state.tasks[0]!.attempts[0]!.preliminaryChecks!.results[31]!.stderr, escaped);

		const largeRecord = launch();
		largeRecord.rawArgs = Array.from({ length: 12 }, () => "\u0001".repeat(32_000));
		const { fingerprint: _fingerprint, ...fingerprinted } = largeRecord;
		largeRecord.fingerprint = launchRecordFingerprint(fingerprinted);
		await assert.rejects(
			store.create(state(root, { ...request, id: "large-metadata" }, largeRecord)),
			/state exceeds 2097152 bytes/,
		);

		const malformedPath = store.statePath(root, "malformed");
		const malformed = "{}\n";
		await writeFile(malformedPath, malformed);
		await assert.rejects(store.load(root, "malformed"), /Unsupported or malformed pi-orchestrator v1 state/);
		assert.equal(await readFile(malformedPath, "utf8"), malformed);

		const oversizedPath = store.statePath(root, "oversized");
		await writeFile(oversizedPath, "");
		await truncate(oversizedPath, STATE_MAX_BYTES + 1);
		await assert.rejects(store.load(root, "oversized"), new RegExp(`state exceeds ${STATE_MAX_BYTES} bytes`));
		assert.equal((await stat(oversizedPath)).size, STATE_MAX_BYTES + 1);
		assert.equal((await readFile(handle.path, "utf8")).includes("\\u0001"), true);
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

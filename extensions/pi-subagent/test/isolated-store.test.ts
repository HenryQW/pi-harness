import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseExecuteRequest,
	RUN_STATE_VERSION,
	type ExecuteRequest,
	type RunState,
	type WorkspaceIdentity,
} from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

const STATE_MAX_BYTES = 128 * 1024 * 1024;

function identity(): WorkspaceIdentity {
	return {
		branch: "refs/heads/main",
		head: "a".repeat(40),
		index: "a".repeat(40),
		tree: "a".repeat(40),
	};
}

function request(): ExecuteRequest {
	return parseExecuteRequest({
		id: "request-one",
		goal: "Persist the text task.",
		mode: "isolated",
		approval: "scoped",
		tasks: [{
			id: "research",
			kind: "text",
			role: "researcher",
			modelClass: "fast",
			requirements: "Gather the facts.",
			deliverable: "A concise summary.",
			dependsOn: [],
			contextFrom: [],
		}],
		finalChecks: [{ command: "check-final", args: [] }],
	});
}

function state(root: string): RunState {
	const main = identity();
	return {
		version: RUN_STATE_VERSION,
		request: request(),
		policy: {
			maxSubagents: 5,
			maxTurns: 50,
			childIdleMs: 600_000,
			childMaxMs: 1_800_000,
			maxCorrections: 1,
		},
		correctionCount: 0,
		root,
		requestStartMain: main,
		main,
		status: "pending",
		tasks: [{
			taskId: "research",
			kind: "text",
			status: "completed",
			attempts: [{ number: 1, status: "completed", output: { text: "The persisted result." } }],
		}],
		waves: [],
		final: { status: "pending" },
		accepted: false,
		createdAt: 1,
		updatedAt: 1,
	};
}

test("the store persists v4 text state, rejects duplicate creates, and preserves unsupported older files", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "pi-subagent-store-"));
	const plannedRoot = join(sandbox, "repo");
	const agentDir = join(sandbox, "agent");
	await mkdir(plannedRoot);
	const root = await realpath(plannedRoot);
	try {
		const savedStates: RunState[] = [];
		const store = new FileRunStore(agentDir, (saved) => savedStates.push(saved));
		const created = state(root);
		const handle = await store.create(created);
		assert.deepEqual(savedStates, [created]);
		handle.state.updatedAt = 2;
		await handle.save();
		assert.deepEqual(savedStates.map(({ updatedAt }) => updatedAt), [1, 2]);
		const contents = await readFile(handle.path, "utf8");
		assert.doesNotMatch(contents, /launchRecords|fingerprint|LaunchRecord/);
		await assert.rejects(store.create(created), {
			message: `Pi Subagent request ${created.request.id} already exists.`,
		});

		const loaded = await store.load(root, created.request.id);
		assert.deepEqual(loaded.state, { ...created, updatedAt: 2 });

		for (const version of [1, 2, 3]) {
			const legacyPath = store.statePath(root, `legacy-v${version}`);
			const legacy = JSON.stringify({ ...created, version, launchRecords: {} });
			await writeFile(legacyPath, legacy);
			await assert.rejects(store.load(root, `legacy-v${version}`), new RegExp(`Unsupported pi-subagent state version ${version}; expected 4`));
			assert.equal(await readFile(legacyPath, "utf8"), legacy);
		}
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("the lifecycle lock rejects unowned productive work while admitting owned, status, and abort operations", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "pi-subagent-store-"));
	const plannedRoot = join(sandbox, "repo");
	const agentDir = join(sandbox, "agent");
	await mkdir(plannedRoot);
	const root = await realpath(plannedRoot);
	try {
		const owner = new FileRunStore(agentDir);
		const contender = new FileRunStore(agentDir);
		await owner.withProductiveRunLease(root, async (productiveRunLease) => {
			await owner.withLock(root, async (lifecycle) => {
				assert.equal(lifecycle.productiveRunLeaseActive, true);
			}, { productiveRunLease });

			let rejectedOperationRan = false;
			await assert.rejects(
				contender.withLock(root, async () => { rejectedOperationRan = true; }),
				/Another Pi Subagent productive request is active/,
			);
			assert.equal(rejectedOperationRan, false);

			for (const purpose of ["status", "abort"] as const) {
				await contender.withLock(root, async (lifecycle) => {
					assert.equal(lifecycle.productiveRunLeaseActive, true);
				}, { purpose });
			}
		});

		await contender.withLock(root, async (lifecycle) => {
			assert.equal(lifecycle.productiveRunLeaseActive, false);
		});
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("invalid and oversized state files are rejected without replacement", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "pi-subagent-store-"));
	const plannedRoot = join(sandbox, "repo");
	const agentDir = join(sandbox, "agent");
	await mkdir(plannedRoot);
	const root = await realpath(plannedRoot);
	try {
		const store = new FileRunStore(agentDir);
		const created = state(root);
		const handle = await store.create(created);

		const malformedPath = store.statePath(root, "malformed");
		const malformed = "{}\n";
		await writeFile(malformedPath, malformed);
		await assert.rejects(store.load(root, "malformed"), /Unsupported or malformed pi-subagent v4 state/);
		assert.equal(await readFile(malformedPath, "utf8"), malformed);

		const oversizedPath = store.statePath(root, "oversized");
		await writeFile(oversizedPath, "");
		await truncate(oversizedPath, STATE_MAX_BYTES + 1);
		await assert.rejects(store.load(root, "oversized"), {
			message: `pi-subagent state exceeds ${STATE_MAX_BYTES} bytes.`,
		});
		assert.equal((await stat(oversizedPath)).size, STATE_MAX_BYTES + 1);
		assert.match(await readFile(handle.path, "utf8"), /request-one/);
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

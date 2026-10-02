import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EphemeralSubagentExecutor } from "@henryqw/pi-subagent";
import {
	IsolatedRunner,
	type CoordinatorRuntime,
	type GitRuntime,
	type HostRuntime,
	type TaskCandidateInspector,
} from "../src/runner.ts";
import type { ExecuteRequest, RunState, TaskState, TextTaskState, WorkspaceIdentity } from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

function mainIdentity(root: string): WorkspaceIdentity {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const tree = git("rev-parse", "HEAD^{tree}");
	return { branch: git("symbolic-ref", "HEAD"), head: git("rev-parse", "HEAD"), index: tree, tree };
}

async function initializeRepository(root: string): Promise<void> {
	await mkdir(root);
	await writeFile(join(root, "README.md"), "fixture\n");
	await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["add", "README.md", "package.json"], { cwd: root });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
}

type AttentionRunner = {
	attention(task: TextTaskState, failure: string): void;
};

type DispatchTaskRunner = {
	dispatchTask(handle: unknown, task: TaskState, scope: unknown): Promise<void>;
};

class RecordingRunStore extends FileRunStore {
	readonly saved: RunState[] = [];

	override async load(root: string, id: string) {
		const handle = await super.load(root, id);
		const save = handle.save.bind(handle);
		handle.save = async () => {
			const snapshot = JSON.parse(JSON.stringify(handle.state)) as RunState;
			await save();
			this.saved.push(snapshot);
		};
		return handle;
	}
}

const unavailableTextExecutor: EphemeralSubagentExecutor = {
	run: async () => { throw new Error("Text task dispatch is not implemented."); },
};

const acquireTextLaunch = async () => ({
	launch: {
		role: "researcher",
		modelClass: "fast",
		model: "test-model",
		thinkingLevel: "low",
		args: [],
		env: {},
		tools: [],
	},
	cleanup: async () => {},
});

function markAttention(task: TextTaskState, failure: string): void {
	const runner = new IsolatedRunner(
		{} as CoordinatorRuntime,
		{} as HostRuntime,
		{} as GitRuntime & TaskCandidateInspector,
		undefined,
		unavailableTextExecutor,
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

test("text attention preserves execution history when no attempt is running", () => {
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
		attempts: [{ number: 1, status: "failed", failure: "Earlier attempt stopped." }],
		failure,
	});
});

test("text dispatch failure persists its failed running attempt", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-text-state-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	await initializeRepository(root);
	const store = new FileRunStore(join(directory, "agent"));
	const runner = new IsolatedRunner(
		{
			now: () => 1,
			randomToken: () => "token-0000000000000001",
			preflight: async (input: { cwd: string }) => ({ root: input.cwd, main: mainIdentity(root) }),
			acquireLaunch: acquireTextLaunch,
		} as unknown as CoordinatorRuntime,
		{} as HostRuntime,
		{
			inspectMain: async () => mainIdentity(root),
			inspectMainBase: async () => mainIdentity(root),
		} as unknown as GitRuntime & TaskCandidateInspector,
		store,
		unavailableTextExecutor,
	);
	const request: ExecuteRequest = {
		id: "text-failure",
		goal: "Retain failed text-task state.",
		mode: "isolated",
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
	assert.equal(task.failure, "Task dispatch was interrupted: Text task dispatch is not implemented.");
	assert.equal(task.attempts.at(-1)!.status, "failed");
	assert.equal(task.attempts.at(-1)!.failure, task.failure);
	assert.deepEqual((await store.load(root, request.id)).state.tasks[0], task);
});

for (const change of ["ignored", "tracked", "committed", "executor-failure"]) test(`text result and cleanup evidence survive retained artifacts: ${change}`, async (t) => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-text-retained-")));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	await initializeRepository(root);
	await writeFile(join(root, ".gitignore"), ".codegraph/\nnode_modules/\ndist/\n");
	execFileSync("git", ["add", ".gitignore"], { cwd: root });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "ignore generated artifacts"], { cwd: root });
	const store = new FileRunStore(join(directory, "agent"));
	let checkout = "";
	const runner = new IsolatedRunner({
		now: () => 1,
		randomToken: () => "token-0000000000000001",
		preflight: async () => ({ root, main: mainIdentity(root) }),
		acquireLaunch: acquireTextLaunch,
	} as unknown as CoordinatorRuntime, {} as HostRuntime, {
		inspectMain: async () => mainIdentity(root),
		inspectMainBase: async () => mainIdentity(root),
		runChecks: async () => ({ results: [], identityAfter: mainIdentity(root) }),
	} as unknown as GitRuntime & TaskCandidateInspector, store, {
		run: async (options) => {
			checkout = (await options.prepare()).cwd;
			for (const path of [".codegraph", "node_modules", "dist"]) {
				await mkdir(join(checkout, path));
				await writeFile(join(checkout, path, "artifact"), "automatic artifact\n");
			}
			if (change === "executor-failure") throw new Error("Original executor failure.");
			if (change !== "ignored") await writeFile(join(checkout, "README.md"), "changed source\n");
			if (change === "committed") {
				execFileSync("git", ["add", "README.md"], { cwd: checkout });
				execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "source change"], { cwd: checkout });
			}
			return { outcome: "success", exitCode: 0, output: "Complete reviewer verdict.", outputTruncated: false, stderr: "" };
		},
	});
	const request: ExecuteRequest = {
		id: "text-retained", goal: "Preserve the completed review.", mode: "isolated",
		tasks: [{ id: "review", kind: "text", role: "researcher", modelClass: "fast", requirements: "Review read-only.", deliverable: "Verdict.", dependsOn: [], contextFrom: [] }],
		finalChecks: [],
	};
	const result = await runner.execute(request, root);
	const task = result.state.tasks[0]!;
	if (task.kind !== "text") throw new Error("Expected text task.");
	assert.equal(task.attempts[0]!.output?.text, change === "executor-failure" ? undefined : "Complete reviewer verdict.");
	assert.equal(task.status, change === "ignored" ? "completed" : "needs_attention");
	if (change === "tracked") assert.match(task.failure!, /read-only.*tracked or untracked/i);
	if (change === "committed") assert.match(task.failure!, /read-only.*HEAD or branch changed/i);
	if (change === "executor-failure") assert.match(task.failure!, /Original executor failure/);
	assert.deepEqual(task.attempts[0]!.cleanup, {
		outcome: "retained", path: checkout,
		branch: execFileSync("git", ["branch", "--show-current"], { cwd: checkout, encoding: "utf8" }).trim(),
		commits: change === "committed" ? 1 : 0, dirty: true,
	});
	assert.deepEqual((await store.load(root, request.id)).state.tasks[0], JSON.parse(JSON.stringify(task)));
	if (change === "ignored") assert.equal((await runner.listRequests(root)).requests[0]!.status, "completed · retained");
	if (change === "tracked" || change === "committed") {
		assert.equal(result.continuation, undefined); // A completed answer must not be replayed.
		await assert.rejects(runner.resume({ id: request.id, action: "retry", taskId: "review" }, root), /retry requires an unstarted, failed or superseded/);
	}
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: checkout, encoding: "utf8" }).trim(), change === "tracked" ? "M README.md" : "");
	assert.match(execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: checkout, encoding: "utf8" }), /!! .codegraph\//);
});

test("text retry saves its second attempt atomically before executor launch", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-text-state-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	await initializeRepository(root);
	const store = new RecordingRunStore(join(directory, "agent"));
	const request: ExecuteRequest = {
		id: "text-retry",
		goal: "Retry a failed text task without an invalid intermediate state.",
		mode: "isolated",
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
	let launches = 0;
	let persistedAtSecondLaunch: RunState | undefined;
	const executor: EphemeralSubagentExecutor = {
		run: async () => {
			launches += 1;
			if (launches === 1) throw new Error("first executor launch failed");
			persistedAtSecondLaunch = (await store.load(root, request.id)).state;
			return {
				outcome: "success",
				exitCode: 0,
				output: "Second attempt output.",
				outputTruncated: false,
				stderr: "",
			};
		},
	};
	const runner = new IsolatedRunner(
		{
			now: () => 1,
			randomToken: () => "token-0000000000000001",
			preflight: async (input: { cwd: string }) => ({ root: input.cwd, main: mainIdentity(root) }),
			acquireLaunch: acquireTextLaunch,
		} as unknown as CoordinatorRuntime,
		{} as HostRuntime,
		{
			inspectMain: async () => mainIdentity(root),
			inspectMainBase: async () => mainIdentity(root),
			runChecks: async () => ({
				results: [{ command: "true", args: [], code: 0, killed: false, stdout: "", stderr: "" }],
				identityAfter: mainIdentity(root),
			}),
		} as unknown as GitRuntime & TaskCandidateInspector,
		store,
		executor,
	);

	const failed = await runner.execute(request, root);
	const failedTask = failed.state.tasks[0]!;
	if (failedTask.kind !== "text") throw new Error("Expected a text task.");
	assert.equal(failedTask.status, "needs_attention");
	assert.deepEqual(failedTask.attempts.map(({ number, status }) => ({ number, status })), [{ number: 1, status: "failed" }]);

	const retried = await runner.resume({ id: request.id, action: "retry", taskId: "research" }, root);
	assert.equal(retried.state.accepted, true);
	assert.equal(launches, 2);

	const firstProductiveSave = store.saved.find((snapshot) => snapshot.status === "running")!;
	const taskAtFirstSave = firstProductiveSave.tasks[0]!;
	if (taskAtFirstSave.kind !== "text") throw new Error("Expected a text task.");
	assert.equal(firstProductiveSave.status, "running");
	assert.deepEqual(firstProductiveSave.waves.at(-1), {
		number: 2,
		base: mainIdentity(root),
		taskIds: ["research"],
		status: "dispatching",
	});
	assert.equal(taskAtFirstSave.status, "running");
	assert.deepEqual(taskAtFirstSave.attempts.map(({ number, status }) => ({ number, status })), [
		{ number: 1, status: "failed" },
		{ number: 2, status: "running" },
	]);
	assert.ok(store.saved.every((snapshot) => {
		const task = snapshot.tasks[0]!;
		return snapshot.status !== "running" || task.kind !== "text" || task.status !== "pending" || task.attempts.length !== 1;
	}));

	if (!persistedAtSecondLaunch) throw new Error("Expected state to be persisted before the second executor launch.");
	assert.deepEqual(persistedAtSecondLaunch, firstProductiveSave);
});

test("text retry runs only the selected ready task while another needs attention", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-text-state-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	await initializeRepository(root);
	const store = new FileRunStore(join(directory, "agent"));
	const otherId = "other";
	const selectedId = "selected";
	const request: ExecuteRequest = {
		id: "text-retry-with-attention",
		goal: "Retry one failed text task without scheduling another.",
		mode: "isolated",
		tasks: [
			{
				id: otherId,
				kind: "text",
				role: "researcher",
				modelClass: "fast",
				requirements: "Research the other task.",
				deliverable: "Return the other result.",
				dependsOn: [],
				contextFrom: [],
			},
			{
				id: selectedId,
				kind: "text",
				role: "researcher",
				modelClass: "fast",
				requirements: "Research the selected task.",
				deliverable: "Return the selected result.",
				dependsOn: [],
				contextFrom: [],
			},
		],
		finalChecks: [{ command: "true", args: [] }],
	};
	const executions: string[] = [];
	let persistedSelectedRetry: RunState | undefined;
	const executor: EphemeralSubagentExecutor = {
		run: async ({ prepare }) => {
			const prepared = await prepare();
			const taskId = /^Task: (\S+)$/m.exec(prepared.task)?.[1];
			if (!taskId) throw new Error("Text task prompt did not name its task.");
			executions.push(taskId);
			if (executions.filter((id) => id === taskId).length === 1) {
				throw new Error(`first ${taskId} launch failed`);
			}
			if (taskId === selectedId) persistedSelectedRetry = (await store.load(root, request.id)).state;
			return {
				outcome: "success",
				exitCode: 0,
				output: "Selected retry output.",
				outputTruncated: false,
				stderr: "",
			};
		},
	};
	const runner = new IsolatedRunner(
		{
			now: () => 1,
			randomToken: () => "token-0000000000000001",
			preflight: async (input: { cwd: string }) => ({ root: input.cwd, main: mainIdentity(root) }),
			acquireLaunch: acquireTextLaunch,
		} as unknown as CoordinatorRuntime,
		{} as HostRuntime,
		{
			inspectMain: async () => mainIdentity(root),
			inspectMainBase: async () => mainIdentity(root),
		} as unknown as GitRuntime & TaskCandidateInspector,
		store,
		executor,
	);

	const failed = await runner.execute(request, root);
	const failedOther = failed.state.tasks.find((task) => task.taskId === otherId);
	const failedSelected = failed.state.tasks.find((task) => task.taskId === selectedId);
	if (failedOther?.kind !== "text" || failedSelected?.kind !== "text") throw new Error("Expected text task state.");
	assert.equal(failedOther.status, "needs_attention");
	assert.equal(failedSelected.status, "needs_attention");

	const blocked = await store.load(root, request.id);
	const selectedRequest = blocked.state.request.tasks.find((task) => task.id === selectedId);
	if (!selectedRequest) throw new Error("Expected selected task request.");
	selectedRequest.dependsOn.push(otherId);
	await blocked.save();
	await assert.rejects(
		runner.resume({ id: request.id, action: "retry", taskId: selectedId }, root),
		/dependencies are not completed/,
	);
	assert.equal(executions.filter((id) => id === selectedId).length, 1);
	assert.equal((await store.load(root, request.id)).state.tasks.find((task) => task.taskId === selectedId)?.status, "needs_attention");

	selectedRequest.dependsOn.length = 0;
	await blocked.save();
	const retried = await runner.resume({ id: request.id, action: "retry", taskId: selectedId }, root);
	const retriedOther = retried.state.tasks.find((task) => task.taskId === otherId);
	const retriedSelected = retried.state.tasks.find((task) => task.taskId === selectedId);
	if (retriedOther?.kind !== "text" || retriedSelected?.kind !== "text") throw new Error("Expected text task state.");
	assert.equal(retried.state.status, "needs_attention");
	assert.equal(retriedOther.status, "needs_attention");
	assert.equal(retriedSelected.status, "completed");
	assert.equal(executions.filter((id) => id === otherId).length, 1);
	assert.equal(executions.filter((id) => id === selectedId).length, 2);

	if (!persistedSelectedRetry) throw new Error("Expected selected retry to be persisted before executor launch.");
	const persistedOther = persistedSelectedRetry.tasks.find((task) => task.taskId === otherId);
	const persistedSelected = persistedSelectedRetry.tasks.find((task) => task.taskId === selectedId);
	if (persistedOther?.kind !== "text" || persistedSelected?.kind !== "text") throw new Error("Expected persisted text task state.");
	assert.equal(persistedOther.status, "needs_attention");
	assert.equal(persistedSelected.status, "running");
	assert.deepEqual(persistedSelectedRetry.waves.at(-1), {
		number: 2,
		base: mainIdentity(root),
		taskIds: [selectedId],
		status: "dispatching",
	});
	assert.deepEqual(persistedSelected.attempts.map(({ number, status }) => ({ number, status })), [
		{ number: 1, status: "failed" },
		{ number: 2, status: "running" },
	]);
});

test("mixed waves settle and attribute dispatch failures in either task order", async (t) => {
	for (const kinds of [["changeset", "text"], ["text", "changeset"]] as const) {
		await t.test(kinds.join(" then "), async (t) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-subagent-text-state-"));
			t.after(async () => await rm(directory, { recursive: true, force: true }));
			const root = join(directory, "workspace");
			await initializeRepository(root);
			let stateHandle: { state: RunState; save(): Promise<void> };
			const store = {
				async assertLegacyAdmissionSafe() {},
				async withProductiveRunLease<T>(_root: string, action: (lease: unknown) => Promise<T>): Promise<T> {
					return await action({});
				},
				async withLock<T>(_root: string, action: (lifecycle: unknown) => Promise<T>): Promise<T> {
					return await action({ productiveRunLeaseActive: true });
				},
				async create(state: RunState) {
					stateHandle = { state, save: async (): Promise<void> => {} };
					return stateHandle;
				},
				async load() {
					return stateHandle;
				},
			} as unknown as FileRunStore;
			const runner = new IsolatedRunner(
				{
					now: () => 1,
					randomToken: () => "token-0000000000000001",
					preflight: async (input: { cwd: string }) => ({ root: input.cwd, main: mainIdentity(root) }),
					acquireLaunch: acquireTextLaunch,
				} as unknown as CoordinatorRuntime,
				{} as HostRuntime,
				{
					inspectMain: async () => mainIdentity(root),
					inspectMainBase: async () => mainIdentity(root),
				} as unknown as GitRuntime & TaskCandidateInspector,
				store,
				unavailableTextExecutor,
			);
			const dispatchingRunner = runner as unknown as DispatchTaskRunner;
			const dispatchTask = dispatchingRunner.dispatchTask.bind(runner);
			// This fixture does not create a checked changeset attempt; only dispatch attribution is under test.
			(runner as unknown as { retainCandidate(): void }).retainCandidate = () => {};
			dispatchingRunner.dispatchTask = async (handle, task, scope) => {
				if (task.kind === "text") return await dispatchTask(handle, task, scope);
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
				task.status = "ready_to_integrate";
			};
			const text = {
				id: "research",
				kind: "text" as const,
				role: "researcher",
				modelClass: "fast" as const,
				requirements: "Research the implementation.",
				deliverable: "Return the result.",
				dependsOn: [],
				contextFrom: [],
			};
			const changeset = {
				id: "change",
				kind: "changeset" as const,
				role: "implementer",
				modelClass: "fast" as const,
				requirements: "Implement the change.",
				deliverable: "Deliver the change.",
				dependsOn: [],
				contextFrom: [],
				checks: [{ command: "true", args: [] }],
			};
			const result = await runner.execute({
				id: `mixed-${kinds.join("-")}`,
				goal: "Keep wave failure attribution exact.",
				mode: "isolated",
				tasks: kinds.map((kind) => kind === "text" ? text : changeset),
				finalChecks: [{ command: "true", args: [] }],
			} satisfies ExecuteRequest, root);
			const textTask = result.state.tasks.find((task) => task.taskId === text.id);
			const changesetTask = result.state.tasks.find((task) => task.taskId === changeset.id);
			if (textTask?.kind !== "text" || changesetTask?.kind !== "changeset") throw new Error("Expected mixed task state.");

			assert.equal(result.state.status, "needs_attention");
			assert.equal(result.state.waves[0]!.status, "needs_attention");
			assert.equal(textTask.status, "needs_attention");
			assert.equal(textTask.failure, "Task dispatch was interrupted: Text task dispatch is not implemented.");
			assert.equal(textTask.attempts.at(-1)!.status, "failed");
			assert.equal(textTask.attempts.at(-1)!.failure, textTask.failure);
			assert.equal(changesetTask.status, "ready_to_integrate");
			assert.equal(changesetTask.failure, undefined);
		});
	}
});

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { extensionConfigDir, readTextFileBounded, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
import { lock } from "proper-lockfile";
import { Check } from "typebox/value";
import { CheckedGitRuntime } from "./git-runtime.ts";
import { IntegrationGit } from "./integration-git.ts";
import { FileRunStore } from "./store.ts";
import { runProcess } from "./process.ts";
import { runGit } from "./git-process.ts";
import { utf8Prefix } from "./ephemeral.ts";
import { CLEANUP_KINDS, sameIdentity, type AllocationIntent, type ExecutionPolicySnapshot, type TaskAttempt, type WorkspaceIdentity, type WorktreeAllocationIntent } from "./schema.ts";
import type { CoordinatorRuntime, HostRuntime, OperationContext } from "./runner.ts";
import { parseWorkspaceRequest, parseWorkspaceState, sameSet, setFrom, workerTask, WorkspaceActionSchema, type IdentitySet, type WorkspaceAction, type WorkspaceCheck, type WorkspaceEvidence, type WorkspaceRequest, type WorkspaceState } from "./workspace-schema.ts";
import { resolveWorkspaceScope, workspaceInputPath, type WorkspaceScope } from "./workspace-scope.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const diagnostic = (error: unknown) => utf8Prefix(error instanceof Error ? error.message : String(error), 8192);
const context = (signal: AbortSignal): OperationContext => ({ signal, timeoutMs: 30_000 });
const safeContext = (): OperationContext => context(AbortSignal.timeout(30_000));
const owned = (attempt: TaskAttempt) => {
	const intent = attempt.allocations.find((item): item is WorktreeAllocationIntent => item.kind === "worktree");
	if (!intent?.worktree || intent.status !== "owned") throw new Error("Workspace member has no exact owned worktree.");
	return intent.worktree;
};
const branchBase = (repo: WorkspaceState["repositories"][string]) => ({ ...repo.base, branch: `refs/heads/${owned(repo.attempt).branch}` });
function suite(manifest: string): string {
	const value = JSON.parse(manifest);
	if (typeof value?.scripts?.test !== "string" || !value.scripts.test.trim()) throw new Error("Every selected repository needs a root package.json test script.");
	return value.scripts.test;
}
const passes = (evidence: WorkspaceEvidence | undefined, checks: readonly WorkspaceCheck[], expected: IdentitySet): boolean => Boolean(evidence
	&& sameSet(evidence.before, expected) && sameSet(evidence.after, expected) && evidence.results.length === checks.length
	&& evidence.results.every((result, index) => result.code === 0 && !result.killed && result.repository === checks[index]!.repository
		&& result.command === checks[index]!.command && JSON.stringify(result.args) === JSON.stringify(checks[index]!.args)));

export interface WorkspaceRuntimeOptions {
	coordinator: CoordinatorRuntime;
	host(policy: WorkspaceState["policy"]): HostRuntime;
	preflightHost(root: string, operation: OperationContext): Promise<void>;
	policy(): ExecutionPolicySnapshot;
	agentDir?: string;
	git?: CheckedGitRuntime;
	integration?: IntegrationGit;
	execute?: typeof runProcess;
}

/** Include workspace ownership in the existing prune gate, including unchanged secondary worktrees. */
export async function workspacePruneOwners(checkouts: readonly string[], agentDir?: string): Promise<Array<{ label: string; text?: string }>> {
	const owners: Array<{ label: string; text?: string }> = [];
	for (const root of new Set(checkouts.map((path) => dirname(path)))) {
		const directory = join(extensionConfigDir("pi-subagent", agentDir), "workspace-state", hash(root));
		let names: string[];
		try { names = await readdir(directory); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") owners.push({ label: "Unreadable workspace state may own this resource" });
			continue;
		}
		if (names.length > 256) { owners.push({ label: "Workspace state inventory limit reached" }); continue; }
		for (const name of names) {
			try {
				const text = await readTextFileBounded(join(directory, name, "state.json"), 2 * 1024 * 1024);
				const state = parseWorkspaceState(JSON.parse(text));
				if (state.status !== "cleaned") owners.push({ label: `Owned by workspace request ${state.request.id}; use subagent_workspace`, text });
			} catch { owners.push({ label: `Unreadable workspace request ${name} may own this resource` }); }
		}
	}
	return owners;
}

/** A whole repository set is the validation unit. Git mutations remain serial, never atomic. */
export class WorkspaceRunner {
	private readonly git: CheckedGitRuntime;
	private readonly integration: IntegrationGit;
	private readonly store: FileRunStore;
	private readonly active = new Map<string, AbortController>();
	private readonly options: WorkspaceRuntimeOptions;
	constructor(options: WorkspaceRuntimeOptions) {
		this.options = options;
		this.git = options.git ?? new CheckedGitRuntime();
		this.integration = options.integration ?? new IntegrationGit();
		this.store = new FileRunStore(options.agentDir);
	}
	private directory(root: string, id: string): string {
		if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) throw new Error("Invalid workspace request ID.");
		const directory = resolve(extensionConfigDir("pi-subagent", this.options.agentDir), "workspace-state", hash(root), id);
		if (directory === root || directory.startsWith(`${root}/`)) throw new Error("Workspace state must be outside the workspace.");
		return directory;
	}
	private async save(state: WorkspaceState): Promise<void> {
		parseWorkspaceState(state);
		const text = JSON.stringify(state);
		if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Workspace state exceeds 2 MiB; resources are retained.");
		await writePrivateTextFileAtomically(join(this.directory(state.root, state.request.id), "state.json"), text);
	}
	async status(cwd: string, id: string): Promise<WorkspaceState> {
		const root = await realpath(cwd), path = join(this.directory(root, id), "state.json");
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await realpath(path) !== path) throw new Error("Workspace state is not an exact private regular file.");
		const state = parseWorkspaceState(JSON.parse(await readTextFileBounded(path, 2 * 1024 * 1024)));
		if (state.root !== root || state.request.id !== id) throw new Error("Workspace state address changed.");
		return state;
	}
	private async locked<T>(scope: WorkspaceScope, id: string, operation: () => Promise<T>): Promise<T> {
		const directory = this.directory(scope.root, id);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		if (await realpath(directory) !== directory) throw new Error("Workspace state directory is not canonical.");
		await chmod(directory, 0o700);
		const release = await lock(join(directory, "lifecycle"), { realpath: false, stale: 30_000, update: 5_000, retries: 0 });
		const roots = Object.values(scope.repositories).map(({ root }) => root).sort();
		const lease = async (index: number): Promise<T> => index === roots.length ? await operation()
			: await this.store.withProductiveRunLease(roots[index]!, async () => await lease(index + 1));
		try { return await lease(0); } finally { await release(); }
	}
	async plan(value: unknown, cwd: string, signal = new AbortController().signal) {
		const request = parseWorkspaceRequest(value);
		const scope = await resolveWorkspaceScope(cwd, request.repositories, signal);
		const bases: IdentitySet = {}, scripts: Record<string, string> = {};
		for (const [name, repo] of Object.entries(scope.repositories)) {
			bases[name] = await this.git.inspectMainBase({ root: repo.root }, context(signal));
			if ([...request.tasks[0]!.checks, ...request.finalChecks].some((check) => check.repository === name && check.command === "pnpm"
				&& (check.args[0] === "test" || check.args[0] === "run" && check.args[1] === "test"))) {
				const manifest = await runGit(["show", `${bases[name]!.head}:package.json`], repo.root, signal);
				if (manifest.code !== 0) throw new Error(`Cannot read committed test script for repository ${name}: ${manifest.stderr}`);
				scripts[name] = suite(manifest.stdout);
			}
		}
		for (const path of Object.values(request.tasks[0]!.inputs ?? {})) {
			await workspaceInputPath(scope, path);
			if ((await lstat(path)).size > 64 * 1024) throw new Error("Each workspace input must be at most 64 KiB.");
		}
		// Resolve the same effective Role, tools, Skills, and model as a single-repository launch.
		const rolePlan = await this.options.coordinator.preflight({ request: { mode: "isolated", id: request.id, goal: request.goal,
			tasks: [workerTask(request)], finalChecks: request.finalChecks.map(({ repository: _repository, ...check }) => check) },
			cwd: Object.values(scope.repositories)[0]!.root, dryRun: true }, context(signal));
		return { request, scope, bases, scripts, routes: rolePlan.routes };
	}
	async execute(value: unknown, cwd: string, signal = new AbortController().signal, accepted?: (state: WorkspaceState) => void): Promise<WorkspaceState> {
		const plan = await this.plan(value, cwd, signal);
		await this.options.preflightHost(plan.scope.root, context(signal));
		return await this.locked(plan.scope, plan.request.id, async () => {
			const { request, scope, bases, scripts } = plan;
			const policy = this.options.policy();
			const state: WorkspaceState = { version: 1, root: scope.root, request, status: "allocating", inputs: {}, repositories: {},
				policy: { ...policy } };
			for (const [name, repo] of Object.entries(scope.repositories)) state.repositories[name] = { ...repo, base: bases[name]!, ...(scripts[name] === undefined ? {} : { testScript: scripts[name] }),
				attempt: { number: 1, waveNumber: 1, waveBase: bases[name]!, correlationToken: randomBytes(12).toString("hex"), allocationGeneration: 1, allocations: [], prompts: [], cleanup: CLEANUP_KINDS.map((kind) => ({ kind, status: "pending" })) } };
			// Exclusive creation prevents replay, including a prior crash before the first allocation.
			const file = await open(join(this.directory(scope.root, request.id), "state.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			try { await file.writeFile(JSON.stringify(parseWorkspaceState(state))); await file.sync(); } finally { await file.close(); }
			const directory = await open(this.directory(scope.root, request.id), "r");
			try { await directory.sync(); } finally { await directory.close(); }
			accepted?.(structuredClone(state));
			const controller = new AbortController(), key = `${scope.root}\0${request.id}`;
			this.active.set(key, controller);
			const activeSignal = AbortSignal.any([signal, controller.signal]);
			try {
				for (const [name, source] of Object.entries(request.tasks[0]!.inputs ?? {})) {
					const bytes = await readFile(await workspaceInputPath(scope, source));
					if (bytes.length > 64 * 1024) throw new Error("Workspace input grew beyond 64 KiB.");
					const path = join(this.directory(scope.root, request.id), `input-${name}`);
					state.inputs[name] = { source, path, digest: hash(bytes) };
					await this.save(state);
					const input = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
					try { await input.writeFile(bytes); await input.sync(); } finally { await input.close(); }
				}
				await this.allocate(state, activeSignal);
				await this.work(state, activeSignal);
				state.candidates = await this.inspectWorkers(state, activeSignal);
				if (Object.keys(state.repositories).every((name) => state.candidates![name]!.head === state.repositories[name]!.base.head)) throw new Error("The worker made no committed change in the selected repository set.");
				await this.stop(state);
				state.status = "checking"; await this.save(state);
				state.preliminary = await this.checks(state, state.candidates, request.tasks[0]!.checks, false, activeSignal);
				if (!passes(state.preliminary, request.tasks[0]!.checks, state.candidates)) throw new Error("Workspace task checks failed or the complete input set changed.");
				state.status = "ready"; delete state.failure; await this.save(state);
			} catch (error) {
				state.failure = diagnostic(error); state.status = activeSignal.aborted ? "aborted" : "attention";
				try { await this.stop(state); } catch (stopError) { state.failure = diagnostic(`${state.failure}\nTermination: ${diagnostic(stopError)}`); }
				await this.save(state);
			} finally { this.active.delete(key); }
			return state;
		});
	}
	private async verifyScope(state: WorkspaceState, signal: AbortSignal): Promise<void> {
		const scope = await resolveWorkspaceScope(state.root, state.request.repositories, signal);
		for (const [name, repo] of Object.entries(scope.repositories)) if (repo.common !== state.repositories[name]!.common) throw new Error(`Repository identity changed: ${name}.`);
		for (const [name, input] of Object.entries(state.inputs)) {
			if (input.path !== join(this.directory(state.root, state.request.id), `input-${name}`) || input.source !== state.request.tasks[0]!.inputs?.[name]) throw new Error("Workspace input identity changed.");
			await workspaceInputPath(scope, input.source);
			for (const path of [input.source, input.path]) {
				const stat = await lstat(path);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || await realpath(path) !== path || hash(await readFile(path)) !== input.digest) throw new Error(`Read-only workspace input changed: ${name}.`);
			}
		}
		if (Object.keys(state.inputs).length !== Object.keys(state.request.tasks[0]!.inputs ?? {}).length) throw new Error("Workspace input set is incomplete.");
	}
	private async allocate(state: WorkspaceState, signal: AbortSignal): Promise<void> {
		const task = workerTask(state.request);
		for (const repo of Object.values(state.repositories)) {
			await this.verifyScope(state, signal);
			for (const member of Object.values(state.repositories)) if (!sameIdentity(await this.git.inspectMainBase({ root: member.root }, context(signal)), member.base)) throw new Error("Main changed before complete-set allocation.");
			const intent: WorktreeAllocationIntent = { kind: "worktree", generation: 1, token: repo.attempt.correlationToken, status: "allocating" };
			repo.attempt.allocations.push(intent); await this.save(state);
			const result = await this.git.allocateWorktree({ requestId: state.request.id, root: repo.root, task, attempt: repo.attempt, intent,
				onPrepared: async (worktree) => { intent.worktree = worktree; await this.save(state); } }, context(signal));
			intent.status = result.outcome === "owned" ? "owned" : result.outcome;
			if (result.outcome !== "owned") { intent.failure = result.failure; await this.save(state); throw new Error(result.failure); }
			await this.save(state);
		}
	}
	private paths(state: WorkspaceState, integration: boolean): Record<string, string> {
		return Object.fromEntries(Object.entries(state.repositories).map(([name, repo]) => {
			const path = integration ? repo.integration?.path : owned(repo.attempt).path;
			if (!path) throw new Error(`Missing integration checkout: ${name}.`);
			return [name, path];
		}));
	}
	private async work(state: WorkspaceState, signal: AbortSignal): Promise<void> {
		const task = workerTask(state.request), attempt = Object.values(state.repositories)[0]!.attempt, host = this.options.host(state.policy);
		const paths = this.paths(state, false);
		const goal = `${state.request.goal}\n\nRead-only input copies (never promote these files):\n${JSON.stringify(Object.fromEntries(Object.entries(state.inputs).map(([name, input]) => [name, input.path])))}\n\nCheck repository labels refer to this absolute worktree map:\n${JSON.stringify(paths)}`;
		for (const kind of ["workspace", "worker_tab", "agent"] as const) {
			const plan = await host.planHostAllocation({ requestId: state.request.id, goal, kind, task, attempt }, context(signal));
			const intent = { ...plan, generation: 1, token: attempt.correlationToken, status: "allocating" as const } as AllocationIntent;
			attempt.allocations.push(intent); await this.save(state);
			if (intent.kind === "worktree") throw new Error("Invalid host plan.");
			const result = await host.allocateHost({ requestId: state.request.id, intent, task, attempt,
				acquireLaunch: () => this.options.coordinator.acquireLaunch(task.role, task.modelClass, context(signal)) }, context(signal));
			intent.status = result.outcome === "owned" ? "owned" : result.outcome;
			if (result.outcome === "owned") {
				if (intent.kind === "workspace" && result.kind === "workspace") Object.assign(intent, { workspaceId: result.workspaceId, rootTabId: result.rootTabId, rootPaneId: result.rootPaneId });
				if (intent.kind === "worker_tab" && result.kind === "worker_tab") Object.assign(intent, { tabId: result.tabId, paneId: result.paneId });
			} else intent.failure = result.failure;
			await this.save(state);
			if (result.outcome !== "owned") throw new Error(result.failure);
		}
		const agent = attempt.allocations.find((item) => item.kind === "agent");
		if (!agent || agent.kind !== "agent") throw new Error("Worker identity is missing.");
		const preCandidate = branchBase(Object.values(state.repositories)[0]!);
		attempt.prompts.push({ kind: "initial", status: "submitting", preCandidate, at: Date.now() });
		state.status = "working"; await this.save(state);
		const result = await host.runWorker({ goal, contexts: [], task, attempt, workerId: agent.agentName, kind: "initial", preCandidate, workspacePaths: paths }, context(signal));
		if (result.outcome !== "candidate") throw new Error(result.diagnostic ?? "Workspace worker did not finish with an exact candidate.");
		attempt.prompts[0]!.status = "settled"; attempt.prompts[0]!.candidate = result.candidate;
		await this.save(state);
	}
	private async inspectWorkers(state: WorkspaceState, signal: AbortSignal): Promise<IdentitySet> {
		await this.verifyScope(state, signal);
		const result: IdentitySet = {};
		for (const [name, repo] of Object.entries(state.repositories)) {
			const inspection = await this.git.inspectInFlightTaskCandidate({ root: repo.root, task: workerTask(state.request), attempt: repo.attempt }, context(signal));
			if (!inspection.valid || !inspection.clean) throw new Error(`Repository ${name} has no exact clean owned candidate.`);
			const candidate = inspection.candidate;
			await this.integration.inspectWorker(repo.root, owned(repo.attempt), candidate, signal);
			if (state.candidates && !sameIdentity(candidate, state.candidates[name]!)) throw new Error(`Sealed worker candidate changed: ${name}.`);
			result[name] = candidate; repo.attempt.candidate = candidate;
		}
		return result;
	}
	private async stop(state: WorkspaceState): Promise<void> {
		const primary = Object.values(state.repositories)[0]!;
		if (primary.cleanup?.includes("workspace")) return;
		const attempt = primary.attempt;
		const agent = attempt.allocations.find((item) => item.kind === "agent");
		if (!agent) return;
		if (agent.kind !== "agent" || agent.status !== "owned") throw new Error("Agent allocation is uncertain; manual host reconciliation is required. All worktrees are retained.");
		const host = this.options.host(state.policy), input = { task: workerTask(state.request), attempt, workerId: agent.agentName, candidate: attempt.candidate ?? branchBase(Object.values(state.repositories)[0]!) };
		attempt.termination = { status: "terminating", workerId: agent.agentName, candidate: input.candidate }; await this.save(state);
		let result = await host.reconcileWorkerTermination(input, safeContext());
		if (result.outcome === "active") result = await host.terminateWorker(input, safeContext());
		attempt.termination.status = result.outcome === "terminated" ? "terminated" : "unknown";
		await this.save(state);
		if (result.outcome !== "terminated") throw new Error(result.outcome === "unknown" ? result.failure : "Worker termination is not proved.");
	}
	private async inspectTips(state: WorkspaceState, signal: AbortSignal): Promise<IdentitySet> {
		await this.verifyScope(state, signal);
		const result: IdentitySet = {};
		for (const [name, repo] of Object.entries(state.repositories)) {
			if (!repo.integration || repo.allocation !== "owned" || !repo.stage || repo.stage === "staging") throw new Error(`Repository ${name} is not fully staged.`);
			result[name] = await this.integration.inspectCombined(repo.root, repo.integration, repo.base, repo.receipt ? [repo.receipt] : [], signal);
		}
		if (state.tips && !sameSet(result, state.tips)) throw new Error("Integration input set changed.");
		return result;
	}
	private async checks(state: WorkspaceState, expected: IdentitySet, commands: WorkspaceCheck[], integration: boolean, signal: AbortSignal): Promise<WorkspaceEvidence> {
		const inspect = () => integration ? this.inspectTips(state, signal) : this.inspectWorkers(state, signal);
		const before = await inspect();
		if (!sameSet(before, expected)) throw new Error("Complete check input set changed before validation.");
		const results: WorkspaceEvidence["results"] = [], paths = this.paths(state, integration);
		for (const check of commands) {
			for (const [name, path] of Object.entries(paths)) {
				const baseline = state.repositories[name]!.testScript;
				if (baseline !== undefined && suite(await readFile(join(path, "package.json"), "utf8")) !== baseline) throw new Error(`Canonical test script changed: ${name}.`);
			}
			const result = await (this.options.execute ?? runProcess)(check.command, check.args, { cwd: paths[check.repository]!, signal, timeoutMs: state.policy.childMaxMs,
				env: { PI_SUBAGENT_REPOSITORIES: JSON.stringify(paths), PI_SUBAGENT_INPUTS: JSON.stringify(Object.fromEntries(Object.entries(state.inputs).map(([name, input]) => [name, input.path]))) } });
			results.push({ ...check, code: result.code, killed: result.killed, stdout: utf8Prefix(result.stdout, 8192), stderr: utf8Prefix(result.stderr, 8192) });
			if (result.code !== 0 || result.killed || !sameSet(await inspect(), before)) break;
		}
		return { before, after: await inspect(), results };
	}
	async action(value: unknown, cwd: string, signal = new AbortController().signal): Promise<WorkspaceState> {
		if (!Check(WorkspaceActionSchema, value)) throw new Error("Invalid workspace action.");
		const action = value as WorkspaceAction, root = await realpath(cwd);
		if (["status", "abort", "reconcile", "cleanup"].includes(action.action) ? action.expected !== undefined : action.expected === undefined) throw new Error("stage, validate, and promote require the complete expected identity set; other actions do not accept it.");
		if (action.action === "status") return await this.status(root, action.id);
		if (action.action === "abort") this.active.get(`${root}\0${action.id}`)?.abort();
		const before = await this.status(root, action.id);
		const scope = await resolveWorkspaceScope(root, before.request.repositories, signal);
		return await this.locked(scope, action.id, async () => {
			const state = await this.status(root, action.id);
			try {
				if (action.action === "abort") { await this.stop(state); state.status = "aborted"; }
				else if (action.action === "cleanup") await this.cleanup(state, signal);
				else {
					await this.verifyScope(state, signal);
					if (action.action === "stage") await this.stage(state, action.expected!, signal);
					else if (action.action === "validate") {
						if (state.status !== "staged" || !state.tips || !sameSet(state.tips, action.expected!)) throw new Error("Validation requires the exact fully staged set.");
						state.status = "validating"; await this.save(state);
						state.final = await this.checks(state, state.tips, state.request.finalChecks, true, signal);
						if (!passes(state.final, state.request.finalChecks, state.tips)) throw new Error("Combined workspace checks failed.");
						state.status = "validated";
					} else if (action.action === "promote") await this.promote(state, action.expected!, signal);
					else if (action.action === "reconcile") await this.reconcile(state, signal);
				}
				delete state.failure;
			} catch (error) {
				state.failure = diagnostic(error);
				if (action.action !== "cleanup") {
					if (Object.values(state.repositories).some((repo) => repo.promotion)) state.status = "partial";
					else if (!["ready", "validated", "staged", "aborted", "cleaned"].includes(state.status)) state.status = "attention";
				}
			}
			await this.save(state); return state;
		});
	}
	private async stage(state: WorkspaceState, expected: IdentitySet, signal: AbortSignal): Promise<void> {
		if (state.status !== "ready" || !state.candidates || !sameSet(expected, state.candidates)
			|| !passes(state.preliminary, state.request.tasks[0]!.checks, state.candidates)) throw new Error("Stage requires the exact complete checked candidate set.");
		await this.stop(state); await this.inspectWorkers(state, signal);
		// Every Main target is inspected before the first allocation or merge.
		await this.preflightMain(state, false, signal);
		state.status = "staging"; await this.save(state);
		for (const [name, repo] of Object.entries(state.repositories)) {
			repo.allocation = "allocating"; await this.save(state);
			const allocation = await this.integration.allocate(repo.root, `workspace-${state.request.id}-${randomBytes(12).toString("hex")}`, repo.base,
				async (worktree) => { repo.integration = worktree; await this.save(state); }, signal, [state.request.id, name, "integration"]);
			if (allocation.outcome !== "ready") throw new Error(allocation.failure);
			repo.allocation = "owned"; await this.save(state);
			if (state.candidates[name]!.head === repo.base.head) { repo.stage = "unchanged"; await this.save(state); continue; }
			repo.stage = "staging"; await this.save(state);
			const result = await this.integration.stage(repo.root, repo.integration!, repo.base, [], owned(repo.attempt), state.candidates[name]!, signal);
			if (result.outcome !== "ready") throw new Error(result.failure);
			repo.receipt = result.value; repo.stage = "staged"; await this.save(state);
		}
		state.tips = await this.inspectTips(state, signal); state.status = "staged";
	}
	private async preflightMain(state: WorkspaceState, promotion: boolean, signal: AbortSignal): Promise<void> {
		await this.verifyScope(state, signal);
		for (const [name, repo] of Object.entries(state.repositories)) {
			const expected = promotion && repo.promotion?.status === "promoted" ? repo.promotion.mainAfter! : repo.base;
			if (!sameIdentity(await this.git.inspectMain({ root: repo.root }, context(signal)), expected)) throw new Error(`Main target ${name} is dirty or changed; no later target will be promoted.`);
		}
	}
	private async promote(state: WorkspaceState, expected: IdentitySet, signal: AbortSignal): Promise<void> {
		if (!["validated", "partial"].includes(state.status) || !state.tips || !sameSet(state.tips, expected) || !passes(state.final, state.request.finalChecks, state.tips)) throw new Error("Promotion requires the exact complete passing final input set.");
		if (Object.values(state.repositories).some((repo) => repo.promotion?.status === "promoting")) throw new Error("Reconcile the interrupted per-repository promotion intent before continuing.");
		await this.stop(state); await this.inspectWorkers(state, signal); await this.inspectTips(state, signal);
		await this.preflightMain(state, true, signal);
		for (const [name, repo] of Object.entries(state.repositories)) repo.promotion ??= { status: "pending", expected: repo.base, tip: state.tips[name]! };
		state.status = "promoting"; await this.save(state);
		for (const [name, repo] of Object.entries(state.repositories)) {
			if (repo.promotion!.status === "promoted") continue;
			// Recheck all targets between serial mutations as well as before the first one.
			await this.preflightMain(state, true, signal); await this.inspectTips(state, signal);
			repo.promotion!.status = "promoting"; await this.save(state);
			let main: WorkspaceIdentity;
			if (repo.stage === "unchanged") main = await this.git.inspectMain({ root: repo.root }, context(signal));
			else {
				const tip = state.tips[name]!;
				const result = await this.integration.promote({ root: repo.root, integration: repo.integration!, base: repo.base, stages: [repo.receipt!],
					checks: { phase: "final", candidate: tip, identityAfter: tip, results: state.final!.results.map(({ repository: _repository, ...result }) => result), passed: true, at: Date.now() },
					commands: state.request.finalChecks.map(({ repository: _repository, ...check }) => check) }, signal);
				if (result.outcome !== "ready") throw new Error(`${name}: ${result.failure}. Earlier promotion receipts remain valid; no rollback was attempted.`);
				main = result.value;
			}
			repo.promotion = { ...repo.promotion!, status: "promoted", mainAfter: main }; await this.save(state);
		}
		await this.preflightMain(state, true, signal);
		state.status = "promoted";
	}
	private async reconcile(state: WorkspaceState, signal: AbortSignal): Promise<void> {
		await this.stop(state);
		if (Object.values(state.repositories).some((repo) => repo.promotion)) {
			for (const repo of Object.values(state.repositories)) {
				if (repo.promotion?.status !== "promoting") continue;
				const actual = await this.git.inspectMain({ root: repo.root }, context(signal));
				if (sameIdentity(actual, { ...repo.promotion.tip, branch: repo.base.branch })) repo.promotion = { ...repo.promotion, status: "promoted", mainAfter: actual };
				else if (sameIdentity(actual, repo.base)) repo.promotion.status = "pending";
				else throw new Error("Main differs from both saved promotion endpoints; manual reconciliation is required. Nothing was rolled back.");
				await this.save(state);
			}
			await this.inspectTips(state, signal); await this.preflightMain(state, true, signal);
			state.status = Object.values(state.repositories).every((repo) => repo.promotion?.status === "promoted") ? "promoted" : "partial";
			return;
		}
		if (!state.candidates) throw new Error("Interrupted allocation or worker execution requires manual inspection. Prompts and allocations are never replayed.");
		await this.inspectWorkers(state, signal);
		for (const [name, repo] of Object.entries(state.repositories)) {
			if (repo.allocation === "allocating" || !repo.integration) throw new Error("Incomplete integration allocation is retained for manual reconciliation; it is not adopted or replayed.");
			if (repo.stage === "staging") {
				const result = await this.integration.reconcileStage(repo.root, repo.integration, repo.base, [], owned(repo.attempt), state.candidates[name]!, signal);
				if (result.outcome !== "ready" || result.value === "not_started") throw new Error(result.outcome === "ready" ? "Interrupted merge did not start; its intent is retained without replay." : result.failure);
				repo.receipt = result.value; repo.stage = "staged"; await this.save(state);
			}
		}
		state.tips = await this.inspectTips(state, signal);
		state.status = passes(state.final, state.request.finalChecks, state.tips) ? "validated" : "staged";
	}
	private async cleanup(state: WorkspaceState, signal: AbortSignal): Promise<void> {
		if (state.status !== "promoted" && state.status !== "cleaned") throw new Error("Workspace cleanup requires all repositories to be promoted. Failed and aborted work stays retained for manual inspection.");
		await this.stop(state); await this.preflightMain(state, true, signal);
		const first = Object.values(state.repositories)[0]!, host = this.options.host(state.policy);
		first.cleanup ??= [];
		for (const kind of ["worker_tab", "workspace"] as const) {
			if (first.cleanup.includes(kind)) continue;
			const result = await host.cleanupHost({ requestId: state.request.id, kind, task: workerTask(state.request), attempt: first.attempt }, context(signal));
			if (result.outcome === "blocked") throw new Error(result.failure);
			first.cleanup.push(kind); await this.save(state);
		}
		for (const [name, repo] of Object.entries(state.repositories)) {
			repo.cleanup ??= [];
			for (const [label, info, expected, kind] of [
				["worker", owned(repo.attempt), state.candidates![name]!, "worktree"], ["worker_branch", owned(repo.attempt), state.candidates![name]!, "branch"],
				["integration", repo.integration!, state.tips![name]!, "worktree"], ["integration_branch", repo.integration!, state.tips![name]!, "branch"],
			] as const) {
				if (repo.cleanup.includes(label)) continue;
				const result = await this.integration.release(repo.root, info, expected, kind, signal);
				if (result.outcome !== "ready") throw new Error(result.failure);
				repo.cleanup.push(label); await this.save(state);
			}
		}
		state.status = "cleaned";
	}
}

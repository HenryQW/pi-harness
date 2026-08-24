import { randomUUID } from "node:crypto";
import { loadProjectConfig } from "./config.ts";
import { runCommand, type CommandRunner } from "./command.ts";
import { hashDeliveryGraph, readDeliveryGraph } from "./graph.ts";
import { inspectActiveIntegrationWorktree, inspectIntegrationCandidate, resolveGitTopLevel } from "./git.ts";
import type { ProjectConfig, RunState } from "./model.ts";
import { createInitialRunState, createRun, readActiveRunId, type Uuid } from "./state.ts";
import { nonEmptyString } from "./validate.ts";

const LOCAL_GRAPH_PATH = ".context/issues/graph.json";
const LOCAL_CONTEXT_PATH = ".context/";

export interface IntakeOptions {
	mainWorktree: string;
	runner?: CommandRunner;
	uuid?: Uuid;
	now?: () => string;
	mainPane: string;
	workspaceId: string;
	expectedGraphHash?: string;
}

export interface LocalRunPreflight {
	main_worktree: string;
	branch: string;
	head: string;
	default_branch: string;
	config: ProjectConfig;
}

/** Read-only validation shared by confirmation and the final start boundary. */
export async function preflightLocalRun(mainWorktree: string, runner: CommandRunner = runCommand): Promise<LocalRunPreflight> {
	const root = await resolveGitTopLevel(mainWorktree, runner);
	const source = await inspectIntegrationCandidate(root, runner);
	await assertIgnoredLocalContext(root, runner);
	const active = await readActiveRunId(root);
	if (active) throw new Error(`An active pi-auto-dag run already exists: ${active}`);
	return { main_worktree: root, ...source, config: await loadProjectConfig() };
}

/** Validate local authority once, then persist the normalized graph and integration facts. */
export async function startLocalRun(options: IntakeOptions): Promise<RunState> {
	const runner = options.runner ?? runCommand;
	const boundary = await preflightLocalRun(options.mainWorktree, runner);
	const mainWorktree = boundary.main_worktree;
	const uuid = options.uuid ?? randomUUID;
	const mainPane = nonEmptyString(options.mainPane, "main Herdr pane");
	const graph = await readDeliveryGraph(mainWorktree);
	if (options.expectedGraphHash !== undefined && hashDeliveryGraph(graph) !== options.expectedGraphHash) {
		throw new Error("Delivery Graph changed after execution confirmation");
	}

	const state = createInitialRunState({
		run_id: uuid(),
		graph,
		source_commit: boundary.head,
		main_worktree: mainWorktree,
		integration_branch: boundary.branch,
		default_branch: boundary.default_branch,
		created_at: (options.now ?? (() => new Date().toISOString()))(),
		main_pane: mainPane,
		workspace_id: nonEmptyString(options.workspaceId, "Herdr workspace id"),
	});
	await createRun(mainWorktree, state, uuid);
	return state;
}

/** Local inputs and all generated run state must stay outside Git's dirty-worktree boundary. */
export async function assertIgnoredLocalContext(mainWorktree: string, runner: CommandRunner = runCommand): Promise<void> {
	const graph = await runner("git", ["ls-files", "--error-unmatch", "--", LOCAL_GRAPH_PATH], { cwd: mainWorktree });
	if (graph.code === 0) throw new Error(`${LOCAL_GRAPH_PATH} must be untracked and Git-ignored`);
	if (graph.code !== 1) throw new Error(`git ls-files failed while checking ${LOCAL_GRAPH_PATH}`);

	const ignored = await runner("git", ["check-ignore", "--quiet", "--no-index", "--", LOCAL_CONTEXT_PATH], { cwd: mainWorktree });
	if (ignored.code === 0) return;
	if (ignored.code === 1) throw new Error(`${LOCAL_CONTEXT_PATH} must be Git-ignored`);
	throw new Error(`git check-ignore failed while checking ${LOCAL_CONTEXT_PATH}`);
}

/** Every execution boundary reads only the live main-worktree graph and source-commit config. */
export async function assertRunBoundary(
	state: RunState,
	runner: CommandRunner = runCommand,
): Promise<ProjectConfig> {
	const current = await inspectActiveIntegrationWorktree(state.main_worktree, runner);
	if (current.branch !== state.integration_branch) {
		throw new Error(`Main integration branch changed from ${state.integration_branch} to ${current.branch}`);
	}
	if (current.head !== state.integration_head) {
		throw new Error(`Main integration HEAD changed from ${state.integration_head} to ${current.head}`);
	}
	const graph = await readDeliveryGraph(state.main_worktree);
	if (hashDeliveryGraph(graph) !== state.graph_hash) {
		throw new Error("Delivery Graph changed during the run; execution is blocked");
	}
	return await loadProjectConfig();
}

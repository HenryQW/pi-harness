import type { CoreLifecycle } from "../../src/lifecycle.ts";
import { parseDeliveryGraph } from "../../src/graph.ts";
import { createOrchestratorExtension } from "../../src/orchestrator.ts";
import { createInitialRunState } from "../../src/state.ts";

const state = createInitialRunState({
	run_id: "00000000-0000-4000-8000-000000000001",
	graph: parseDeliveryGraph({
		status: "approved",
		id: "worker-ui-demo",
		goal: "Preview active workers.",
		constraints: [],
		non_goals: [],
		issues: [
			{ id: "api", title: "API", profile: "backend", objective: "Build API.", acceptance: ["API works."], testing: "npm test", depends_on: [] },
			{ id: "web", title: "Web", profile: "frontend", objective: "Build UI.", acceptance: ["UI works."], testing: "npm test", depends_on: [] },
		],
		final_check: { acceptance: ["Checks pass."], testing: "npm test" },
	}),
	source_commit: "demo",
	main_worktree: process.cwd(),
	integration_branch: "demo",
	default_branch: "main",
	created_at: new Date(0).toISOString(),
	main_pane: "demo",
	workspace_id: "demo-workspace",
});
state.tasks.api = {
	status: "implementing",
	attempts: 1,
	implementer_agent: "dag-api-i",
	implementer_pane: "demo-api",
	activity_started_at: new Date(Date.now() - 65_000).toISOString(),
};
state.tasks.web = {
	status: "reviewing",
	attempts: 1,
	reviewer_agent: "dag-web-r",
	reviewer_pane: "demo-web",
	activity_started_at: new Date(Date.now() - 125_000).toISOString(),
};

const lifecycle: CoreLifecycle = {
	start: async () => state,
	status: async () => state,
	resume: async () => state,
	resolve: async () => state,
	abort: async () => state,
	health: async () => state,
};

export default createOrchestratorExtension({
	lifecycle,
	runner: async () => ({
		code: 0,
		stdout: JSON.stringify({
			result: {
				agents: [
					{ pane_id: "demo-api", agent_status: "working", workspace_id: "demo-workspace" },
					{ pane_id: "demo-web", agent_status: "idle", workspace_id: "demo-workspace" },
				],
			},
		}),
		stderr: "",
	}),
});

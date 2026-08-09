# `@henryqw/pi-auto-dag`

Pi extension package for an approved local `.context/issues/graph.json` Delivery Graph.

## Install and scope resources

Configure the package as filtered resources. Main integration settings load only the orchestrator extension:

```json
{
  "packages": [{
    "source": "npm:@henryqw/pi-auto-dag",
    "autoload": false,
    "extensions": ["extensions/auto-dag.ts"]
  }]
}
```

Each worker profile uses the same package with only `extensions/worker.ts`. Pi then loads that profile natively; worker launches add `--no-skills`, `<profile>/.agents/skills`, `<main-worktree>/.pi/shared-skills/.agents/skills`, and a role-specific tool allowlist.

The main extension registers these lifecycle tools and activates only those valid for current run state:

- `auto_dag_start`
- `auto_dag_status`
- `auto_dag_resume`
- `auto_dag_resolve`
- `auto_dag_abort`
- `auto_dag_health`

The main Pi UI shows a compact widget for active and blocked workers. Each row shows its issue, human activity, live Herdr state, and time in the current activity; blocked rows include their reason. Activity times survive Pi reloads in durable run state and repaint locally every second. One batched Herdr agent read refreshes live states every five seconds and after lifecycle tool calls. Runs persist their initiating Herdr workspace, filter every agent listing to it, and prefix worker names with that workspace ID so another Auto DAG cannot reuse or close their agents.

`status` may read a historical `run_id`; `health` requires one. `resume`, `resolve`, and `abort` always use the sole active run. Strict worker-envelope JSON arriving in main pane routes directly into active lifecycle without a model turn. Manual envelope-less `resume` and explicit retained-run `health` remain available.

## Local inputs and state

The strict JSON configuration is loaded from `join(getAgentDir(), "config", "pi-auto-dag.json")`, typically `~/.pi/agent/config/pi-auto-dag.json`; `PI_CODING_AGENT_DIR` changes the agent directory. It is not committed to the repository:

```json
{
  "version": 1,
  "profiles": {
    "coder": "/absolute/path/to/coder",
    "backend": "/absolute/path/to/backend",
    "frontend": "/absolute/path/to/frontend",
    "reviewer": "/absolute/path/to/reviewer"
  }
}
```

Optional positive `max_parallel_tasks` and `max_review_rounds` both default to `5`. Intake accepts only an approved graph at `.context/issues/graph.json` in the main integration worktree.

Each run stores a normalized graph SHA-256, source commit, expected integration `HEAD`, recorded main pane, and facts in `.context/pi-auto-dag/runs/<UUID>/state.json`. `active.json` is an exclusive same-checkout lock. The state file is atomically replaced; lifecycle mutations are serialized in-process and the lock stays until cleanup succeeds.

## Delivery Graph

The only graph location is the ignored, untracked `.context/issues/graph.json` in the main integration worktree; there is no path override. Its top-level object has exactly `version` (`1`), `status` (`"draft"` or `"approved"`), `id`, `title`, `goal`, `constraints`, and `issues`. Only `"approved"` may start a run.

Every Local Issue has exactly `id`, `title`, `role`, `profile`, `purpose`, `acceptance`, `testing`, and `blocked_by`. IDs are lowercase hyphenated names; `constraints`, `acceptance`, and `blocked_by` are string arrays. An `implementation` uses `profile` `"coder"`, `"backend"`, or `"frontend"` (a profile name, never a path). There is exactly one `final_check`, with `profile: null`; it has the same shape and must be blocked by every implementation ID. Dependencies use `blocked_by` only: there is no `blocks` field, and no issue may depend on `final_check`.

Minimal startable example:

```json
{
  "version": 1,
  "status": "approved",
  "id": "example-delivery",
  "title": "Example delivery",
  "goal": "Deliver one checked change.",
  "constraints": [],
  "issues": [
    {
      "id": "implement-change",
      "title": "Implement change",
      "role": "implementation",
      "profile": "backend",
      "purpose": "Make the requested change.",
      "acceptance": ["Change works."],
      "testing": "npm test",
      "blocked_by": []
    },
    {
      "id": "final-check",
      "title": "Final check",
      "role": "final_check",
      "profile": null,
      "purpose": "Verify the integrated delivery.",
      "acceptance": ["Verification passes."],
      "testing": "npm test",
      "blocked_by": ["implement-change"]
    }
  ]
}
```

## Orchestration

Start from the main Herdr pane. The extension freezes each ready dependency wave at its integration commit, creates child worktrees beside the integration worktree under `.<repo>-auto-dag/<run-id>/<issue-id>`, and starts one implementer tab per active task in the workspace containing the recorded main pane. `.context` stays only in the main worktree.

Implementers send their compact worker-tool envelope to recorded main pane; main extension validates and routes that JSON without a model relay. A review request must name the clean child-worktree `HEAD` on its recorded branch, which must be exactly one commit over the frozen base, plus the prompted task attempt and next review round; after `changes_requested`, it must be a new amended or replacement SHA. Review verdicts and blocker reports bind the active role, task attempt, and review round; verdicts also carry the frozen testing command, exact commit, and exit code, and only exit code `0` may approve. The task-owned reviewer pane starts then, runs the issue's frozen testing command, and remains for bounded revision rounds. Approved commits integrate only after the full frozen wave is reviewed, in lexical Local Issue ID order. `final_check` is never dispatched as a worker.

An envelope advances only that worker event and never broadly reconciles or nudges workers. While a task is blocked, new worker dispatch is deferred until every task block resolves, though an in-flight review may still submit its verdict. Every execution boundary requires the clean main integration worktree to remain at its recorded expected `HEAD`; successful or recovered cherry-picks advance that fact atomically. An explicit envelope-less `auto_dag_resume` rechecks the graph and agent configuration, asks live workers to resend their last event, restarts a missing role with its durable pending instruction, and retries blocked cleanup. A cherry-pick conflict aborts that pick and sends the same task back to its existing implementer and reviewer on the current integration `HEAD` for one replacement commit. Abort removes owned tabs/worktrees, retains unintegrated branches, and releases the active lock only after native cleanup completes.

## Final check, PR, and health

After every implementation Local Issue integrates, the frozen `final_check.testing` command is assigned to one temporary read-only reviewer at the exact integration `HEAD`. A failed gate blocks the run before any push or PR. Resolve it against the completed implementation Local Issue that owns the repair, not `final_check`; this starts a fresh child worktree and a fresh implementer, then an on-demand reviewer must approve its sole repair commit before it is cherry-picked and the final gate runs again.

On approval, Auto DAG pushes only the recorded integration branch to `origin` and opens one PR against the recorded default branch. Recovery reuses only an open PR with the exact recorded number, URL, head branch, base branch, and head commit. The PR body records the Delivery Graph ID/hash, source commit, and completed Local Issue IDs; it deliberately contains no issue-closing references. Lifecycle-owned repair picks persist their intent before Git runs, so crash recovery can finish an applied pick or safely abort a conflict.

`auto_dag_health` works only on a retained completed run. It rechecks the graph hash, clean recorded branch, agent configuration and coder profile, then fast-forwards locally to the exact remote PR head with `git merge --ff-only`; it never resets or switches branches. Its one read-only reviewer records only unresolved thread node IDs plus failing-check name/link/output evidence. If none is actionable, it records that evidence and stops without a coder or push. Otherwise one coder repairs the current PR head in a fresh child worktree, that same reviewer approves the exact repair commit, Auto DAG pushes once to the same PR, and resolves only the triaged thread IDs the reviewer marks fixed. Health events carry their prompted attempt and review round, so delayed events are ignored. A changed PR head blocks the active repair, and a successful push enters durable cleanup-only state so retries cannot review, pick, or push it again. Later feedback waits for another explicit health run.

Successful PR completion removes owned Herdr tabs, child worktrees, and integrated child branches, then releases the active lock. Abort never force-deletes uncommitted work or unintegrated branches. Run State and PR/health evidence remain under `.context/pi-auto-dag/` until manually removed.

## Development

```bash
npm run dev:ui --workspace @henryqw/pi-auto-dag
npm test --workspace @henryqw/pi-auto-dag -- core
npm test --workspace @henryqw/pi-auto-dag -- orchestration
npm test --workspace @henryqw/pi-auto-dag -- pr-lifecycle
npm run typecheck --workspace @henryqw/pi-auto-dag
npm run pack:check --workspace @henryqw/pi-auto-dag
```

`dev:ui` opens an isolated, offline Pi TUI with deterministic working and idle rows so the worker widget and live elapsed timers can be inspected directly.

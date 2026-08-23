# 018. pi-subagent Execution

- **Status:** accepted
- **Date:** 2026-08-13, updated 2026-08-20 (migrated from Obsidian vault)

## Decision

- **Run each `delegate_task` call in one ephemeral Pi child process using `pi --mode json -p --no-session`.** Pi CLI already provides context isolation, exact resource selection, structured events, and process-level crash isolation. One delegated task maps to one disposable process with abort propagation and no saved child session; Main owns orchestration.
- **Pi Subagent owns two lifecycle paths: ephemeral `delegate_task` children and Herdr-backed managed workers.** Herdr remains for persistent multi-turn workers that must survive orchestrator pauses or restarts; Auto DAG consumes this lifecycle API and does not manage Subagent processes itself. Ephemeral delegation has a 10-minute soft deadline, one 5-minute grace when model/tool/recent activity shows work, and a 15-minute hard cap. Pi child processes provide bounded one-task isolation, while durable multi-turn workers need external supervision and reconnection. Timeout applies only to ephemeral delegation; managed Auto DAG workers retain existing lifecycle semantics. Source: user direction on 2026-08-20, superseding the earlier same-day removal decision.
- **Main decomposes broad work into independent bounded task packets and retains integration and cross-cutting decisions.** Each packet states its objective, exact scope and exclusions, relevant context and constraints, expected deliverable, and validation. Main chooses the least capable `modelClass` that can reliably complete each task. Independent calls may run concurrently; concurrent edit tasks must own non-overlapping files. Decomposition must happen before child launch, while file ownership prevents external child processes from racing on shared files. `delegate_task` exposes caller-side prompt guidance while Role instructions remain child-owned. Source: user-approved delegation prompt design.

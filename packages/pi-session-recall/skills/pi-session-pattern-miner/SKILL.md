---
name: pi-session-pattern-miner
description: Mine repeated work, corrections, and manual procedures from past Pi sessions with session_search, then identify the smallest deterministic script or reusable skill that would prevent repeating them. Use when the user asks what to automate, which workflows recur, or what skill or script should be extracted from prior Pi sessions.
---

# Pi Session Pattern Miner

Find repeated work in past Pi sessions and turn the best-supported pattern into an automation candidate. Use `session_search` for session history; do not scan Pi session files directly. The current model mines the evidence once; the resulting automation should remove model judgment from recurring execution wherever the workflow permits it.

## Scope

Use the scope or topic in the request. Otherwise sample recent sessions. If the user specifies the current repository, use the current Git root and session `cwd` metadata to filter where possible; search distinctive repository or package names to find related sessions from other worktrees.

State the sampled scope and its limits. `session_search` browse returns at most ten recent sessions, discovery is query-driven, and current live-context matches are suppressed. Its messages contain user/assistant text, not hidden thinking or tool output. Never claim exhaustive coverage or invent commands that are absent from the evidence.

## Mine

1. Call `session_search` with only `limit: 10` to seed the sample.
2. Read each in-scope session by `sessionId`. For a truncated session, inspect only relevant gaps with `sessionId`, `aroundMessageId`, and `window: 20`; retain `branchTip` while scrolling a fork.
3. Extract candidate episodes: repeated user intents, corrections, manual procedures, avoidable retries, and agent-authored steps that recur. Ignore generic coding work such as inspect/edit/test unless the same concrete procedure repeats.
4. Cluster by underlying job, not wording. A pattern needs evidence from at least two independent sessions; do not count forks, retries, or continuations of one task as separate evidence.
5. Confirm each candidate with one or more distinctive `query` searches using `limit: 10` and `detail: "full"`. Record session path, date or name, relevant entry id, and a short paraphrase. Do not copy secrets or unnecessary transcript text.
6. Inspect the current repository's commands, package scripts, executable scripts, skills, and agent instructions before proposing anything. Reuse or repair an existing automation when it already owns the workflow.

Stop with “not enough repeated evidence” when fewer than two independent sessions support a pattern. Do not manufacture a recommendation from one occurrence.

## Choose the owning surface

Stop at the first option that fully handles the pattern:

1. **Existing command or skill** — document, fix, or invoke it instead of adding another path.
2. **Script** — choose when inputs, decisions, outputs, and failures can be specified without model judgment. Prefer a repository command or standard-library script over a new dependency.
3. **Script plus thin skill** — choose when an agent must gather inputs or explain results, but the repeated operation itself can be deterministic. The skill must call the script rather than restate its algorithm.
4. **Skill only** — choose only when the reusable work inherently requires judgment, repository inspection, or user decisions.
5. **Product change** — choose when the root cause belongs in an extension, API, CI check, or other code rather than agent instructions.

A deterministic candidate must define its trigger, inputs, outputs, side effects, failure behavior, and one runnable check. If those cannot be defined from session evidence plus the current codebase, recommend a focused investigation instead of automation.

## Report

Return at most three ranked patterns:

| Pattern | Independent sessions | Repeated cost or failure | Existing coverage | Smallest automation |
| --- | ---: | --- | --- | --- |

For each pattern, cite the session paths and entry ids, explain why the proposed owning surface fits, and state what model work it removes. Then give the highest-confidence candidate a minimal implementation contract:

- **Trigger and inputs**
- **Deterministic steps**
- **Output and side effects**
- **Failure behavior**
- **Runnable check**
- **Files to add or change**

Do not grade the agent, generate a report site, or modify files unless the user asks to implement a candidate.

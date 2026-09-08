---
name: pi-session-pattern-miner
description: Mine repeated work, corrections, and manual procedures from past Pi sessions with session_search, then identify the smallest deterministic script or reusable skill that would prevent repeating them. Use when the user asks what to automate, which workflows recur, or what skill or script should be extracted from prior Pi sessions.
---

# Pi Session Pattern Miner

Find repeated work in past Pi sessions. Turn the best-supported pattern into the smallest useful automation.

Use `session_search` for session history. Do not scan Pi session files directly.

## Prepare once

Choose the requested scope. Use `repository` for the current Git repository. Use `all` for a cross-repository request or work outside Git.

Before interpretation, call `session_search` exactly once with:

```json
{
  "operation": "prepare-pattern-miner",
  "scope": "repository",
  "limit": 10
}
```

Change only `scope` when needed. Do not run manual browse, read, scroll, or inventory rounds during preparation.

State the returned scope and sample count. If `sync.complete` is false, report the incomplete walk or positive backlog as a sample limitation.

The prepared corpus is recent and bounded. A truncated session can omit middle episodes. Never claim exhaustive coverage.

## Mine

The model performs these steps. Do not replace them with mechanical keyword rules.

1. Identify semantic episodes, including repeated intents, corrections, retries, manual procedures, and recurring agent-authored steps.
2. Ignore generic inspect, edit, and test work unless the same concrete procedure repeats.
3. Cluster episodes by their underlying job, not their wording.
4. Treat sessions with equal `lineageId` values as one source.
5. Choose the owning automation surface from the prepared inventory and targeted repository evidence.
6. Write the recommendation and implementation contract.

A user-supplied topic is already a candidate. Run a focused confirmation search even when that topic is absent from the prepared sample.

For other work, create a candidate from the prepared corpus before running optional searches. Do not search speculatively when no topic or candidate exists.

Confirm a candidate with one or more distinctive `query` calls. Use `limit: 10`. Record the session path, date or name, relevant entry ID, and a short paraphrase.

Do not copy secrets or unnecessary transcript text. Do not count forks, retries, or continuations of one task as independent evidence.

## Verify ownership

After clustering, inspect only candidate-relevant skill, executable, and instruction files. Use the paths returned by the inventory.

Reuse or repair existing automation when it already owns the workflow. Inventory names and paths help discovery, but they do not prove ownership by themselves.

If inventory is truncated or unavailable, inspect the likely owning files directly. Abstain when ownership cannot be verified safely.

## Evidence gate

A recommendation requires two independent examples. This gate is mandatory.

Stop with “not enough repeated evidence” when fewer than two independent sessions support a pattern. Do not manufacture a recommendation from one occurrence.

## Choose the owning surface

Stop at the first option that fully handles the pattern:

1. **Existing command or skill** — document, fix, or invoke it instead of adding another path.
2. **Script** — use when inputs, decisions, outputs, and failures need no model judgment.
3. **Script plus thin skill** — use when an agent gathers inputs, but a script performs the repeated operation.
4. **Skill only** — use only when the reusable work inherently requires judgment, repository inspection, or user decisions.
5. **Product change** — use when the root cause belongs in an extension, API, CI check, or other code.

Prefer a repository command or standard-library script. Add no dependency without evidence that existing tools cannot handle the job.

A deterministic candidate must define its trigger, inputs, outputs, side effects, failure behavior, and one runnable check. Recommend investigation when evidence cannot define these details.

## Report

Return at most three ranked patterns:

| Pattern | Independent sessions | Repeated cost or failure | Existing coverage | Smallest automation |
| --- | ---: | --- | --- | --- |

For each pattern, cite session paths and entry IDs. Explain why the owning surface fits and what model work it removes.

Give the highest-confidence candidate a minimal implementation contract:

- **Trigger and inputs**
- **Deterministic steps**
- **Output and side effects**
- **Failure behavior**
- **Runnable check**
- **Files to add or change**

Do not grade the agent, generate a report site, or modify files unless the user asks to implement a candidate.

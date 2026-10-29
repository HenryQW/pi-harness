---
description: Hand off a separate issue to a new Herdr worktree from main.
argument-hint: "<issue>"
---

Hand off this separate issue to a new Herdr worktree: $ARGUMENTS

If the issue is empty, stop and ask the user to run `/handoff-worktree <issue>`. Do not modify the current worktree.

1. Gather only the missing facts from the conversation and the repository. Ask one focused question only if the repository, expected outcome, or a critical constraint is unclear.
2. Write one self-contained prompt: problem, evidence, expected outcome, constraints, starting files, validation, and requested delivery. Exclude unrelated context, secrets, and stale runtime IDs.
3. Choose a concise branch, a short label, and a unique agent name.
4. Call `herdr_handoff` with them. Set `project` to the selected repository path when the current directory is a non-Git folder or the pane workspace belongs to another repository. Resolve relative paths from the current Pi working directory. Never scan or guess a sibling repository. Report the result. Do not wait for the new agent to finish.

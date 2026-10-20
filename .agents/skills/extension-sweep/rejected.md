# Rejected sweep findings

Scouts must not report these again unless the cited code or its call frequency changed. Add each new rejection with its reason and the sweep PR number.

| Package | Finding | Reason | Source |
| --- | --- | --- | --- |
| pi-subagent | Reread session in the 250 ms settle poll | Short window; Git inspection dominates. | #468 |
| pi-subagent | Reuse state after save instead of reparsing | Would share a mutable snapshot. | #468 |
| pi-subagent | Reread state before each `saveProductive` | Detects an external abort; about 1 ms per operation. | 2026-10-20 |
| pi-subagent | Fewer verify calls, shared snapshots, or one save per item in discard | Rare user-confirmed delete; these are data-loss guards. | 2026-10-20 |
| pi-subagent | Text-buffer and continuation double parse; serial `inspectMainBase` Git; extra render requests | Small, rare, or already coalesced. | #468 |
| pi-subagent | Trim prompt text; remove helpers used only by tests | Maintainer declined; tests use them. | #468 |
| pi-subagent | Remove built-in Role tool assertions in `examples.test.ts` | Security contract for Role tools. | 2026-10-20 |
| pi-pr | Skill reinjection; sequential CI log reads; routing spinner; cross-repo metadata reads | Once per route, ordered budget, or rare. | #468 |
| pi-pr | Remove re-reads that compare against an earlier discovery (`samePullRequestSnapshot`, `sameLinkage`, `freshAuthority`, the feedback guard's second discovery) | Authority brackets around mutations; maintainer kept them. | 2026-10-20 |
| pi-pr | Parallel discovery reads; drop Codex reads from helper loads | Changes error order; maintainer deferred. | 2026-10-20 |
| pi-pr | Remove action-list assertions in `pr.test.ts`; UI and discovery test duplicates | Public tool contract, or the only coverage of fetch-before-classify. | 2026-10-20 |
| pi-herdr-tools | Skip `removeStale()` on the 3 s merge poll | Only expiry path for a deferred merge. | #468 |
| pi-herdr-tools | Cache merge payload parse per launch | Runs only while a merge request is pending. | 2026-10-20 |
| pi-herdr-tools | Parallel rename reads; duplicate handoff `rev-parse` | Ordered with `isCurrent`, or once per command. | 2026-10-20 |
| pi-memory | `MEMORY_CHECK` per-turn text; tool description trim | Deliberate; `/btw` children rely on the description. | #468, 2026-10-20 |
| pi-memory | Per-turn prompt join; `/remember` double read | Microseconds, or once per command. | #468 |
| pi-session-recall | Session walk; inventory bound; `maxFittingCap` serialization | Small real data, 10 KB cap, or pattern miner only. | #468, 2026-10-20 |
| pi-session-recall | Reuse `pi-process` for `runGit` | Not a drop-in swap (environment, byte parsing). | 2026-10-20 |
| pi-session-recall | Incremental indexing of appended session data | Medium risk; maintainer deferred. | 2026-10-20 |
| pi-cron | Config and state reload per tick; `Intl` formatter cache | Real config is 263 bytes; one tick per 60 s. | 2026-10-20 |
| pi-rtk-test | Lazy `rtk test --help` probe | Measured 5 ms. | 2026-10-20 |
| pi-add-dir | Instruction reads per turn; `promptGuidelines` trim | Keeps edits live; maintainer deferred prompt trims. | #468, 2026-10-20 |
| pi-auto-compact | Use `ctx.model.contextWindow` before `getContextUsage()` | Routed-model window risk for small gain. | 2026-10-20 |
| pi-footer, pi-notes, pi-codegraph, pi-ask-question | Usage loop; notes Git pruning; startup probes; snippet tokens | Linear, no records, startup only, or about 20 tokens. | #468 |
| pi-footer, pi-add-dir | Footer config and open-in render tests; add-dir codemode test | Only coverage of render cache or codemode output. | 2026-10-20 |

# Thread Triage

- Resolved: ignore.
- Outdated: inspect current diff and source lines; re-anchor before deciding relevance.
- Open/current: record `actionable`, `non-actionable`, or `blocked` with evidence,
  smallest fix, and regression check.
- Resolve only an addressed actionable thread after verified fix and head check.
  Never resolve non-actionable or blocked threads; report their IDs as pending.

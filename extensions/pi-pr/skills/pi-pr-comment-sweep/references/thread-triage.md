# Thread Triage

- Resolved: record the thread and its comments as `non-actionable`.
- Outdated: inspect current diff and source lines; re-anchor before deciding relevance.
- Open/current: record `addressed`, `non-actionable`, or `blocked` with evidence,
  smallest fix, and regression check.
- Resolve only an addressed actionable thread after verified fix and head check.
  Never resolve non-actionable or blocked threads; report their IDs as pending.

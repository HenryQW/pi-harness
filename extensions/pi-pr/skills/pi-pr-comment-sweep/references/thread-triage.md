# Thread Triage

- Already resolved: record the thread and its comments as non-actionable history; do not reply or resolve again.
- Outdated: inspect current diff and source lines; re-anchor before deciding relevance. If the fixing commit made a classified thread outdated, keep its decision unless the comment content changed.
- Open/current: inspect every child comment and classify the parent as addressed, non-actionable, or blocked. Record the proposed smallest fix and check for an actionable thread, or a specific one-sentence reason for a non-actionable thread.
- Already fixed by a published PR commit: classify it as addressed and set `commit` to that full hash instead of making another change.
- After publication, reply with only the full published commit hash that addresses the thread (the cited `commit`, otherwise the sweep's published head), or the recorded one-sentence rebuttal for a non-actionable thread, then resolve it. Leave blocked threads open.

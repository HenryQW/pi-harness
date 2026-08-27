# Package-owned `delegate_flow` orchestration

`delegate_task` remains the generic bounded Role executor described by [ADR 001](./001-composable-ephemeral-execution.md). The package will also provide `delegate_flow` as a thin caller above that executor because deterministic candidate preparation and integration remove repeated Main-side Git work, reduce context use, and bind every integration decision to exact evidence.

A Flow implements independent units in parallel, then validates, reviews, and fast-forwards one immutable Integration Candidate at a time in declared order. Gate Approval is bound to the candidate's exact base OID, tip OID, and patch SHA-256; source branches are never approved.

The Flow is deliberately session-local and supports one Flow per Main session. It does not add a DAG, persisted recovery, concurrent Flow coordination, rollback, dependency modeling, or automatic repair loops; dependent work remains ordinary caller composition, and blocked repair or reconsideration remains an explicit Main decision.

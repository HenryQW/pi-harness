# Confirm each PR merge

A merge is irreversible and outward-facing, so `/pr` asks for explicit approval before each merge. ADR 0003 let one invocation merge without a dialog; in practice, automatic continuation after a finalized feedback sweep merged a pull request that the user had not approved. Before the merge mutation, an interactive session shows one native confirmation that names the PR number and URL, the short head OID, the base ref, and the configured `mergeMethod`. A decline reports the PR as merge-ready and ends the invocation without error. A session without UI never merges and stops at merge-ready. The confirmation covers every path to a merge, including continuation after a completed helper action.

Confirmation is not readiness authority. After a yes, `/pr` still runs fresh discovery, requires the same confirmed PR context, readiness, and no new feedback, and sends the merge with the exact confirmed `expectedHeadOid`, so a head that changed while the dialog was open cancels the merge. Routine creation, linking, sync, publication, sweeps, CI repair, and CI waits keep running without prompts.

This supersedes the merge clause of ADR 0003. `/pr` stays flagless and adds no configuration to skip the confirmation.

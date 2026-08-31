# Route `/pr` by current condition

`/pr` is one argument-free workflow router rather than a browser opener, workflow menu, or family of action commands. Each invocation reads fresh remote and local state, derives one priority next step shared with the footer and widget, runs at most one workflow, then stops; deterministic merging runs directly only after final confirmation. This keeps the public interaction small while preventing stale polling state, conflicting UI priorities, and one approval from chaining into unrelated mutations.

# Pi Task Models

Pi Task Models owns shared Task Profiles and explicit user assignments. Consumers own their Model Tasks; Pi owns available models and their capabilities.

## Language

**Model Task**:
A consumer-owned, independently executed model operation with a declared identity, purpose, and default Task Profile. Work performed by the current session agent is not a Model Task.
_Avoid_: package-wide model setting, centrally owned consumer-task catalog, current-agent work

**Task Profile**:
A named shared route set: `fast`, `balanced`, `frontier`, or `fav`. A configured profile has a primary Task Route and an optional fallback, except that `fav` has no fallback.
_Avoid_: package-owned model picker, per-extension model catalog

**Task Route**:
One model reference and thinking level resolved against Pi's available text models in the current session scope. A scope-pinned thinking level remains binding.
_Avoid_: free-form provider path, copied model metadata

**Task assignment**:
An explicit user choice of Task Profile for a Model Task, in place of its consumer-declared default. An inactive task can retain its assignment.

**Task declaration**:
A consumer's identity, label, purpose, and default profile for one Model Task, not a shared model catalog.

**Task declaration discovery**:
The collection of declarations from active consumers for the shared configuration view. It does not search package files.
_Avoid_: filesystem scan, command/tool source discovery

**Task-model preset**:
A named saved set of complete routes for some or all Task Profiles. It contains no task assignments, and omitted profiles retain their current routes when the preset is applied.

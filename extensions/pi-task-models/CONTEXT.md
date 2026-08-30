# Pi Task Models

Pi Task Models stores shared Task Profiles and explicit user overrides for consumer-owned Model Tasks. Consumers declare identity, intent, and default profiles; this package has no consumer catalog or package/source discovery.

## Language

**Model Task**:
A consumer-owned independently executed model operation. Exists only for independent model execution — not for work performed by the current session agent. Each consumer owns its Model Task ID, label, purpose, execution/prompt, and default Task Profile.
_Avoid_: package-wide model setting, centrally owned consumer-task catalog, current-agent work

**Task Profile**:
Named shared route set (`fast`, `balanced`, `frontier`, or `fav`) with a required primary route and optional fallback route (`fav` has no fallback).
_Avoid_: package-owned model picker, per-extension model catalog

**Task Route**:
One model reference plus thinking level chosen from current Pi model scope. Empty scope means every available registry model; pinned scope thinking remains binding.
_Avoid_: free-form provider path, copied model metadata

**Task declaration discovery**:
The single control plane requests active consumer declarations through an idempotent namespaced Pi event request/response handshake when `/task-models` opens. It shows each declaration's effective `config.tasks[id] ?? defaultProfile`; inactive explicit overrides remain stored.
_Avoid_: filesystem scan, command/tool `sourceInfo` discovery, bundled consumer control planes

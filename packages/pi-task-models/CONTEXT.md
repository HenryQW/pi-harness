# Pi Task Models

Pi Task Models stores shared task profiles and task-to-profile assignments for HenryQW extensions, including default Subagent effort.

## Language

**Task Profile**:
Named shared route set (`fast`, `balanced`, or `frontier`) with a required primary route and optional fallback route.
_Avoid_: package-owned model picker, per-extension model catalog

**Task Route**:
One model reference plus thinking level chosen from current Pi model scope. Empty scope means every available registry model; pinned scope thinking remains binding.
_Avoid_: free-form provider path, copied model metadata

**Active Task Package**:
Installed HenryQW package discovered from Pi command/tool sourceInfo.
_Avoid_: filesystem scan, settings.json scan

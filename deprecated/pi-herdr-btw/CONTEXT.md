# Pi Herdr BTW (retired)

This archive records the former side-question context, now part of [Pi Herdr Tools](../../extensions/pi-herdr-tools/CONTEXT.md). These terms describe the archived package, not a second active implementation.

## Language

**Main**:
The parent Pi session that owned side-thread launch and merge delivery.
_Avoid_: Parent agent

**Side Thread**:
A separate Pi conversation and Herdr pane for a bounded question, with a snapshot of Main's context. It shared the working directory; it did not isolate file changes.
_Avoid_: Child agent

**Side-Thread Transcript**:
The user and assistant text returned to Main, excluding tool payloads.
_Avoid_: Full child context

**Merge Request**:
A one-way handoff of a Side-Thread Transcript and follow-up prompt to Main, without waiting for acknowledgement.
_Avoid_: Merge acknowledgement

**BTW Task Profile**:
The shared Task Profile for the archived side-question Model Task `pi-herdr-btw/btw`, with `fast` as its default.
_Avoid_: Package-owned model picker

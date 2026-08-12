# Pi Herdr Subagents

Pi extension context for delegating bounded work from one Pi agent to one-shot subagents through Herdr.

## Language

**Main**:
Pi agent that owns delegated tasks and receives their completion notices.
_Avoid_: Parent agent, coordinator

**Delegated Task**:
One bounded unit of work assigned by Main to one Subagent.
_Avoid_: Job, assignment

**Subagent**:
One-shot Pi agent owned by Main session and created to execute exactly one Delegated Task.
_Avoid_: Worker, child agent, peer, agent session

**Subagent Limit**:
Maximum number of concurrently live Subagents that Main may own.
_Avoid_: Max concurrency, pool size

**Subagent Model Class**:
One of `fast`, `balanced`, or `frontier`, chosen by Main from Delegated Task complexity and mapped by user to one available Pi model plus one supported thinking level.
_Avoid_: Hardcoded model, model profile

**Result**:
Evidence produced by Subagent for Delegated Task, including failure information when work does not succeed. Result does not establish that Main accepted or verified work.
_Avoid_: Output, response

**Subagent Question**:
Clarification requested by Subagent and answered by user in Subagent's own Herdr tab.
_Avoid_: Escalation, question routing, Main question

**Completion Notice**:
Message sent by Subagent to Main after Result becomes available.
_Avoid_: Nudge, notification, callback

**Subagent Status Widget**:
Session-local Pi TUI rows showing live and terminal Subagent state. `/subagent-widget clear` closes terminal tabs and removes their rows.
_Avoid_: Dashboard, monitor

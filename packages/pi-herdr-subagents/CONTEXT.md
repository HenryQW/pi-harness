# Pi Herdr Subagents

Pi extension context for delegating bounded work from one Pi agent to one-shot workers through Herdr.

## Language

**Main**:
Pi agent that owns delegated tasks and receives their completion notices.
_Avoid_: Parent agent, coordinator

**Delegated Task**:
One bounded unit of work assigned by Main to one Worker.
_Avoid_: Job, assignment

**Worker**:
One-shot Pi agent owned by Main session and created to execute exactly one Delegated Task.
_Avoid_: Subagent, child agent, peer, agent session

**Worker Limit**:
Maximum number of concurrently live Workers that Main may own.
_Avoid_: Max concurrency, pool size

**Worker Model Class**:
One of `fast`, `balanced`, or `frontier`, chosen by Main from Delegated Task complexity and mapped by user to one model from Pi's available model catalog.
_Avoid_: Hardcoded model, model profile

**Result**:
Evidence produced by Worker for Delegated Task, including failure information when work does not succeed. Result does not establish that Main accepted or verified work.
_Avoid_: Output, response

**Worker Question**:
Clarification requested by Worker and answered by user in Worker's own Herdr tab.
_Avoid_: Escalation, question routing, Main question

**Completion Notice**:
Message sent by Worker to Main after Result becomes available.
_Avoid_: Nudge, notification, callback

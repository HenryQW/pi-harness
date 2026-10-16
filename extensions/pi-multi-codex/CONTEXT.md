# Pi Multi Codex

Pi Multi Codex selects among ChatGPT Codex account slots while preserving the selected physical model.

## Language

**Codex account**:
A ChatGPT identity authenticated through Codex OAuth, including Free accounts. An API-key identity is not a Codex account.
_Avoid_: API account, provider as a name for the account

**Account slot**:
A position through which Pi authenticates one Codex account. Slot 1 is native; each additional numbered slot appears as a separate provider.
_Avoid_: Account, pool member

**Remaining quota**:
The unused percentage of the seven-day Codex allowance, used to rank eligible slots with fresh usage data.
_Avoid_: Balance, normalized capacity

**Quota window**:
A Codex usage period ending at its reset time. The seven-day window supplies remaining quota; the five-hour window can temporarily block a slot.
_Avoid_: Balance period

**Five-hour quota block**:
The period after a slot reaches its five-hour usage limit and before that window resets, during which automatic routing excludes it.
_Avoid_: Exhausted account, disabled slot

**Usage snapshot**:
The last observed usage information for a slot, including any available quota, tier, and reset times. A failed observation does not prove remaining quota.
_Avoid_: Account state, credential state

**Fresh usage snapshot**:
A successful usage snapshot for the current account, less than five minutes old and before its quota reset.
_Avoid_: Live quota, session cache

**Subscription tier**:
The optional plan class used for status display and the displayed reset window. It does not determine account eligibility or ranking.
_Avoid_: Sub type, capacity multiplier

**Startup ranking**:
Selection of the eligible slot with the most fresh remaining quota before initial agent work, unless an explicit model selection takes priority.

**Quota failover**:
Selection of another eligible, untried slot after HTTP 429. Unlike startup ranking, it can use stale or missing quota data.

# Pi Multi Codex

## Language

**Codex account**:
ChatGPT identity authenticated through Codex OAuth and returning seven-day usage data. Free accounts qualify; API-key identities do not.
_Avoid_: API account, provider

**Account slot**:
Position through which Pi authenticates one Codex account. Base slot is native Codex position; additional slots are numbered.
_Avoid_: Account, pool member

**Remaining quota**:
Unused percentage of seven-day Codex allowance and sole account-selection score.
_Avoid_: Balance, normalized capacity

**Quota window**:
Seven-day Codex usage period ending at reset time.
_Avoid_: Rate limit, five-hour window

**Usage snapshot**:
Remaining quota, subscription tier, and reset times observed for account slot at specific time.
_Avoid_: Account state, credential state

**Fresh usage snapshot**:
Usage snapshot fetched successfully less than five minutes ago. Sessions share fresh snapshots instead of repeating network requests.
_Avoid_: Live quota, session cache

**Subscription tier**:
Optional Codex plan class reported by usage service for display only. Tier does not affect account eligibility or selection.
_Avoid_: Sub type, capacity multiplier

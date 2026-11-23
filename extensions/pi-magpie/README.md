# `@henryqw/pi-magpie`

See the selected Magpie model, its route, and the served account's quota in the Pi footer. Use `/magpie-quota` for full details.

## Install

```bash
pi install npm:@henryqw/pi-magpie
```

Requires Pi 1.5.0 or later. Keep the selected Magpie gateway running. For a local gateway, install Magpie and make `magpie` available on your path. For a remote gateway, configure its address and key in the Pi model registry.

## Use

For a Magpie model, the footer shows the selected model or group and the last route. When the served account matches one subscription card, it shows that account's lowest remaining percentage and reset time. The percentage is the account's allowance, not a group total. With `pi-footer`, the quota appears above the route.

The footer shows `route unavailable` when it cannot match a route to the session. It shows `account unavailable` when it cannot identify one subscription card for the route. It shows `quota unavailable` when the account or its percentage is unavailable. Use `/magpie-quota` to see all cards and windows.

Claude usage credits are an extra-usage spending cap. `/magpie-quota` shows the amount used and the limit when Magpie provides them. Credits do not change the footer quota or cause low quota warnings.

The extension warns once when a fresh quota window falls below 25 percent. One warning includes all newly low windows on a card. Each window can cause a new warning after a fresh reading rises to 25 percent or more. Stale and unknown readings do not cause warnings. A narrow terminal can truncate the status; use `/magpie-quota` for the full route, account, and all quota windows.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/magpie-quota` | command | Show all cards, windows, balances, and reading times. |
| `/magpie-quota refresh` | command | Ask Magpie for a new quota report and show it. |

Pi reads Magpie's cached report at session start and every five minutes. It reads the session route after a provider response and at the end of a turn. It checks again while a route is active and briefly after it ends. It sends a process-specific session identifier in `X-Magpie-Session` for Magpie requests. It reads the usage log by route to identify the account; it does not use global last-served data. These reads do not ask providers for quota.

A manual refresh asks Magpie for a new report; Magpie can return a cached reading. A card is stale when its reading is at least ten minutes old or has no reading time. A failed request keeps the last report and marks it stale.

## Limits and recovery

Gateway permissions, missing usage records, older Magpie versions, or a route that does not match the selected model can make the route or account unavailable. A remote Magpie provider can route a request through another gateway without reporting the final account to the selected gateway. The footer cannot identify that account from the outer route alone. Account lookup scans at most 1,000 records for the route. A provider name that differs from its subscription name can prevent a quota card match.

The extension reads the selected model's Magpie gateway. For a remote gateway, it uses the model registry's credentials and refuses redirects. Magpie decides which providers and accounts report quota. Text-only windows and balances are not percentages.

If Magpie cannot provide a reading, the footer shows `quota unavailable`. Check Magpie and run `/magpie-quota refresh`. The extension does not show raw command errors, which can contain secrets. It does not run Magpie's per-account refresh command, which can have provider-specific effects.

# `@henryqw/pi-magpie`

See the current Magpie route, served account, and quota in the Pi footer. Use `/magpie-quota` for full details.

## Install

```bash
pi install npm:@henryqw/pi-magpie
```

Requires Pi 1.5.0 or later. Install Magpie and make `magpie` available on your path. Sign in to providers in Magpie. Keep the Magpie gateway running for cached reports.

## Use

For a Magpie model, the footer shows up to two account cards. Each card shows its lowest known remaining percentage and the minutes to reset. Card numbers match `/magpie-quota`. The served model and fallback count use a separate status. A matching account uses its card number; otherwise the account is unknown. With `pi-footer`, the cards appear above the served model.

The extension warns once when a fresh quota window falls below 25 percent. It can warn again after a fresh reading rises to 25 percent or more. Stale and unknown readings do not cause warnings. A narrow terminal can truncate the status; use `/magpie-quota` for the full route, account, and all quota windows.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/magpie-quota` | command | Show all cards, windows, balances, and reading times. |
| `/magpie-quota refresh` | command | Ask Magpie for a new quota report and show it. |

Pi reads Magpie's cached report at session start and every five minutes. It reads the session route after a provider response and at the end of a turn. It checks again while a route is active and briefly after it ends. It sends a process-specific session identifier in `X-Magpie-Session` for Magpie requests. It reads the usage log by route to identify the account; it does not use global last-served data. These reads do not ask providers for quota.

A manual refresh asks Magpie for a new report; Magpie can return a cached reading. A card is stale when its reading is at least ten minutes old or has no reading time. A failed request keeps the last report and marks it stale.

## Limits and recovery

The extension reads the local gateway reported by `magpie status`. A Magpie model that uses another gateway has an unknown route and account. Gateway permissions, missing usage records, older Magpie versions, or a route that does not match the selected model can also leave them unknown. Account lookup scans at most 1,000 records for the route. A provider name that differs from its subscription name can prevent a quota card match.

Magpie decides which providers and accounts report quota. Text-only windows and balances are not percentages. If Magpie cannot provide a reading, the footer shows `unknown` or `unavailable`. Check Magpie and run `/magpie-quota refresh`. The extension does not show raw command errors, which can contain secrets. It does not run Magpie's per-account refresh command, which can have provider-specific effects.

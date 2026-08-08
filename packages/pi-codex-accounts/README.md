# `@henryqw/pi-codex-accounts`

Pi extension that keeps the native `openai-codex` provider as account A1 and
enrolls additional Codex subscriptions as numbered providers through Pi's
normal `/login` flow.

## Install

```bash
pi install npm:@henryqw/pi-codex-accounts
```

The extension reuses Pi's `auth.json` and native Codex model catalog. It does
not create a second credential store or write access and refresh tokens.

After A1 is authenticated, `/login openai-codex-account-2` adds the next
numbered account. The extension exposes one next empty slot for each successful
login and rejects duplicate Codex account identities before Pi persists them.

Authenticated accounts refresh their allowance snapshots in the background.
`codex-accounts.json` contains only account identity, normalized allowance
windows, and fetch time; it never stores credentials or authorization headers.

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```

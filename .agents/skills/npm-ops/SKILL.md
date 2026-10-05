---
name: npm-ops
description: Add, repair, or verify npm trusted publishing for public packages in this repository, or deprecate packages and version ranges with drafted migration messages.
---

# npm Ops

Choose the requested operation. Deprecation does not run trusted-publisher sync or change other packages. Extending this skill or asking for a draft/preview does not authorize live registry changes.

## Trusted publishing

Use the bundled script from the repository root. It owns the deterministic package scan and trust changes.

1. Confirm npm authentication:

   ```bash
   npx --yes npm@^11.15.0 whoami
   ```

   If needed, run `npx --yes npm@^11.15.0 login --auth-type=web`. Never ask the user to paste credentials or a one-time password into chat.

2. Check all public workspaces:

   ```bash
   bash .agents/skills/npm-ops/sync.sh --check
   ```

3. If the check reports mismatches, apply them:

   ```bash
   bash .agents/skills/npm-ops/sync.sh
   ```

   Let the user complete npm 2FA in the browser. Ask them to select npm's temporary exemption for publish and trust operations so the bulk run can finish.

4. Run `--check` again.

A package must already exist on npm. For a first release, follow [the bootstrap checklist](../../../docs/releasing.md#first-publication-checklist) and prompt the maintainer for any pending work. A missing trust configuration is created automatically.

The npm API cannot update a configuration in place. The script revokes a mismatched configuration before creating its replacement. If creation fails, rerun the script; packages already configured are skipped.

## Deprecate packages or versions

1. Establish the exact package selectors and reason from the request and repository READMEs, retirement docs, or release history. Use `@*` only when the entire package is confirmed retired; otherwise use the requested range. Ask only when the target, range, or migration is ambiguous. Never unpublish packages or alter users' installs.
2. If there is a replacement, verify its documented minimum version with `npm view '<replacement>@<version>' version`. Block if it is unavailable or the lookup fails; never direct users to an unpublished replacement. Do not invent a replacement when none is documented.
3. Draft a short, plain-English message stating the reason and next action, with the replacement and migration URL when applicable. For Pi consolidations, tell users to install the replacement, remove old sources in the relevant user/project scopes, and restart Pi. Never use an empty message: npm interprets it as removing the deprecation warning.
4. An explicit request to deprecate identified packages authorizes drafting and applying the message without a second approval. Show the selectors and draft, use the authentication step above if needed, then preview and apply with native npm commands. For draft/preview-only requests, do not apply; if preview needs unavailable authentication, report that blocker rather than logging in automatically.

   ```bash
   # Set these to the established selector and drafted message, not placeholders.
   TARGET='@henryqw/<retired-package>@<range>'
   MESSAGE='<reason, replacement, and migration guidance>'
   npx --yes npm@^11.15.0 deprecate "$TARGET" "$MESSAGE" --dry-run
   # Only after the preview succeeds and live deprecation was requested:
   npx --yes npm@^11.15.0 deprecate "$TARGET" "$MESSAGE"
   ```

5. Verify every affected version, including selected prereleases, with `npm view '<package>@<exact-version>' deprecated --json`; each must equal the drafted message. Use `npm view '<package>' versions --json` to enumerate versions, and the dry-run output to inspect the affected range. Batch verification in one local loop with bounded summary output, not one model/tool turn per version. Do not rely on a range query that omits missing fields or prereleases. If a mutation response is lost, check registry state before retrying the same operation. Report the selectors, exact message, verified results, and any blockers; do not claim success from the mutation's exit code alone.

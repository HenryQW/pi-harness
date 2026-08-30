---
name: npm-ops
description: Add, repair, or verify npm trusted publishing for public packages in this repository, including packages after their first release.
---

# npm Ops

Use the bundled script from the repository root. It owns the deterministic package scan and npm changes.

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

A package must already exist on npm. For a first release, publish it with maintainer authentication, then run this script. A missing trust configuration is created automatically.

The npm API cannot update a configuration in place. The script revokes a mismatched configuration before creating its replacement. If creation fails, rerun the script; packages already configured are skipped.

# Release packages

Agents release packages by bumping workspace versions and pushing `main`.

```bash
npm version patch --workspace extensions/<package> --no-git-tag-version
git commit -am "chore: release <package>"
git push origin main
```

`.github/workflows/publish.yml` runs checks, compares every public workspace version with npm, and publishes only new versions. No tags needed. Private workspaces are skipped.

One-time setup per package:

1. Bootstrap first version with authenticated local npm publish.
2. npm package settings → Trusted Publisher → GitHub Actions.
3. Configure `HenryQW/pi-harness` and workflow filename `publish.yml`.

Trusted publishing needs npm CLI 11.5.1+ and GitHub OIDC. Keep package scope `@henryqw` for future Pi packages.

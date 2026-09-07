## Release checklist

- [ ] Bumped every affected public package with `pnpm --filter ./<root>/<package> version patch --no-git-tag-version` using the `extensions` or `packages` root.
- [ ] No published package files changed; version bump is not needed.
- [ ] After the final base sync, ran `pnpm run check:package-versions` before committing or pushing.

List affected packages and release level, or explain why no package releases.

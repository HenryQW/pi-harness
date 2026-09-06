## Release checklist

- [ ] Bumped every affected public package with `pnpm --filter ./extensions/<package> version patch --no-git-tag-version`.
- [ ] No published package files changed; version bump is not needed.
- [ ] After the final base sync, ran `pnpm run check:package-versions` before committing or pushing.

List affected packages and release level, or explain why no package releases.

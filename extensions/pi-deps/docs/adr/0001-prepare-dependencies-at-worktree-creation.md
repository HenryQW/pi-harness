# Prepare dependencies at worktree creation

Pi Deps installs through an explicitly enabled repository's shared Git `post-checkout` hook rather than Pi session startup. Git invokes that hook for every `git worktree add` regardless of creator, so failures stay attached to workspace creation and Pi sessions pay no repeated startup cost; global Git hooks and creator-specific integrations were rejected because they either override unrelated hooks or miss other creators.

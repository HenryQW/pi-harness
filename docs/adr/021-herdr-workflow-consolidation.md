# 021. One Herdr Workflow Extension

- **Status:** accepted

`@henryqw/pi-herdr-tools` replaces `pi-herdr-btw`, `pi-herdr-clone`, and `pi-herdr-rename` with one package and one extension entry point. Clone, completion, side-thread, and title behavior stay in separate internal modules; this reduces installation and loaded-extension count without rewriting their safety boundaries. The shared `@henryqw/pi-herdr` CLI library remains separate for other consumers.

We accept losing native per-feature resource selection rather than introduce feature-toggle configuration or retain wrapper packages. Commands, task-model IDs, title session entries, BTW payload flags, config paths, and pending-delivery storage keep their existing identifiers so migration requires removing old installs, not rewriting user data. Old packages leave the active workspace and website catalog; registry deprecation follows publication of the replacement.

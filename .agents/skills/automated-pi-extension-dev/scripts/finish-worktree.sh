#!/bin/sh
# Usage: finish-worktree.sh <Herdr workspace id> <merged PR number>
# Node opens the persistent lock without following links; each local command inherits it.
set -eu
exec node "$(dirname "$0")/finish-worktree.mjs" "$@"

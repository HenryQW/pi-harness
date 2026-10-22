#!/bin/sh
# Usage: finish-worktree.sh <Herdr workspace id> <merged PR number>
# Finish a worker worktree after its PR merges, like /done in that pane: refuse unless the PR is merged,
# the checkout is on the PR branch at the merged head and clean, and no agent in the workspace is working.
# Then remove the checkout, close the workspace, and fast-forward the primary checkout.
set -eu
ws=$1; n=$2
main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
pr=$(gh pr view "$n" --json state,headRefOid,headRefName)
[ "$(printf '%s' "$pr" | jq -r .state)" = MERGED ] || { echo "PR #$n is not merged" >&2; exit 1; }
path=$(herdr worktree list | jq -r --arg ws "$ws" '.result.worktrees[] | select(.open_workspace_id == $ws) | .path')
[ -n "$path" ] || { echo "No worktree is open in workspace $ws" >&2; exit 1; }
[ "$(git -C "$path" rev-parse --abbrev-ref HEAD)" = "$(printf '%s' "$pr" | jq -r .headRefName)" ] || { echo "$path is not on the PR branch" >&2; exit 1; }
[ "$(git -C "$path" rev-parse HEAD)" = "$(printf '%s' "$pr" | jq -r .headRefOid)" ] || { echo "$path HEAD differs from the merged PR head" >&2; exit 1; }
[ -z "$(git -C "$path" status --porcelain)" ] || { echo "$path has uncommitted changes" >&2; exit 1; }
busy=$(herdr agent list | jq -r --arg ws "$ws" '[.result.agents[] | select(.pane_id | startswith($ws + ":")) | select(.agent_status == "working")] | length')
[ "$busy" = 0 ] || { echo "An agent in $ws is still working" >&2; exit 1; }
git -C "$main" worktree remove "$path"
herdr workspace close "$ws" >/dev/null
git -C "$main" pull --ff-only -q
echo "Done: removed $path, closed $ws, $(git -C "$main" rev-parse --abbrev-ref HEAD) at $(git -C "$main" rev-parse --short=8 HEAD)"

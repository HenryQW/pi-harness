#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: pi-profile.sh [resolve] <backend|coder|frontend|reviewer|writer> [--json|pi options...]" >&2
  exit 2
}

mode="launch"
if [[ "${1:-}" == "resolve" ]]; then
  mode="resolve"
  shift
fi
profile="${1:-}"
[[ -n "$profile" ]] || usage
shift

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile_dir="$root/profiles/$profile"
coding_tools="read,bash,edit,write,grep,find,ls"
web_tools="web_search,fetch_content,get_search_content"

case "$profile" in
  backend)  tools="$coding_tools,$web_tools"; description="Backend implementation" ;;
  coder)    tools="$coding_tools,$web_tools"; description="General implementation" ;;
  frontend) tools="$coding_tools,$web_tools"; description="Frontend implementation" ;;
  reviewer) tools="read,bash,grep,find,ls,$web_tools"; description="Read-only review" ;;
  writer)   tools="$coding_tools,$web_tools,source_check"; description="Research and writing" ;;
  *)
    echo "Unknown profile: $profile" >&2
    exit 2
    ;;
esac

[[ -f "$profile_dir/SYSTEM.md" && -f "$profile_dir/settings.json" ]] || {
  echo "Incomplete profile: $profile_dir" >&2
  exit 1
}

if [[ "$mode" == "resolve" ]]; then
  [[ $# -eq 0 || ( $# -eq 1 && "$1" == "--json" ) ]] || usage
  node -e '
    const [id, description, agentDir, profileSkills, sharedSkills, tools] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      version: 1,
      id,
      description,
      agent_dir: agentDir,
      skills: [profileSkills, sharedSkills],
      tools: tools.split(","),
    }));
  ' "$profile" "$description" "$profile_dir" "$profile_dir/.agents/skills" "$root/shared-skills/.agents/skills" "$tools"
  exit
fi

PI_CODING_AGENT_DIR="$profile_dir" exec pi \
  --no-skills \
  --skill "$profile_dir/.agents/skills" \
  --skill "$root/shared-skills/.agents/skills" \
  --tools "$tools" \
  "$@"

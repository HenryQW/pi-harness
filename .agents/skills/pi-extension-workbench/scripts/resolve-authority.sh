#!/usr/bin/env bash
set -eu

fail() {
  printf 'Pi authority resolver: %s\n' "$1" >&2
  exit 1
}

probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT
cat >"$probe_dir/probe.cjs" <<'EOF'
require("node:fs").appendFileSync(process.env.PI_ENTRY_PROBE, `${process.argv[1]}\n`)
EOF
if ! PI_ENTRY_PROBE="$probe_dir/entries" \
  NODE_OPTIONS="--require=$probe_dir/probe.cjs ${NODE_OPTIONS:-}" \
  pi --version >/dev/null; then
  fail 'active pi launcher failed; check pi --version and PATH'
fi
test -s "$probe_dir/entries" || fail 'pi launcher exposed no Node entry point'

PI_CODING_AGENT_ROOT=
while IFS= read -r entry; do
  resolved="$(realpath "$entry")" || fail "cannot resolve Node entry point: $entry"
  candidate="$(dirname "$resolved")"
  while [ "$candidate" != "$(dirname "$candidate")" ]; do
    if node -e 'const p=require(process.argv[1]); process.exit(p.name === "@earendil-works/pi-coding-agent" ? 0 : 1)' \
      "$candidate/package.json" 2>/dev/null; then
      PI_CODING_AGENT_ROOT="$candidate"
      break 2
    fi
    candidate="$(dirname "$candidate")"
  done
done <"$probe_dir/entries"

test -n "$PI_CODING_AGENT_ROOT" || fail 'no @earendil-works/pi-coding-agent package owns the launcher entry points'
test -d "$PI_CODING_AGENT_ROOT/examples/extensions" || fail "missing examples/extensions in $PI_CODING_AGENT_ROOT"
test -f "$PI_CODING_AGENT_ROOT/docs/extensions.md" || fail "missing docs/extensions.md in $PI_CODING_AGENT_ROOT"
printf '%s\n' "$PI_CODING_AGENT_ROOT"

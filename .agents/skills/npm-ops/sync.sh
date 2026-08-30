#!/usr/bin/env bash
set -euo pipefail

readonly repository="HenryQW/pi-harness"
readonly workflow="publish.yml"
check_only=false

case "${1:-}" in
  "") ;;
  --check) check_only=true ;;
  *) echo "Usage: $0 [--check]" >&2; exit 2 ;;
esac

npm_latest() { npx --yes npm@^11.15.0 "$@"; }

trust_field() {
  TRUST_JSON="$1" TRUST_FIELD="$2" node -e '
    const raw = JSON.parse(process.env.TRUST_JSON);
    const trust = Array.isArray(raw) ? raw[0] : raw;
    const fields = {
      id: trust?.id,
      type: trust?.type,
      repository: trust?.repository ?? trust?.claims?.repository,
      file: trust?.file ?? trust?.claims?.workflow_ref?.file,
      canPublish: trust?.permissions?.includes("createPackage"),
    };
    process.stdout.write(String(fields[process.env.TRUST_FIELD] ?? ""));
  '
}

mismatches=0
for manifest in extensions/*/package.json; do
  [[ "$(node -p "Boolean(require('./$manifest').private)")" == true ]] && continue

  package="$(node -p "require('./$manifest').name")"
  trust="$(npm_latest trust list "$package" --json)"
  id="$(trust_field "$trust" id)"
  type="$(trust_field "$trust" type)"
  current_repository="$(trust_field "$trust" repository)"
  current_file="$(trust_field "$trust" file)"
  can_publish="$(trust_field "$trust" canPublish)"

  if [[ "$type" == github && "$current_repository" == "$repository" && "$current_file" == "$workflow" && "$can_publish" == true ]]; then
    echo "OK   $package"
  elif $check_only; then
    echo "NEED $package" >&2
    mismatches=$((mismatches + 1))
  else
    [[ -z "$id" ]] || npm_latest trust revoke "$package" --id "$id"
    npm_latest trust github "$package" \
      --repo "$repository" \
      --file "$workflow" \
      --allow-publish \
      --yes
    echo "SET  $package"
  fi

  sleep 2
done

((mismatches == 0))

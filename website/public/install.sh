#!/bin/sh
# Henry Pi Harness installer.
# The extension list between the generated markers comes from extensions/*/package.json.
# Do not edit that list by hand.

set -eu

PI_INSTALLER_URL="https://pi.dev/install.sh"
PI_MIN_VERSION="0.85.1"
HERDR_INSTALLER_URL="https://herdr.dev/install.sh"
HERDR_MIN_VERSION="0.7.4"

# BEGIN GENERATED EXTENSIONS
EXTENSIONS='
@henryqw/pi-add-dir
@henryqw/pi-ask-question
@henryqw/pi-auto-compact
@henryqw/pi-auto-dag
@henryqw/pi-deps
@henryqw/pi-footer
@henryqw/pi-herdr-btw
@henryqw/pi-herdr-clone
@henryqw/pi-herdr-done
@henryqw/pi-herdr-rename
@henryqw/pi-memory
@henryqw/pi-multi-codex
@henryqw/pi-notes
@henryqw/pi-open-in
@henryqw/pi-pr
@henryqw/pi-prompt-creator
@henryqw/pi-session-recall
@henryqw/pi-subagent
@henryqw/pi-task-models
@henryqw/pi-undo
'
# END GENERATED EXTENSIONS

if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
  blue=$(printf '\033[34m')
  green=$(printf '\033[32m')
  yellow=$(printf '\033[33m')
  red=$(printf '\033[31m')
  reset=$(printf '\033[0m')
else
  blue=
  green=
  yellow=
  red=
  reset=
fi

info() {
  printf '%s> %s%s\n' "$blue" "$1" "$reset"
}

success() {
  printf '%s✓ %s%s\n' "$green" "$1" "$reset"
}

warn() {
  printf '%s! %s%s\n' "$yellow" "$1" "$reset" >&2
}

die() {
  printf '%s✗ %s%s\n' "$red" "$1" "$reset" >&2
  exit 1
}

count_extensions() {
  count=0
  for extension in $EXTENSIONS; do
    count=$((count + 1))
  done
  printf '%s\n' "$count"
}

has_tty() {
  ( : <>/dev/tty ) 2>/dev/null
}

find_pi() {
  if command -v pi >/dev/null 2>&1; then
    command -v pi
    return 0
  fi

  for candidate in "$HOME/.local/bin/pi" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin/pi"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v npm >/dev/null 2>&1; then
    npm_prefix=$(npm prefix -g 2>/dev/null || true)
    if [ -n "$npm_prefix" ] && [ -x "$npm_prefix/bin/pi" ]; then
      printf '%s\n' "$npm_prefix/bin/pi"
      return 0
    fi
  fi

  return 1
}

find_herdr() {
  if command -v herdr >/dev/null 2>&1; then
    command -v herdr
    return 0
  fi

  candidate="${HERDR_INSTALL_DIR:-$HOME/.local/bin}/herdr"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

run_installer() {
  label=$1
  url=$2

  command -v curl >/dev/null 2>&1 || die "curl is required to install $label."
  command -v mktemp >/dev/null 2>&1 || die "mktemp is required to install $label."

  installer=$(mktemp "${TMPDIR:-/tmp}/pi-harness-installer.XXXXXX") || die "Could not create a temporary installer file."
  if ! curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 "$url" -o "$installer"; then
    rm -f "$installer"
    die "Could not download the $label installer."
  fi

  info "Installing $label..."
  if ! sh "$installer"; then
    rm -f "$installer"
    die "$label installation failed."
  fi
  rm -f "$installer"
}

parse_semantic_version() {
  awk '
    match($0, /(^|[[:space:]])v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)([[:space:]]|$)/) {
      version = substr($0, RSTART, RLENGTH)
      sub(/^[[:space:]]+/, "", version)
      sub(/^v/, "", version)
      sub(/[[:space:]]+$/, "", version)
      print version
      exit
    }
  '
}

version_at_least() {
  awk -v version="$1" -v minimum="$2" '
    BEGIN {
      split(version, actual, ".")
      split(minimum, required, ".")
      for (component = 1; component <= 3; component++) {
        if (actual[component] + 0 > required[component] + 0) exit 0
        if (actual[component] + 0 < required[component] + 0) exit 1
      }
      exit 0
    }
  '
}

check_version() {
  label=$1
  bin=$2
  minimum=$3

  if ! version_output=$("$bin" --version 2>&1); then
    die "$label at $bin could not start. Install or update $label $minimum+, then run this installer again."
  fi

  version=$(printf '%s\n' "$version_output" | parse_semantic_version)
  [ -n "$version" ] || die "$label at $bin did not report a recognized semantic version. Install or update $label $minimum+, then run this installer again."

  if ! version_at_least "$version" "$minimum"; then
    die "$label $version at $bin is too old. $label $minimum+ is required; update it, then run this installer again."
  fi
}

ensure_pi() {
  if pi_bin=$(find_pi); then
    success "Pi already installed: $pi_bin"
  else
    run_installer "Pi" "$PI_INSTALLER_URL"
    pi_bin=$(find_pi) || die "Pi installed, but could not be found. Restart your shell, then run this installer again."
    success "Pi installed: $pi_bin"
  fi

  check_version "Pi" "$pi_bin" "$PI_MIN_VERSION"
}

ensure_herdr() {
  if herdr_bin=$(find_herdr); then
    herdr_status="already installed"
  else
    run_installer "Herdr" "$HERDR_INSTALLER_URL"
    herdr_bin=$(find_herdr) || die "Herdr installed, but could not be found. Restart your shell, then run this installer again."
    herdr_status="installed"
  fi

  check_version "Herdr" "$herdr_bin" "$HERDR_MIN_VERSION"
  success "Herdr $herdr_status: $herdr_bin"
}

show_extensions() {
  index=1
  for extension in $EXTENSIONS; do
    printf '  %2s. %s\n' "$index" "$extension" >&3
    index=$((index + 1))
  done
}

extension_at() {
  target=$1
  index=1
  for extension in $EXTENSIONS; do
    if [ "$index" -eq "$target" ]; then
      printf '%s\n' "$extension"
      return 0
    fi
    index=$((index + 1))
  done
  return 1
}

select_individual_extensions() {
  show_extensions

  while :; do
    printf '\nEnter extension numbers separated by spaces: ' >&3
    if ! IFS= read -r selection <&3; then
      die "Could not read extension selection from the terminal."
    fi
    [ -n "$selection" ] || {
      warn "Choose at least one extension."
      continue
    }

    selected_extensions=
    valid=true
    for number in $selection; do
      case "$number" in
        ''|*[!0-9]*)
          valid=false
          break
          ;;
      esac
      if ! [ "$number" -ge 1 ] 2>/dev/null || ! [ "$number" -le "$extension_count" ] 2>/dev/null; then
        valid=false
        break
      fi

      extension=$(extension_at "$number") || {
        valid=false
        break
      }
      case " $selected_extensions " in
        *" $extension "*) ;;
        *) selected_extensions="${selected_extensions}${selected_extensions:+ }$extension" ;;
      esac
    done

    if [ "$valid" = true ] && [ -n "$selected_extensions" ]; then
      return 0
    fi
    warn "Use numbers from 1 to $extension_count, separated by spaces."
  done
}

choose_extensions() {
  if [ "$force_all" = true ]; then
    selected_extensions=$EXTENSIONS
    return 0
  fi

  if ! has_tty; then
    selected_extensions=$EXTENSIONS
    warn "No interactive terminal detected; installing all $extension_count extensions."
    return 0
  fi

  exec 3<>/dev/tty
  while :; do
    printf '\nChoose extensions:\n' >&3
    printf '  [A] Install all %s extensions (default)\n' "$extension_count" >&3
    printf '  [S] Select individual extensions\n' >&3
    printf '  [Q] Quit\n\n' >&3
    printf 'Choice [A]: ' >&3
    if ! IFS= read -r choice <&3; then
      die "Could not read installer selection from the terminal."
    fi

    case "$choice" in
      ''|a|A|all|ALL)
        selected_extensions=$EXTENSIONS
        exec 3>&-
        return 0
        ;;
      s|S|select|SELECT)
        select_individual_extensions
        exec 3>&-
        return 0
        ;;
      q|Q|quit|QUIT)
        exec 3>&-
        info "Nothing installed."
        exit 0
        ;;
      *)
        warn "Choose A, S, or Q."
        ;;
    esac
  done
}

install_extensions() {
  installed=0
  for extension in $selected_extensions; do
    info "Installing $extension..."
    "$pi_bin" install "npm:$extension"
    installed=$((installed + 1))
    success "Installed $extension"
  done
  printf '\n'
  success "Installed $installed extension(s)."
  info "Start Pi with: $pi_bin"
}

main() {
  [ -n "${HOME:-}" ] || die "HOME must be set."

  case "$#" in
    0) force_all=false ;;
    1)
      [ "$1" = "--all" ] || die "Usage: sh install.sh [--all]"
      force_all=true
      ;;
    *) die "Usage: sh install.sh [--all]" ;;
  esac

  extension_count=$(count_extensions)
  [ "$extension_count" -gt 0 ] || die "No installable Pi extensions were found."

  printf '\nHenry Pi Harness installer\nPi + Herdr + selected extensions\n'
  choose_extensions
  ensure_pi
  ensure_herdr
  install_extensions
}

main "$@"

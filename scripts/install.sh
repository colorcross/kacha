#!/usr/bin/env bash
set -euo pipefail

ref=${KACHA_REF:-main}
archive_url=${KACHA_ARCHIVE_URL:-}
archive_file=""
agent=""
custom_target=""
dry_run=false

usage() {
  cat <<'EOF'
Install Kacha as a user-level Agent Skill.

Usage:
  install.sh --agent codex|claude|both [--ref REF] [--target DIR] [--dry-run]

Default locations:
  Codex       ~/.codex/skills/kacha
  Claude Code ~/.claude/skills/kacha

Options:
  --agent NAME    Required: codex, claude, or both
  --ref REF       GitHub branch or tag; default: main
  --target DIR    Custom target; only valid with one agent
  --archive FILE  Install from a local tar.gz archive
  --dry-run       Print planned actions without changing files
  -h, --help      Show this help

Safety:
  - Downloads the public source archive without Git credentials.
  - Validates the skill and scans for secrets before installation.
  - Never overwrites an existing target, including local modifications.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      agent=$2
      shift 2
      ;;
    --ref)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      ref=$2
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      custom_target=$2
      shift 2
      ;;
    --archive)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      archive_file=$2
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$agent" in
  codex|claude|both) ;;
  *)
    printf '%s\n' "--agent must be codex, claude, or both" >&2
    usage >&2
    exit 2
    ;;
esac

[[ "$ref" =~ ^[A-Za-z0-9._/-]+$ && "$ref" != -* ]] || {
  printf '%s\n' "Invalid GitHub ref" >&2
  exit 2
}
[[ -n "${HOME:-}" && "$HOME" = /* && "$HOME" != "/" ]] || {
  printf '%s\n' "HOME must be an absolute, non-root directory" >&2
  exit 2
}
for command_name in python3 tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '%s is required\n' "$command_name" >&2
    exit 2
  }
done
if [[ -z "$archive_file" ]]; then
  command -v curl >/dev/null 2>&1 || {
    printf '%s\n' "curl is required" >&2
    exit 2
  }
  archive_url=${archive_url:-"https://api.github.com/repos/colorcross/kacha/tarball/$ref"}
else
  [[ -f "$archive_file" ]] || {
    printf 'Archive not found: %s\n' "$archive_file" >&2
    exit 2
  }
fi

if [[ -n "$custom_target" && "$agent" == "both" ]]; then
  printf '%s\n' "--target cannot be combined with --agent both" >&2
  exit 2
fi

codex_target=${KACHA_CODEX_SKILLS_DIR:-"$HOME/.codex/skills"}/kacha
claude_target=${KACHA_CLAUDE_SKILLS_DIR:-"$HOME/.claude/skills"}/kacha

resolve_target() {
  case "$1" in
    codex) printf '%s\n' "${custom_target:-$codex_target}" ;;
    claude) printf '%s\n' "${custom_target:-$claude_target}" ;;
  esac
}

validate_target() {
  local target=$1
  [[ "$target" = /* && "$target" != "/" && "$target" != "$HOME" ]] || {
    printf 'Refusing unsafe target: %s\n' "$target" >&2
    return 1
  }
}

prepare_source() {
  local work_root=$1
  local downloaded_archive="$work_root/kacha.tar.gz"
  local candidate="$work_root/kacha"
  local top_directory
  local version

  if [[ -n "$archive_file" ]]; then
    downloaded_archive=$archive_file
  else
    curl \
      --fail \
      --location \
      --silent \
      --show-error \
      --retry 3 \
      --connect-timeout 10 \
      --max-time 120 \
      --output "$downloaded_archive" \
      "$archive_url"
  fi

  python3 - "$downloaded_archive" <<'PY'
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
with tarfile.open(archive, "r:gz") as handle:
    members = handle.getmembers()
    if not members:
        raise SystemExit("Downloaded archive is empty")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"Unsafe archive path: {member.name}")
        if member.issym() or member.islnk():
            raise SystemExit(f"Archive links are not allowed: {member.name}")
PY

  top_directory=$(tar -tzf "$downloaded_archive" | sed -n '1s#/.*##p')
  [[ -n "$top_directory" ]] || {
    printf '%s\n' "Downloaded archive is empty or invalid" >&2
    return 1
  }
  mkdir -p "$candidate"
  tar -xzf "$downloaded_archive" -C "$candidate" --strip-components=1
  [[ -f "$candidate/SKILL.md" && -f "$candidate/scripts/kacha.mjs" ]] || {
    printf '%s\n' "Downloaded archive is missing required skill files" >&2
    return 1
  }

  python3 "$candidate/scripts/scan_secrets.py" >&2
  version=${top_directory##*-}
  printf 'ref=%s\nsource=%s\narchive=%s\n' \
    "$ref" "$version" "${archive_url:-local}" > "$candidate/.kacha-version"
  printf '%s\n' "$candidate"
}

install_one() {
  local agent_name=$1
  local source=$2
  local target
  local parent

  target=$(resolve_target "$agent_name")
  validate_target "$target"
  parent=$(dirname "$target")

  if $dry_run; then
    printf '[dry-run] install %s at %s from ref %s\n' \
      "$agent_name" "$target" "$ref"
    return
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    if [[ -f "$target/SKILL.md" ]]; then
      printf 'Already installed; left unchanged for %s: %s\n' \
        "$agent_name" "$target"
      return
    fi
    printf 'Refusing to overwrite existing directory: %s\n' "$target" >&2
    return 1
  fi

  mkdir -p "$parent"
  mv "$source" "$target"
  printf 'Installed for %s: %s\n' "$agent_name" "$target"
  printf 'Version: %s\n' "$(sed -n '2s/^source=//p' "$target/.kacha-version")"
}

if $dry_run; then
  case "$agent" in
    codex) install_one codex "" ;;
    claude) install_one claude "" ;;
    both)
      install_one codex ""
      install_one claude ""
      ;;
  esac
else
  work_root=$(mktemp -d "${TMPDIR:-/tmp}/kacha-install.XXXXXX")
  trap 'rm -rf "${work_root:-}"' EXIT
  source=$(prepare_source "$work_root")

  case "$agent" in
    codex) install_one codex "$source" ;;
    claude) install_one claude "$source" ;;
    both)
      codex_source="$work_root/kacha-codex"
      cp -R "$source" "$codex_source"
      install_one codex "$codex_source"
      install_one claude "$source"
      ;;
  esac
fi

printf '%s\n' "Installation complete."
printf '%s\n' "Current Agent: read the installed SKILL.md now, then load the required references before use."

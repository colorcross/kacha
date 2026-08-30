#!/usr/bin/env bash
set -euo pipefail

ref=${KACHA_REF:-}
channel=${KACHA_CHANNEL:-canary}
ref_explicit=false
channel_explicit=false
[[ -n "$ref" ]] && ref_explicit=true
archive_url=${KACHA_ARCHIVE_URL:-}
archive_url_explicit=false
[[ -n "$archive_url" ]] && archive_url_explicit=true
archive_file=""
agent=""
custom_target=""
dry_run=false
release_channels_temp=""
work_root=""

cleanup() {
  if [[ -n "$release_channels_temp" && -f "$release_channels_temp" ]]; then
    rm -f -- "$release_channels_temp"
  fi
  if [[ -n "$work_root" && -d "$work_root" ]]; then
    rm -rf -- "$work_root"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Install Kacha as a user-level Agent Skill.

Usage:
  install.sh --agent codex|claude|both [--channel stable|canary | --ref REF] [--target DIR] [--dry-run]

Default locations:
  Codex       ~/.codex/skills/kacha
  Claude Code ~/.claude/skills/kacha

Options:
  --agent NAME    Required: codex, claude, or both
  --channel NAME  stable uses the last formally tagged release; canary follows main (default)
  --ref REF       Explicit GitHub branch or tag; reported as the custom channel
  --target DIR    Custom target; only valid with one agent
  --archive FILE  Install from a local tar.gz archive; reported as the custom channel
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
      ref_explicit=true
      shift 2
      ;;
    --channel)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      channel=$2
      channel_explicit=true
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

for command_name in python3 tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '%s is required\n' "$command_name" >&2
    exit 2
  }
done

if [[ -n "${KACHA_STABLE_REF:-}" || -n "${KACHA_CANARY_REF:-}" ]]; then
  printf '%s\n' "Stable/canary refs are controlled by config/release-channels.json; use --ref for a custom source." >&2
  exit 2
fi

case "$channel" in
  stable|canary) ;;
  *)
    printf '%s\n' "--channel must be stable or canary" >&2
    exit 2
    ;;
esac
if $ref_explicit && $channel_explicit; then
  printf '%s\n' "--ref cannot be combined with --channel" >&2
  exit 2
fi
stable_ref=""
canary_ref=""
if $ref_explicit; then
  channel=custom
elif [[ -n "$archive_file" ]]; then
  channel=custom
  ref=local-archive
elif $archive_url_explicit; then
  channel=custom
  ref=custom-url
else
  release_channels_file=""
  script_source=${BASH_SOURCE[0]-}
  if [[ -n "$script_source" && -f "$script_source" ]]; then
    local_release_channels_file=$(cd "$(dirname "$script_source")/.." && pwd)/config/release-channels.json
    if [[ -f "$local_release_channels_file" ]]; then
      release_channels_file=$local_release_channels_file
    fi
  fi
  if [[ -z "$release_channels_file" ]]; then
    command -v curl >/dev/null 2>&1 || {
      printf '%s\n' "curl is required to load the release channel contract" >&2
      exit 2
    }
    release_channels_temp=$(mktemp "${TMPDIR:-/tmp}/kacha-release-channels.XXXXXX")
    release_channels_url="https://raw.githubusercontent.com/colorcross/kacha/main/config/release-channels.json"
    curl \
      --fail \
      --location \
      --silent \
      --show-error \
      --retry 3 \
      --connect-timeout 10 \
      --max-time 30 \
      --output "$release_channels_temp" \
      "$release_channels_url"
    release_channels_file=$release_channels_temp
  fi
  IFS=$'\t' read -r stable_ref canary_ref < <(python3 - "$release_channels_file" <<'PY'
import json
import pathlib
import sys

try:
    payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"release channel config is invalid: {exc}") from exc
if not isinstance(payload, dict) or payload.get("schemaVersion") not in (1, "1.0"):
    raise SystemExit("release channel config must be a schemaVersion 1 object")
channels = payload.get("channels", {})
stable = channels.get("stable", {}).get("ref")
canary = channels.get("canary", {}).get("ref")
def valid(value):
    if not isinstance(value, str) or not value or value.startswith(("-", "/", ".")):
        return False
    if value.endswith(("/", ".", ".lock")) or ".." in value or "//" in value:
        return False
    if any(part.startswith(".") or part.endswith(".lock") for part in value.split("/")):
        return False
    return all(char.isascii() and (char.isalnum() or char in "._/-") for char in value)
if not valid(stable) or not valid(canary):
    raise SystemExit("release channel config is missing stable/canary refs")
print(f"{stable}\t{canary}")
PY
)
  case "$channel" in
    stable) ref=$stable_ref ;;
    canary) ref=$canary_ref ;;
  esac
fi

python3 - "$ref" <<'PY'
import sys

value = sys.argv[1]
valid = (
    bool(value)
    and not value.startswith(("-", "/", "."))
    and not value.endswith(("/", ".", ".lock"))
    and ".." not in value
    and "//" not in value
    and all(not part.startswith(".") and not part.endswith(".lock") for part in value.split("/"))
    and all(char.isascii() and (char.isalnum() or char in "._/-") for char in value)
)
if not valid:
    raise SystemExit("Invalid GitHub ref")
PY
[[ -n "${HOME:-}" && "$HOME" = /* && "$HOME" != "/" ]] || {
  printf '%s\n' "HOME must be an absolute, non-root directory" >&2
  exit 2
}
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
  local archive_sha256

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
  # The public repository also hosts the product website. It is not part of
  # the runtime skill bundle and would only add unrelated build dependencies.
  if [[ -d "$candidate/website" ]]; then
    rm -rf -- "$candidate/website"
  fi
  [[ -f "$candidate/SKILL.md" && -f "$candidate/scripts/kacha.mjs" ]] || {
    printf '%s\n' "Downloaded archive is missing required skill files" >&2
    return 1
  }

  python3 "$candidate/scripts/scan_secrets.py" >&2
  version=${top_directory##*-}
  archive_sha256=$(python3 - "$downloaded_archive" <<'PY'
import hashlib
import pathlib
import sys

digest = hashlib.sha256()
with pathlib.Path(sys.argv[1]).open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
)
  printf 'channel=%s\nref=%s\nsource=%s\narchive=%s\narchive_sha256=%s\n' \
    "$channel" "$ref" "$version" "${archive_url:-local}" "$archive_sha256" > "$candidate/.kacha-version"
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
  printf 'Version: %s\n' "$(sed -n 's/^source=//p' "$target/.kacha-version")"
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
printf 'Channel: %s; ref: %s\n' "$channel" "$ref"
if [[ "$channel" == "stable" ]]; then
  printf 'Note: stable remains %s until a newer candidate is formally tagged; use canary for the configured development line.\n' "$stable_ref"
fi
printf '%s\n' "Current Agent: read the installed SKILL.md now, then load the required references before use."

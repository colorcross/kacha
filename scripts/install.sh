#!/usr/bin/env bash
set -euo pipefail

repo_url=${KACHA_REPO_URL:-https://github.com/colorcross/kacha.git}
ref=${KACHA_REF:-main}
agent=""
custom_target=""
dry_run=false

usage() {
  cat <<'EOF'
Install Kacha as a user-level Agent Skill.

Usage:
  install.sh --agent codex|claude|both [--ref REF] [--target DIR] [--dry-run]

Default locations:
  Codex       ~/.agents/skills/kacha-kacha
  Claude Code ~/.claude/skills/kacha-kacha

Options:
  --agent NAME   Required: codex, claude, or both
  --ref REF      Git branch or tag; default: main
  --target DIR   Custom target; only valid with one agent
  --repo URL     Override repository URL, mainly for mirrors and tests
  --dry-run      Print planned actions without changing files
  -h, --help     Show this help

Safety:
  - Never overwrites a non-Git directory.
  - Never updates an installation with uncommitted changes.
  - Only fast-forward updates are allowed.
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
    --repo)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      repo_url=$2
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

[[ "$ref" != -* && -n "$ref" ]] || {
  printf '%s\n' "Invalid Git ref" >&2
  exit 2
}
[[ -n "${HOME:-}" && "$HOME" = /* && "$HOME" != "/" ]] || {
  printf '%s\n' "HOME must be an absolute, non-root directory" >&2
  exit 2
}
command -v git >/dev/null 2>&1 || {
  printf '%s\n' "git is required" >&2
  exit 2
}
command -v python3 >/dev/null 2>&1 || {
  printf '%s\n' "python3 is required" >&2
  exit 2
}
export GIT_TERMINAL_PROMPT=0

if [[ -n "$custom_target" && "$agent" == "both" ]]; then
  printf '%s\n' "--target cannot be combined with --agent both" >&2
  exit 2
fi

codex_target=${KACHA_CODEX_SKILLS_DIR:-"$HOME/.agents/skills"}/kacha-kacha
claude_target=${KACHA_CLAUDE_SKILLS_DIR:-"$HOME/.claude/skills"}/kacha-kacha

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

install_one() {
  local agent_name=$1
  local target
  local parent
  local temporary
  local candidate
  local origin

  target=$(resolve_target "$agent_name")
  validate_target "$target"
  parent=$(dirname "$target")

  if $dry_run; then
    if [[ -e "$target" ]]; then
      printf '[dry-run] update %s at %s from %s ref %s\n' \
        "$agent_name" "$target" "$repo_url" "$ref"
    else
      printf '[dry-run] install %s at %s from %s ref %s\n' \
        "$agent_name" "$target" "$repo_url" "$ref"
    fi
    return
  fi

  if [[ -e "$target" ]]; then
    [[ ! -L "$target" ]] || {
      printf 'Refusing to update a symlinked installation: %s\n' "$target" >&2
      return 1
    }
    [[ -d "$target/.git" && -f "$target/SKILL.md" ]] || {
      printf 'Refusing to overwrite existing non-Kacha directory: %s\n' "$target" >&2
      return 1
    }
    [[ -z "$(git -C "$target" status --porcelain)" ]] || {
      printf 'Refusing to update installation with local changes: %s\n' "$target" >&2
      return 1
    }
    origin=$(git -C "$target" remote get-url origin)
    [[ "$origin" == "$repo_url" ]] || {
      printf 'Origin mismatch at %s\nExpected: %s\nActual:   %s\n' \
        "$target" "$repo_url" "$origin" >&2
      return 1
    }
    git -c credential.helper= -C "$target" fetch --depth 1 origin "$ref"
    git -C "$target" merge --ff-only FETCH_HEAD
  else
    mkdir -p "$parent"
    temporary=$(mktemp -d "$parent/.kacha-install.XXXXXX")
    candidate="$temporary/kacha-kacha"
    trap 'rm -rf "${temporary:-}"' RETURN
    git -c credential.helper= clone --depth 1 --branch "$ref" "$repo_url" "$candidate"
    [[ -f "$candidate/SKILL.md" && -f "$candidate/scripts/kacha.mjs" ]] || {
      printf '%s\n' "Downloaded repository is missing required skill files" >&2
      return 1
    }
    python3 "$candidate/scripts/scan_secrets.py"
    mv "$candidate" "$target"
    rm -rf "$temporary"
    trap - RETURN
  fi

  printf 'Installed for %s: %s\n' "$agent_name" "$target"
  printf 'Commit: %s\n' "$(git -C "$target" rev-parse --short=12 HEAD)"
}

case "$agent" in
  codex) install_one codex ;;
  claude) install_one claude ;;
  both)
    install_one codex
    install_one claude
    ;;
esac

printf '%s\n' "Installation complete."
printf '%s\n' "Current Agent: read the installed SKILL.md now, then load the required references before use."

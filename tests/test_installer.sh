#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/kacha-installer-tests.XXXXXX")
trap 'rm -rf "$temporary"' EXIT

test_home="$temporary/home"
source_clone="$temporary/source"
mkdir -p "$test_home"

git clone --quiet --no-hardlinks "$root" "$source_clone"
git -C "$source_clone" checkout -q -B main

HOME="$test_home" "$root/scripts/install.sh" \
  --agent both \
  --repo "$source_clone" \
  --ref main

codex_skill="$test_home/.agents/skills/kacha-kacha"
claude_skill="$test_home/.claude/skills/kacha-kacha"
[[ -f "$codex_skill/SKILL.md" ]]
[[ -f "$claude_skill/SKILL.md" ]]
[[ "$(git -C "$codex_skill" remote get-url origin)" == "$source_clone" ]]
[[ "$(git -C "$claude_skill" remote get-url origin)" == "$source_clone" ]]

HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex \
  --repo "$source_clone" \
  --ref main

printf '%s\n' "local change" > "$codex_skill/local-change.txt"
if HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex \
  --repo "$source_clone" \
  --ref main; then
  printf '%s\n' "Installer unexpectedly overwrote a dirty installation" >&2
  exit 1
fi
[[ -f "$codex_skill/local-change.txt" ]]

printf '%s\n' "Installer tests passed."

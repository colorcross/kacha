#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/kacha-installer-tests.XXXXXX")
trap 'rm -rf "$temporary"' EXIT

test_home="$temporary/home"
source_clone="$temporary/source"
archive="$temporary/kacha.tar.gz"
mkdir -p "$test_home"

mkdir -p "$source_clone/kacha-fixture"
tar --exclude=.git -cf - -C "$root" . | tar -xf - -C "$source_clone/kacha-fixture"
tar -czf "$archive" -C "$source_clone" kacha-fixture

HOME="$test_home" "$root/scripts/install.sh" \
  --agent both \
  --archive "$archive" \
  --ref main

codex_skill="$test_home/.codex/skills/kacha"
claude_skill="$test_home/.claude/skills/kacha"
[[ -f "$codex_skill/SKILL.md" ]]
[[ -f "$claude_skill/SKILL.md" ]]
[[ -f "$codex_skill/.kacha-version" ]]
[[ -f "$claude_skill/.kacha-version" ]]

HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex \
  --archive "$archive" \
  --ref main

printf '%s\n' "local change" > "$codex_skill/local-change.txt"
HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex \
  --archive "$archive" \
  --ref main
[[ -f "$codex_skill/local-change.txt" ]]

printf '%s\n' "Installer tests passed."

#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/kacha-installer-tests.XXXXXX")
trap 'rm -rf "$temporary"' EXIT

test_home="$temporary/home"
source_clone="$temporary/source"
archive="$temporary/kacha.tar.gz"
mkdir -p "$test_home"

mock_bin="$temporary/mock-bin"
mkdir -p "$mock_bin"
cp "$root/tests/fixtures/mock_installer_curl.sh" "$mock_bin/curl"
chmod +x "$mock_bin/curl"

piped_stable_plan=$(PATH="$mock_bin:$PATH" \
  KACHA_TEST_RELEASE_CHANNELS_FILE="$root/config/release-channels.json" \
  HOME="$test_home" \
  bash -s -- --agent codex --channel stable --dry-run < "$root/scripts/install.sh")
[[ "$piped_stable_plan" == *"from ref v1.1.0"* ]]

piped_canary_plan=$(PATH="$mock_bin:$PATH" \
  KACHA_TEST_RELEASE_CHANNELS_FILE="$root/config/release-channels.json" \
  HOME="$test_home" \
  bash -s -- --agent codex --channel canary --dry-run < "$root/scripts/install.sh")
[[ "$piped_canary_plan" == *"from ref main"* ]]

if PATH="$mock_bin:$PATH" KACHA_TEST_CURL_FAIL=true \
  KACHA_TEST_RELEASE_CHANNELS_FILE="$root/config/release-channels.json" \
  HOME="$test_home" \
  bash -s -- --agent codex --channel stable --dry-run < "$root/scripts/install.sh" \
  >/dev/null 2>&1; then
  printf '%s\n' "piped installer ignored a release channel fetch failure" >&2
  exit 1
fi

piped_custom_plan=$(PATH="$mock_bin:$PATH" KACHA_TEST_CURL_FAIL=true \
  HOME="$test_home" \
  bash -s -- --agent codex --ref feature/test --dry-run < "$root/scripts/install.sh")
[[ "$piped_custom_plan" == *"Channel: custom; ref: feature/test"* ]]

if PATH="$mock_bin:$PATH" \
  KACHA_TEST_RELEASE_CHANNELS_FILE="$root/tests/fixtures/invalid-release-channels.json" \
  HOME="$test_home" \
  bash -s -- --agent codex --channel stable --dry-run < "$root/scripts/install.sh" \
  >/dev/null 2>&1; then
  printf '%s\n' "piped installer accepted an invalid release channel contract" >&2
  exit 1
fi

stable_plan=$(HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex \
  --channel stable \
  --dry-run)
[[ "$stable_plan" == *"from ref v1.1.0"* ]]

canary_plan=$(HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex \
  --channel canary \
  --dry-run)
[[ "$canary_plan" == *"from ref main"* ]]

if HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex --channel stable --ref main --dry-run >/dev/null 2>&1; then
  printf '%s\n' "installer accepted conflicting --channel and --ref" >&2
  exit 1
fi

if HOME="$test_home" KACHA_STABLE_REF=main "$root/scripts/install.sh" \
  --agent codex --channel stable --dry-run >/dev/null 2>&1; then
  printf '%s\n' "installer accepted an environment override for the stable ref" >&2
  exit 1
fi

custom_plan=$(HOME="$test_home" KACHA_CHANNEL=stable KACHA_REF=main \
  "$root/scripts/install.sh" --agent codex --dry-run)
[[ "$custom_plan" == *"Channel: custom; ref: main"* ]]

if HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex --ref ../main --dry-run >/dev/null 2>&1; then
  printf '%s\n' "installer accepted a path-normalizing ref" >&2
  exit 1
fi

archive_paths() {
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$root" ls-files --cached --others --exclude-standard -z \
      | while IFS= read -r -d '' path; do
          if [[ -e "$root/$path" || -L "$root/$path" ]]; then
            printf '%s\0' "$path"
          fi
        done
    return
  fi

  (
    cd "$root"
    find . \
      \( -name .git -o -name node_modules -o -name .next \
        -o -name .open-next -o -name .wrangler -o -name dist \) -prune \
      -o \( -type f -o -type l \) -print0
  )
}

mkdir -p "$source_clone/kacha-fixture"
archive_paths \
  | tar -cf - -C "$root" --null -T - \
  | tar -xf - -C "$source_clone/kacha-fixture"
tar -czf "$archive" -C "$source_clone" kacha-fixture

local_plan=$(HOME="$test_home" "$root/scripts/install.sh" \
  --agent codex --archive "$archive" --dry-run)
[[ "$local_plan" == *"from ref local-archive"* ]]
[[ "$local_plan" == *"Channel: custom; ref: local-archive"* ]]

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
grep -qx 'channel=custom' "$codex_skill/.kacha-version"
grep -qx 'ref=main' "$codex_skill/.kacha-version"
grep -Eq '^archive_sha256=[0-9a-f]{64}$' "$codex_skill/.kacha-version"
[[ ! -e "$codex_skill/website" ]]
[[ ! -e "$claude_skill/website" ]]

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

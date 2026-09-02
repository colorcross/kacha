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
[[ "$piped_stable_plan" == *"from ref v1.2.0"* ]]

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
[[ "$stable_plan" == *"from ref v1.2.0"* ]]

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

archive_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
matched_channels="$temporary/pinned-release-channels.json"
python3 - "$archive_sha" "$matched_channels" <<'PY'
import json
import pathlib
import sys

payload = {
    "schemaVersion": 1,
    "channels": {
        "stable": {"ref": "v1.2.0", "archiveSha256": sys.argv[1]},
        "canary": {"ref": "main"},
    },
}
pathlib.Path(sys.argv[2]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

pinned_home="$temporary/pinned-home"
mkdir -p "$pinned_home"
if PATH="$mock_bin:$PATH" \
  KACHA_TEST_RELEASE_CHANNELS_FILE="$root/tests/fixtures/pinned-release-channels.json" \
  KACHA_TEST_ARCHIVE_FILE="$archive" \
  HOME="$pinned_home" \
  bash -s -- --agent codex --channel stable < "$root/scripts/install.sh" \
  >/dev/null 2>&1; then
  printf '%s\n' "installer accepted an archive that violates the channel SHA-256 pin" >&2
  exit 1
fi
[[ ! -e "$pinned_home/.codex/skills/kacha" ]]

pinned_install_output=$(PATH="$mock_bin:$PATH" \
  KACHA_TEST_RELEASE_CHANNELS_FILE="$matched_channels" \
  KACHA_TEST_ARCHIVE_FILE="$archive" \
  HOME="$pinned_home" \
  bash -s -- --agent codex --channel stable < "$root/scripts/install.sh")
[[ "$pinned_install_output" == *"Installed for codex"* ]]
grep -qx 'channel=stable' "$pinned_home/.codex/skills/kacha/.kacha-version"

# ── --hooks：settings.json 幂等合并，绝不破坏已有 hooks ──
hooks_home="$temporary/hooks-home"
mkdir -p "$hooks_home/.claude"
cat > "$hooks_home/.claude/settings.json" <<'JSON'
{
  "model": "keep-me",
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "echo keep-me"}]}
    ]
  }
}
JSON

hooks_install_output=$(HOME="$hooks_home" "$root/scripts/install.sh" \
  --agent claude --archive "$archive" --ref main --hooks)
[[ "$hooks_install_output" == *"Registered kacha Stop closeout hook"* ]]

verify_hooks() {
  python3 - "$1" <<'PY'
import json
import sys

settings = json.load(open(sys.argv[1], encoding="utf-8"))
assert settings.get("model") == "keep-me", "existing settings were overwritten"
stop = settings["hooks"]["Stop"]
commands = [
    hook.get("command", "")
    for entry in stop
    for hook in entry.get("hooks", [])
]
assert any("check_closeout.mjs" in command for command in commands), commands
assert "echo keep-me" in commands, commands
print("hooks merged ok")
PY
}
verify_hooks "$hooks_home/.claude/settings.json"

# 幂等：重复安装 --hooks 不产生重复注册。
HOME="$hooks_home" "$root/scripts/install.sh" \
  --agent claude --archive "$archive" --ref main --hooks >/dev/null
HOOK_COUNT=$(python3 - "$hooks_home/.claude/settings.json" <<'PY'
import json
import sys

settings = json.load(open(sys.argv[1], encoding="utf-8"))
commands = [
    hook.get("command", "")
    for entry in settings["hooks"]["Stop"]
    for hook in entry.get("hooks", [])
]
print(sum(1 for command in commands if "check_closeout.mjs" in command))
PY
)
[[ "$HOOK_COUNT" == "1" ]]

# --agent codex --hooks：Codex 无 hooks 机制，明确跳过且不碰 claude settings。
rm -rf "$temporary/codex-hooks-home"
mkdir -p "$temporary/codex-hooks-home/.claude"
printf '%s\n' '{"hooks":{"Stop":[]}}' > "$temporary/codex-hooks-home/.claude/settings.json"
codex_hooks_output=$(HOME="$temporary/codex-hooks-home" "$root/scripts/install.sh" \
  --agent codex --archive "$archive" --ref main --hooks)
[[ "$codex_hooks_output" == *"nothing to register for Codex"* ]]
[[ "$(cat "$temporary/codex-hooks-home/.claude/settings.json")" == '{"hooks":{"Stop":[]}}' ]]

# 损坏的 settings.json：skill 已安装后 wiring 失败必须显式报错（fail-closed）。
broken_settings_home="$temporary/broken-settings-home"
mkdir -p "$broken_settings_home/.claude"
printf '%s\n' 'not-json{{{' > "$broken_settings_home/.claude/settings.json"
if HOME="$broken_settings_home" "$root/scripts/install.sh" \
  --agent claude --archive "$archive" --ref main --hooks >/dev/null 2>&1; then
  printf '%s\n' "installer reported success with a corrupted settings.json" >&2
  exit 1
fi

printf '%s\n' "Installer tests passed."

#!/usr/bin/env bash
set -euo pipefail

if [[ "${KACHA_TEST_CURL_FAIL:-false}" == "true" ]]; then
  printf '%s\n' "mock curl failure" >&2
  exit 22
fi

output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || exit 2
      output=$2
      shift 2
      ;;
    --retry|--connect-timeout|--max-time)
      [[ $# -ge 2 ]] || exit 2
      shift 2
      ;;
    --*) shift ;;
    *)
      url=$1
      shift
      ;;
  esac
done

[[ -n "$output" ]] || { printf '%s\n' "mock curl missing --output" >&2; exit 2; }
[[ "$url" == "https://raw.githubusercontent.com/colorcross/kacha/main/config/release-channels.json" ]] || {
  printf 'mock curl rejected URL: %s\n' "$url" >&2
  exit 2
}
[[ -f "${KACHA_TEST_RELEASE_CHANNELS_FILE:-}" ]] || {
  printf '%s\n' "mock release channel fixture is missing" >&2
  exit 2
}
cp -- "$KACHA_TEST_RELEASE_CHANNELS_FILE" "$output"

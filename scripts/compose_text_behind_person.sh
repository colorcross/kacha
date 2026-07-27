#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  compose_text_behind_person.sh BASE_VIDEO PERSON_MASK_VIDEO TEXT_LAYER_VIDEO OUTPUT.mov

The mask and text layer must match the base duration, frame rate and start PTS
within one frame. TEXT_LAYER_VIDEO must contain an alpha channel. Any mismatch
fails closed. The result is a high-quality ProRes 4444 intermediate.
EOF
}

[[ $# -eq 4 ]] || { usage >&2; exit 2; }

base=$1
mask=$2
text_layer=$3
output=$4

for file in "$base" "$mask" "$text_layer"; do
  [[ -f "$file" ]] || { printf 'Input not found: %s\n' "$file" >&2; exit 2; }
done
[[ ! -e "$output" ]] || { printf 'Output already exists: %s\n' "$output" >&2; exit 2; }
command -v ffmpeg >/dev/null || { printf '%s\n' "ffmpeg is required" >&2; exit 2; }
command -v ffprobe >/dev/null || { printf '%s\n' "ffprobe is required" >&2; exit 2; }
command -v node >/dev/null || { printf '%s\n' "node is required" >&2; exit 2; }

base_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$base")
mask_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$mask")
text_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$text_layer")
output_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$output")
[[ "$output_resolved" != "$base_resolved" && "$output_resolved" != "$mask_resolved" && "$output_resolved" != "$text_resolved" ]] || {
  printf '%s\n' "Refusing to overwrite an input file" >&2
  exit 2
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$script_dir/assert_media_alignment.mjs" \
  "$base" "$mask" "$text_layer" \
  --allow-size-mismatch \
  --duration-tolerance-frames 1 >/dev/null

width=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$base")
height=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$base")
duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$base")
text_pixel_format=$(ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of csv=p=0 "$text_layer")
[[ "$text_pixel_format" =~ ^(rgba|bgra|argb|abgr|yuva|gbrap|ya) ]] || {
  printf 'Text layer has no verified alpha channel: %s\n' "$text_pixel_format" >&2
  exit 2
}
[[ "$duration" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  printf '%s\n' "Could not determine base duration" >&2
  exit 2
}

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/kacha-text-behind.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
temporary_output="$work_dir/output.mov"

ffmpeg -hide_banner -loglevel error -nostdin -y \
  -i "$base" \
  -i "$mask" \
  -i "$text_layer" \
  -filter_complex "
    [0:v]setpts=PTS-STARTPTS,format=rgba,split=2[background][person_rgb];
    [1:v]setpts=PTS-STARTPTS,scale=${width}:${height}:flags=bilinear,format=gray,gblur=sigma=2[person_mask];
    [2:v]setpts=PTS-STARTPTS,scale=${width}:${height}:flags=lanczos,format=rgba[text];
    [background][text]overlay=eof_action=endall:shortest=1:repeatlast=0:format=auto[background_with_text];
    [person_rgb][person_mask]alphamerge[person];
    [background_with_text][person]overlay=eof_action=endall:shortest=1:repeatlast=0:format=auto[outv]
  " \
  -map "[outv]" -map 0:a? \
  -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le \
  -c:a copy -t "$duration" \
  "$temporary_output"

node "$script_dir/assert_media_alignment.mjs" \
  "$base" "$temporary_output" \
  --duration-tolerance-frames 1 >/dev/null
mkdir -p "$(dirname "$output")"
mv -f "$temporary_output" "$output"

printf '%s\n' "$output"

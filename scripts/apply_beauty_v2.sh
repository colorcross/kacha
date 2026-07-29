#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  apply_beauty_v2.sh INPUT_VIDEO SKIN_MASK NASOLABIAL_MASK OUTPUT.mov PROFILE \
    --vision-manifest FILE --config FILE [--anchor PATH] [--report FILE] \
    [--ab-dir DIR]

PROFILE:
  natural  Restrained smoothing, whitening, tone evening and fold softening
  visible  More visible treatment; still preserves identity and face geometry

Beauty v2 is local-only. It does not reshape the face, eyes or nose. Both masks
must match the input duration, frame rate and start PTS within one frame.
The current project or explicit config must enable Beauty v2. A frame-accurate
Vision manifest is mandatory; the built-in default remains disabled.
EOF
}

[[ $# -ge 5 ]] || { usage >&2; exit 2; }

input=$1
skin_mask=$2
nasolabial_mask=$3
output=$4
profile=$5
shift 5

vision_manifest=""
project_config=""
anchor_path=""
report_file=""
ab_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vision-manifest)
      [[ $# -ge 2 ]] || { printf '%s\n' "--vision-manifest requires a value" >&2; exit 2; }
      vision_manifest=$2
      shift 2
      ;;
    --config)
      [[ $# -ge 2 ]] || { printf '%s\n' "--config requires a value" >&2; exit 2; }
      project_config=$2
      shift 2
      ;;
    --anchor)
      [[ $# -ge 2 ]] || { printf '%s\n' "--anchor requires a value" >&2; exit 2; }
      anchor_path=$2
      shift 2
      ;;
    --report)
      [[ $# -ge 2 ]] || { printf '%s\n' "--report requires a value" >&2; exit 2; }
      report_file=$2
      shift 2
      ;;
    --ab-dir)
      [[ $# -ge 2 ]] || { printf '%s\n' "--ab-dir requires a value" >&2; exit 2; }
      ab_dir=$2
      shift 2
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[[ -f "$input" ]] || { printf 'Input not found: %s\n' "$input" >&2; exit 2; }
[[ -f "$skin_mask" ]] || { printf 'Skin mask not found: %s\n' "$skin_mask" >&2; exit 2; }
[[ -f "$nasolabial_mask" ]] || { printf 'Nasolabial mask not found: %s\n' "$nasolabial_mask" >&2; exit 2; }
[[ -n "$vision_manifest" && -f "$vision_manifest" ]] || {
  printf 'Vision manifest not found: %s\n' "${vision_manifest:-<missing>}" >&2
  exit 2
}
[[ ! -e "$output" ]] || { printf 'Output already exists: %s\n' "$output" >&2; exit 2; }
command -v ffmpeg >/dev/null || { printf '%s\n' "ffmpeg is required" >&2; exit 2; }
command -v ffprobe >/dev/null || { printf '%s\n' "ffprobe is required" >&2; exit 2; }
command -v node >/dev/null || { printf '%s\n' "node is required" >&2; exit 2; }

input_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$input")
skin_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$skin_mask")
naso_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$nasolabial_mask")
output_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$output")
[[ "$output_resolved" != "$input_resolved" && "$output_resolved" != "$skin_resolved" && "$output_resolved" != "$naso_resolved" ]] || {
  printf '%s\n' "Refusing to overwrite an input file" >&2
  exit 2
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
skill_root=$(cd "$script_dir/.." && pwd)
config_file="$skill_root/config/beauty-v2.json"
[[ -f "$config_file" ]] || { printf 'Beauty v2 config missing: %s\n' "$config_file" >&2; exit 3; }
node "$script_dir/kacha_beauty.mjs" validate >/dev/null
authorization_args=(authorize --profile "$profile")
if [[ -n "$project_config" ]]; then
  authorization_args+=(--config "$project_config")
fi
if [[ -n "$anchor_path" ]]; then
  authorization_args+=(--anchor "$anchor_path")
fi
node "$script_dir/kacha_beauty.mjs" "${authorization_args[@]}" >/dev/null

node "$script_dir/assert_media_alignment.mjs" \
  "$input" "$skin_mask" \
  --allow-size-mismatch \
  --duration-tolerance-frames 1 >/dev/null
node "$script_dir/assert_media_alignment.mjs" \
  "$input" "$nasolabial_mask" \
  --allow-size-mismatch \
  --duration-tolerance-frames 1 >/dev/null

parameter_args=(parameters --profile "$profile" --format tsv)
if [[ -n "$project_config" ]]; then
  parameter_args+=(--config "$project_config")
fi
if [[ -n "$anchor_path" ]]; then
  parameter_args+=(--anchor "$anchor_path")
fi
parameter_line=$(node "$script_dir/kacha_beauty.mjs" "${parameter_args[@]}")
IFS=$'\t' read -r \
  skin_sigma_s skin_sigma_r chroma_sigma_s chroma_sigma_r \
  skin_brightness skin_gamma skin_saturation detail_amount \
  skin_mask_blur skin_temporal_frames \
  naso_sigma_s naso_sigma_r naso_brightness naso_gamma \
  naso_mask_blur naso_temporal_frames <<<"$parameter_line"

width=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$input")
height=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$input")
source_frames=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$input")
[[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]] || {
  printf '%s\n' "Could not determine source dimensions" >&2
  exit 2
}
[[ "$source_frames" =~ ^[0-9]+$ && "$source_frames" -gt 0 ]] || {
  printf '%s\n' "Could not count source frames" >&2
  exit 2
}

color_primaries=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_primaries -of csv=p=0 "$input")
color_transfer=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of csv=p=0 "$input")
color_space=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_space -of csv=p=0 "$input")
color_range=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_range -of csv=p=0 "$input")
color_args=()
if [[ -n "$color_primaries" && "$color_primaries" != "unknown" && "$color_primaries" != "reserved" ]]; then
  color_args+=(-color_primaries "$color_primaries")
fi
if [[ -n "$color_transfer" && "$color_transfer" != "unknown" && "$color_transfer" != "reserved" ]]; then
  color_args+=(-color_trc "$color_transfer")
fi
if [[ -n "$color_space" && "$color_space" != "unknown" && "$color_space" != "reserved" ]]; then
  color_args+=(-colorspace "$color_space")
fi
if [[ -n "$color_range" && "$color_range" != "unknown" && "$color_range" != "unspecified" ]]; then
  color_args+=(-color_range "$color_range")
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/kacha-beauty-v2.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
temporary_output="$work_dir/output.mov"

temporal_weights() {
  case "$1" in
    1) printf '%s' "1" ;;
    2) printf '%s' "1 1" ;;
    3) printf '%s' "1 2 1" ;;
    4) printf '%s' "1 3 3 1" ;;
    5) printf '%s' "1 4 6 4 1" ;;
    *) printf 'Unsupported temporal window: %s\n' "$1" >&2; return 1 ;;
  esac
}
skin_weights=$(temporal_weights "$skin_temporal_frames")
naso_weights=$(temporal_weights "$naso_temporal_frames")

ffmpeg -hide_banner -loglevel error -nostdin -y \
  -i "$input" \
  -i "$skin_mask" \
  -i "$nasolabial_mask" \
  -filter_complex "
    [0:v]setpts=PTS-STARTPTS,format=yuv444p10le,split=2[base][skin_source];
    [skin_source]
      bilateral=sigmaS=${skin_sigma_s}:sigmaR=${skin_sigma_r}:planes=1,
      bilateral=sigmaS=${chroma_sigma_s}:sigmaR=${chroma_sigma_r}:planes=6,
      eq=brightness=${skin_brightness}:gamma=${skin_gamma}:saturation=${skin_saturation},
      unsharp=5:5:${detail_amount}:3:3:0
      [skin_effected];
    [1:v]setpts=PTS-STARTPTS,
      scale=${width}:${height}:flags=bilinear,
      format=gray,
      tmix=frames=${skin_temporal_frames}:weights='${skin_weights}',
      gblur=sigma=${skin_mask_blur}
      [skin_soft_gray];
    [skin_soft_gray]split=3[skin_y][skin_u][skin_v];
    [skin_y][skin_u][skin_v]mergeplanes=0x001020:yuv444p10le[skin_soft_mask];
    [base][skin_effected][skin_soft_mask]maskedmerge=planes=15[skin_result];
    [skin_result]split=2[beauty_base][naso_source];
    [naso_source]
      bilateral=sigmaS=${naso_sigma_s}:sigmaR=${naso_sigma_r}:planes=1,
      eq=brightness=${naso_brightness}:gamma=${naso_gamma}
      [naso_effected];
    [2:v]setpts=PTS-STARTPTS,
      scale=${width}:${height}:flags=bilinear,
      format=gray,
      tmix=frames=${naso_temporal_frames}:weights='${naso_weights}',
      gblur=sigma=${naso_mask_blur}
      [naso_soft_gray];
    [naso_soft_gray]split=3[naso_y][naso_u][naso_v];
    [naso_y][naso_u][naso_v]mergeplanes=0x001020:yuv444p10le[naso_soft_mask];
    [beauty_base][naso_effected][naso_soft_mask]maskedmerge=planes=15,
      format=yuv422p10le[outv]
  " \
  -map "[outv]" -map 0:a? -map 0:s? -map 0:d? \
  -frames:v "$source_frames" \
  -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le \
  -c:a copy -c:s copy -c:d copy \
  -map_metadata 0 -map_metadata:s:v:0 0:s:v:0 -map_chapters 0 -fps_mode passthrough \
  "${color_args[@]}" \
  "$temporary_output"

output_frames=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$temporary_output")
[[ "$output_frames" == "$source_frames" ]] || {
  printf 'Beauty v2 frame-count mismatch: source=%s output=%s\n' "$source_frames" "$output_frames" >&2
  exit 4
}
node "$script_dir/assert_media_alignment.mjs" \
  "$input" "$temporary_output" \
  --duration-tolerance-frames 1 >/dev/null

node "$script_dir/beauty_qc.mjs" \
  "$input" "$temporary_output" \
  --skin-mask "$skin_mask" \
  --nasolabial-mask "$nasolabial_mask" \
  --vision-manifest "$vision_manifest" \
  --profile "$profile" \
  --technical-only >/dev/null

mkdir -p "$(dirname "$output")"
mv -f "$temporary_output" "$output"
qc_args=(
  "$input" "$output"
  --skin-mask "$skin_mask"
  --nasolabial-mask "$nasolabial_mask"
  --vision-manifest "$vision_manifest"
  --profile "$profile"
  --technical-only
)
if [[ -n "$report_file" ]]; then
  qc_args+=(--output "$report_file")
fi
if [[ -n "$ab_dir" ]]; then
  qc_args+=(--ab-dir "$ab_dir")
fi
node "$script_dir/beauty_qc.mjs" "${qc_args[@]}" >/dev/null
printf '%s\n' "$output"

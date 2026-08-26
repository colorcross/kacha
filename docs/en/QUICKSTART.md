# Quick start

## V7 recoverable entry

Start from source media:

```bash
node scripts/kacha.mjs start --source /path/to/source.mov \
  --project-root /path/to/project
node scripts/kacha.mjs status /path/to/project
node scripts/kacha.mjs run /path/to/project --confirm-execute
node scripts/kacha.mjs resume /path/to/project --confirm-execute
```

Or start before footage exists:

```bash
node scripts/kacha.mjs start --script /path/to/script.md \
  --task content_generation --project-root /path/to/content-project
node scripts/kacha.mjs run /path/to/content-project --confirm-execute
```

V7 maps thirteen professional stages to four user checkpoints: proposal,
first cut, candidate review, and delivery/revision. New video projects require
V6 by default. Runtime drift, installation drift, source identity changes,
unresolved facts, or unresolved assets fail closed.

This walkthrough creates a local `source_edit` project from the fictional templates. The templates are not authorization for a real project; replace every placeholder with verified project data.

To reuse subtitle, audio, beauty, or pacing preferences, create a user or
project configuration first. `prepare` will carry applicable structured and
natural-language defaults into the current packet. See
[Configuration](CONFIGURATION.md).

## Start with the local production studio

When you do not want to author JSON by hand:

```bash
node scripts/kacha.mjs studio serve
```

Use the five-step flow—source, style, sound, effects, and delivery. Search the
129 registered effects and assign them to natural-language positions. Current
project voice, BGM, Beauty v2, and density overrides do not modify the reusable
style. Run preflight before generation; it verifies source media, writable
output, licensed font evidence, the design system, and every selected effect.
The studio stays on `127.0.0.1` and does not upload, render, publish, or
overwrite source media.

## 0. Put the Agent into deterministic mode

For a lower-capability model, lower reasoning effort, or Claude Code:

```bash
node scripts/kacha.mjs doctor --profile claude-vision
node scripts/kacha.mjs prepare \
  --task source_edit --modules audio,subtitles \
  --agent claude --model-tier economy --source /path/to/source.mov \
  --output my-video-project/agent-packet.json
```

Read the packet's complete `readOrder`. When a manifest exists, run
`node scripts/kacha.mjs next PROJECT.json` and execute one `nextAction` at a
time. Build local `visual-evidence` for visual tasks. MiniMax remains blocked
without external-upload authorization, paid-service authorization, and the
explicit upload flag.

Do not put a full word-level transcript in the packet:

```bash
node scripts/kacha.mjs transcript index transcript.json
node scripts/kacha.mjs transcript slice transcript.json \
  --start 0 --end 90
```

## 1. Create a separate project directory

```bash
mkdir -p my-video-project/contracts
cp examples/edit-proposal.json my-video-project/contracts/
cp examples/edit-plan.json my-video-project/contracts/
cp examples/project-manifest.json my-video-project/contracts/
```

Do not copy source media into the Kacha repository. Keep real projects in separate directories and treat original media as read-only.

## 2. Complete the proposal and plan

At minimum, replace:

- `taskPath`
- real input paths, roles, specifications, and SHA-256 hashes
- platform, audience, language, duration, video aspect ratio, and cover aspect ratio
- content to preserve, remove, reorder, or verify
- enabled modules, success criteria, and fallbacks
- `authorization` and supporting evidence
- initial status for all 13 stages
- output paths and allowed tolerances

Calculate SHA-256 on macOS:

```bash
shasum -a 256 /path/to/source.mov
```

On Linux:

```bash
sha256sum /path/to/source.mov
```

## 3. Pass the planning gate

```bash
node scripts/validate_edit_proposal.mjs my-video-project/contracts/edit-proposal.json
node scripts/validate_edit_plan.mjs my-video-project/contracts/edit-plan.json
node scripts/kacha.mjs gate-plan my-video-project/contracts/project-manifest.json
```

If the task path is `proposal_review` or authorization is `proposal_only`, stop here. A valid proposal is not permission to edit source files.

## 4. Probe the current machine

```bash
scripts/capability_probe.sh \
  --profile core \
  --output my-video-project/contracts/capabilities.json
```

Use the relevant profile or add `--require` when the project needs masks, source separation, HDR, motion processing, geometry correction, or AI video. Do not treat an old capability snapshot as proof of current availability.

## 5. Check render readiness

```bash
node scripts/kacha.mjs gate-render my-video-project/contracts/project-manifest.json
```

After it passes, a project with `plans.timeline` can execute the supported
unified timeline directly:

```bash
node scripts/kacha.mjs timeline validate \
  --plan my-video-project/contracts/timeline.json
node scripts/kacha.mjs render \
  my-video-project/contracts/project-manifest.json
```

EDL, breathing motion, overlays, captions, dialogue, BGM, and SFX are compiled
into one Render Graph. A final visual version uses at most one full video
encode. For parameter exploration, render a separate local proxy range:

```bash
node scripts/kacha.mjs timeline migrate-timebase \
  --plan my-video-project/contracts/timeline.json \
  --output my-video-project/contracts/timeline.v2.json
node scripts/kacha.mjs editor project \
  --timeline my-video-project/contracts/timeline.v2.json
node scripts/kacha.mjs studio serve
```

The `/editor` source-video-plus-projection view is approximate. Its
snapshot-backed Command Journal supports allowlisted apply/undo/redo, but every
change still requires the normal Timeline, QC, and human-review gates. Output
playhead time is mapped through the EDL to source time, while transition overlaps
remain single-picture approximations. If history requires recovery, explicitly
choose between the last verified snapshot and an intentional external edit:

```bash
node scripts/kacha.mjs editor recover --timeline timeline.v2.json --expected-sha CURRENT_SHA
node scripts/kacha.mjs editor reopen --timeline timeline.v2.json --expected-sha CURRENT_SHA
```

```bash
node scripts/kacha.mjs timeline render \
  --plan my-video-project/contracts/timeline.json \
  --mode preview --range-start 42 --range-end 50 \
  --output my-video-project/preview/42-50.mp4
```

Work outside the unified contract may still use a project-selected NLE,
Remotion, HyperFrames, or another verified engine. `gate-render` itself only
checks readiness.

## 6. Execute the 13 stages in order

1. `inventory`
2. `transcript_structure`
3. `rough_cut`
4. `dialogue_preprocess`
5. `connection_qc`
6. `fine_cut`
7. `visual_packaging`
8. `subtitles`
9. `final_mix`
10. `cover`
11. `preview_render`
12. `final_qc`
13. `release_package`

At most one stage may be `in_progress`. A `passed` stage must include real evidence; a `not_applicable` stage must explain why.

### Apply semantic net-style mechanisms during `visual_packaging`

After picture lock, compile and render a production effect timeline from the
final timed transcript:

```bash
node scripts/kacha.mjs netstyle plan \
  --input my-video-project/picture-lock.mov \
  --transcript my-video-project/final-timed-transcript.json \
  --output my-video-project/contracts/netstyle-plan.json \
  [--mask my-video-project/person-mask.mkv]
node scripts/kacha.mjs netstyle validate-plan \
  --plan my-video-project/contracts/netstyle-plan.json
node scripts/kacha.mjs netstyle render-plan \
  --plan my-video-project/contracts/netstyle-plan.json \
  --output my-video-project/visual-packaged.mov
```

Register the plan under `plans.netstyleTimelines` in the project manifest.
Subtitles and final mixing run after this output. See the
[semantic net-style reference](../../references/z-en-editing-system.md) for
cue fields and fail-closed gates.

Use the shared cache for high-cost analysis and generation:

```bash
node scripts/kacha.mjs transcribe source.mov --output transcript.json
node scripts/kacha.mjs masks source.mov --output-dir masks
node scripts/kacha.mjs styleframe render \
  --scene process_progressive --output design/process.svg
node scripts/kacha.mjs cache inspect --project-root my-video-project
```

See [Performance, token, and weak-model production](PERFORMANCE_TOKEN_STABILITY_V5.md).

## V6 global direction and semantic review

Compile the final timed semantic cues into an episode-level plan and an asset
gap plan, then audit and review the candidate:

```bash
node scripts/kacha.mjs intelligence director \
  --cues semantic-cues.json --show tool-share \
  --style light-warm-overlay --output director-plan.json
node scripts/kacha.mjs intelligence assets \
  --director director-plan.json --media-index .kacha/media-index.json \
  --output asset-gap-plan.json
node scripts/kacha.mjs intelligence perception \
  --timeline timeline.json --output perception-audit.json
node scripts/kacha.mjs review build \
  --timeline timeline.json --director director-plan.json \
  --preview-dir preview --output-dir .kacha/review
node scripts/kacha.mjs studio serve
```

Open `/review`, inspect each high-impact decision in a verified 1x preview with
decodable video, audio, and representative duration, then record accept,
adjust, or reject. Resolution evidence uses the same real video/audio gate, and
the project/show/style/platform scope is derived from the current Timeline and
director rather than reassigned by the review command. Missing previews keep
the candidate blocked. See
[V6 editorial evaluation and semantic review](INTELLIGENT_EDITING_V6.md) for
evaluation, preference learning, NLE interchange, and gate integration.

## 7. Run automated technical QC

```bash
node scripts/kacha.mjs qc my-video-project/contracts/project-manifest.json
```

Automated QC creates a technical report and checks decoding, streams, dimensions, aspect ratio, frame rate, audio, A/V duration difference, loudness, and black/frozen/silent clues. `pass_with_review` still means a human must resolve the reported clues.

## 8. Add human review and pass the release gate

Copy `examples/release-report.template.json`. Record evidence for a complete watch-through, subtitles, edit connections, asset licenses, masks/beauty/PiP, dialogue and device listening, cover, opening and ending, and resolution of technical clues.

```bash
node scripts/kacha.mjs gate-release my-video-project/contracts/project-manifest.json
```

Only when the real files, hashes, automated QC, and every required human check pass may you claim that local full QC passed. Uploading and publishing require separate authorization and platform-side verification.

## 9. Use v3 for a local change on a verified baseline

Initialize stable project context once:

```bash
node scripts/init_incremental_project.mjs /path/to/base.mov \
  --project-id my-video --output-dir my-video-project/incremental
```

Create one delta and one manifest per feedback round:

```bash
node scripts/create_version_delta.mjs \
  my-video-project/incremental/project-context.json \
  --write my-video-project/incremental/v2-delta.json \
  --new-version v2 --type sfx_adjust \
  --output-video my-video-project/incremental/v2.mov

node scripts/create_incremental_manifest.mjs \
  my-video-project/incremental/project-context.json \
  my-video-project/incremental/v2-delta.json \
  my-video-project/incremental/artifact-index.json \
  --output my-video-project/incremental/v2-project.json

node scripts/kacha.mjs gate-plan my-video-project/incremental/v2-project.json
# Render with the generated stream-copy/layer/segment strategy.
node scripts/kacha.mjs qc my-video-project/incremental/v2-project.json
node scripts/create_incremental_review.mjs \
  my-video-project/incremental/v2-project.json
node scripts/kacha.mjs gate-candidate \
  my-video-project/incremental/v2-project.json
```

An audio-only change should preserve the original video stream; a visual-only
change should preserve the original audio stream. QC proves this with
elementary-stream SHA-256. Use a new `release_candidate` delta and the full
manual checklist before `gate-release`.

Common changes can be compiled instead of hand-authoring a complex delta:

```bash
node scripts/kacha.mjs compile-change change-request.json --dry-run
node scripts/kacha.mjs compile-change change-request.json
node scripts/kacha.mjs next /path/to/compiled/incremental-project.json
```

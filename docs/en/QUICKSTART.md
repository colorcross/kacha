# Quick start

This walkthrough creates a local `source_edit` project from the fictional templates. The templates are not authorization for a real project; replace every placeholder with verified project data.

To reuse subtitle, audio, beauty, or pacing preferences, create a user or
project configuration first. `prepare` will carry applicable structured and
natural-language defaults into the current packet. See
[Configuration](CONFIGURATION.md).

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

After it passes, execute the approved plan with the project-selected FFmpeg, NLE, Remotion, HyperFrames, or other verified timeline engine. Kacha validates contracts and gates; `gate-render` does not build or render a universal timeline.

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

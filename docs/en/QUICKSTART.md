# Quick start

This walkthrough creates a local `source_edit` project from the fictional templates. The templates are not authorization for a real project; replace every placeholder with verified project data.

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

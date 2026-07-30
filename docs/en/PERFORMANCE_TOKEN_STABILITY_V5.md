# Performance, token, and weak-model production (V5)

V5 reduces duplicate analysis, reasoning, and encoding without lowering
content, visual, audio, or release gates. Improvements must be demonstrated by
runtime metrics, cache evidence, current-output QC, and normal-speed human
review.

## Where time goes

The exact share is project-specific. The common expensive paths are:

1. final 4K video encoding and complex compositing;
2. Demucs, Whisper, Apple Vision tracking/masks, Beauty, and voice processing;
3. generated or downloaded media, including queue and review time;
4. unnecessary whole-film preview renders;
5. competing MPS/video-encode jobs and large-file I/O;
6. repeatedly rebuilding model context from long transcripts, references, and
   logs.

Measure instead of guessing:

```bash
node scripts/kacha.mjs metrics run \
  --stage preview_render --project-root PROJECT_DIR \
  --model-tier economy --reference-tokens 402 -- \
  COMMAND [ARGS...]
node scripts/kacha.mjs metrics summarize --project-root PROJECT_DIR
```

Full redacted logs stay on disk. The Agent receives only a compact result and
the measured time/token bottlenecks. Token usage is extracted from common child
JSON `usage`/`metrics` fields when available. Packet/reference estimates are
explicitly labeled `estimated` or `unavailable`; they never impersonate
provider-measured usage.

## Faster execution without lower-quality finals

### One final visual encode

Timeline IR is the editing truth; Render Graph is the deterministic execution
plan:

```bash
node scripts/kacha.mjs timeline validate --plan timeline.json
node scripts/kacha.mjs render PROJECT.json
```

EDL, breathing motion, overlays, captions, dialogue, BGM, SFX, and stems are
composed together. A supported final visual version has at most one full video
encode. An exact verified graph/output reuse has zero. Finals always start from
the highest-quality source, never an upscaled proxy. The graph identity also
freezes proposal/edit-plan contracts, overlays, captions, dialogue, BGM, SFX,
and the font directory by content hash, so replacing a file in place
invalidates reuse.

### Proxy and range previews

```bash
node scripts/kacha.mjs timeline render \
  --plan timeline.json --mode preview \
  --range-start 42.5 --range-end 49 \
  --output preview/42.5-49.mp4
```

The explicit range slices and re-times video, overlays, captions, dialogue,
BGM, and SFX together. It cannot overwrite the final path or emit official
stems. Preview scaling also scales overlay geometry; an overlay outside the
official canvas fails compilation instead of being silently clipped.

### Content-addressed reuse

```bash
node scripts/kacha.mjs transcribe INPUT.mov --output transcript.json
node scripts/kacha.mjs masks INPUT.mov --output-dir masks
node scripts/kacha.mjs beauty render INPUT.mov [options]
node scripts/kacha.mjs styleframe render --scene SCENE --output frame.svg
node scripts/kacha.mjs generated-cache run \
  --plan generated.json --shot SHOT_ID --output shot.mp4 -- GENERATOR...
```

Demucs, ASR, masks/tracking, Beauty, styleframes, and generated media use source,
implementation, operation, parameter, and output-schema fingerprints. Hits
still verify hashes. Demucs and ASR additionally fingerprint actual
model-weight/model-directory content plus runtime and service implementation
hashes. Missing strong fingerprints bypass cache; replacing weights or
upgrading a service invalidates old stems/transcripts. A paid generated shot
is not resubmitted on a hit, even when only its local delivery path changes.
Capacity exhaustion stops explicitly instead of silently deleting high-value
edit assets.

### Resource scheduling

```bash
node scripts/kacha.mjs resources status --project-root PROJECT_DIR
node scripts/kacha.mjs resources run \
  --project-root PROJECT_DIR --resource mps -- COMMAND
```

CPU, MPS, video encoding, network, and I/O have independent cross-process
leases in one host-level pool shared by independent projects. Heavy MPS work
and full video encoding default to one job each. `--project-root` attributes
metrics; it does not create an isolated competing GPU lock pool.

## Lower token use without removing evidence

The main token drains are repeated large references, full ASR plus word timing,
old project contracts copied into every revision, full effect catalogs, and
large tool logs.

Kacha uses five bounded context packets. They route information and do not
replace the ordered 13-stage v2 execution state:

```bash
node scripts/kacha.mjs prepare \
  --task source_edit --stage edit --model-tier economy \
  --project PROJECT.json --output edit-packet.json
```

Each stage reference target is at most 12,000 tokens; the complete packet is at
most 16,000. Hard rules remain executable gates rather than text removed for
budget reasons.

Keep the full transcript on disk:

```bash
node scripts/kacha.mjs transcript index transcript.json
node scripts/kacha.mjs transcript slice transcript.json \
  --start 90 --end 180
```

The maximum slice is 180 seconds. `prepare` inlines at most 20 low-confidence
segments; explicit text is loaded only for the selected window.

Rule retrieval returns one to three candidates, and project state persists
outside chat:

```bash
node scripts/kacha.mjs rules query \
  --stage edit --modules cut,transition \
  --signals '["information_change","connection"]' --limit 3
node scripts/kacha.mjs state snapshot PROJECT.json
node scripts/kacha.mjs state record .kacha/project-state.json \
  --stage fine_cut --status complete --evidence fine-cut-evidence.json
```

Every completed v2 stage binds current `{path, sha256}` evidence. Contract
changes invalidate stale progress, while merely filling in a rendered output
hash does not reset valid stages.

## Stable quality with weaker models

The model handles intent, narrative emphasis, selection among bounded recipes,
and comparison of short previews. Code handles file identities, rule scoring,
state, dependencies, Timeline IR, caching, resource leases, encoding, and
technical QC.

The same cues, rules, configuration, and seed produce the same decision digest.
Low confidence or conflicts are preview-only and escalate to a stronger model
or human; they cannot silently enter a final render:

```bash
node scripts/kacha.mjs rules compile \
  --cues semantic-cues.json --model-tier economy \
  --seed 7 --output decision-plan.json
node scripts/kacha.mjs rules apply \
  --decision-plan decision-plan.json \
  --timeline timeline.json --output preview-timeline.json --preview-only
```

## Acceptance

```bash
node tests/run_tests.mjs --report /tmp/kacha-tests.json
node scripts/kacha.mjs golden real \
  --video REAL_VIDEO --output-dir /tmp/kacha-golden \
  --start 15 --duration 6 --mode final
node scripts/kacha.mjs optimization-audit run \
  --test-report /tmp/kacha-tests.json \
  --golden-report /tmp/kacha-golden/golden-report.json \
  --asr-report /tmp/kacha-asr-canary.json \
  --install-report /tmp/kacha-install-verification.json \
  --output /tmp/kacha-optimization-audit.json
```

The real-media golden exercises EDL, motion, overlay, captions, BGM, SFX, and
dialogue/BGM/SFX/mix stems. QC reconstructs the component mix and compares the
decoded final audio with the declared mix stem, catching the case where stems
contain music but the final video does not.

The audit does not trust a report's self-declared `pass`. It verifies current
source/output/graph/manifest/QC hashes, the real ASR input plus model/service
fingerprints, and both installed Agent bundle digests, then reruns the current
full regression suite itself. It also checks one final encode, zero-encode
exact reuse, geometry, one-frame A/V drift, packet budgets, warm-cache reuse,
economy decisions, host-level serialization, mandatory telemetry, Beauty
default-off, and no silent fallback. All four evidence reports are required.
It does not replace normal-speed visual review, headphone/phone listening, or
release approval for each real video.

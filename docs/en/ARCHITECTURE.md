# Architecture and design boundaries

## V7 production orchestration

`.kacha/orchestration.json` binds runtime and dual-install status, source
identity, local execution authority, V6 evidence, project files, and one next
action. `config/workflow-recipes.json` groups the thirteen professional stages
into proposal, first-cut, candidate-review, and delivery/revision checkpoints.
`start`, `run`, `resume`, and `status` use the same recoverable state.

Script-first projects create a content spine, fact-check tasks, a recording
plan, an asset inbox, and a source-edit handoff. The handoff remains blocked
until facts, assets, and human content approval have evidence. The release
review binds eleven checks to the current final-video SHA-256; a changed output
invalidates the prior approval.

## Design goal

Kacha separates five states that are often incorrectly treated as one:

1. The proposal is complete.
2. The current machine has the required capabilities.
3. The timeline was actually executed.
4. Automated technical checks passed.
5. Human review and local delivery completed.

An earlier state must never impersonate a later state.

## Core data objects

### `editProposal`

Defines goals, inputs, content structure, modules, authorization, fallbacks, and the 13 stages. It answers: why are we doing this, what is allowed, and what counts as success?

### `editPlan`

Defines cuts, subjects, shot sizes, reasons for shot changes, continuity, and effect contracts. It answers: what exactly should happen on the timeline?
High-impact visual modules also reference a real styleframe, implementation
manifest, file hashes, resolved fonts, and token paths from the active video
design system.

### `projectManifest`

Connects the proposal, plan, capability snapshot, inputs, outputs, and QC reports. It is the unified gate entry point.

### `Timeline IR + Render Graph`

`timeline.ir.json` is the execution truth for the source hash, EDL, breathing
motion, overlays, captions, dialogue, BGM, SFX, and output contract.
`render-graph.json` is compiled deterministically from it and freezes geometry,
events, configuration, encoder selection, decision digests, proposal/edit-plan
contracts, every media layer, and the font directory by content identity. A
supported final visual version uses at most one full video encode. Reuse
requires the graph, all inputs, the final output, and every declared stem to
remain current; replacing an asset in place invalidates reuse.

### `Timebase V2 + Timeline Projection + Command Journal`

The Timeline editing boundary uses 120,000 integer ticks per second and a
rational frame rate. Legacy seconds remain accepted; when ticks exist they are
authoritative and seconds must agree within half a frame. Migration writes a
new file by default.

`timeline_projection.mjs` derives typed picture, overlay, caption, effect,
dialogue, BGM, and SFX tracks while retaining stable source pointers and an
editable-field allowlist. It never becomes a second project model.

`editor_command_journal.mjs` stores forward and inverse mutations,
before/after hashes, content-addressed snapshots, affected tracks, required QC,
and a chained append-only record. Optimistic SHA locking protects apply, undo,
and redo. `recover` restores the last verified snapshot and archives the damaged
state; `reopen` explicitly accepts a valid external edit. Both require the current
Timeline SHA. The Studio Canvas provider maps output time through the EDL but does
not composite overlaps, so it is never final-eligible. The canonical FFmpeg Render
Graph also has to pass its current runtime probe before final eligibility.

### `.kacha/metrics + cache + project-state`

- `metrics/` records stage wall time, measured/estimated token provenance,
  cache outcomes, render scope, video encode count, artifacts, and redacted
  logs.
- `cache/` stores artifacts keyed by source, implementation, operation,
  model/service content, parameters, and output schema digests.
- `project-state.json` persists the ordered 13-stage v2 state, decisions,
  issues, current file-backed evidence hashes, and the one legal next action
  outside chat history. The five packets route context; they do not replace
  execution state.

### `generatedShotPlan`

Records reference assets and hashes, provider/model/transport, capability snapshot, action beats, specifications, authorization, and QC targets for generated shots.

### v3 `projectContext + versionDelta + artifactIndex`

`projectContext` stores stable project and baseline facts. `versionDelta`
records only the current feedback. `artifactIndex` stores content fingerprints,
dependencies, and regeneration cost. Together they generate an
`incrementalPlan` with L0-L3 risk, invalidation/reuse, minimum render scope, and
dynamic QC.

### `releaseReport`

Records final-file hashes, limitations, and human-review evidence. An automated report must never generate a false claim of human approval.

### `deltaQc + incrementalReview`

`deltaQc` records checks for changed layers and elementary-stream hashes for
frozen layers. `incrementalReview` stores candidate-specific human evidence; it
cannot impersonate a final release report.

## Gates

```text
editProposal + editPlan + inputs
                |
                v
            gate-plan
                |
      capability snapshot
                |
                v
           gate-render
                |
       external render engine
                |
                v
               qc
                |
       human review evidence
                |
                v
          gate-release
```

### `gate-plan`

Checks the proposal, task path, authorization, real inputs, SHA-256 hashes, and plan consistency.

### `gate-render`

Checks stage state, inputs, capabilities, and output contracts for execution readiness. It is not a render command.

### `qc`

Runs automated technical analysis on the final media and writes a traceable report.

### `gate-release`

Checks the final video, cover, subtitles, technical report, SHA-256 hashes, and human-review evidence.

### `gate-candidate`

For v3 only. It checks the current deliverable, incremental technical evidence,
frozen-layer proof, and the dynamic human checklist. A passing `candidate`
remains editable; only a `release_candidate` may enter `gate-release`.

## V4 deterministic execution layer

Eight stable commands reduce model-reasoning dependence:

- `doctor`: inspect runtime and visual-compensation capabilities;
- `prepare`: emit a model-tiered, budget-bounded task packet and exact `readOrder`;
- `next`: derive one legal next action from current files and hashes;
- `compile-change`: compile common feedback recipes into v3 contracts;
- `effects`: validate, inspect, and preview registered openings/transitions;
- `design`: resolve registered renderers, emit SVG/PNG/ASS plus implementation
  manifests, and run the cross-mode/state QC matrix;
- `beauty`: enforce project-level opt-in for local Beauty v2 and keep technical
  QC separate from dynamic human review;
- `connections`: combine timeline cuts and scene-change candidates into review handles;
- `visual-evidence`: build local keyframe, face/person, OCR, and technical evidence;
- `vision-enrich`: enrich a few frames with MiniMax only after external-upload,
  paid-service, and explicit command authorization.

`nextAction.owner` separates Agent-safe work from a real render engine and
human review. See `references/agent-execution.md` and
`references/visual-evidence.md`.

## V5 performance and weak-model execution layer

V5 adds four deterministic boundaries:

1. five bounded packets: `inventory`, `content`, `edit`, `visual_audio`, and
   `release`;
2. transcript indexing and explicit windows, with a hard 180-second slice
   maximum;
3. scored rules that return one to three candidates and force uncertain work
   into preview/escalation instead of final output;
4. unified timeline/render commands backed by content-addressed cache,
   host-level cross-project resource leases, and automatic telemetry.

The model handles intent, content structure, candidate selection, and short
preview comparison. Code handles file identity, state, dependencies, caching,
encoding, and technical QC. See
[`PERFORMANCE_TOKEN_STABILITY_V5.md`](PERFORMANCE_TOKEN_STABILITY_V5.md).

For required BGM, technical QC reconstructs the mix from dialogue/BGM/SFX
stems and compares decoded final audio with the declared mix stem. Correct
component files cannot hide a final mux that omitted the music.

## V6 editorial-intelligence evidence layer

V6 keeps Timeline IR and Render Graph as the execution sources of truth. It
adds a global director plan, asset-gap plan, temporal-perception audit,
semantic review bundle/session, versioned preference candidate/profile,
human editorial evaluation, NLE interchange reports, and a user-visible
observability summary.

With `intelligenceV6.required=true`, v2 and v3 plan, render, and release gates
validate those current file-backed artifacts and reject a director, asset plan,
Timeline, perception audit, or review bundle assembled from different project
or SHA evidence sets. Media-index digest v2 freezes provenance, license, and
strong file identities. NLE exchange binds the baseline and source SHA, accepts
only baseline-known semantic IDs, and import is candidate-only. Preference
activation rebuilds only candidate-ready evidence and lock-merges scoped rules
instead of replacing unrelated history. Automatic perception checks retain
verified 1x video/audio previews and normal-speed human review. See
[`INTELLIGENT_EDITING_V6.md`](INTELLIGENT_EDITING_V6.md).

## Configuration boundary

`scripts/kacha_config.mjs` merges built-in, user, project, machine-local, and
explicit layers into one schema- and range-validated safe snapshot.
`prepare`, `compile-change`, visual evidence, MiniMax, QC, audio, and media
helpers record only its credential-free digest.

Credentials come from a separate secrets file or environment. Values remain
non-serializable internal state and are injected only into the required child
process. Editing defaults enter the execution contract but cannot override
project authorization or non-negotiable gates.

## Video design system boundary

`config/design-system/` stores the system, five mode dimensions, component,
scene, renderer, layout, and motion registries. `config/styles/` stores the base style profile;
`config/effects/` stores opening and transition registries. Timeline intervals
reference IDs and digests instead of copying fonts, colors, shadows, borders,
safe areas, or easing curves.

`scripts/design_system.mjs` validates and resolves the contract.
`scripts/kacha_design.mjs` provides validation, inventory, resolution, real
SVG/PNG/ASS rendering, implementation manifests, font resolution, contrast
checks, and cross-mode/state QC. Each manifest freezes the resolver, style
resolver, and renderer implementation digest so stale previews cannot serve as
current evidence. A preview proves that an implementation path works; it does
not prove that a scene is narratively appropriate.

## Fail closed

- Missing input or hash mismatch: stop.
- Authorization conflicts with the task path: stop.
- Required capability missing: downgrade the plan or stop.
- Mask, text layer, and source-video timestamps disagree: stop.
- Generated task state unknown: query it; do not automatically resubmit.
- Automated QC finds clues: resolve them through human review before continuing.
- Human-review evidence missing: do not release.
- Explicit cache reuse conflicts with dependency invalidation: reject it.
- A `candidate` attempts to pass final release: stop.
- A partial preview targets the final output, a final plan still contains an
  unresolved escalation, or a final visual render would exceed one full video
  encode: stop.
- Cache contents or hashes fail verification, capacity is exhausted, or a
  credential appears in cache parameters: stop.

## Extending Kacha

When adding a capability:

1. Define its trigger, mechanism, simple fallback, failure condition, and QC in a reference.
2. Add real detection to the capability probe.
3. Add verifiable fields to the JSON contracts.
4. Test both passing and failing paths.
5. Do not describe a platform-specific feature as a stable cross-platform capability.

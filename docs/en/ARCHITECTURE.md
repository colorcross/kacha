# Architecture and design boundaries

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

### `projectManifest`

Connects the proposal, plan, capability snapshot, inputs, outputs, and QC reports. It is the unified gate entry point.

### `generatedShotPlan`

Records reference assets and hashes, provider/model/transport, capability snapshot, action beats, specifications, authorization, and QC targets for generated shots.

### `releaseReport`

Records final-file hashes, limitations, and human-review evidence. An automated report must never generate a false claim of human approval.

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

## Fail closed

- Missing input or hash mismatch: stop.
- Authorization conflicts with the task path: stop.
- Required capability missing: downgrade the plan or stop.
- Mask, text layer, and source-video timestamps disagree: stop.
- Generated task state unknown: query it; do not automatically resubmit.
- Automated QC finds clues: resolve them through human review before continuing.
- Human-review evidence missing: do not release.

## Extending Kacha

When adding a capability:

1. Define its trigger, mechanism, simple fallback, failure condition, and QC in a reference.
2. Add real detection to the capability probe.
3. Add verifiable fields to the JSON contracts.
4. Test both passing and failing paths.
5. Do not describe a platform-specific feature as a stable cross-platform capability.

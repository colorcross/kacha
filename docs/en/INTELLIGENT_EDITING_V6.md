# Kacha V6: editorial evaluation, semantic review, and preference learning

V6 adds an evidence-backed intelligence layer on top of Timeline IR, Render
Graph, Mutation Delta, Jobs, cache, and release gates. It does not add a second
renderer or treat effect count as editing quality.

## Implemented capabilities

- `intelligence director` compiles timed semantic cues into an episode-level
  narrative spine, one opening, high-impact budget, deliberate quiet, content
  priority, style grammar, fallbacks, and human-review requirements.
- `intelligence assets` resolves each media need to licensed local candidates,
  an explicitly non-factual generation candidate, or a blocking requirement
  for real user/source evidence.
- `intelligence perception` checks time-domain conflicts, text exposure,
  mobile text size, full-frame flash risk, mask evidence, audio/visual landing,
  motion coverage, and quiet ratio while retaining dynamic human review.
- `review build|record|validate` creates a localhost semantic review package in
  which every high-impact decision is accepted, adjusted, or rejected.
- `review learn|activate|rollback` produces transparent, evidence-counted,
  versioned preference candidates. Activation and rollback require explicit
  confirmation; the source-session hash is revalidated, rollback creates a new
  monotonic audit version, and freeform notes never enter the long-term profile.
- `eval score|compare` reports first-draft usability, decision acceptance,
  semantic damage, manual intervention, connection rejection, caption
  correction, and style-grammar violations. It never emits a composite vanity
  score. Dataset hashes are frozen and deltas use only genuinely shared source
  groups. Improvement claims require at least eight such pairs.
- `nle export|import` supports OTIO and FCPXML semantic-ID round trips and
  CMX3600 export. Import always creates a preview candidate and cannot overwrite
  the baseline Timeline IR.
- `intelligence observe` exposes Jobs, measured telemetry, cache, encodes, and
  disk evidence. ETA and provider cost remain unavailable when not measured.

## Full V6 gate opt-in

```json
{
  "intelligenceV6": { "required": true },
  "plans": {
    "directorPlan": "./director-plan.json",
    "assetGapPlan": "./asset-gap-plan.json",
    "temporalPerceptionAudit": "./temporal-perception-audit.json",
    "semanticReviewSession": "./.kacha/review/review-session.json"
  }
}
```

`gate-plan` validates the global director and asset plan. `gate-render` blocks
truncated media indexes and unresolved factual evidence. `gate-release` blocks
perception failures, missing human-review requirements, incomplete decisions,
and unresolved adjustments or rejections.

## Evidence boundary

Repository fixtures prove contracts and failure behavior, not real-world
editing improvement. A production claim still requires at least eight paired,
human-reviewed source projects, real normal-speed mobile/headphone review, and
application-level round-trip checks in Final Cut Pro, Premiere, or Resolve.

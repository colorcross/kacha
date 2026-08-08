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
  for real user/source evidence. A generation candidate remains blocked until
  its output is materialized and re-indexed with current SHA-256, license, and
  provenance.
- `intelligence perception` checks time-domain conflicts, text exposure,
  mobile text size, full-frame flash risk, mask evidence, audio/visual landing,
  motion coverage, and quiet ratio while retaining dynamic human review.
- `review build|record|validate` creates a localhost semantic review package in
  which every high-impact decision is accepted, adjusted, or rejected. Every
  candidate-ready decision also needs a decodable 1x preview with video, an
  audible track, and enough representative duration.
- `review learn|activate|rollback` produces transparent, evidence-counted,
  versioned preference candidates. Activation and rollback require explicit
  confirmation; activation deterministically rebuilds rules from the current
  source session, merges them by project/show/style/platform scope, and cannot
  erase unrelated or absent rules. Rollback creates a new monotonic audit
  version, and freeform notes never enter the long-term profile.
- `eval score|compare` reports first-draft usability, decision acceptance,
  semantic damage, manual intervention, connection rejection, caption
  correction, and style-grammar violations. It never emits a composite vanity
  score. Dataset hashes are frozen and deltas use only genuinely shared source
  groups. Eight pairs are necessary but insufficient for an overall improvement
  claim: every required guardrail must be measured without regression and at
  least one primary quality metric must improve.
- `nle export|import` supports OTIO and FCPXML semantic-ID round trips and
  CMX3600 export. Interchange files bind the baseline Timeline and source-media
  SHA; FCPXML uses valid rational timing for fractional rates. Import always
  creates a preview candidate, rejects cross-project reuse, and cannot overwrite
  the baseline Timeline IR.
- `intelligence observe` exposes Jobs, measured telemetry, cache, encodes, and
  disk evidence. A malformed job or truncated JSONL line is isolated and marks
  integrity as degraded instead of breaking the whole view. ETA and provider
  cost remain unavailable when not measured.

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

The same opt-in applies to v2 first-edit and v3 incremental manifests.
`gate-plan` validates the global director and asset plan. `gate-render` blocks
truncated indexes, unmaterialized generation candidates, and unresolved factual
evidence. `gate-release` blocks perception failures, missing verified previews,
missing human-review requirements, incomplete decisions, and unresolved
adjustments or rejections.

## Evidence boundary

Repository fixtures prove contracts and failure behavior, not real-world
editing improvement. A production claim still requires at least eight paired,
human-reviewed source projects with no measured guardrail regression, real
normal-speed mobile/headphone review, and
application-level round-trip checks in Final Cut Pro, Premiere, or Resolve.

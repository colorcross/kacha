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
  provenance. Media-index digest v2 freezes strong file identity, license,
  provenance, semantic fields, and scan completeness; validation deterministically
  rebuilds the gap plan from the current director and index.
- `intelligence perception` checks time-domain conflicts, text exposure,
  mobile text size, full-frame flash risk, mask evidence, audio/visual landing,
  motion coverage, and quiet ratio while retaining dynamic human review. Bound
  dynamic evidence must match the Timeline width, height, frame rate, and full
  duration; it does not replace normal-speed human inspection.
- `review build|record|validate` creates a localhost semantic review package in
  which every high-impact decision is accepted, adjusted, or rejected. Every
  candidate-ready decision also needs a decodable 1x preview with video, an
  audible track, and enough representative duration. Resolution evidence uses
  the same media gate, while project/show/style/platform scope is rebuilt from
  the current Timeline and director and cannot be reassigned by CLI input.
- `review learn|activate|rollback` produces transparent, evidence-counted,
  versioned preference candidates. Activation and rollback require explicit
  confirmation; activation deterministically rebuilds rules from the current
  source session, merges them by project/show/style/platform scope, and cannot
  erase unrelated or absent rules. Rollback creates a new monotonic audit
  version, and freeform notes never enter the long-term profile. Only a fully
  candidate-ready session may be learned, and profile activation/rollback share
  a file lock so concurrent updates cannot lose rules.
- `eval score|compare` reports first-draft usability, decision acceptance,
  semantic damage, manual intervention, connection rejection, caption
  correction, and style-grammar violations. It never emits a composite vanity
  score. Dataset hashes are frozen and deltas use only genuinely shared source
  groups. Eight pairs are necessary but insufficient for an overall improvement
  claim: every required guardrail must be measured without regression and at
  least one primary quality metric must improve. Sources must be decodable
  videos, reviewed outputs must be decodable videos with audio and matching
  duration, one source SHA cannot be counted under multiple groups, and source
  mismatch or unchanged baseline/candidate output cannot support improvement.
- `nle export|import` supports OTIO and FCPXML semantic-ID round trips and
  CMX3600 export. Interchange files bind the baseline Timeline and source-media
  SHA; FCPXML uses valid rational timing for fractional rates. Import always
  creates a preview candidate, rejects cross-project reuse, accepts only clip
  IDs already present in the baseline with unchanged decision/semantic IDs, and
  cannot overwrite an existing candidate, report, or baseline Timeline IR.
- `intelligence observe` exposes Jobs, measured telemetry, cache, encodes, and
  disk evidence. A malformed job or truncated JSONL line is isolated and marks
  integrity as degraded instead of breaking the whole view. Reads are bounded to
  the recent telemetry/job window. Each job's immutable submission contract is
  revalidated before execution and state mutation. ETA and provider cost remain
  unavailable when not measured.

## Full V6 gate opt-in

```json
{
  "intelligenceV6": { "required": true },
  "plans": {
    "directorPlan": "./director-plan.json",
    "assetGapPlan": "./asset-gap-plan.json",
    "timeline": "./timeline.json",
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
adjustments or rejections. Every gate also rejects a director, asset plan,
Timeline, perception audit, or review bundle assembled from different project
or SHA evidence sets.

## Evidence boundary

Repository fixtures prove contracts and failure behavior, not real-world
editing improvement. A production claim still requires at least eight paired,
human-reviewed source projects with no measured guardrail regression, real
normal-speed mobile/headphone review, and
application-level round-trip checks in Final Cut Pro, Premiere, or Resolve.

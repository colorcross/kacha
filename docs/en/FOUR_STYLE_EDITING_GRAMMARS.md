# Four-Style Editing Grammar Contract

The four styles share subject safety, caption legibility, font routing,
persistent-brand restraint, contrast, and audiovisual synchronization. They do
not share shot organization. Changing color, radius, halftone, pixel edges, or
glass material alone is not a style change.

The machine-readable authority is
[`config/design-system/visual-languages.json`](../../config/design-system/visual-languages.json).
Every effect contract carries the matching `editingGrammarContract`.

## Decision table

| Style | Basic time unit | Spatial organization | Primary transition | Sound structure | Fallback |
| --- | --- | --- | --- | --- | --- |
| Light Warm Overlay | One complete spoken thought | Margin notes plus negative space | Clean/match cut, short dissolve, local reveal | Quiet by default; one soft paper or air cue for a major note | Plain captions or a clean cut |
| Spatial Light Path | One real relationship or route | Fixed world coordinates, depth, and occlusion | Occlusion travel, route continuation, focus transfer | Origin and destination share one directional tonal phrase | Light Warm notes or a clean cut |
| Humor Comic | Setup, expectation, reaction, punchline, callback | Main panel plus reaction insert; panel order represents time or contrast | Hard cut, freeze, smash insert, panel snap | Silence carries timing; at most one dry cue after the action | Light Warm Overlay or plain captions |
| Pixel Editorial | Input, process, state, result | Integer grid, state register, one active cursor | Tile swap, cursor commit, state replace | A UI cue only for a real state change | Light Warm information card or a clean cut |

## Light Warm Overlay: continuous editorial notes

1. Keep the talking-head delivery continuous and preserve one complete thought.
2. Establish the question first, then add one primary note from the frame edge
   or opposite the speaker's gaze.
3. Evidence may occupy a second reading zone; centered card stacks and web-like
   popup walls are forbidden.
4. Emphasis scale stays at or below 103%, and at least 45% of readable hold time
   remains free of decorative motion.
5. Exit secondary evidence, then the main note, then return to clean A-roll.

Original primitive: `assets/design/original/editorial-margin-notes.svg`.

## Spatial Light Path: single-pass depth navigation

1. Establish world coordinates and depth before drawing the relationship path.
2. Move focus or camera only after the route arrives; hold a node before moving
   to the next destination.
3. Anchor text to depth, including behind the subject when a real mask exists.
4. Prefer one spatial pass while the relationship remains unchanged; cut on an
   occlusion or spatial boundary.
5. Origin, route, and destination form one audiovisual phrase. Do not score
   every particle or node separately.

Original primitive: `assets/design/original/spatial-route-field.svg`.

## Humor Comic: comedy timing, not a comic filter

1. Make the setup clear and leave a half-beat of expectation.
2. Reveal contrast with a hard cut, reaction insert, freeze, or scale mismatch.
3. Use one primary punchline per semantic beat; let text arrive half a beat late.
4. Leave reaction time, then reuse the same compositional element only when a
   callback is earned.
5. Without real contrast, misunderstanding, scale mismatch, reaction, or
   callback, do not use panel overshoot or comedy sound.

Original primitive: `assets/design/original/comic-beat-panels.svg`.

## Pixel Editorial: deterministic state machine

1. Declare the input, then show the rule or process.
2. Commit one real state change at a time; unchanged modules remain still.
3. Results must be verifiable. Rewards, failures, timers, and confirmations need
   a real event source.
4. Faces, evidence, QR codes, sources, and readable text stay high resolution.
5. If the beat has no state change, keep clean A-roll—no scan lines, random
   glitch, or decorative game HUD.

Original primitive: `assets/design/original/pixel-state-lattice.svg`.

## Production gates

- `design validate` requires four unique grammar IDs and compares seven axes
  pairwise. Sharing more than one axis fails as a cosmetic reskin.
- `contracts validate` requires all 960 contracts to carry a complete matching
  grammar, with one signature per style and four signatures overall.
- Full-library QC checks render evidence, manifests, contracts, subject-head
  collision, contrast, forbidden black panels, and cross-style exact duplicates.
- Peak frames prove spatial composition only. Final video review still checks
  timing, pauses, cuts, sound, exit behavior, and fallback.

# Five-Style Editing Grammar Contract

The five styles share subject safety, caption legibility, font routing,
persistent-brand restraint, contrast, and audiovisual synchronization. They do
not share shot organization. Color, radius, halftone, pixel edges, dark fills,
or glass material alone never constitute a style change.

The machine-readable authority is
[`config/design-system/visual-languages.json`](../../config/design-system/visual-languages.json).
Every effect contract carries the matching `editingGrammarContract` and runtime
selection evidence.

| Style | Time unit | Spatial model | Primary transition | Sound | Fallback |
| --- | --- | --- | --- | --- | --- |
| Light Warm Overlay | Complete spoken thought | Margin note + negative space | Clean/match cut, local reveal | Quiet; one soft cue for a major note | Plain caption or clean cut |
| Spatial Light Path | Real relationship or route | World coordinates + depth | Occlusion, route continuation, focus rack | One directional phrase | Light Warm or clean cut |
| Humor Comic | Setup to callback | Main panel + reaction insert | Hard cut, freeze, panel snap | Silence plus one earned dry cue | Light Warm or caption |
| Pixel Editorial | Input to verified result | Integer grid + state register | Tile/state commit | Exact UI semantics only | Light Warm or clean cut |
| Dark Tech | Anomaly to verdict and recovery | Bounded aperture + evidence layers | Local isolation, luma reveal, verdict snap | One low diagnostic lock or resolve | Spatial for relations, Pixel for state, otherwise clean |

## Dark Tech: forensic reveal, not a black HUD

1. Establish a normally exposed baseline before isolating one real anomaly.
2. Local darkness may cover at most 42% of the frame. Retain at least 82% of
   subject luma and 90% of evidence luma.
3. Use one observation aperture, at most two evidence layers, and one verdict.
4. The camera stops before evidence becomes readable; hold the locked evidence
   for 0.9–1.8 seconds without ambient motion.
5. Ban full-frame black washes, generic cyberpunk HUDs, neon grids, data rain,
   continuous scans, random glitch, and ambient pulse.
6. Remove the verdict, restore clean context, and never darken an ordinary tech
   explanation merely for atmosphere.

Original primitive: `assets/design/original/diagnostic-aperture-grid.svg`.

## Production gates

- `design validate` requires five unique grammar IDs and compares seven axes
  pairwise; sharing more than one axis fails as a cosmetic reskin.
- `contracts validate` requires all 1,200 contracts to carry matching grammar,
  applicability, fallback, typography, and audiovisual contracts.
- Full-library QC checks 2,400 peak frames for cross-style exact duplicates,
  undeclared near-duplicates, subject collision, font bindings, black blocks,
  and material boundaries.
- The current report is `docs/generated/five-style-library-qc.json`. Peak frames
  prove spatial composition only; normal-speed final review still checks timing,
  pauses, cuts, sound, cleanup, and fallback.

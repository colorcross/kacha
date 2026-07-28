# Kacha Product Brand and Website System

This document governs the Kacha product identity across the official website,
GitHub, documentation, social cards, and future product UI. It is separate from
the runtime video design system in
[`VIDEO_DESIGN_SYSTEM_V1.md`](../VIDEO_DESIGN_SYSTEM_V1.md).

## Positioning

Kacha is a local-first professional AI video workflow skill. It coordinates
planning, fine cuts, audio, visual packaging, captions, incremental revision,
and quality checks through auditable, reproducible, fail-closed contracts.

Primary message:

> More than effects. Finish the workflow.

Kacha never presents a preview as a finished video, automated QC as human
approval, or AI assistance as one-click magic. The product signature is
“Built by 行者大灰”.

## Logo

The source of truth is `assets/brand/kacha-logo.png`. The scissors represent
selection and editing; the play/K geometry represents video and Kacha; the
orange dot is the active cut point and verified action.

- Do not redraw, distort, recolor, extrude, glow, or decorate the mark.
- Preserve clear space equal to at least twice the orange dot diameter.
- Use the mark without a wordmark below 48 px.
- Warm white is the default background.
- The current asset has no approved reversed version; CSS inversion is not an
  acceptable substitute.
- A viewport may crop the supplied whitespace while preserving the mark itself.

## Color tokens

| Token | Value | Role |
| --- | --- | --- |
| `paper` | `#F5F2EB` | warm page |
| `paper-bright` | `#FCFBF8` | elevated surface |
| `ink` | `#24272F` | primary text and dark actions |
| `graphite` | `#41454E` | logo-adjacent charcoal and secondary text |
| `steel` | `#727985` | labels and scales |
| `line` | `#D9D4CA` | borders and rules |
| `signal` | `#FB6B14` | primary action and cut point |
| `signal-red` | `#F42800` | small gradient endpoint only |
| `signal-gold` | `#FEAE5F` | highlight endpoint |
| `night` | `#191B21` | technical and terminal surfaces |
| `positive` | `#79D18A` | a real verified state |

Orange is a signal, not a wallpaper. Avoid purple AI gradients, neon glow,
decorative glassmorphism, or high-saturation technology clichés. `positive`
must never imply a check passed when it did not.

## Typography and layout

Use a condensed grotesk display face, a restrained humanist body face, and a
monospace face for commands and states. The CSS fallback stack is the runtime
source of truth. Titles are large and compressed; body copy has generous
leading and controlled line length.

The desktop grid uses a 1420–1520 px content width and a four-pixel spacing
base. Corners stay nearly square. Diagonal cut lines, timeline tracks,
waveforms, playheads, and QC nodes are the product's supporting visual
language.

## Website components

The site in `website/` uses:

- a bilingual brand lockup;
- a timeline hero that explains “workflow” visually;
- version-scoped proof metrics;
- capability cards and a six-step workflow;
- explicit local-first and human-review principles;
- an `OFF` Beauty v2 default state;
- a real, copyable installation command.

Every new component must have an information purpose, a mobile reflow, and no
ambiguous state or authorization claim.

## Motion and accessibility

Motion borrows from editing: a low-frequency signal-dot pulse, directional
underlines, restrained card lift, and short content transitions. Disable
non-essential motion under `prefers-reduced-motion`. Keep keyboard focus
visible, touch targets at least 38×38 px, WCAG AA text contrast, and redundant
state cues beyond color.

## Source assets and release checks

```text
assets/brand/kacha-logo.png
assets/brand/kacha-og.png
website/public/brand/kacha-logo.png
website/public/og.png
website/app/globals.css
website/app/site-content.ts
```

Before release, run website lint, typecheck, build, rendered-page tests, the
full Kacha regression suite, the installer test, and the secret scanner.
Review both language routes and keep all version counts synchronized.

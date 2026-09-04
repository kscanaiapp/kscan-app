# Live VTO Phase 3 — Visual Review

Section 19 deliverable: the human visual gate for Phase 3 (Visual Realism +
Hybrid Generative Bridge). Per the build plan's own rule, **the agent
cannot self-certify a visual gate** — this document records what was
rendered and how to judge it; the verdict field below stays `PENDING` until
a human program owner fills it in, exactly as `docs/vto-visual-verdicts.md`
already established for Phase 1-2.

```
LANDMARK:   Phase 3 realism/hybrid-bridge review package #1
SHA:        (the commit this branch is pushed at — see the PR)
FIXTURES:   7 static synthetic cases + 1 temporal synthetic sequence, 4
            synthetic garments (plain, logo/canary, light, dark)
REVIEWER:   (unfilled)
VERDICT:    PENDING
```

## What this evidence is, and is not

Identical discipline to Package #2 (`docs/vto-static-preview-review.md`):

- **SYNTHETIC/PRECOMPUTED — MECHANICS EVIDENCE ONLY.** Every person,
  garment, and semantic mask in `evidence/phase3-preview/` is authored
  arithmetic (see `kscan-live-vto/tools/render-phase3-review.js`), not a
  real photo and not real model output. No real person or retailer image
  was used anywhere in this pass.
- **No real segmentation, pose, or hair model ran.** Every semantic mask
  carries `SEMANTIC MASK: PRECOMPUTED — MODEL NOT VALIDATED`
  (`@kscan-live-vto/realism`'s `PRECOMPUTED_SEMANTIC_MASK_LABEL`), enforced
  by a contract assertion (`assertValidSemanticMaskFrame`), not just stated
  in prose.
- **Headless evaluation renderer**, same one Package #2 used — not the
  native rasterization baseline. See `docs/vto-phase3-native-blockers.md`
  for everything this package does not and cannot prove.
- This package **extends** Package #2's renderer and does not re-render or
  overwrite it: `evidence/static-preview/` is untouched, and its own PASS
  stands independently of whatever verdict this document receives.

## How to regenerate

```
cd kscan-live-vto
npm install
npm run build
node tools/render-phase3-review.js
```

Deterministic: same commit + same fixtures ⇒ byte-identical PNGs (the same
property Package #2 pins; not yet pinned by its own dedicated golden test in
this pass — see "Known gaps" below).

## Review cases

| Case | What it tests | Key files |
|---|---|---|
| 1 — Neutral pose, plain tee | Baseline: does P3 processing alone (no occlusion needed) look coherent? | `case-1-neutral-plain-tee-*` |
| 2 — Logo/text tee (canary) | Product fidelity: does the logo stay unmirrored and undistorted through P3 processing? | `case-2-logo-tee-canary-*` |
| 3 — Forearm crossing | Semantic occlusion: does one forearm correctly occlude the garment? | `case-3-forearm-crossing-*` |
| 4 — Both arms interacting with torso | Semantic occlusion, harder case: forearms + upper arms | `case-4-both-arms-torso-*` |
| 5 — Hair-over-shoulder | Hair foregrounding: does draped hair sit above the garment? | `case-5-hair-over-shoulder-*` |
| 6 — Mask instability/dropout | Temporal stability: does a dropout avoid a visible pop, and recover smoothly? | `case-6-mask-instability-dropout-contact-sheet.png` |
| 7 — Dark scene / light garment | Lighting coherence, and: does a light garment stay visibly clean under shadow/gamma? | `case-7-dark-scene-light-garment-*` |
| 8 — Bright scene / dark garment | Lighting coherence, the opposite mismatch | `case-8-bright-scene-dark-garment-*` |

Each static case (1-5, 7-8) ships: `00-person-fixture`, `01-static-baseline`
(no Phase 3 involvement — what Package #2's pipeline alone would already
produce), `02-occlusion-only`, `04-lighting-adjusted`, `06-final-p3-composite`
(the full P3 stack: occlusion + gamma/exposure + contact shadow),
`07-diagnostic-overlay`, and a `manifest.json` recording the exact
adjustments applied and this pass's own diagnostic metrics. (`03` and `05`
are recorded in the manifest as pixel-identical to `02`/`06` respectively,
with the reason stated, rather than duplicated as separate files — see the
manifest's `images` field for each case.) Case 6 ships a single ordered
contact-sheet image (green border = trusted/live frame, amber = held, red =
failed-safe) plus its own manifest, per Section 17's temporal-case
allowance.

## What to judge

- **Occlusion plausibility** (cases 3, 4): does the forearm/upper-arm
  region read as genuinely in front of the garment, not just a flat patch?
- **Edge integration**: does the garment edge look intentional rather than
  cut out? (Compare `01-static-baseline` against `06-final-p3-composite` —
  Phase 3 adds no new edge treatment beyond Package #2's existing
  supersampled compositing; judge whether that remains sufficient.)
- **Neck/collar integration** (all cases, most visible on case 2): does the
  collar shadow read as a plausible contact cue, or as a visible defect?
- **Lighting coherence** (cases 7, 8 especially): does the garment look like
  it belongs in the scene after gamma/exposure adjustment, compared to the
  unadjusted baseline?
- **Product fidelity** (case 2 primarily): is the logo legible, unmirrored,
  and undistorted? Does the garment's color read as the same product before
  and after Phase 3 processing?
- **Overall reduction in sticker appearance**: side-by-side,
  `01-static-baseline` vs `06-final-p3-composite` — does the final composite
  look materially less pasted-on?

## What NOT to judge here

Per Section 19: live tracking quality, device FPS, true segmentation
accuracy, cloth physics, physical fit. None of this evidence speaks to any
of those — see `docs/vto-phase3-native-blockers.md`.

## Disclosed finding — not resolved by an automated threshold

Case 8 (bright scene / dark garment)'s automated color-fidelity check
(`preservesChannelBrightness` at 0.8, `@kscan-live-vto/realism-preview`)
reports `false` at its sampled reference pixel: combined gamma/exposure +
contact-shadow darkening on an already-dark garment under a bright-scene
correction pushes at least one channel below the 80%-of-original bound that
check uses. This is recorded here rather than silently passed or
threshold-tuned away, per Section 18's "do not invent quality thresholds
merely to create a PASS" — an 80% ratio bound is more forgiving for a light
garment (where "dirtying" is the visible failure mode Section 14 names)
than for an already-dark one (where the same absolute darkening is a larger
relative change but may not read as a defect at all to a human viewer).
**This is exactly the kind of case a human reviewer, not an automated
metric, should judge** — see `case-8-bright-scene-dark-garment-manifest.json`
`productFidelity` field for the exact sampled values.

## Verdict

```
VERDICT:               PENDING
ACCEPTED LIMITATIONS:  (to be filled in by the reviewer)
REQUIRED CHANGES:      (to be filled in by the reviewer)
NOTES:                 See "Disclosed finding" above for one specific item
                       this review should weigh explicitly.
```

A PASS here licenses continued P3-A work and preparing for P3-B once a
native-capable environment exists. It does not certify photorealism, does
not certify device rendering, and does not authorize any change to
`CURRENT_GENERATIVE_VTO_AUTHORITY` or production/staging state.

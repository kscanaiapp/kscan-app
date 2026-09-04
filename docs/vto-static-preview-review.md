# Live VTO — Static Preview Visual Review Package #1

**Human verdict: PENDING.** No human has reviewed this. Nothing below may be
read as a PASS. Section 19's rubric is reproduced here with the evidence a
reviewer needs; the verdict line at the bottom is to be filled in by a person
and recorded in `docs/vto-visual-verdicts.md`.

```
BRANCH:      claude/kscan-live-vto-phase1-phase2-lcqyg9
RENDERER:    @kscan-live-vto/static-renderer 0.1.0
DEFORMATION: affine-mls@asset-pipeline-0.1.0
EVIDENCE:    kscan-live-vto/evidence/static-preview/ (PNG + JSON sidecar per case)
REGENERATE:  cd kscan-live-vto && npm run build && node tools/render-static-review.js
```

## What this evidence is, and is not

- **SYNTHETIC — NOT HUMAN.** Every person fixture is procedurally drawn.
  *This validates rendering mechanics given known BodyFrames. It does not
  validate human pose perception, body diversity, or production segmentation
  quality.*
- **No pose model ran.** The BodyFrame is an *input* emitted by the fixture
  generator, which knows where every landmark is because it drew them.
- **SEGMENTATION ENGINE: NOT YET IMPLEMENTED — PRECOMPUTED TEST MASK.** Case 5
  proves the *compositor* can express correct occlusion. It says nothing about
  automatic segmentation.
- **Headless evaluation renderer.** Establishes semantic golden behavior
  (anchoring, geometry, deformation, layering, mirroring, asset
  interpretation). Its pixels are **not** the native rasterization baseline —
  native goldens must be established on physical devices.
- **MECHANICS EVIDENCE ONLY** on the garment side. Both garments are
  synthetic. **REAL CATALOG ASSET VIABILITY: BLOCKED — FIXTURE CORPUS
  REQUIRED.**

## Findings before the rubric — the stop gate did its job

The first render of this pass **refused 5 of 6 cases** at the rigid stop gate
with `garment_largely_outside_torso`, and that refusal was correct. It exposed
two genuine geometry defects that no amount of deformation could have fixed:

| # | Defect | Measured | Fix |
|---|---|---|---|
| 1 | Garment silhouette disproportionately long | seam→hem was **2.625** shoulder-spans; the body's shoulder→hem target is **1.18** | Fixture re-proportioned to **1.348**; pinned by a test against `GARMENT_LENGTH_RATIO` |
| 2 | Hem target too high on the body | `HIP_LENGTH_HEM_DROP` 0.12 put the hem 12% of a torso below the hip *joint* | Raised to **0.28** — a hip-length tee hangs about a quarter-torso below the hip landmark |

A third defect was caught by *looking at the image*, not by any metric, after
the gate passed:

| # | Defect | Measured | Fix |
|---|---|---|---|
| 3 | Neck opening 58% of seam span, closed with a single apex vertex — rendered as a deep V exposing most of the chest; sleeves extended 1.1 seam-spans past the seam (sleeve span 2.17× shoulder span) | visual | Crew neck at ~0.35 seam-span opening as a shallow arc; short sleeve at ~0.31 seam-spans |

This is the intended division of labor: the gate catches gross semantic
errors, metrics catch geometric ones, and a human catches the rest.

## Case metrics

Control-point residual is **0.00 px in every case** — affine MLS interpolates
its control points exactly, so this confirms the warp honors its anchors.
No case shows any mesh foldover.

| Case | Gate | Rigid scale | Torso coverage | Jacobian [min, max] (median) | Logo aspect (h / v) |
|---|---|---|---|---|---|
| 1 — neutral + plain tee | PASS | 1.120 | 98.7% | [0.25, 1.84] (1.17) | — |
| 2 — logo tee (canary) | PASS | 1.120 | 98.7% | [0.25, 1.84] (1.17) | **1.298** (0.94 / 0.72) |
| 3a — narrow torso | PASS | 1.120 | 98.6% | [0.23, 1.58] (0.99) | **0.932** (0.73 / 0.78) |
| 3b — broad torso | PASS | 1.120 | 98.6% | [0.22, 2.16] (1.38) | **1.746** (1.17 / 0.67) |
| 4 — arms away | PASS | 1.120 | 99.3% | [0.54, 2.11] (1.34) | — |
| 5 — forearm crossing | PASS | 1.120 | 98.7% | [0.22, 1.81] (1.16) | — |

**Reading the "spill" metric (32–40% across cases): not a defect.** The
coverage denominator is the shoulder/hip quad, which by construction excludes
the sleeves and the hem drop — so roughly a third of garment pixels landing
outside it is structural. It is reported for completeness, not as a finding.

**Lighting, case 1** (all inside the experimental guardrails, nothing clamped):
scene mean luminance 0.362, contrast 0.038, colour cast r0.90/g0.99/b1.11 →
luminance gain **0.945**, contrast gain **0.929**, hue shift **−5.9°**,
saturation **0.956**. Every case ships an unadjusted counterpart
(`*-04-preview-unadjusted.png`) so the adjustment's effect on product colour
is directly inspectable.

**Occlusion, case 5:** 13,938 pixels where the real forearm correctly
overrode garment pixels; the control and intended images differ substantially.

## Open defects a reviewer should judge

These are visible in the rendered images and are **not** fixed:

1. **Vertical compression of chest content.** The logo's vertical scale is
   0.72 / 0.78 / 0.67 across the three body types — consistently squashed,
   while horizontal scale tracks body width as it should (0.94 / 0.73 / 1.17).
   Hypothesis: the flat-lay asset's sleeve control points sit diagonally
   outboard of the shoulder, while the arms-at-side targets sit almost
   directly below it, so the warp compresses the chest region vertically to
   reconcile them. This is a control-point *weighting//topology* question, not
   an argument to swap deformation algorithms — Section 13 reserves that for
   evidence that affine MLS itself fails, and it has not.
2. **Hem notch.** The bottom edge dips in the middle in every case, because
   the `waist` control point's target sits above the hem line and drags the
   mid-hem upward. Candidate fixes: give `waist` a hem-relative target, or
   exclude it from the warp below the torso band.
3. **Shoulder-cap coverage.** The person's shoulder geometry pokes above the
   garment's shoulder line, leaving visible slivers of their existing
   clothing at both shoulder tops.
4. **Hard garment edge.** Feathering is applied to the foreground mask only;
   the garment silhouette itself composites with a hard edge, which reads as
   "sticker" at the boundary.
5. **Broad-torso fixture is deliberately extreme** (torso height 0.84× shoulder
   span). It is a stress case, not a typical body, and its 1.746 logo aspect
   should be read that way.

## Section 19 rubric

Judge: attachment, scale, orientation, deformation, mirroring, layering,
occlusion semantics, edge composition.

Do **not** judge as Phase 1 blockers: skin realism, full lighting realism,
actual MediaPipe tracking, real segmentation quality (fixture masks are in
use), true fabric drape, physical fit.

### CASE 1 — NEUTRAL + PLAIN TEE
`case-1-neutral-plain-tee-03-preview-lighting-adjusted.png`
Expected: neckline near neck base; shoulders near body shoulder anchors; hem
plausibly located; no inversion/foldover; reasonable garment scale.

### CASE 2 — LOGO TEE (CANARY)
`case-2-logo-tee-canary-03-preview-lighting-adjusted.png`
Expected: logo readable; not mirrored; upright; not grossly stretched;
approximately chest-centred.
Machine check: `mirrored: false`, shear indicator 0.004, aspect change 1.298.

### CASE 3 — BODY-PROPORTION VARIATION
`case-3a-narrow-torso-*`, `case-3b-broad-torso-*`
Expected: garment width responds to body width; garment does not float away;
sleeves remain connected.

### CASE 4 — ARMS AWAY
`case-4-arms-away-03-preview-lighting-adjusted.png`
Expected: shoulder/sleeve geometry remains coherent; no severe mesh tearing.

### CASE 5 — FOREARM CROSSING
`case-5-forearm-crossing-03-preview-lighting-adjusted.png` (intended) vs
`case-5-forearm-crossing-05-occlusion-control-wrong-layer-order.png` (control).
Expected: arm appears in front of garment; edge follows the provided
foreground mask; garment does not bleed significantly across the foreground
limb. The control image shows the same composite with the foreground layer
omitted — the arms disappear behind the garment — so the pair isolates exactly
what the foreground layer contributes.

### Global
Correct layer order; no accidental mirroring; no obvious mesh inversion; no
extreme alpha halo; lighting change remains restrained.

### Diagnostic overlays
`*-02-rigid-overlay.png` annotates every case with teal body anchors, amber
garment control points, a white line from each control point to the semantic
target it aimed at, and the gate's own measurements burned into the image.

## Verdict

```
LANDMARK:              Static preview review package #1 (rigid + deformation +
                       compositing + occlusion + lighting)
SHA:                   (fill in at review time)
DATE:
FIXTURES:              6 synthetic cases, 2 synthetic garments
REVIEWER:
VERDICT:               PASS | FAIL | HOLD        <-- not yet given
PRIMARY BUCKET IF FAIL: ASSET | ANCHORS | DEFORMATION | COMPOSITING | LIGHTING | HARNESS
ACCEPTED LIMITATIONS:
REQUIRED CHANGES:
NOTES:
```

PASS here would mean *semantic behavior is sound enough to continue*. It would
not mean photorealistic, and it would not mean customer-ready.

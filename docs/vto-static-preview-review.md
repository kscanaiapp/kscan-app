# Live VTO — Static Preview Visual Review Package #2

**Human verdict: PENDING.** No human has reviewed this. Nothing below may be
read as a PASS.

This package responds to the recorded **FAIL — DEFORMATION** verdict on
package #1 at `ee298587` (see `docs/vto-visual-verdicts.md`). Four defects
were named; all four were repaired, and the same six cases were re-rendered.
Package #1's artifacts are retained beside the new ones for direct comparison.

```
BRANCH:      claude/kscan-live-vto-phase1-phase2-lcqyg9
RENDERER:    @kscan-live-vto/static-renderer 0.2.0  (was 0.1.0)
DEFORMATION: affine-mls@asset-pipeline-0.1.0  — UNCHANGED
BEFORE:      kscan-live-vto/evidence/static-preview-v1/
AFTER:       kscan-live-vto/evidence/static-preview/
REGENERATE:  cd kscan-live-vto && npm run build && node tools/render-static-review.js
```

**Affine MLS was not modified, and not replaced.** The deformation function in
`@kscan-live-vto/asset-pipeline` is byte-identical to package #1. Every repair
below is in the control-point/target *topology* — what the warp is asked to
do, not how it does it. Post-repair evidence gives no reason to suspect the
algorithm: control-point residual is 0.00px, and mesh foldover is zero across
all six cases.

## What this evidence is, and is not

Unchanged from package #1, and still binding:

- **SYNTHETIC — NOT HUMAN.** *This validates rendering mechanics given known
  BodyFrames. It does not validate human pose perception, body diversity, or
  production segmentation quality.*
- **No pose model ran.** BodyFrame is an input from the fixture generator.
- **SEGMENTATION ENGINE: NOT YET IMPLEMENTED — PRECOMPUTED TEST MASK.**
- **Headless evaluation renderer** — not the native rasterization baseline.
- **MECHANICS EVIDENCE ONLY** for garments. **REAL CATALOG ASSET VIABILITY:
  BLOCKED — FIXTURE CORPUS REQUIRED.**

## The four defects

### DEFECT 1 — vertical chest/logo compression → REPAIRED

**Root cause.** Targets were derived from whichever body landmark had a
similar-sounding name. The fixture's `waist` control point sits at 76% of the
*garment's* shoulder→hem length; the body's `waistCenter` landmark sits at 82%
of *torso height*, well above the hem. Pinning one to the other dragged the
garment's middle upward and compressed everything above it.

**Repair.** `computeControlPointTargets` now builds a garment frame in body
space — origin at the shoulder-seam midpoint, down-axis toward the hem
midpoint, width across the shoulder line — and maps each control point using
its *own* normalized coordinates from the manifest. No control point is pinned
to a same-named body part any more.

Three supporting changes fell out of the same analysis:

- The sleeve target used to sit at a fixed fraction of the way to the elbow,
  which stretched the sleeve by ~1.24× on the neutral fixture and fed that
  stretch back into the chest. It now keeps its authored length and only
  rotates onto the arm.
- Chest width is held at full shoulder width above `TORSO_WIDTH_HOLD_T` and
  tapers only below it. Tapering from t=0 compressed chest content
  horizontally — the other half of the same defect.
- `MAX_LONGITUDINAL_ASPECT_DEVIATION` (0.15) bounds how far the garment's
  longitudinal scale may diverge from its lateral scale. Forcing the hem onto
  `hips + drop` for every body meant a long torso stretched the garment
  without limit (1.50× vs 1.06× lateral on the narrow fixture). Past the
  bound the garment keeps its own proportions and the hem sits where its size
  puts it — slightly short on a long torso, slightly long on a short one,
  which is what real garments do.

**Result.** Neutral logo aspect **1.298 → 1.012**. Stress bodies **1.746 →
1.155** (broad) and **0.932 → 0.864** (narrow).

### DEFECT 2 — centre hem notch → REPAIRED

Same root cause as Defect 1: the raised `waist` target pulled the middle of
the hem up between the two corner hem points. With the waist target on the
garment's own longitudinal axis the notch is gone. A test now measures the
rendered silhouette directly — lowest garment pixel at the centre column vs
the quarter columns — and fails if the centre sits more than 6% of a shoulder
span high.

### DEFECT 3 — shoulder-cap undercoverage → REPAIRED

`leftShoulder`/`rightShoulder` are joint centres, which sit *inside* the body,
while a shirt's seam lies on top of the deltoid. Placing the seam exactly on
the joint guaranteed a bare cap. Added `SHOULDER_SEAM_RISE` (0.09 of shoulder
span) alongside the existing outset, raised to 0.08. A test probes above each
joint and fails if the garment does not cover it.

### DEFECT 4 — hard garment-edge compositing → REPAIRED

The garment layer is now rasterized at **2× and box-downsampled in
premultiplied alpha** (`GARMENT_SUPERSAMPLE`), giving coverage-based edge
alpha. This is deliberately *not* a blur: Section 15 forbids burying edge
quality under blur, and blurring would also grow the silhouette outward.
Supersampling adds no softness of its own. A test asserts the layer contains
partial-alpha pixels rather than a binary silhouette.

## Before / after

| Case | Torso coverage | Jacobian min | Foldover | Logo aspect (h / v) |
|---|---|---|---|---|
| 1 — neutral + plain tee | 98.7% → **100.0%** | 0.246 → **0.783** | 0 → 0 | — |
| 2 — logo tee (canary) | 98.7% → **100.0%** | 0.246 → **0.783** | 0 → 0 | 1.298 → **1.012** (1.376 / 1.359) |
| 3a — narrow torso | 98.6% → **100.0%** | 0.235 → **0.714** | 0 → 0 | 0.932 → **0.864** (1.053 / 1.219) |
| 3b — broad torso | 98.6% → **100.0%** | 0.216 → **0.609** | 0 → 0 | 1.746 → **1.155** (1.740 / 1.506) |
| 4 — arms away | 99.3% → **100.0%** | 0.541 → **1.139** | 0 → 0 | — |
| 5 — forearm crossing | 98.7% → **100.0%** | 0.218 → **0.602** | 0 → 0 | — |

Control-point residual remains **0.00 px** in every case. Mirroring remains
correct (`mirrored: false`, shear 0.004). Jacobian minima roughly tripled —
the warp is doing far less local compression than it was.

## Two mistakes made and corrected during this repair

Recorded because the process is part of the evidence:

1. **Adding the armpit control point reintroduced foldover** (4–8 inverted
   cells across four cases). With arms at the sides, the articulated sleeve
   target landed *inboard* of the armpit target while sitting *outboard* of it
   in the texture — an inverted ordering. Fixed by offsetting the sleeve target
   outboard by an approximate upper-arm half-width
   (`UPPER_ARM_HALF_WIDTH`, explicitly labelled an approximation because
   BodyFrame carries no limb width). A test now pins foldover to zero across
   all five body/pose variants.
2. **The first v2 render made the garment a poncho.** Holding full chest width
   exposed that the fixture's body was 1.33 shoulder-seam-spans wide, which
   the old body-derived side targets had been hiding by pulling it in. Caught
   by looking at the image, not by any metric. The fixture body was narrowed to
   ~1.1 seam-spans, which is a real tee's proportion.

## Still open — for the reviewer to weigh

1. **Armpit gap.** With arms away from the body (case 4) and crossed (case 5),
   a wedge of the person's own clothing shows between the sleeve underside and
   the torso. The garment has no gusset geometry and the frame does not model
   the sleeve/body join as a surface.
2. **Residual aspect deviation on stress bodies** — 1.155 broad, 0.864 narrow.
   Bounded and much reduced, but not eliminated. Some is the intended bound;
   a few points come from local MLS blending near the sleeve.
3. **The broad fixture is deliberately extreme** (torso 0.84× shoulder span,
   outside a realistic human range). It is a stress case, not a typical body.
4. **The tee reads as slightly boxy** through the lower torso — the taper
   below `TORSO_WIDTH_HOLD_T` is linear and does not model drape.

## Section 19 rubric

Judge: attachment, scale, orientation, deformation, mirroring, layering,
occlusion semantics, edge composition.

Do **not** judge as Phase 1 blockers: skin realism, full lighting realism,
actual MediaPipe tracking, real segmentation quality, true fabric drape,
physical fit.

| Case | Files |
|---|---|
| 1 — neutral + plain tee | `case-1-neutral-plain-tee-03-preview-lighting-adjusted.png` |
| 2 — logo tee (canary) | `case-2-logo-tee-canary-03-preview-lighting-adjusted.png` |
| 3 — body proportion | `case-3a-narrow-torso-*`, `case-3b-broad-torso-*` |
| 4 — arms away | `case-4-arms-away-03-preview-lighting-adjusted.png` |
| 5 — forearm crossing | `case-5-forearm-crossing-03-preview-lighting-adjusted.png` (intended) vs `…-05-occlusion-control-wrong-layer-order.png` (control) |

Every case also ships `-01-rigid`, `-02-rigid-overlay` (teal body anchors,
amber garment control points, white line to each semantic target, gate
measurements burned in), `-04-preview-unadjusted` (lighting comparison), and a
`-manifest.json` sidecar. The identically-named files under
`evidence/static-preview-v1/` are package #1's.

## Verdict

```
LANDMARK:              Static preview review package #2 (topology repair)
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

PASS would mean semantic behavior is sound enough to continue. It would not
mean photorealistic, and it would not mean customer-ready.

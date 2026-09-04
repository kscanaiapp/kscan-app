# Live VTO Phase 3-B — P3-A → Native-Renderer Conformance Specification

Amendment Section 5-6 deliverable: "The P3-A Node renderer is the
deterministic CI/reference renderer. It is NOT the production mobile
renderer... Create an explicit native-renderer contract whose inputs and
expected semantic behavior correspond to the P3-A renderer."

This document is a specification. **No native renderer exists yet** (Hard
Build Gate failed this session — see
`docs/vto-phase3b-native-build-handoff.md`), so nothing here is verified
against a GPU implementation. It exists so a future native-renderer author
has exact numbers to conform to instead of having to reverse-engineer them
from the Node source.

## Reference oracle

```
REFERENCE:  @kscan-live-vto/static-renderer + @kscan-live-vto/realism-preview
VERSION:    RENDERER_VERSION = '0.2.0' (static-renderer), realism/realism-preview 0.1.0
STATUS:     Human-PASSed (Package #2, docs/vto-visual-verdicts.md entry 2) for
            attachment/deformation/edge/mirroring/occlusion-semantics/lighting-restraint.
            Human verdict PENDING (docs/vto-phase3-visual-review.md) for the P3-A
            realism additions this document also covers.
```

A native renderer's job is to reproduce this reference's **semantic
behavior** at real-time frame rates on real hardware — not to share code
with it. "Do not attempt to embed Node.js image-processing code into the
native frame loop" (amendment Section 5) is absolute; every number below
must be reimplemented in the native GPU pipeline, then validated against
the reference's own output on the same input (see the cross-runtime
fixture ledger in `docs/vto-phase3b-native-build-handoff.md`).

## 1. Garment attachment

**Reference**: `packages/static-renderer/src/attachment.ts` +
`packages/asset-pipeline/src/affineMlsDeformation.ts` (`asset-pipeline`
package, unmodified since Package #1 — byte-identical, per
`docs/vto-static-preview-review.md`).

| Property | Value | Source |
|---|---|---|
| Deformation algorithm | Affine MLS (moving least squares), control points interpolated exactly | `DEFORMATION_ALGORITHM = 'affine-mls@asset-pipeline-0.1.0'` |
| Control-point target derivation | Garment-local frame (origin at shoulder-seam midpoint, down-axis toward hem midpoint), NOT pinned to same-named body landmarks | `computeControlPointTargets` |
| Max longitudinal aspect deviation | 0.15 | `attachment.ts` `MAX_LONGITUDINAL_ASPECT_DEVIATION` |
| Shoulder seam rise | 0.09 × shoulder span | `SHOULDER_SEAM_RISE` |
| Rigid stop gate | Must run BEFORE deformation; catches left/right inversion, upside-down placement, gross scale error, neckline misplacement, garment off-torso | `evaluateRigidGate` |
| Control-point residual (neutral fixture) | 0.00 px | Package #2 evidence |

**Native conformance requirement**: a native implementation MAY use a
different deformation algorithm (e.g. a GPU mesh-warp shader) but MUST
reproduce this table's qualitative properties (garment-local target frame,
rigid-gate-before-deformation ordering) — reproducing the exact MLS
mathematics is not required, reproducing the placement semantics is.

## 2. Semantic occlusion + hair foregrounding

**Reference**: `packages/realism/src/semanticOcclusion.ts`.

```
OCCLUSION_PAINT_ORDER (back to front): BACKGROUND, EXISTING_CLOTHING, GARMENT, BODY
SEMANTIC_REGIONS: forearm_hand, upper_arm, neck_chin, hair, background
REGION_LAYER: every non-background region -> BODY
```

**Native conformance requirement**: whatever produces a per-pixel or
per-region occlusion decision natively (a segmentation model's output mask,
a depth estimate, or a replay fixture) must be composited in this exact
paint order. `combineSemanticScene`'s per-texel-maximum combination rule
(when multiple regions claim a texel, the highest coverage wins) is the
reference behavior for multi-region overlap.

## 3. Edge integration

**Reference**: `packages/static-renderer/src/raster.ts#downsample` +
`renderPreview.ts`'s `GARMENT_SUPERSAMPLE = 2`.

```
Mechanism: rasterize at 2x, box-downsample in PREMULTIPLIED alpha.
Forbidden: any Gaussian/box blur applied to hide segmentation quality;
           silhouette growth; halo.
```

**Native conformance requirement**: a native GPU path should achieve
equivalent anti-aliased, coverage-correct edges — typically supersampled
rendering + a resolve step, or MSAA with premultiplied-alpha blending. The
forbidden-list is the binding constraint, not the specific mechanism:
`@kscan-live-vto/realism-preview`'s `opaqueBoundingBox`/`opaquePixelCount`
diagnostics (Section 12) are the native implementation's own regression
check once it exists — no silhouette growth, no halo, measured the same way.

## 4. Lighting adjustment

**Reference**: `packages/static-renderer/src/lighting.ts` (Phase 1-2, gain)
+ `packages/realism-preview/src/gammaExposure.ts` (Phase 3, gamma).

```
EXISTING GAIN (linear, HSL-space), LIGHTING_GUARDRAILS:
  maxHueShiftDegrees: 15
  maxSaturationDelta: 0.2
  minLuminanceGain: 0.85,  maxLuminanceGain: 1.15
  minContrastGain: 0.9,    maxContrastGain: 1.1
  Correction strength: PARTIAL (an explicit fraction toward the scene estimate,
    not a full match -- see computeLightingAdjustment)

NEW GAMMA/EXPOSURE (power curve, out = in^gamma), GAMMA_EXPOSURE_GUARDRAILS:
  minGamma: 0.88,  maxGamma: 1.14
  Applied AFTER the existing gain, on non-transparent pixels only, same
  convention as applyLightingAdjustment.
```

**Native conformance requirement**: both adjustments operate on the garment
layer only (never the person/background), preserve an unadjusted comparison
render (`unadjustedImage`), and record every applied value — a native
renderer must expose the equivalent of `PreviewManifest.lightingParameters`
plus this phase's `GammaExposureAdjustment` in whatever telemetry/debug
surface it has, not silently apply and discard them.

## 5. Contact/collar shadow cues

**Reference**: `packages/realism-preview/src/contactShadow.ts`.

```
SHADOW_GUARDRAILS:
  maxIntensity: 0.14 (never darken more than 14% of a pixel's own luminance)
  featherFraction: 0.4
Mechanism: MULTIPLICATIVE darkening only, on the COMPOSITED image, never
  the garment layer's own alpha. Never paints onto a fully transparent pixel.
```

**Native conformance requirement**: additive gray/black overlays are
explicitly forbidden (this is what "dirties" a light garment — see Section
15 below); a native implementation must darken existing pixel color
multiplicatively, bounded identically.

## 6. Product fidelity

**Reference**: `packages/static-renderer/src/metrics.ts#logoDistortion` +
`packages/realism-preview/src/productFidelity.ts`.

```
Logo geometry (existing, Package #2):
  mirrored must be exactly false
  aspectRatioChange within ±0.06 of 1.0 on the neutral fixture,
                          ±0.21 on narrow/broad stress fixtures
                          (MAX_LONGITUDINAL_ASPECT_DEVIATION 0.15 + 0.06 render-noise margin)

Color fidelity (new, Phase 3):
  hueDeltaDegrees -- reported, not threshold-gated in this program
  preservesChannelBrightness -- reported at a chosen ratio bound; Case 8's
    disclosed finding (docs/vto-phase3-visual-review.md) shows this ratio
    is more forgiving for light garments than dark ones and should not be
    treated as a universal pass/fail gate without human calibration.
```

**Native conformance requirement**: a native renderer must be able to
report the same measurements (or equivalents) so a future review corpus
generated FROM a native/device build can be compared against
`evidence/phase3-preview/`'s Node-rendered numbers using the same metric
definitions — not eyeballed equivalence.

## 7. What native conformance does NOT require

- Pixel-identical output to the Node renderer. GPU filtering, color
  management, and premultiplication legitimately differ — Phase 1-2's own
  `docs/vto-native-device-handoff.md` §1 already states this ("Do not treat
  the headless PNGs as native golden images").
- Reproducing `@kscan-live-vto/static-renderer`'s exact function-level
  architecture (rigid stage / deformed stage split, `RenderInput` shape,
  etc.) — those are Node-package engineering conveniences, not semantic
  requirements.
- Any P4/motion-video/3D capability — out of scope for this document and
  for P3-B entirely (amendment Sections 37-39 / original Sections 37-39).

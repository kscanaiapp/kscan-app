# Live VTO Native Runtime N1 — Cross-Runtime Conformance

The N1-B / N1-C conformance record: how native geometry is compared against
the P3-A reference oracle, what was measured, and what is frozen.

Regenerate everything in this document with:

```bash
cd android && ./gradlew :kscan-live-vto-native:testDebugUnitTest
```

```bash
node modules/kscan-live-vto-native/tools/run-reference-oracle.mjs --reference <path-to>/kscan-live-vto
```

```bash
node modules/kscan-live-vto-native/tools/compare-conformance.mjs
```

## What is being compared

**Geometry, numerically, before rasterization** — not screenshots
(amendment D8). `LiveVtoGeometryPipeline.compute` is the single entry point
that turns `(garment manifest, BodyFrame)` into an immutable
`GeometrySnapshot`, and it is the same call the diagnostic render view
draws from. A snapshot therefore cannot describe state the renderer did not
actually receive.

The geometry stack has **zero Android dependencies** (`Vec2` instead of
`PointF`, `LiveVtoJson` instead of `org.json`), so the whole pipeline runs
in a plain JVM unit test. That is what makes this measurement repeatable and
independent of emulator health, which the mission requires it to be.

## Reference provenance (amendment D5)

The authority is the **compiled** reference implementation, not its `.d.ts`,
comments, or documentation — N1-ENV-006 is the concrete argument for why.

| | |
|---|---|
| Reference checkout | `kscan-live-vto` @ `266ab1a8538ed73b91a50e58f7089ae41b784c2b` |
| Reference working tree | clean (`git status --porcelain` empty for `packages/static-renderer`) |
| `attachment.ts` blob | `3149a5e74004becf74371d3ff9b5945d6165f260` |
| `attachment.js` blob (executed) | `72fbc01303a56134e3837b563fa14feca71607e6` |
| Native implementation | `modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoGarmentAttachment.kt` |

Ported algorithms, each read from `dist/attachment.js`:
`extractBodyAnchors`, `computeControlPointTargets` (including the
hip-derived hem width, the shoulder-first axis order, and the sleeve
fallback direction), `fitRigidPlacement`, `applySimilarity`,
`evaluateRigidGate`.

The reference package is a **disjoint, unmerged git history**. It is never
imported by app or module code — `scripts/check-vto-live-integration-scope.js`
forbids that mechanically. The oracle runner reaches it only as an
out-of-tree measurement tool, by explicit path.

> **REFERENCE CONFORMANCE: VALIDATED.**
> **REFERENCE VISUAL CORRECTNESS: NOT YET HUMAN-APPROVED.**
>
> Amendment D4. The P3-A visual verdict is still PENDING on the program
> ledger. Numerical agreement with the oracle proves the native runtime
> computes what the reference computes. It does not prove the reference is
> visually right, and nothing in this document should be read as claiming
> it does. N1-ENV-008 below is a concrete demonstration that the reference
> is not automatically correct.

## Golden BodyFrame set

`modules/kscan-live-vto-native/goldens/bodyframes.json` — committed,
machine-readable, and read by **both** runtimes, so a typo cannot present
itself as a conformance divergence.

Every case is a named geometric perturbation (rotation about the torso
centre, axis scaling, landmark removal) of the research fixture generator's
own base standing pose, not hand-authored coordinates.

13 valid poses: `neutral-frontal`, `arms-slightly-out`,
`left-shoulder-raised`, `right-shoulder-raised`, `torso-rotated-left`,
`torso-rotated-right`, `narrow-torso`, `wide-torso`, `short-torso`,
`long-torso`, `partial-wrist`, `missing-elbows`, `missing-left-elbow`.

8 refusal cases: `missing-left-shoulder`, `missing-right-shoulder`,
`missing-left-hip`, `missing-hips`, `degenerate-shoulders`, `nan-shoulder`,
`infinite-hip`, `impossible-coordinate`.

JSON has no literal for NaN or Infinity, so the golden file encodes them as
strings and declares that encoding in its own `nonFiniteEncoding` field. A
golden set that could not express a NaN could not prove a NaN is rejected.

### Refusal layering

A case declares which layer is responsible, and the test asserts on that
layer specifically:

- **`expectedFailure`** — the pipeline must refuse before any geometry is
  produced.
- **`expectedGateFindings`** — the geometry is finite and computable but
  semantically impossible; the *rigid gate* must reject it and withhold the
  mesh.

`impossible-coordinate` is the second kind, and its expectation was
**measured, not predicted**. It was initially written expecting
`gross_scale_error`; the gate actually reports
`garment_largely_outside_torso`. That is correct and worth recording:
`gross_scale_error` is close to unreachable for a placement fitted from this
pipeline's own targets, because the similarity is fitted so the garment's
shoulders land exactly on targets whose span is always
`shoulderSpan * (1 + 2*SHOULDER_SEAM_OUTSET)` = 1.16×. The scale check
exists to catch a placement that came from somewhere else; here the centroid
check is the one doing real work.

## Asymmetric fixture (amendment D6)

`android/src/main/assets/n1c-asym-fixture/` carries three
non-mirror-symmetric marks: a block on the wearer's own left chest, a
letter "L" (a glyph with no mirror symmetry), and a stripe down the
wearer's own right side only.

Verified property: the set of pixels it changes relative to the source
texture has **zero overlap with its own horizontal mirror** (1763 changed
pixels, 1158 left / 605 right, mirror overlap 0). No horizontal flip,
left/right swap, or 180° rotation maps this fixture onto itself.

Silhouette, alpha mask, control points and mesh are byte-identical to the
governed SYNTHETIC source asset `081350cef7f5c83e05c3e6c1`, so geometry is
directly comparable between the two fixtures and only orientation differs.

Orientation is additionally asserted **numerically**, not just visually:
`leftRightOrientationIsPreservedAcrossEveryGolden` requires the garment's
shoulder and hem ordering to follow the body's for every golden and both
fixtures, and `raisedShoulderAsymmetryLandsOnTheRaisedSide` requires the
raised-shoulder pair to lift the correct side.

## Measured results

42 (fixture, case) pairs · 308 control points · 2 fixtures · 21 poses.

| Measurement | Median | Max |
|---|---|---|
| Control-point delta | 2.68e-5 px | **5.63e-3 px** |
| Scale delta | 1.85e-7 | 2.94e-6 |
| Rotation delta | 0 rad | 6.31e-8 rad |
| Bounds delta | 5.88e-5 px | 5.20e-3 px |

Per control point (max Euclidean, px):

| Control point | Median | Max |
|---|---|---|
| leftArmpit | 2.580e-5 | 8.660e-4 |
| leftHem | 6.213e-5 | 5.232e-3 |
| leftShoulder | 2.611e-5 | 1.214e-3 |
| leftSleeve | 2.705e-5 | 9.603e-4 |
| leftTorso | 3.311e-5 | 2.747e-3 |
| rightArmpit | 1.883e-5 | 1.534e-3 |
| rightHem | 5.952e-5 | 5.206e-3 |
| rightShoulder | 1.160e-5 | 1.214e-3 |
| rightSleeve | 2.083e-5 | **5.628e-3** |
| rightTorso | 3.423e-5 | 2.718e-3 |
| waist | 3.126e-5 | 3.059e-3 |

Worst case overall: `n1c-asym-fixture / long-torso / rightSleeve`,
5.628e-3 px.

### Mesh deformation

Control-point agreement is **not** evidence about the surface between the
control points — N1-ENV-010 is precisely that failure, so deformation is
measured separately.

The reference oracle runner emits the reference's own deformed mesh
(`warp.buildGridMesh` + `deformMesh` -> `deformVertex`), and the comparison
measures it vertex for vertex.

| Measurement | Value |
|---|---|
| Vertices compared | 1600 (20 cases x 80 vertices) |
| Mesh delta, median | 2.51e-5 px |
| Mesh delta, **max** | **1.04e-4 px** |
| Grid-shape disagreements | 0 |
| Vertex-count disagreements | 0 |

The deformation is affine moving-least-squares, ported line-for-line from
`dist/affineMlsDeformation.js`. Note the grid convention (N1-ENV-011):
`meshDefinition.width`/`height` are **vertex** counts in the reference,
while Android's `drawBitmapMesh` takes **cell** counts. The snapshot
publishes cell counts, and a test asserts the published shape and the
published vertex array agree by construction.

Semantic checks:

| Check | Result |
|---|---|
| Unexplained semantic divergences | **0** |
| Left/right orientation divergences | **0** |
| Gate pass/fail disagreements | **0** |
| Gate finding-set disagreements | **0** |
| Refusal decisions agreeing | 10 of 14 |
| Refusal disagreements, documented as reference defects | 4 (see N1-ENV-008) |
| Over the 2 px investigation ceiling | **0** |
| Mesh grid-shape disagreements | **0** |

### N1-B closeout table

`n1b-fixture` / `neutral-frontal` — the N1-B gate fixture and pose:

| Control point | Oracle X | Oracle Y | Native X | Native Y | Δx | Δy | Euclidean |
|---|---|---|---|---|---|---|---|
| leftShoulder | 259.284706 | 253.248000 | 259.284730 | 253.247990 | 0.000024 | -0.000010 | 0.000026 |
| rightShoulder | 459.732706 | 253.248000 | 459.732700 | 253.247990 | -0.000006 | -0.000010 | 0.000012 |
| leftArmpit | 294.657882 | 356.075859 | 294.657900 | 356.075840 | 0.000018 | -0.000019 | 0.000026 |
| rightArmpit | 424.359529 | 356.075859 | 424.359530 | 356.075840 | 0.000001 | -0.000019 | 0.000019 |
| leftTorso | 288.762353 | 412.574682 | 288.762360 | 412.574650 | 0.000007 | -0.000032 | 0.000033 |
| rightTorso | 430.255059 | 412.574682 | 430.255070 | 412.574650 | 0.000011 | -0.000032 | 0.000034 |
| waist | 359.508706 | 412.574682 | 359.508700 | 412.574650 | -0.000006 | -0.000032 | 0.000033 |
| leftHem | 281.088000 | 548.171859 | 281.087980 | 548.171800 | -0.000020 | -0.000059 | 0.000062 |
| rightHem | 437.955491 | 548.171859 | 437.955500 | 548.171800 | 0.000009 | -0.000059 | 0.000060 |
| leftSleeve | 231.664346 | 283.310406 | 231.664370 | 283.310400 | 0.000024 | -0.000006 | 0.000025 |
| rightSleeve | 487.353066 | 283.310406 | 487.353060 | 283.310400 | -0.000006 | -0.000006 | 0.000008 |

Max Euclidean on the N1-B fixture and pose: **6.2e-5 px**.

Fixture: `081350cef7f5c83e05c3e6c1` (SYNTHETIC, ACCEPTED, Phase 4 generated),
texture 271×302, mesh 8×10, 11 control points.
BodyFrame: golden `neutral-frontal`. Canvas 720×960.

## Frozen tolerance

Measure first, root-cause, then freeze — never set the tolerance equal to
the largest observed error (amendment D7).

**Observed max divergence: 5.63e-3 px.** Every value is four orders of
magnitude below the 2 px investigation ceiling, and no value required
root-causing.

The residual is float32-vs-float64 arithmetic, not geometry: the native
runtime computes in Kotlin `Float`, the reference in JavaScript `number`
(IEEE-754 double). A relative difference of ~1e-7 on coordinates of order
100–500 px lands exactly where these numbers land. Two independent
confirmations that this is the whole explanation: the rotation delta is
**exactly 0** for most cases (both runtimes produce the identical value where
no rounding accumulates), and the deltas scale with coordinate magnitude
rather than clustering by control-point role.

> **FROZEN N1-C TOLERANCE: 0.05 px** per control point (Euclidean).
>
> Chosen as roughly one order of magnitude above the observed maximum
> (5.63e-3 px) — loose enough to absorb float32 rounding on a different
> device or JDK, and still ~40× tighter than the 2 px investigation
> ceiling, so any real geometry defect trips it long before it becomes
> visible. It is **not** set to the largest observed error.
>
> Any of the following is a defect at ANY pixel distance and is not covered
> by this tolerance: a left/right swap, a mirror inversion, a scale or
> bounds error, a gate pass/fail disagreement, or an undocumented refusal
> disagreement.

## Documented divergences where native does NOT match the reference

Printed and recorded on every run, classified as
`documented_reference_defect` — never suppressed.

**N1-ENV-008 — the reference's own rigid stop gate passes all-NaN geometry.**

Given a landmark of NaN or Infinity, the reference does not refuse. NaN
propagates through every stage (`NaN < 1` is false, so the degenerate-span
check never fires), the placement comes out entirely NaN, and
`evaluateRigidGate` then returns `passed: true` with **zero findings** —
because each of its five comparisons against NaN is also false. The gate
whose stated job is "is the garment semantically attached to this body at
all" certifies all-NaN geometry as correctly attached.

The native runtime refuses with `non_finite_landmark` instead. Matching the
reference here to improve a conformance number would mean shipping a runtime
that renders undefined geometry whenever a perception provider emits a bad
frame, which mission sections 11 and D13 forbid outright.

This also motivates a distinction the reference does not make: **absent** and
**present-but-garbage** are different failures. A provider reporting a
landmark as unobserved is working correctly; one reporting NaN is broken. At
N1-E that is the difference between "occluded, wait" and "this provider is
faulty, stop", so `missing_shoulders` and `non_finite_landmark` are separate
reasons rather than one.

## Non-oracle assertions

Things the oracle cannot judge, asserted directly (all green):

| Test | What it proves |
|---|---|
| `everyValidGoldenProducesFiniteRenderableGeometry` | 13 poses × finite, gate-passing, 11 targets, mesh produced |
| `everyRefusalGoldenFailsClosedWithItsDeclaredReason` | 8 refusals, each at its declared layer, no mesh |
| `leftRightOrientationIsPreservedAcrossEveryGolden` | orientation, both fixtures, every pose |
| `raisedShoulderAsymmetryLandsOnTheRaisedSide` | the asymmetry lands on the side actually raised |
| `badFrameInASequenceIsNotAmplifiedAndDoesNotPoisonTheNextFrame` | D13: no amplification, and no state leaks into the next frame |
| `deformationIsContinuousAcrossASmoothSequence` | 40-step interpolation, max per-step control-point jump < 20 px |
| `switchingGarmentsUnderTheSamePoseCarriesNoStaleState` | A→B→A reproduces A byte-identically |
| `invalidGarmentManifestsAreRefusedAtParse` | wrong schema / missing control point / wrong mesh / corrupt JSON |
| `pipelineIsDeterministic` | byte-identical snapshots across repeated runs |

No smoothing was added anywhere. The continuity result is the raw
deterministic behaviour of the geometry, recorded for later N1-E tuning
(mission section 12).

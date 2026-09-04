# Live VTO — Phase 1 Status

Section 19 weekly-status format, first entry. This is a running log —
append new entries below the divider as work continues; do not overwrite
prior entries.

---

## Entry 1 — 2026-09-04

```
CURRENT BRANCH:   claude/kscan-live-vto-phase1-phase2-lcqyg9
BASELINE HEAD:    688dc35e5bc19bed603eea9835d3f8f12afba3be (kscan-app master, see docs/source-authority.md)
```

### Completed

- **Source authority** (`docs/source-authority.md`): full baseline of
  VTO/camera/garment/privacy/feature-flag code, including the (incorrect —
  see below) conclusion that the existing VTO was backend-plumbing-only.

  > **CORRECTED 2026-09-04 (Entry 2).** That conclusion was drawn from
  > `master` alone, which is not the VTO authority. A complete governed VTO
  > client + backend exists on
  > `integration/backend-kplus-complimentary-staging-v1` @ `4af92f4c`. See
  > the AUDIT CORRECTION section of `docs/source-authority.md`.
- **Isolation guardrails**: `kscan-live-vto/tools/protected-paths.json` +
  `validate-protected-paths.js` (mechanical check, verified passing) and
  `.github/workflows/live-vto-protected-paths.yml` (same check in CI).
- **Isolated workspace scaffold**: `kscan-live-vto/` — npm workspaces,
  5 packages, apps/sandbox, native/, fixtures/, tests/privacy/, all
  independent of the root `kscan-app` `package.json`.
- **Contracts** (`packages/live-vto-contract`, `packages/garment-contract`):
  `BodyFrame` (provider-neutral pose shape, explicit absent-landmark
  representation), `GuidanceState` + priority selector, the Section 10
  native-view command/event surface with a `FORBIDDEN_EVENT_PAYLOAD_KEYS`
  regression guard, `LiveVTOPrivacyPhase` + candidate disclaimer copy,
  `DeviceCapabilityLevel` classifier, `GarmentDescriptor`, `.ksgarment`
  manifest schema + validator.
- **Body model** (`packages/body-model`): a real One Euro Filter
  implementation (Casiez et al. 2012) and the Section P2-B ephemeral
  `BodyProxy` derivation (shoulder/hip width, torso height, arm vectors,
  torso orientation, calibrated camera-relative scale) — both fully
  covered by passing unit tests, including a filter jitter-reduction test
  and geometry tests for known landmark configurations.
- **Asset pipeline** (`packages/asset-pipeline`): Section P1-D2 shot-class
  ranking, Section P1-D5 QC record composition (mechanical
  accept/reject against named, evidence-pending thresholds), and a real,
  mathematically-verified **affine MLS** control-point deformation
  (chosen over rigid MLS for implementation-correctness confidence this
  session — see that file's header for the reasoning and the documented
  trigger for revisiting it).
- **Evaluation harness** (`packages/evaluation`): Section 17 fixture
  manifest schema (all 20 required categories enumerated), real metric
  functions (landmark jitter, tracking-confidence stats, dropped-frame
  estimation, hysteresis-based tracking loss/reacquisition detection), a
  golden-sequence runner, and a deterministic synthetic BodyFrame
  generator.
- **Fixtures**: 3 of 20 golden-sequence categories covered
  (`centered-subject`, `tracking-loss`, `tracking-reacquisition`), all
  synthetic, with real generated metric reports committed under
  `fixtures/sequences/reports/`. One manifest-only `.ksgarment` fixture.
  `fixtures/people/` deliberately empty (no consented footage available).
- **Native scaffold** (`kscan-live-vto/native/`): Expo Modules-shaped
  Swift + Kotlin stubs for the `LiveVTO` native view, structurally
  mirroring the TS command/event contract. Explicitly unbuilt/uncompiled
  — no Xcode/Android toolchain or device in this session.
- **Privacy tests**: `tests/privacy/` mechanically enforces zero
  unreviewed external runtime dependencies across the workspace and
  regression-guards the local-only data-class list and forbidden
  event-payload keys.
- **Docs**: `docs/vto-risk-register.md` (all 10 Section 36 risks, honest
  status against each), `docs/vto-visual-verdicts.md` (empty log,
  correct format established), `docs/fixture-consent-log.md` (empty log,
  correct format established).

**Test evidence:** 66 tests passing (`npm test` from `kscan-live-vto/`):
7 garment-contract, 11 live-vto-contract, 13 body-model, 15 asset-pipeline,
16 evaluation, 4 privacy. All cross-package TypeScript project references
build cleanly (`npm run build`).

### In progress

Nothing is actively in-flight at the time of this entry; the items below
are queued next-critical-path work, not partially-started.

### Visual verdicts

None. Nothing has been rendered — see `docs/vto-visual-verdicts.md`. The
Section 22 Phase 1 hard visual gate cannot be attempted until a
compositor and native camera pipeline exist.

### Performance

No performance data exists. `DEFAULT_DEVICE_CAPABILITY_THRESHOLDS`
(`packages/live-vto-contract/src/deviceCapability.ts`) and
`DEFAULT_ONE_EURO_CONFIG` are explicitly-labeled placeholders, not
calibrated values — see Section 29's own instruction not to fabricate
these before baselines exist.

### Privacy

No live-traffic audit is possible yet (Section 32 requires a real device
Live session; none exists). What's verifiable today: zero external
runtime dependencies in any package (mechanically tested), and the
type-level JS/native boundary (`FORBIDDEN_EVENT_PAYLOAD_KEYS`) and
local-only data-class list (`LOCAL_ONLY_DURING_LIVE`) are both
regression-guarded.

### Known failures

None yet — nothing has run against real conditions to fail. This is a
gap, not a clean bill of health: see "Known limitations" below.

### Known limitations (read alongside "Completed" above)

This entry's "Completed" list is entirely software scaffolding, math, and
contracts. None of the following exist yet, and none can exist without
resources this cloud sandbox session does not have:

- **No camera.** No frame has ever been captured by any code in this
  program.
- **No physical iOS or Android device**, and no Xcode (iOS builds require
  macOS). The native Swift/Kotlin files have never been compiled.
- **No pose or segmentation model is integrated.** `BodyFrame` has never
  been populated from anything but the synthetic generator.
- **No renderer or compositor exists.** No garment has ever been visually
  placed on an image or video frame. The static preview described in
  Section 21 (P1-E) does not exist as running code — only its deformation
  math does.
- **No human has reviewed any visual output**, because there is none to
  review.
- **17 of 20 Section 17 golden-sequence categories have no fixture.**

### Blockers

The items above are not blocked by any decision this session can make —
they require a session with camera hardware, a physical device, and
(for iOS) an Xcode/macOS toolchain, none of which this cloud container
provides. This is an environment constraint, not a Section 1 authorization
gap: nothing above requires crossing into production/staging/Commerce.

### Next critical path item

Per Section 37's critical path (SOURCE AUTHORITY → ISOLATION GUARDRAILS →
REPLAY HARNESS → NATIVE CAMERA → POSE/BODYFRAME → ...), this entry
completes REPLAY HARNESS. The next item, **NATIVE CAMERA (P1-B1)**,
requires a session with the hardware/toolchain access described above. In
the meantime, the next item any session (including this kind of sandbox)
*can* make progress on without new hardware is extending
`packages/evaluation/src/syntheticFixtures.ts` to cover the remaining
synthesizable BodyFrame-only categories (arm-crossing, arms-raised,
torso-rotation, closer-farther-movement) — see
`fixtures/sequences/README.md`.

---

## Entry 2 — 2026-09-04 (source-authority correction + first static preview)

```
CURRENT BRANCH:   claude/kscan-live-vto-phase1-phase2-lcqyg9
MASTER BASELINE:  688dc35e5bc19bed603eea9835d3f8f12afba3be
VTO AUTHORITY:    integration/backend-kplus-complimentary-staging-v1 @ 4af92f4c
```

### Completed

- **Source-authority correction.** Entry 1's "VTO is backend-plumbing only"
  conclusion was drawn from `master`, which is not the VTO authority. A
  complete governed VTO — `components/vto/`, 10 `services/vto/` modules,
  `types/vto.ts`, `supabase/functions/vto-generate/` with entitlement, quota,
  idempotency and reservation controls, and 4 migrations — exists on the
  integration branch, and the older `tryon-clothes-pro` proxy is a *retired
  handler that refuses*. `docs/source-authority.md` now records both
  authorities, a 5-way reachability classification, and an itemized list of
  what the first audit got wrong.
- **Headless static preview renderer** (`packages/static-renderer`, 20 tests):
  pure-Node PNG codec, raster primitives, semantic attachment contract, rigid
  placement + stop gate, affine-MLS mesh warp and rasterizer, compositor with
  feathered foreground restoration, lighting estimator with guardrails, and
  the Section 14 metric set.
- **Actual rendered images.** Six cases in
  `kscan-live-vto/evidence/static-preview/`, with JSON sidecar manifests,
  regenerable deterministically.
- **Asset QC tool** (`tools/garment-qc.js`) emitting annotated inspection
  sheets and AUTO / MANUAL_CORRECTION / REJECTED records.
- **Docs:** `docs/vto-static-preview-review.md` (review package, verdict
  PENDING), `docs/vto-native-device-handoff.md` (architecture, pose-model
  criteria and candidates, first-device-test procedure, evidence return
  protocol), `docs/vto-integration-candidate.md` (integration surface map
  against the real VTO client — documentation only).

**Tests: 66 baseline → 86 final. 0 deleted, 0 weakened.**

### Findings

1. **The rigid stop gate earned its place immediately.** It refused 5 of 6
   cases on the first run, exposing a garment silhouette 2.625 shoulder-spans
   long against a 1.18-span target, plus a hem-drop constant that put the hem
   too high. Both fixed and pinned by a test.
2. **A third defect was caught only by looking at the image** — a neck opening
   58% of seam span cut as a V, and sleeves 2.17× shoulder span. No metric
   flagged it. This is the argument for the human visual gate in one example.
3. **Consistent vertical compression of chest content** (logo v-scale
   0.67–0.78 across body types) — characterized, hypothesis recorded, not
   silently "fixed" by swapping deformation algorithms.
4. Open, unfixed, and listed for the reviewer: hem notch, shoulder-cap
   coverage, hard garment edge.

### Visual verdicts

Still none. `docs/vto-static-preview-review.md` is the first package ready for
a human; `docs/vto-visual-verdicts.md` remains empty until someone reviews it.

### Known limitations (unchanged where unchanged)

No camera, no device, no Xcode/Android toolchain, no pose model, no
segmentation model, no native compilation, no human review. Every person and
garment fixture is synthetic; every mask is precomputed. The renderer is an
evaluation renderer and its pixels are not a native baseline.

### Next critical path item

Human review of `docs/vto-static-preview-review.md`. Independent of that, the
next unblocked engineering item is the P1-D3 asset pipeline — turning a real
retailer image into a `.ksgarment` — which is what actually gates a Live
integration, and which remains **BLOCKED — FIXTURE CORPUS REQUIRED** until an
authorized real-asset corpus exists.

---

## Entry 3 — 2026-09-04 (FAIL verdict answered — topology repair, package #2)

```
CURRENT BRANCH:   claude/kscan-live-vto-phase1-phase2-lcqyg9
VERDICT ANSWERED: FAIL — DEFORMATION at ee298587
```

### Completed

Human review returned **FAIL — DEFORMATION** on static preview package #1,
naming four defects. All four repaired in the control-point/target topology;
**affine MLS itself was not modified and not replaced**, and post-repair
evidence gives no reason to suspect it (control-point residual 0.00px, zero
foldover).

- **Defect 1 (vertical chest compression)** — root cause found: targets were
  pinned to same-named body landmarks, so the garment's `waist` control point
  (76% of the garment's length) was dragged onto the anatomical waist landmark
  (82% of torso height, above the hem). Replaced with a body-space garment
  frame that maps each control point by its own manifest coordinates. Neutral
  logo aspect 1.298 → **1.012**.
- **Defect 2 (centre hem notch)** — same root cause; gone.
- **Defect 3 (shoulder-cap undercoverage)** — added `SHOULDER_SEAM_RISE`; the
  seam now sits above the joint landmark as a real shirt does.
- **Defect 4 (hard garment edge)** — 2× supersampled rasterization with
  premultiplied box downsample. Not a blur.

Supporting topology changes: sleeve targets rotate without stretching; new
`leftArmpit`/`rightArmpit` control points anchor the torso side of the sleeve
junction; `TORSO_WIDTH_HOLD_T` holds chest width above the taper;
`MAX_LONGITUDINAL_ASPECT_DEVIATION` bounds longitudinal distortion on extreme
bodies.

**Tests: 86 → 95. 0 deleted, 0 weakened.** Nine new regression tests, one per
repaired defect plus foldover and ordering invariants.

### Findings

1. **Adding the armpit anchor reintroduced mesh foldover** (4–8 cells) because
   the articulated sleeve landed inboard of it while sitting outboard in the
   texture. Fixed with an approximate upper-arm half-width offset, labelled as
   an approximation because BodyFrame carries no limb width. Pinned by a test.
2. **The first v2 render turned the tee into a poncho** — holding full chest
   width exposed that the fixture body was 1.33 seam-spans wide, previously
   masked by body-derived side targets. Caught by looking at the image; no
   metric flagged it. Narrowed to ~1.1 seam-spans.

### Still open

Armpit gap with arms away/crossed; residual aspect deviation on the stress
bodies (1.155 broad / 0.864 narrow); the broad fixture is deliberately outside
a realistic human range; boxy lower torso (linear taper, no drape model).

### Visual verdicts

Package #1: **FAIL — DEFORMATION** (recorded). Package #2:
`docs/vto-static-preview-review.md`, verdict **PENDING**.

### Known limitations

Unchanged: no camera, no device, no toolchain, no pose model, no segmentation
model, no native compilation. Synthetic fixtures, precomputed masks, headless
evaluation renderer whose pixels are not a native baseline.

### Next critical path item

Human review of package #2. Independent of it, the P1-D3 asset pipeline
(retailer image → `.ksgarment`) remains what actually gates a Live
integration, and remains **BLOCKED — FIXTURE CORPUS REQUIRED**.

### External CI status — `npm audit` (record only)

Recorded per the directive to log this check's status without repairing it.
`.github/workflows/master-required-checks.yml` is outside this lane's
authorized scope and was not modified.

`npm audit` is the only red check on this branch. It is **intermittent** and
external to this diff:

| Head | Result | Registry response |
|---|---|---|
| `ee29858` | fail | `400 Bad Request` |
| `ee29858` (re-run, same commit) | **pass** | — |
| `8b75915` | fail | `503 Service Unavailable` |

All three point at the same call, `POST
https://registry.npmjs.org/-/npm/v1/security/audits/quick`. The step's guard
(`node -e "... if(r.error) process.exit(2)"`) fires because npm writes an
`error` object into `npm-audit.json` instead of a report; the step otherwise
tolerates real vulnerability findings (`test "$CODE" = 0 -o "$CODE" = 1`), so
only the transport failure fails the job. In the same job `npm ci` succeeded
and reported 38 vulnerabilities, so dependency resolution was fine.

Passing and failing on the identical commit rules this out as a property of
the diff. This branch touches neither the root `package-lock.json`, the root
`package.json`, nor any workflow file — "Validate no production paths touched"
(green) enforces that. The other 12 checks on `8b75915` are green.

One re-run has been spent on this head. Observed, not proposed as work in this
lane: a required check with a hard dependency on a third-party endpoint can
block merges repo-wide on registry weather, and the repo already runs
OSV-Scanner and Trivy, both green.

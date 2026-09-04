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
  VTO/camera/garment/privacy/feature-flag code, including the discovery
  that the "existing generative VTO capability" this program builds on is
  backend-plumbing-only — no client UI reaches it today.
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

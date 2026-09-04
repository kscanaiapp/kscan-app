# Live VTO — Risk Register

Section 36 deliverable. Each risk carries the plan's own mitigation
strategy plus this program's actual current status against it — not just
the intended mitigation, but what evidence exists for it as of this
document's last update (2026-09-04, branch
`claude/kscan-live-vto-phase1-phase2-lcqyg9`, see
`docs/vto-phase1-status.md` for the fuller build log).

---

## RISK 1 — Static preview looks like a sticker

**Mitigation (plan):** better anchors; asset QC; segmentation; lighting;
human review.

**Status:** Control-point-based attachment (`P1-E1`) and its deformation
math (`packages/asset-pipeline/src/affineMlsDeformation.ts`) exist and are
unit-tested for mathematical correctness (exact interpolation, correct
behavior under pure translation/scaling). Asset QC composition
(`packages/asset-pipeline/src/qc.ts`) exists and is tested. **Segmentation
and lighting integration do not exist yet** — no compositor, no
segmentation model. **No human visual review has happened** — nothing has
been rendered, because no renderer exists (Section 10's native view is
unbuilt scaffolding; see `kscan-live-vto/native/README.md`). This risk is
entirely unmitigated on the visual-quality dimension; only the math
underneath one piece of the mitigation is proven correct.

---

## RISK 2 — Retail images fail as garment assets

**Mitigation (plan):** Class A/B first; explicit rejection; manual QC;
record failure by source type.

**Status:** `packages/asset-pipeline/src/shotClass.ts` encodes the A/B/C/D
class ranking and QC rejection composition
(`summarizeQcRecords`/`composeQcRecord`) is real and tested. **No real
shot classifier or segmentation model is wired in** — `classifyShotStub`
is an explicit, self-labeling stub (`isStubResult` always true) precisely
so nothing downstream can mistake it for real evidence. Zero real retail
images have been run through any part of this pipeline in this session
(Section 8.4: no automatic production/vendor calls; no retailer image
sourcing decision has been made). Unmitigated pending a real model
integration session.

---

## RISK 3 — Live garment swims

**Mitigation (plan):** temporal state; stable body coordinate system;
filtering; async perception.

**Status:** `packages/body-model/src/oneEuroFilter.ts` is a real,
tested One Euro Filter implementation (Casiez et al. 2012) with
variance-reduction and steady-state tests passing. `BodyFrame` (stable
coordinate system) and `BodyProxy` (Section P2-B ephemeral geometry) exist
and are tested. **None of this has ever run against real, continuous
camera input** — there is no camera pipeline, no async perception loop
(Section P2-A), and therefore no possible evidence yet about whether
swimming actually occurs or how well filtering addresses it in practice.
The filter's default parameters (`DEFAULT_ONE_EURO_CONFIG`) are the
paper's generic starting point, explicitly not tuned against any Live VTO
evidence.

---

## RISK 4 — Arm occlusion fails

**Mitigation (plan):** segmentation; body geometry; hysteresis;
supported-pose constraints.

**Status:** `BodyProxy`'s arm vectors (shoulder→elbow→wrist) exist as the
geometric half of a future occlusion heuristic. `detectTrackingEvents`'s
hysteresis pattern (two thresholds, not one) is real and tested, and the
same two-threshold approach is the natural fit for a front/back occlusion
flip-flop guard once one is built. **No segmentation, no compositor, no
occlusion logic of any kind exists yet.** Fully unmitigated; this is P1-E3/
P2-E work that has not started.

---

## RISK 5 — Android diverges

**Mitigation (plan):** platform-neutral contract; delayed parity; device
capability system.

**Status:** The command/event contract
(`packages/live-vto-contract/src/nativeView.ts`) and `BodyFrame` are
provider- and platform-neutral by construction — no iOS/Android-specific
type appears in any shared package. `kscan-live-vto/native/ios` and
`kscan-live-vto/native/android` scaffolds are structurally parallel
(same command/event names, same TODO markers). Per Section 11, Android is
deliberately not being raced against iOS — **neither platform has been
built or run**, so "divergence" cannot yet be observed either way. Revisit
once one platform has a working Phase 1 pipeline (Section 11: iOS or
whichever platform proves faster to iterate on, once this program has
access to a real device).

---

## RISK 6 — Thermals are unacceptable

**Mitigation (plan):** adaptive quality; session fallback; lower
processing cadence.

**Status:** `packages/live-vto-contract/src/deviceCapability.ts` defines
the `ENHANCED/STANDARD/BASIC/UNSUPPORTED` levels, the ordered
`QUALITY_REDUCTION_STEPS`, and the `LIVE_UNAVAILABLE_FALLBACK_MESSAGE`
copy — the full shape of the mitigation. **Every threshold in
`DEFAULT_DEVICE_CAPABILITY_THRESHOLDS` is an explicitly-labeled
placeholder, not measured evidence** (Section 29: "Do not fabricate fixed
universal FPS/thermal thresholds before baselines exist"). No device has
run this code even once — there is no thermal or frame-time data of any
kind yet. Unmitigated until a real device calibration pass happens.

---

## RISK 7 — Current clothing corrupts visual body proxy

**Mitigation (plan):** narrow use cases; fitted-top guidance; no
hidden-body claims.

**Status:** `BodyProxy`'s doc comments and the candidate fit disclaimer
(`CANDIDATE_FIT_DISCLAIMER = 'VISUALIZATION ONLY — NOT A FIT PREDICTION'`
in `packages/live-vto-contract/src/privacy.ts`) encode the "no hidden-body
claims" half of the mitigation at the contract level. The "fitted-top
guidance" UX copy (Section 16's "keep your torso visible and wear a
fitted top") is not yet wired into any guidance state — `GuidanceState`
(Section 21) does not currently include a bulky-clothing-specific message;
Section 16 explicitly says not to invent a fixed body-ratio heuristic
without evidence, so this is deliberately left for a real-fixture-informed
pass rather than guessed at now.

---

## RISK 8 — SDK breaks privacy

**Mitigation (plan):** local models; network audit; remove vendor if
necessary.

**Status:** `kscan-live-vto/tests/privacy/dependencyBoundary.test.js`
mechanically enforces that no `packages/*/package.json` may depend on
anything outside the `@kscan-live-vto/*` scope without deliberate,
reviewed addition to an explicit allow-list (currently empty — zero
external runtime dependencies exist in this workspace today).
`LOCAL_ONLY_DURING_LIVE` and `FORBIDDEN_EVENT_PAYLOAD_KEYS` (both in
`packages/live-vto-contract/src/privacy.ts` / `nativeView.ts`) are
regression-guarded by tests. **No SDK selection (pose model, segmentation
model) has happened yet, so there is nothing to run a live-traffic audit
against** — Section 32's device-level network audit is necessarily future
work, once a real model is chosen and a device session exists.

---

## RISK 9 — Agent self-certifies visual quality

**Mitigation (plan):** human visual verdict protocol.

**Status:** `docs/vto-visual-verdicts.md` exists as the required review-log
format (Section 18), currently with no entries — because nothing has been
rendered yet to review (see RISK 1). This document itself follows the
same discipline: every status claim above cites what code/tests exist
rather than asserting visual or UX quality, precisely because this session
has no rendered output to evaluate and no authority to self-certify one
even if it did.

---

## RISK 10 — Experimental work touches production

**Mitigation (plan):** credentials removed; protected paths; isolated
branch/worktree; CI validation.

**Status:** Fully mitigated by construction as of this document:
- Isolated branch `claude/kscan-live-vto-phase1-phase2-lcqyg9`, all
  engineering work under `kscan-live-vto/` (not referenced by root
  `package.json`/workspaces).
- `kscan-live-vto/tools/protected-paths.json` +
  `validate-protected-paths.js` mechanically block commits touching any
  existing production/runtime path; verified to pass against every change
  in this session (`node kscan-live-vto/tools/validate-protected-paths.js`).
- `.github/workflows/live-vto-protected-paths.yml` runs the same check in
  CI on every PR.
- No deploy/Supabase/EAS/App Store credentials were added, referenced, or
  required by anything in `kscan-live-vto/` — every package's
  `dependencies` list is either empty or internal-only (see RISK 8).

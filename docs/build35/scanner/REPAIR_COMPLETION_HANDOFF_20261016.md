# Scanner Phase 2 + Live VTO source: repair-completion handoff (2026-10-16)

Source repairs only. Nothing here was merged, deployed, activated, built with EAS,
submitted to a store, or run against a paid provider. Merges are a morning owner
action.

## 1. What can be tested tomorrow

**There is no build from any of this source.** Nothing is device-testable until
the owner authorizes an EAS build from an exact merged SHA. Everything below is
ready for REVIEW and for a build decision.

PRs ready for morning merge review (all draft; merge order is in
`ACTIVATION_AND_CONVERGENCE_PLAN_20261016.md`):

| PR | Surface | Head CI at last read |
|---|---|---|
| #622 backend | `scan-identify` evidence, brand conflicts, match tier, destination grading, manifests | 32 pass, 14 skipped, 0 fail (head `663e456a`) |
| #621 mobile | evidence, local privacy, three-tier contract and panel, harness updates, synced backend tree | see section 9; re-run after the final push |
| #624 Live VTO native | view mount, camera ownership, capability stages, garment swap | 34 pass, 16 skipped, 0 fail including the iOS jobs: SwiftPM host tests and the simulator `xcodebuild` |

First things to run once a build exists (device-only, in this order):
1. Android Scanner, camera and gallery: does the local masking pipeline run, and does a
   deliberately unsupported input (HEIC, oversized) FAIL CLOSED instead of uploading?
2. Android and iPhone Scanner result: tier section headings, "Exact product not
   confirmed" note, Try It On opens the tapped row's garment.
3. Android Live: `Start Live` enabled only after the view mounts; capture
   `adb logcat` once for the Samsung `-110` with the bounded stage report.
4. iPhone Live on a physical device (nothing but compile and host tests exists).
5. Retailer relevance inside the existing ledger caps, only with fresh authorization.

Decisions the owner must make (details in section 8): Android PII native on this
line; the "Exact match candidate" wording change; Live ends when switching to AI
Photo; whether to supplement Serper with Brave direct links (a paid-call and
latency decision, deliberately not made).

## 2. Initial four-worktree recovery state

Full detail: `RECOVERY_INVENTORY_20261016.md`. Summary: A at `9a7d067a` (2 local
commits + 1 modified + 5 untracked), B at `b920d4ee` (1 commit + 4 modified + 3
untracked), C at `6e073a1a` (12 modified + 18 untracked, nothing committed), D at
`6e073a1a` (18 modified + 5 untracked). Before any edit I saved a patch of every
tracked diff and a copy of every untracked file outside the repository, then made
non-destructive checkpoint commits. No reset, clean, force-push, rebase, stash or
deletion. Temporary `.scanner-contract-harness.cjs` (D) was not committed.

## 3. Final branches

| Branch | Role |
|---|---|
| `repair/scanner-backend-intelligence-20261016` | backend proposal (#622) |
| `repair/scanner-intelligence-commerce-20261016` | combined mobile proposal (#621) |
| `repair/scanner-local-privacy-20261016`, `repair/scanner-commerce-contract-20261016` | histories, ancestors of #621, no PR |
| `repair/live-vto-native-view-mount-20261016` | Live VTO (#624), created from `integration/build35-v1-convergence` at `a4ea4235` |

Exact heads: read from GitHub; they moved during CI repair.

## 4. Scanner engineering (completed repairs)

- Visual-evidence envelope: versioned, digest-bound, bounded, with provenance.
  `producer.method = none`: no independent OCR or logo classifier exists and none is
  claimed. Model observations stay attributed to the vision model
  (`independentlyVerified: false`). The prompt has no brand example. Conflicting
  strong signals leave the brand unconfirmed and the quality gate cannot re-promote
  one of them.
- Local privacy: Scanner prepares through the local pipeline, binds a proof to the
  exact encoded bytes, rejects copied proofs and changed bytes, no raw fallback.
  Android native recovered WITH its tests.
- Three tiers: listing-bound metadata through normalize, save, reopen, Dressing Room
  and the panel (section headings in tier order; honest empty/pending/error states).
  Legacy and unvalidated metadata confers no tier.
- Destination handling: see section 7.

## 5. Shared Scanner/VTO repairs: confirmed defects versus architectural risks

Confirmed defects (each reproduced from source and fixed):
1. The two "failing" contract tests were wrong. `VtoGarmentInput` carries `productRef`,
   never `productUrl`; the destination is the option's `productUrl`. VTO was not
   changed. (A reopened saved row's `productRef` falls back to the purchase URL because
   saved options carry no `id`: pre-existing, deterministic, now asserted.)
2. The destination repair as written would have emptied shelves (section 7).
3. The Live native view was never mounted, so `start()` could only throw.
4. Live rendered the fixed n1b garment whatever was loaded (Android and iOS).
5. A mobile import of a backend file broke the mobile `tsc` graph (latent errors in
   `safeRemoteMedia.ts` under the non-strict mobile config).

Architectural risk, not reproduced as a user-visible defect: Scanner (expo-camera
17.0.10) and Live (CameraX) both call `unbindAll()` on the process-wide
`ProcessCameraProvider`. Confirmed in both sources. An overlap needs a Live session
alive while a Scanner camera mounts (minimized Live, then navigation to a camera
screen); the normal paths do not produce it (Scanner's camera is replaced by the
result screen; Home is `router.replace`). Mitigated: Live unbinds only its own use
cases, and `services/cameraOwnership.ts` makes the Scanner preempt Live and refuses
Live while the Scanner camera is mounted. The reverse (another surface's
`unbindAll()` removing Live) cannot be fixed from inside either library.

Preserved: #608 attribution, #611 garment pin, #619 account-boundary close (the
existing actor-isolation and launcher tests pass in the full runner). Photo VTO is not
touched and does not depend on Live; its privacy path is not changed (Scanner masking
is applied only on the Scanner path).

## 6. Live native engineering, Android and iOS separately

Android
- Native view wiring: `VtoLiveNativeView` mounted by `VtoLivePanel` before Start;
  Start gated on the view's layout. SOURCE PASS (7 tests + mutation checks).
- Camera lifecycle: own-use-case unbind (no `unbindAll`); Kotlin source scan test.
- Frame delivery code: reviewed, no independently provable defect found. The
  historical `ETIMEDOUT -110` remains a device/HAL-boundary unknown; no CameraX
  rewrite was made.
- Capability: separate static stages, closed gate (`PHYSICAL_CERTIFICATION_APPROVED =
  false`); `capable` and `runtimeReady` remain false. Post-start stages (frames,
  perception, rendering) are not reported pre-start because they cannot be known.
- Garment swap: the running perception session swaps onto the loaded manifest.
- Evidence: NATIVE COMPILE PASS; `testDebugUnitTest` JUnit XML 94 tests, 0
  failures = 94 `@Test` (87 existing + 6 stages + 1 swap).

iOS
- Same stages, same closed gate, same swap, in Swift. SIMULATOR PASS: the iOS
  workflow on #624 ran SwiftPM host tests and the full simulator `xcodebuild` and
  both passed. The swap has no Swift unit test (no perception-session harness on
  that side). Nothing physical was observed.

Preserved: `pose_landmarker_lite.task` registration and its checksum, the raw-data
bridge restrictions, and the existing renderer lifecycle. No model or download added.

## 7. Retailer evidence and what is actually known

Measured (archived replays, October 9; not repaired-code results): 21 requests, 110
offers, 36 of 42 top-three titles matched the category proxy, 13 of 17 queries met the
category-hit proxy, 95 of 110 destinations were Google search pages. Metadata
reranking did not move those proxies, so improved real-world relevance is NOT
established. `PurchaseOptionsPanel` records 28 of 33 destinations as Google Shopping
listings in a live measurement.

Root cause of the search-page share: Serper's shopping API does not return merchant
URLs; its link field is a Google Shopping page. The Brave fallback returns direct
web links but is used only when Serper returns nothing. So the shelf cannot be made
direct-link-only without emptying it.

What changed: public https search/aggregator pages stay eligible but rank below
direct retailer pages and never receive a tier; private, credentialed and non-https
destinations are rejected. What did NOT change and is open: supplementing Serper with
Brave direct links when few direct offers remain (an extra paid call on most scans);
product-level destination resolution. No paid call was made. The ledger showed 27 of
56 image and 21 of 40 commerce requests used as of the last Staging reconciliation;
that is not a fresh authorization.

## 8. Owner decisions and approvals

1. Android PII native on this line. The iOS-line guard (`module is Apple-only`) was
   rewritten to an explicit Apple + Android declaration: Kotlin only under `android/`,
   no model assets anywhere, ML Kit pinned to exactly face-detection 16.1.7,
   pose-detection 18.0.0-beta5 and text-recognition 16.0.1. Android Scanner fails
   closed without it. Binary size and review impact are unmeasured; pose-detection is
   beta and serves the module's existing Closet API, not the Scanner.
2. Wording: results that were "Exact match candidate" now read as close or similar
   because no exact-product proof exists.
3. Live ends when the customer switches to AI Photo (previously kept alive).
4. Camera ownership policy: the Scanner preempts Live.
5. Enumerated backend paths added to the VTO-lane guard's allowlist
   (`BUILD35_AUTHORIZED_BACKEND_PATHS`); `safeRemoteMedia.ts` is explicitly asserted
   unauthorized and is byte-identical to the authority.

## 9. Tests, by evidence category

| Requirement | Category | Result |
|---|---|---|
| Combined mobile, full canonical runner | SOURCE PASS (one run) | 11,183 tests, 11,084 pass, 98 skipped; 1 failure, the premium-fingerprint check, fixed by regenerating the two watch entries (21/21 on re-run). The full runner was not repeated after that regeneration; PR CI is the exact-head evidence |
| `tsc --noEmit`, mobile | SOURCE PASS | clean |
| Backend `scan-identify` | SOURCE PASS | 452 passed, 0 failed |
| Backend `vto-generate` (consumer of `safeRemoteMedia`) | SOURCE PASS | 196 passed |
| `edgeFunctionSourceParity` | SOURCE PASS | 23/23 on a clean committed tree |
| `publicHost` copy parity | SOURCE PASS | source identical; behaviour corpus (Node 3/3, Deno 1/1) |
| Android privacy native | NATIVE COMPILE PASS + JVM | 7 tests, 0 failures = 7 `@Test` |
| Android privacy instrumentation tests | ENVIRONMENT BLOCKED | restored (224 lines) but the emulator refused to boot: not enough disk space (C: had about 0.5 GB free) |
| Android Live | NATIVE COMPILE PASS + JVM | 94 = 94, 0 failures |
| iOS Live | SIMULATOR PASS (CI) | SwiftPM host tests and `xcodebuild` passed on #624 |
| Native detector accuracy, pixels, EXIF on real images | DEFERRED DEVICE CERTIFICATION | not tested |
| Retailer relevance after repair | NOT TESTED | no paid call |
| New Balance photo, deployed-model accuracy | DEFERRED DEVICE CERTIFICATION | not tested |

## 10. Remaining defects and blockers (location, severity, minimal repair, owner)

- Privacy P1 (not production-certified): plate protection is text-region geometry,
  not plate recognition; HEIC and oversized inputs fail closed (the guarantee holds,
  support is a product decision); native accuracy unmeasured. Owner: device
  certification.
- Privacy P1, separate lane: the legacy Elise image path still passes through
  `services/privacyImageSanitizer.js`. Not changed. Owner: Elise lane.
- Match tier P3: no producer of exact-product proof. Minimal repair: a verified
  identity source (GTIN or MPN from a provider that returns it). Owner: product.
- Commerce P2: search-page share (section 7). Owner: cost and latency decision.
- Live P1 (device): Samsung `-110`, iPhone, renderer pixels, garment visibility.
- Live P3: capability gate stays false; flipping it is a release decision.
- Disk: this machine had about 0.5 GB free on C: and the Android emulator would not
  boot. Free space is needed before any emulator or Gradle work.
- Adjacent, documented not fixed (P4 to P10): the Scanner dispatch guard registration
  function is exported, so any module could register bytes with a fabricated proof
  object (same trust level as the existing JS proof; a tighter design would register
  only inside the preparation module); `commerceMatchLabel` reads unclassified rows as
  "Similar Styles"; the Swift side has no perception-session test harness.

## 11. Prepared activation, convergence order, rollback, deferred work

See `ACTIVATION_AND_CONVERGENCE_PLAN_20261016.md`: dependency matrix (source
integrated, backend deployed, in a binary, runtime capable, physically certified,
customer enabled; none inferred from another), single convergence order, approvals,
rollback, and the full deferred Build 35 certification list.

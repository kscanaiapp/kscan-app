# Build 34 / Track B / Phase B2A — On-Device Closet Media Privacy Boundary: Ledger

Status: **SOURCE CORRECTIONS COMPLETE — ANDROID NATIVE VERIFIED — IOS/DEVICE PRIVACY GATE REQUIRED**
Phase: B2A (local sanitization only — no upload, no sync, no network)
Production: **NOT TOUCHED**. Backend: **NOT MODIFIED**.

Predecessor contract: B1C (`feature/backend-build34-closet-media-v1` @ `c7fddfd`).

This ledger has two parts: the original B2A implementation, and a **correction pass** performed after review found the plate path and the thumbnail contract had drifted from what Build 34 actually needs, plus one critical defect the correction pass surfaced.

## Why this phase existed

B1C proved the cloud media contract *and* proved that `services/privacyImageSanitizer.js` was a passthrough: it declared `faceBlurApplied: false` / `plateMaskApplied: false` and returned its input unchanged. Uploading Closet media through that would have shipped unmasked PII. B2A closes the local boundary that must exist before B2B may upload anything.

## What was already there (and what actually blocked the gate)

The engine was **not** missing. `modules/kscan-pii-native` already contained a real, mature on-device face pipeline — decoder, box normalizer, redactor, output verifier, cache manager — with Apple Vision on iOS and **bundled** ML Kit on Android, and it had previously reached a real EAS archive build.

The single blocking gap was **license-plate screening**: `services/privacy/plateDetection.ts` was an explicitly-unsupported stub whose only job was keeping `isImageDispatchAllowed()` false.

So B2A is a repair/activation, not a rewrite.

## The cross-line divergence this phase surfaced

`services/privacy/**` — the whole fail-closed boundary (artifact store, URI materializer, native bridges, proof, two-state dispatch gate) — **existed only on the Android line**. The iOS K+ foundation had none of it and still carried the old permissive `privacyImageUpload.ts` whose `isPrivateImageUploadAvailable()` returns `true`.

B2A ports that foundation to iOS as **dormant** code (nothing routes through it) and deliberately does **not** touch iOS's live `privacyImageUpload.ts`, so no existing iOS image flow changes behaviour.

## Two defects fixed in the original pass (unreachable while the gate was closed)

1. **`no_faces` produced no artifact.** The boundary requires a sanitized artifact, so once the plate gate opened, every face-free image — i.e. most Closet garment photos — would have been BLOCKED. Sanitization now always emits a re-encoded (metadata-free) verified output; masking is orthogonal.
2. **The proof claimed masking from detection.** `platesMasked` was derived from the plate screen having *run*, not from regions being *obscured*. Superseded by the correction pass below — plate detection no longer masks at all in the accepted-Closet-SAFE path.

---

## CORRECTION PASS (post-review)

### Correction #1 — plate policy: BLOCK, not mask

**Before:** a plate-like region was masked by the native call and the run continued to SAFE.
**After:** any accepted plate-shaped region BLOCKS the run outright (`PLATE_DETECTED` / `plate_detected`). The native call still detects-and-masks in one pass (no native change), but the masked artifact is discarded unconditionally and never exposed as cloud-eligible.

Rationale: the plate screen is on-device text-region geometry, not a real plate classifier. It cannot reliably distinguish a license plate from a garment brand wordmark of similar shape, and fashion text is exactly what K Scan needs to read. Masking on that signal and returning SAFE risked silently redacting the product content the app exists to identify. Conservative rejection (BLOCKED) is the correct default for Build 34; face masking is unaffected (detect → mask → continue, unchanged).

The plate detector, its geometry heuristic, and its native masking capability all remain in the tree — they are useful for the detection signal the block decision needs. Nothing was deleted; only how the boundary *uses* the result changed.

### Correction #2 — thumbnail contract: 160w, not 640w

**Before:** the Closet cloud derivative used 640w, matching this client's own local Closet UI thumbnail (`services/closetLibrary.js`).
**After:** 160w, matching B1C's authoritative cloud contract (`feature/backend-build34-closet-media-v1`, `services/closetMedia.ts`).

The local UI asset at 640w is untouched — it is a different concept (on-device display) with a different lifecycle than the artifact this module hands to B2B for cloud upload. The prior pass conflated the two; this correction keeps them separate, matching B1C rather than reinterpreting B1C to fit a client rendering preference.

### `ocrPerformed` → `recognizedTextConsumed`

Reviewed the plate capability's `ocrPerformed: false` field against what actually happens on each platform. On Android, ML Kit's bundled text recognizer *does* perform character recognition internally to produce the candidate regions — `ocrPerformed: false` would have been literally false there. Renamed to `recognizedTextConsumed`, the claim that is true on both platforms regardless of whether recognition ran under the hood: the recognized text is never read, returned, logged, or persisted. On iOS (`VNDetectTextRectanglesRequest`) no recognition happens at all, so the field is doubly true there — but the name must hold across both platforms, and only one of the two readings did.

### CRITICAL DEFECT FOUND DURING THIS CORRECTION: `privacyBoundary.ts` was never committed on iOS

While porting the plate-policy correction, discovered that `services/privacy/privacyBoundary.ts` — the file the entire fail-closed policy lives in, and the file `services/closetMediaPrivacy.ts` directly imports — **had never actually been committed to the iOS branch**, despite the original B2A commit message claiming the boundary was ported. Verified via `git ls-tree` against every commit in the iOS branch's history: the file did not exist at any point.

This is precisely the "source-only, never linked" defect class B1C/B2A exists to catch, and it went undetected because every test that appeared to exercise `privacyBoundary.ts` mocked it out at the require-map boundary (`closetMediaPrivacyBoundary.test.js`'s `buildHarness()` always injects a fake `'./privacy/privacyBoundary'`) — none of them ever actually loaded the real file from disk on iOS. Had this reached a real app build, Metro would have failed to resolve the import at bundle time.

**Root cause:** the initial cross-line port copied the files reachable by reading `privacyBoundary.ts`'s own imports (`nativeFaceEngine.ts`, `plateDetection.ts`, etc.) but never verified `privacyBoundary.ts` itself was in the copy list — an oversight in enumerating the port, not a deliberate choice.

**Fixed:** the corrected `privacyBoundary.ts` (with the plate-block policy already applied) is now committed on iOS. `__tests__/closetMediaPlatePolicy.test.js` — a new file that loads the real `privacyBoundary.ts` from disk (not mocked) and proves the face/plate/no-PII/negative-control behavior — is now committed and passing on **both** platforms.

**Deliberately NOT ported to iOS** (also discovered during the same file-list audit, but out of narrow-correction scope): `services/privacy/onDeviceMasking/**` (14 files) and `services/privacy/types.ts` existed on Android before B2A even began, but are unreachable from the active `privacyBoundary.ts` import graph — nothing in the working pipeline imports them (confirmed via `grep` across `services/`, `app/`, `components/`, `hooks/`). They are dormant, pre-existing, unrelated prototype code; porting them would add untested surface with no functional benefit.

Also not ported: four pre-existing Android-only test files (`privacyBoundaryEnforcement.test.js`, `privacyImageUploadFailClosed.test.js`, `privacyArtifactLifecycle.test.js`, `privacyUriMaterializer.test.js`) that pre-date B2A on Android. `privacyBoundaryEnforcement.test.js` in particular hardcodes Android-specific consumer paths (e.g. `services/privacyImageAdapter.android.ts`) that do not exist on iOS, so a naive port would either fail outright or require independently verifying claims about iOS's `scanIdentification.ts` / `styleObjects.ts` / `savedScanMedia.ts` behavior that this narrow pass did not investigate. **Recorded as an out-of-scope finding**, not fixed here: iOS still lacks an equivalent to that pre-existing Android-only foundation test suite, both before and after B2A.

## How plate screening actually works — stated precisely (post-correction)

Neither platform ships a first-party plate model. Screening is **on-device text-REGION detection plus a plate-shaped geometry filter**, used now purely as a BLOCK signal:

| | iOS | Android |
|---|---|---|
| Detector | `VNDetectTextRectanglesRequest` (regions only, no characters produced at all) | bundled `com.google.mlkit:text-recognition:16.0.1` (recognized characters never read) |
| Model delivery | OS framework | **bundled in APK** — no Play-Services download, works offline |
| Aspect band | 2.0 – 6.5 | 2.0 – 6.5 |
| Min relative width | 0.03 | 0.03 |
| Plate padding (irrelevant once BLOCKED, retained for the discarded native mask) | 0.25 | 0.25 |

`recognizedTextConsumed: false` is a **contract field**, not a comment, so the no-text-consumption claim is auditable.

**`no_plates` means "nothing plate-shaped was found", not "there is no plate."** A false NEGATIVE (a real plate the geometry filter misses) proceeds to SAFE unblocked — the same residual risk this architecture always carried, unchanged by this correction. A false POSITIVE (ordinary garment text in the plate-shaped band) now means a legitimate photo is BLOCKED rather than silently mis-redacted — the safer failure direction for a fashion product, at the cost of availability rather than privacy.

## Result contract B2B consumes

```
sanitizeClosetMedia(localUri, { signal? }) -> ClosetMediaSanitizationResult

SAFE:    primary (1440w JPEG) + thumbnail (160w JPEG, B1C-aligned), both
         derived from the SAME verified sanitized source, mimeType,
         sanitizerVersion, proof, privacyScanCompleted: true,
         metadataStripped: true, cleanup()
BLOCKED: reason (closed vocabulary, now including 'plate_detected' and
         'face_sanitization_failed'), detail, proof, no artifact
```

B2B must branch on `status`. File existence is never evidence of privacy — a run whose proof does not attest completion returns BLOCKED even though both files were written (and they are then deleted).

## Regression

### Original pass (superseded by the correction-pass numbers below; kept for the record)

| Run | tests | pass | fail |
|---|---|---|---|
| iOS baseline (`a6962b9`) | 5430 | 5424 | 1 |
| iOS B2A (`53db817`) | 5481 | 5476 | 0 |
| Android baseline (`f893568`) | 5397 | 5393 | 0 |
| Android B2A (`3185163`) | 5433 | 5428 | 1 |

### Correction pass (clean sequential runs, no concurrency) — FINAL

| Run | tests | pass | fail |
|---|---|---|---|
| **iOS corrected** (`1d2d19c`) | 5491 | 5486 | **0** |
| **Android corrected** (`c63425b`) | 5443 | 5438 | **1** |

**Zero new regressions.** The single Android failure, `__tests__/oauthCallback.test.js` ("native Apple sign-in retains the nonce and CNG capability contract"), is classified **FLAKY — PROVEN**: it also appeared in the iOS baseline and in a prior full run of this same Android tree, passes 3/3 in isolation on this corrected HEAD, and passes 3/3 in isolation on the parent commit. It is unrelated to this phase (the correction pass touches no auth code).

An earlier iOS baseline attempt was discarded rather than reported: it ran under concurrency with another platform's install/test job, aborted 17 whole test files, and executed 319 fewer tests. Every number reported above comes from a run executed alone.

## Verification status — what is and is not proven

| Gate | Status |
|---|---|
| Source complete (both platforms) | YES, including the fix for the missing `privacyBoundary.ts` on iOS |
| JS/TS contract tests + negative controls | PASS (iOS 46, Android 51 across the three B2A test files, all green) |
| Autolinking wiring guard | PASS |
| Android native compile | **PASS** — `./gradlew :kscan-pii-native:compileDebugKotlin` BUILD SUCCESSFUL both before AND after the correction (re-verified post-correction, 1m47s incremental). Expo autolinking discovered `kscan-pii-native (1.0.0)`; the bundled ML Kit text artifact resolved; zero warnings or errors from this module. |
| iOS native compile | **NOT RUN** — no Xcode (Windows host) |
| Physical-device privacy proof | **NOT RUN** — no devices |

No claim is made that face or plate masking has been observed working on a device. The JS-level tests prove the CONTRACT (fail-closed, no raw fallback, no thumbnail leak, machine-readable reasons, plate-detected blocks rather than masks); they cannot prove pixel-level redaction or the plate geometry heuristic's real-world accuracy. That requires the device gate.

## Findings for the owner

1. **RESOLVED — plate contract.** Was: a geometry screen masked plate-shaped regions (which could be garment text) and returned SAFE. Now: any accepted plate-shaped region BLOCKS outright; nothing is silently redacted.
2. **RESOLVED — thumbnail contract.** Was: 640w (client UI value). Now: 160w (B1C's authoritative cloud value). The local 640w UI asset is untouched.
3. **RESOLVED (this pass) — missing `privacyBoundary.ts` on iOS.** A genuine source-only/never-linked defect, found and fixed during this correction; see above.
4. **P2 — plate false positives now cost availability, not privacy.** Because a detected plate BLOCKS rather than masks, a garment with plate-shaped text (aspect ratio 2.0–6.5, minimum relative size) will be rejected for cloud sync even though it contains no PII. This is the accepted tradeoff for Build 34 (conservative rejection over a confident guess), but the false-positive RATE is unmeasured — no device corpus has been run through the heuristic. Needs device validation before the block gate is treated as tuned rather than merely safe.
5. **P1 — the passthrough sanitizer is still live on two other cloud paths.** `services/savedScanMedia.ts` (saved-scan cloud upload) and `components/style-chat/StyleChatPhotoIntake.tsx` both call `sanitizeImageBeforeUpload`, which remains a no-op. Out of scope for both the original B2A pass and this correction; same defect class B1C found, still shipping.
6. **P3 — cross-line divergence, unresolved and non-blocking.** The Android line still carries a stale copy of the iOS podspec (missing the `exclude_files` archive-scope fix) — confirmed harmless: re-verified via read-only `git show` that Android's Gradle build never touches CocoaPods, and the Android native compile succeeded both before and after this correction. iOS also does not carry Android's four pre-existing dormant-foundation test files (see the "Deliberately NOT ported" section above) — a genuinely separate, larger gap than the podspec one, recorded for a future parity/convergence pass, not fixed here.

### Autolinking, proven at build time rather than asserted

The Gradle run is the §23 evidence, not an inference: Expo's autolinking step listed `kscan-pii-native (1.0.0)` among the linked modules and Gradle then executed `:kscan-pii-native:compileDebugKotlin` to completion, both before and after the correction. A source-only native module would have appeared in neither.

The iOS half cannot be compiled on this Windows host, so its autolinking is asserted only structurally (config/podspec/registration guards), not observed.

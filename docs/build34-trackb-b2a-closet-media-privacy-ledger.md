# Build 34 / Track B / Phase B2A — On-Device Closet Media Privacy Boundary: Ledger

Status: **SOURCE COMPLETE — NATIVE COMPILE + DEVICE PRIVACY GATE REQUIRED**
Phase: B2A (local sanitization only — no upload, no sync, no network)
Production: **NOT TOUCHED**. Backend: **NOT MODIFIED**.

Predecessor contract: B1C (`feature/backend-build34-closet-media-v1` @ `c7fddfd`).

## Why this phase existed

B1C proved the cloud media contract *and* proved that `services/privacyImageSanitizer.js` was a passthrough: it declared `faceBlurApplied: false` / `plateMaskApplied: false` and returned its input unchanged. Uploading Closet media through that would have shipped unmasked PII. B2A closes the local boundary that must exist before B2B may upload anything.

## What was already there (and what actually blocked the gate)

The engine was **not** missing. `modules/kscan-pii-native` already contained a real, mature on-device face pipeline — decoder, box normalizer, redactor, output verifier, cache manager — with Apple Vision on iOS and **bundled** ML Kit on Android, and it had previously reached a real EAS archive build.

The single blocking gap was **license-plate screening**: `services/privacy/plateDetection.ts` was an explicitly-unsupported stub whose only job was keeping `isImageDispatchAllowed()` false.

So B2A is a repair/activation, not a rewrite.

## The cross-line divergence this phase surfaced

`services/privacy/**` — the whole fail-closed boundary (artifact store, URI materializer, native bridges, proof, two-state dispatch gate) — **existed only on the Android line**. The iOS K+ foundation had none of it and still carried the old permissive `privacyImageUpload.ts` whose `isPrivateImageUploadAvailable()` returns `true`.

B2A ports that foundation to iOS as **dormant** code (nothing routes through it) and deliberately does **not** touch iOS's live `privacyImageUpload.ts`, so no existing iOS image flow changes behaviour.

## Two defects fixed that were unreachable while the gate was closed

1. **`no_faces` produced no artifact.** The boundary requires a sanitized artifact, so once the plate gate opened, every face-free image — i.e. most Closet garment photos — would have been BLOCKED. Sanitization now always emits a re-encoded (metadata-free) verified output; masking is orthogonal.
2. **The proof claimed masking from detection.** `platesMasked` was derived from the plate screen having *run*, not from regions being *obscured*. It now comes from actual masked-region counts, and a run that accepted regions but masked fewer is BLOCKED.

## How plate screening actually works — stated precisely

Neither platform ships a first-party plate model. Screening is **on-device text-REGION detection plus a plate-shaped geometry filter**:

| | iOS | Android |
|---|---|---|
| Detector | `VNDetectTextRectanglesRequest` (regions only, no characters produced at all) | bundled `com.google.mlkit:text-recognition:16.0.1` (recognized characters never read) |
| Model delivery | OS framework | **bundled in APK** — no Play-Services download, works offline |
| Aspect band | 2.0 – 6.5 | 2.0 – 6.5 |
| Min relative width | 0.03 | 0.03 |
| Plate padding | 0.25 | 0.25 (aligned to iOS in this phase) |

`ocrPerformed: false` is a **contract field**, not a comment, so the no-OCR claim is auditable.

**`no_plates` means "nothing plate-shaped was found", not "there is no plate."** It is a screen, not a guarantee.

## The product risk that needs an owner decision

A geometry filter cannot distinguish a licence plate from any other text of similar shape. In a wardrobe app that means **a brand wordmark printed across a garment can be masked** — the exact content the product exists to identify. The error direction is deliberately toward over-masking (privacy-safe, product-costly). This must be validated on real devices before the gate is opened for uploads.

## Result contract B2B consumes

```
sanitizeClosetMedia(localUri, { signal? }) -> ClosetMediaSanitizationResult

SAFE:    primary + thumbnail (both JPEG, both derived from the SAME verified
         sanitized source), mimeType, sanitizerVersion, proof,
         privacyScanCompleted: true, metadataStripped: true, cleanup()
BLOCKED: reason (closed vocabulary), detail, proof, no artifact
```

B2B must branch on `status`. File existence is never evidence of privacy — a run whose proof does not attest completion returns BLOCKED even though both files were written (and they are then deleted).

## Regression (four clean sequential runs, no concurrency)

| Run | tests | pass | fail |
|---|---|---|---|
| iOS baseline (`a6962b9`) | 5430 | 5424 | 1 |
| **iOS B2A** (`53db817`) | 5481 | 5476 | **0** |
| Android baseline (`f893568`) | 5397 | 5393 | 0 |
| **Android B2A** (`3185163`) | 5433 | 5428 | **1** |

**Zero new regressions.** The only failure on either side is
`__tests__/oauthCallback.test.js` ("native Apple sign-in retains the nonce and
CNG capability contract"), classified **FLAKY — PROVEN**: it appears in the iOS
*baseline* and in one Android B2A run, passed in a different Android B2A run,
and passes 3/3 in isolation on B2A HEAD and on the parent commit on both
platforms. It is unrelated to this phase (B2A touches no auth code).

An earlier iOS baseline attempt was discarded rather than reported: it ran
under concurrency with another platform's install/test job, aborted 17 whole
test files, and executed 319 fewer tests. All four numbers above come from
runs executed one at a time.

## Verification status — what is and is not proven

| Gate | Status |
|---|---|
| Source complete (both platforms) | YES |
| JS/TS contract tests + negative controls | PASS (36/36 on each line) |
| Autolinking wiring guard | PASS |
| Android native compile | **PASS** — `./gradlew :kscan-pii-native:compileDebugKotlin` BUILD SUCCESSFUL (4m59s). Expo autolinking discovered `kscan-pii-native (1.0.0)`; the bundled ML Kit text artifact resolved; zero warnings or errors from this module. |
| iOS native compile | **NOT RUN** — no Xcode (Windows host) |
| Physical-device privacy proof | **NOT RUN** — no devices |

No claim is made that face or plate masking has been observed working on a
device. The JS-level tests prove the CONTRACT (fail-closed, no raw fallback, no
thumbnail leak, machine-readable reasons); they cannot prove pixel-level
redaction. That requires the device gate.

## Findings for the owner

1. **P1 — the passthrough sanitizer is still live on two other cloud paths.**
   `services/savedScanMedia.ts` (saved-scan cloud upload) and
   `components/style-chat/StyleChatPhotoIntake.tsx` both call
   `sanitizeImageBeforeUpload`, which remains a no-op. B2A deliberately did not
   fix these (out of scope, and they are separate egress routes), but they are
   the same defect class B1C found, still shipping.
2. **P1 — geometry cannot distinguish a plate from garment text.** A brand
   wordmark in the accepted aspect band will be masked. Privacy-safe direction,
   real product cost in a wardrobe app. Needs a device-validated decision before
   the gate opens.
3. **P2 — B1C's thumbnail constant disagrees with the client.** B1C recorded
   160 (from the backend line's stale `closetLibrary.js`); both client lines use
   640. B2A emits 640. Reconcile to one value before B2B uploads.
4. **P3 — cross-line divergence.** The Android line carries a stale copy of the
   iOS podspec (missing the `exclude_files` archive-scope fix) and now a stale
   iOS half without plate screening. Harmless while that line never builds iOS
   for release; must be resolved at convergence.

### Autolinking, proven at build time rather than asserted

The Gradle run above is the §23 evidence, not an inference: Expo's autolinking
step listed `kscan-pii-native (1.0.0)` among the linked modules and Gradle then
executed `:kscan-pii-native:compileDebugKotlin` to completion. A source-only
native module would have appeared in neither.

The iOS half cannot be compiled on this Windows host, so its autolinking is
asserted only structurally (config/podspec/registration guards), not observed.

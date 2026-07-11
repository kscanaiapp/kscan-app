# CROSS-PLATFORM NATIVE FACE MASKING PARITY REPORT

## BASELINE
- **Repository:** C:\src\KScan-KC05-repair-20260710-144442
- **Branch:** feature/native-pii-detector-integration
- **Starting tag:** on-device-pii-poc-audited-2026-07-10
- **Starting commit:** e3396b83c6655c6f871e648a1e1ead30b2a38d73
- **Final commit:** bbb6e799ae08e3b8322b68619d3c97604157e55a

## PROJECT CONFIGURATION
- **Expo SDK:** ~54.0.35
- **React Native:** 0.81.5
- **Expo Modules Core:** 3.0.30
- **Android root directory:** present
- **iOS root directory:** absent
- **Android Gradle Plugin:** 8.11.0
- **Gradle:** 8.14.3
- **Kotlin:** 2.1.20
- **Android SDK levels:** minSdk 24, targetSdk 36, compileSdk 36
- **iOS deployment target:** 15.1
- **New Architecture:** true
- **Autolinking status:** discovered `kscan-pii-native` via Expo autolinking

## SHARED CONTRACT
- **Module name:** kscan-pii-native
- **Public functions:** getPrivacyCapabilities, detectAndMaskFaces, cleanupSanitizedImage
- **Status values:** success, no_faces, unsupported, failed
- **Error codes:** INVALID_INPUT, INVALID_URI, UNSUPPORTED_SCHEME, UNSUPPORTED_FORMAT, IMAGE_TOO_LARGE, DECODE_FAILED, ORIENTATION_FAILED, DETECTOR_UNAVAILABLE, DETECTION_FAILED, INVALID_REGION, MASKING_FAILED, ENCODING_FAILED, VERIFICATION_FAILED, CLEANUP_REJECTED, CLEANUP_FAILED, INTERNAL_ERROR
- **Sanitizer version:** native-face-mask-poc-1.0.0
- **Accepted URI schemes:** file
- **Accepted MIME types:** image/jpeg, image/png
- **Output format:** image/png
- **Dimension limits:** 4096x4096, 16,777,216 pixels
- **Padding:** default 0.15, min 0.0, max 0.5
- **Rounding:** floor(start), ceil(end)
- **IoU:** 0.5
- **Redaction color:** opaque black
- **Checksum algorithm:** fnv1a-dual-lane-64

## ANDROID IMPLEMENTATION
- **Detector:** bundled Google ML Kit Face Detection
- **Dependency and version:** com.google.mlkit:face-detection:16.1.7
- **Bundled model:** yes (static artifact)
- **Dynamic model present:** no
- **Image decoder:** BitmapFactory + ExifInterface
- **Orientation normalization:** EXIF rotation and mirror normalization
- **Redactor:** Bitmap mutable copy + Canvas opaque black fill
- **PNG encoder:** Bitmap.compress PNG
- **Persisted verifier:** BitmapFactory re-decode + pixel black-region verification + checksum
- **Cache manager:** module-owned `kscan-pii-native/` cache namespace
- **Unit tests:** Kotlin JUnit (constants, checksums, box normalization, deduplication, sorting)
- **Instrumentation tests:** Kotlin AndroidJUnit + Robolectric (decode, redaction, encode, verify, cleanup)
- **Debug build:** passed (`:app:assembleDebug`)
- **Device validation:** not performed; emulator offline

## IOS IMPLEMENTATION
- **Detector:** Apple Vision VNDetectFaceRectanglesRequest
- **Frameworks:** Vision, CoreGraphics, ImageIO, Foundation
- **Image decoder:** CGImageSource + ImageIO properties
- **Orientation normalization:** ImageIO orientation + CGContext rotation/mirror
- **Vision coordinate conversion:** bottom-left origin converted to top-left
- **Redactor:** CGContext opaque black rectangle fill
- **PNG encoder:** CGImageDestination PNG
- **Persisted verifier:** CGImageSource re-decode + pixel black-region verification + checksum
- **Cache manager:** module-owned `kscan-pii-native/` cache namespace
- **XCTest source:** Swift tests covering constants, checksums, box normalization, deduplication, sorting, cleanup
- **macOS compilation:** pending (macOS/Xcode unavailable on Windows)
- **Simulator/device validation:** pending
- **Pending reason:** Validation environment is Windows; no Xcode toolchain available

## PARITY MATRIX
| Aspect | Parity |
|--------|--------|
| Public API parity | yes |
| Status parity | yes |
| Error parity | yes |
| Input parity | yes |
| Dimension parity | yes |
| Orientation parity | corrected in source, unverified at runtime -- see ORIENTATION AUDIT below |
| Box-normalization parity | yes |
| Padding parity | yes |
| Rounding parity | yes (floor start, ceil end) |
| Deduplication parity | yes (IoU 0.5) |
| Redaction parity | corrected in source (already-redacted regions), unit/instrumentation-tested on Android, unverified on iOS runtime -- see REPAIR AUDIT below |
| Encoding parity | yes (PNG) |
| Verification parity | yes |
| No-face parity | yes |
| Failure parity | yes |
| Cleanup parity | yes |
| Retention parity | yes |
| Logging parity | yes (count/status only) |
| Checksum parity | yes (FNV-1a dual-lane-64 verified TypeScript/Kotlin) |

## REPAIR AUDIT (applied on top of the commit range above)
A follow-up source audit against this branch found and fixed 6 confirmed defects, all within `modules/kscan-pii-native/**`, `services/privacy/onDeviceMasking/nativeAdapter.ts`, and their tests:

1. **Android detector coroutine failure never resumed** (`AndroidFaceDetector.kt`): `.addOnFailureListener { throw it }` threw on ML Kit's own executor thread, not the suspended coroutine's context, so the coroutine never resumed and detection would hang indefinitely on any ML Kit failure. Fixed with `continuation.resumeWithException(it)`.
2. **Android bitmap use-after-recycle** (`AndroidOutputVerifier.kt`): `bitmap.width`/`bitmap.height` were read after `bitmap.recycle()` in two places (the dimension-mismatch error message and the pixel-verification/output-dimension logic). Fixed by capturing both dimensions into local variables before recycling.
3. **Cache ownership bare-prefix bypass** (`AndroidCacheManager.kt`, `IOSCacheManager.swift`): both platforms accepted any path whose string representation merely started with the cache directory's path, which would incorrectly treat a sibling directory such as `kscan-pii-native-evil/` as owned. Fixed to require an exact match or a path-separator-bounded child path; the iOS fix additionally now resolves symlinks and standardizes both the candidate path and the cache directory before comparing (previously only the candidate path was partially resolved).
4. **Already-redacted regions incorrectly failed** (`AndroidFaceRedactor.kt`, `IOSFaceRedactor.swift`, `nativeAdapter.ts`): the masking-invariant check used the total accepted region count instead of the subset that actually needed a pixel change, so a region that was already fully opaque black (a legitimate outcome) could trip a false failure. Fixed to gate on `regionsChanged`, not total accepted count. The iOS `isRegionAlreadyBlack` also had a nonsensical `width * 1000000` placeholder bound instead of a real image-height bound; replaced with a height computed from the actual pixel buffer. The TypeScript adapter used `pixelsChanged` as a required condition for `mode: 'masked'` / transmission safety, which would incorrectly reject an already-redacted (legitimately masked, byte-identical) result; changed to gate on `facesMasked > 0` and a present `sanitizedUri` instead.
5. **iOS EXIF `.left`/`.right` rotation swapped** (`IOSImageDecoder.swift`): the non-mirrored left/right rotation directions were reversed. Corrected in source. Mirrored variants were left unchanged (direct inspection did not show them to be wrong).
6. **Test fixtures used a real, resolvable domain** (`https://example.com`) for negative-path (unsupported-scheme) test cases in two files. Replaced with `https://example.invalid` (RFC 2606 reserved, guaranteed non-resolving), even though no runtime code path ever calls it.

Regression tests were added for all 6 (cache-ownership boundary tests for sibling-directory/traversal/arbitrary-path/network-URI on both platforms; 6 new executable TypeScript adapter tests bringing `__tests__/nativePiiParity.test.js` from 13 to 19). One existing Android instrumentation test (`redactAlreadyBlackRegionReportsNoChange`) already asserted the post-fix behavior and would have failed against the pre-fix code -- independent evidence the defect was real, not speculative.

## ORIENTATION AUDIT
The `.left`/`.right` EXIF rotation direction fix (REPAIR AUDIT item 5) is a source-level correction only. It has not been validated against a real rotated-EXIF photograph on either a simulator or device, because no macOS/Xcode toolchain is available in this (Windows) environment to compile and run `IOSImageDecoder`. Treat orientation parity as **unverified at runtime** until the macOS validation workflow below has been run with a real left/right-rotated JPEG fixture and the output visually or programmatically confirmed upright.

## MACOS VALIDATION WORKFLOW (required before iOS runtime parity can be claimed)
This workflow must be run on a macOS machine with Xcode installed. Do not invent workspace or scheme names -- discover them from the actual generated project.

1. Create a disposable clone or worktree of this branch (do not run prebuild in the primary working copy):
   `git clone <repo-url> /tmp/kscan-ios-validation && cd /tmp/kscan-ios-validation && git checkout feature/native-pii-detector-integration`
2. `npm ci`
3. Run Expo iOS prebuild *only inside the disposable workspace*: `npx expo prebuild --platform ios`
4. `cd ios && pod install`
5. Discover the actual workspace and scheme (do not assume names): `xcodebuild -list -workspace *.xcworkspace`
6. Discover an available simulator: `xcrun simctl list devices available`
7. Build: `xcodebuild build -workspace <discovered>.xcworkspace -scheme <discovered-scheme> -destination 'platform=iOS Simulator,name=<discovered-device>'`
8. Run the native module's XCTest target: `xcodebuild test -workspace <discovered>.xcworkspace -scheme <discovered-scheme> -destination 'platform=iOS Simulator,name=<discovered-device>'`
9. If a physical device is available, repeat the build/test in Debug configuration on-device and run a real (not synthetic) rotated-photo fixture through `IOSImageDecoder` to confirm the orientation fix.
10. Record pass/fail, discovered workspace/scheme names, and simulator/device identifiers in an updated copy of this report. Do not merge or promote this branch based on source-only validation.

## CHECKSUM PARITY
- **TypeScript vectors:** parity-fixtures.json generated from audited POC algorithm
- **Kotlin vectors:** Android unit tests pass against same fixtures
- **Swift vectors:** source implemented; pending macOS compile/run
- **Exact match:** TypeScript and Kotlin match

## ANDROID TESTS
- **Unit tests:** re-verified after REPAIR AUDIT fixes -- 7/7 pass (`:kscan-pii-native:testDebugUnitTest`, BUILD SUCCESSFUL in 41s)
- **Instrumentation tests:** compiled (including the 4 new cache-ownership-boundary tests), not executed -- emulator-5554 offline, no working device available in this environment
- **assembleDebug:** re-verified after REPAIR AUDIT fixes -- passed (`:app:assembleDebug`, BUILD SUCCESSFUL in 1m 27s)
- **Device/emulator:** emulator-5554 offline (confirmed via `adb devices` immediately before this pass)
- **Real-face test:** not performed
- **No-face test:** instrumentation source covers synthetic no-face bitmap
- **Output verification:** covered in instrumentation source
- **Cleanup verification:** covered in instrumentation source, including the 4 new cache-ownership-boundary cases (sibling directory, relative traversal, arbitrary path, network URI)

## IOS TESTS
- **Swift/XCTest:** complete source added
- **Simulator build:** pending macOS
- **Simulator tests:** pending macOS
- **Device:** pending
- **Real-face test:** pending
- **No-face test:** source covers synthetic no-face image path
- **Output verification:** source covers re-decode + black-region verification
- **Cleanup verification:** source covers ownership rejection and deletion
- **Mac validation performed:** no
- **Reason if pending:** Windows environment; macOS/Xcode unavailable

## SHARED TESTS (re-verified after REPAIR AUDIT fixes)
- **Parity tests:** 19/19 pass (was 13 before REPAIR AUDIT; +6 executable adapter tests)
- **POC tests:** 66/66 pass (unchanged by this repair pass)
- **Foundation tests:** 56/56 pass (unchanged by this repair pass)
- **Full Node suite:** 980 tests passed (was 974 before REPAIR AUDIT; +6 new adapter tests)
- **TypeScript:** passed (`npx tsc --noEmit`)
- **Expo config:** resolved (`npx expo config --type public`)
- **Expo Doctor:** 17/18 -- 1 pre-existing non-CNG warning; no new fatal errors

## NETWORK AND RETENTION
- **Android network code:** none
- **iOS network code:** none
- **Dynamic detector download:** no (bundled ML Kit artifact)
- **Original copies retained:** no
- **Face crops retained:** no
- **Coordinates persisted:** no
- **Debug images retained:** no
- **EXIF copied:** no
- **GPS copied:** no
- **Global state:** no

## ISOLATION
- **Scanner modified:** no
- **Camera screen modified:** no
- **Upload flow modified:** no
- **Navigation modified:** no
- **API client modified:** no
- **Backend modified:** no
- **Active imports:** only the inactive adapter `services/privacy/onDeviceMasking/nativeAdapter.ts`
- **Permissions added:** none
- **Identifiers changed:** none
- **Versions changed:** none
- **Signing changed:** none

## VALIDATION
- **Parity tests:** pass
- **POC tests:** pass
- **Foundation tests:** pass
- **Full Node suite:** pass
- **TypeScript:** pass
- **Expo config:** resolves
- **Expo Doctor:** 1 pre-existing non-CNG warning
- **Android debug build:** pass
- **Android unit tests:** pass
- **Android instrumentation tests:** compiled, not executed
- **iOS build:** pending macOS
- **iOS tests:** pending macOS
- **git diff --check:** clean
- **Protected-path diff:** no output
- **Working tree:** clean

## PRODUCTION FREEZE
- **EAS build:** not started
- **Release APK/AAB:** not created
- **Production IPA:** not created
- **TestFlight:** not submitted
- **Google Play:** not uploaded
- **Supabase:** not deployed
- **Render:** not deployed
- **SQL:** not executed
- **Remote flags:** not changed
- **Credentials:** not changed
- **Production data:** not changed
- **Branch merged:** no

## PHASE STATUS
- **Android source complete:** yes
- **Android build complete:** yes
- **Android unit tests complete:** yes
- **iOS source complete:** yes
- **iOS tests written:** yes
- **iOS build complete:** no (pending macOS)
- **iOS tests compiled/run:** no (pending macOS)
- **Source parity complete:** yes
- **Runtime parity verified:** no (iOS runtime unavailable)
- **Partial blockers:** macOS/Xcode environment required to compile and run iOS tests

## SAFETY VERDICT
- **Safe to push:** yes
- **Safe to merge:** no
- **Safe to activate:** no
- **Risk to current tester apps:** none (module is inactive and unimported by app code)
- **Reason:** iOS compilation and runtime parity are unverified; the module has no active consumers

## KNOWN GAPS
- **Phone-camera integration:** not implemented
- **Photo-library integration:** not implemented
- **Plate detection:** not implemented
- **Wearable relay:** not implemented
- **Backend transmission:** not implemented
- **Physical Android validation:** not performed
- **Physical iOS validation:** not performed
- **Production privacy validation:** pending later audit

## RECOMMENDED NEXT STEP
- **Required audit:** iOS compile and test run on macOS
- **Missing validation:** iOS simulator build/test; Android instrumentation tests on emulator/device; real-face fixture test on both platforms
- **Next integration branch:** feature/phone-privacy-capture (future work)
- **Actions still prohibited:** camera integration, scanner integration, upload integration, release builds, deployment, merging this branch

# K Scan AI — Android Google Play readiness

**Current source basis:** Build 35 integration at `ca5c13611543ebc8faff873160182974ae0d408b` after merged PR #564, 2026-10-12.  
**Authoritative store-copy draft:** [GOOGLE_PLAY_METADATA_BUILD35_20261012.md](build35/android/GOOGLE_PLAY_METADATA_BUILD35_20261012.md).  
**Status:** GitHub copy prepared; **not** proof that Play Console has been updated or that a signed Android build passed review.

> The July 8, 2026 version of this note was superseded. In particular, **Voice Scan is no longer merely a Coming Soon placeholder**; the current production source enables user-initiated native Voice Scan, and the Play listing/Data Safety must not claim Android has no microphone capability. Similarly, current source enables Multi-image Scanner, Cloud Closet, Packing Intelligence, Smart Watchlist and the VTO UI. **Elise spoken replies and Today With Elise are OFF** in the snapshot; do not advertise them as live.

## Where to update

The complete English (US) Play title, short/full descriptions and update notes, Android privacy/Data Safety decision worksheet, feature truth matrix, reviewer access, asset and Google Play App Content actions are in the linked Build 35 Android metadata package.

This file remains as a stable pointer for the previous release checklist, so no one can inadvertently reuse obsolete text in Play Console. The following tasks must be completed in **Play Console**, not by merging documentation:

- Main Store Listing text and final Android screenshots/icon/feature graphic.
- What's New/update notes on the intended testing/production track.
- Data Safety based on **final AAB** data collection/sharing and third-party SDKs.
- Account deletion and privacy policy links, correct legal claims about cloud image processing and non-universal PII masking.
- App Access/reviewer instructions, content rating, target audience and Families, ads/Advertising ID, permissions and AI/UGC declarations.
- Play versionCode/upload key, App Signing/App Links domain proof, subscription/base-plan/RevenueCat credential + sandbox billing verification.

## Verified Android source posture (not a Play Console certificate)

- `com.kscanai.app`, checked-in version `1.0.1`, source versionCode `23`; EAS uses **remote** Android versioning. Do not assume `23` is the next upload value.
- Native Android project is authoritative; current Gradle source targets API 36.
- `production` uses a store-distributed AAB; current intended Voice Scan and Smart Watchlist capabilities require final merged-manifest verification.
- The public privacy policy https://kscan.app/legal/privacy and account deletion URL https://kscan.app/legal/delete-account are available; ensure their statements still match actual final behavior before public submission.
- Internal Build 35 numbering is not customer-facing marketing copy.

For full source-gate context, see [ANDROID_GOOGLE_PLAY_COMPLIANCE_MATRIX.md](build35/android/ANDROID_GOOGLE_PLAY_COMPLIANCE_MATRIX.md) and [ANDROID_POSTBUILD_TEST_HANDOFF.md](build35/android/ANDROID_POSTBUILD_TEST_HANDOFF.md).

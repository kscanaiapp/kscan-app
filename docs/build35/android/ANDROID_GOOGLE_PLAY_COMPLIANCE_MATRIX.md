# Android Google Play Compliance Matrix — Build 35

**Scope:** Pre-build source/configuration readiness. Play Console metadata and artifact-generated facts are not asserted without direct proof.

| Requirement | Pre-build status | Evidence / disposition |
| --- | --- | --- |
| Package identity | **PASS** | Native namespace/applicationId and app config resolve `com.kscanai.app`. |
| Target API | **PASS** | Exact Gradle resolution: targetSdk 36, compileSdk 36, minSdk 24. Current Play update requirement is API 36+. |
| Store artifact profile | **PASS** | EAS `production`: store distribution, Android App Bundle, remote version source, autoIncrement. |
| Restricted/sensitive permissions | **PASS source-level** | Default production suppresses microphone, notifications, fine/background location, broad media/storage, boot and unused FGS capabilities. Camera and coarse location are the intended first-party permissions. |
| Advertising ID | **PASS source-level** | Android compliance tests reject AD_ID; privacy policy says K Scan does not use Advertising ID. Final merged artifact still requires post-build inspection. |
| Photo/media access | **PASS source-level** | Uses selective picker architecture; broad storage/media permissions are blocked by native authority/tests. |
| Voice/microphone | **PASS source-level** | Ordinary production Voice is OFF and RECORD_AUDIO is removed. Voice overlays remain separately governed for authorized future variants. |
| Notifications | **PASS source-level** | Ordinary production Watchlist/push is OFF and POST_NOTIFICATIONS is removed. |
| Google Play Billing client | **PASS source-level** | RevenueCat native adapter uses authenticated actor, store-derived products/terms, purchase/restore lifecycle, canonical entitlement refresh. |
| Google Play Billing live configuration | **ACTION REQUIRED before runtime certification** | RevenueCat Play app exists and products/offering are attached, but Google Play service-account credentials are not configured. |
| Subscription disclosure | **PASS source-level** | Paywall shows store-derived price/frequency and renewal/cancellation terms; trial copy appears only when store eligibility is authoritative; Restore and legal links are reachable. |
| Canonical entitlement authority | **PASS** | Android store success does not directly grant K+; canonical backend entitlement is re-read. |
| Account deletion in app | **PASS source-level** | Privacy screen has discoverable Delete Account entry, confirmation, request handling and truthful grace-period/deactivation language. |
| External deletion request | **PASS web presence** | `https://kscan.app/legal/delete-account` is live and provides external request instructions in addition to the in-app path. |
| Privacy policy | **PASS web/source presence** | `https://kscan.app/legal/privacy` is live and describes Android location/microphone/SDK/data handling. |
| Data Safety form | **NOT CERTIFIED PRE-BUILD** | Live Play Console answers were not available. Must be reconciled against final artifact + SDK inventory before submission. |
| App content / target audience / Families | **NOT CERTIFIED PRE-BUILD** | Play Console values were not available. Owner must confirm before submission. |
| Reviewer app access | **NOT CERTIFIED PRE-BUILD** | If login/paywall restricts review surfaces, provide reusable reviewer credentials/instructions in Play Console. |
| Deep links / App Links source | **PASS source-level** | MainActivity owns `kscan://` callback and verified HTTPS `kscan.app/rooms` intent filter. |
| App Links signing/domain proof | **POST-BUILD / PRE-SUBMISSION** | Validate public `assetlinks.json` against the final Play App Signing certificate; not inferred from source. |
| Advertising/ads declaration | **PASS source posture / console pending** | No Advertising ID source permission. Console declaration still requires owner confirmation. |
| 16 KB page-size compatibility | **POST-BUILD** | Source/native dependency plan is present; final AAB and Play-generated APK ELF alignment must be inspected. |
| R8/minification | **PASS source-level** | Release minification resolves enabled. Runtime behavior belongs to post-build smoke. |
| Signing | **POST-BUILD** | Verify final EAS signing/upload certificate and Play App Signing relationship. |
| Final versionCode | **POST-BUILD / PRE-UPLOAD** | Checked-in 23 is not authoritative; EAS remote versioning + autoIncrement is configured. Verify produced code is greater than Play's consumed maximum. |
| Firebase/FCM | **PASS for held release source** | Remote push is OFF in production, so Google Services is not a launch dependency for this held source. If push is later enabled, native Gradle intentionally fails closed without governed Google Services configuration. |
| Account deletion backend lifecycle | **OWNER-DEFERRED SHARED RISK** | DEL-01/backend lifecycle work is Build 36 scope; request entry and external deletion resource remain required now. |
| AI / UGC declarations | **PRE-SUBMISSION OWNER ACTION** | Reconcile final release feature surface against Play Data Safety/App Content/AI/UGC declarations; do not infer live Console answers from source. |

## Current policy references

The certification campaign checked current Google Play / Android policy, including:

- Target API level: https://support.google.com/googleplay/android-developer/answer/11926878
- User data/account deletion: https://support.google.com/googleplay/android-developer/answer/10144311
- Data Safety: https://support.google.com/googleplay/android-developer/answer/10787469
- Payments: https://support.google.com/googleplay/android-developer/answer/15748846
- 16 KB page sizes: https://developer.android.com/guide/practices/page-sizes

## Store/config dependencies that do not require source repair

1. Configure RevenueCat Google Play service-account credentials before Android billing sandbox/lifecycle certification.
2. Verify Play subscription/base-plan/offer state through store-authoritative tooling before paid rollout.
3. Verify final versionCode against Play after EAS remote auto-increment.
4. Verify Play App Signing certificate against App Links.
5. Complete Data Safety, reviewer access, target audience/content-rating, AI/UGC and subscription declarations using the final built surface.

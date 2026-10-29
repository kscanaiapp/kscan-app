# Platform candidate audit handoff — NOT READY / PARTIAL

Final candidate SHA: NOT SELECTED. Do not build from an assumed converged source.

- Source authorities and unresolved RP-108 gate: build35-source-convergence-ledger.md.
- #644 shared client repair: malformed secondary fields, focused 22/22. Verify malformed responses never disrupt main results on both platforms.
- #645 shared consent repair: explicit Gemini photos/text disclosure, v2_google_gemini acceptance. Verify existing v1 and new users cannot send through Scanner/Elise before current consent; check decline, offline acceptance, auth switching and accessibility on both devices. Binding legal documents unchanged; legal/privacy review still needed.
- Integration baseline has RevenueCat native packages and Live VTO module absent from pre-freeze. Do not resolve by wholesale backend overwrite.
- Build profiles differ by lineage. Inspect effective production / production-certification / build35-release definitions and native resources from the owner-selected final SHA; profile names alone are not certification. No native changes made here.
- Signed-artifact checks remain: permissions, privacy manifests, SDK/resource packaging, signing/entitlements, store pricing/offer readback, account deletion, paywall/restore, FCM/APNs receipts, mouth/timestamp alignment, native Live VTO and all revoked-permission paths.
- All physical-device scenarios NOT TESTED. No iOS/Android signed-artifact certification or store-submission approval claimed.
- No EAS build, IPA, AAB, APK, upload or submission was generated during this campaign. No Production mutation, price change, commercial activation or customer deletion performed.

Resume order F → B → C → G → D → E → H → A. Use checkpoint and mandatory probe inventory; do not repeat already captured tests without cause.

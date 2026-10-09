# Build 35 — Owner-Approved Revised Certification Contract (2026-10-09)

**Status:** Scope amendment to the previous G01–G13 binary certification campaign. The original report remains historical evidence and its FAIL verdict is **not** retroactively upgraded. Apply this contract to the next full exact-source certification and record one final PASS or FAIL.

## Owner release decision

Physical iOS and Android device testing is **NOT** a pre-candidate certification blocker. It will be done when a candidate is ready for real testing. During the current convergence-certification phase, the mandatory evidence is:

1. **Android emulator smoke certification.** Install the exact candidate Android build, cold-start it, cover authentication/onboarding, primary navigation, Scanner/gallery and multi-image behavior only when enabled, save/reopen, K+ and Elise availability/held states, sign-out/re-entry, recovery and crash detection. A simulation or unit test is not an emulator run.
2. **iOS code-level release certification.** Typecheck, iOS-specific/Expo config contracts, native bridge/permission/deep-link/entitlement guards, StoreKit integration source tests, signing-profile and release-flag validation. State clearly that no physical iOS test has been performed; do not infer native runtime success.
3. **Firebase artifact validation before release.** Upload/test the approved candidate artifact through the configured Firebase artifact/testing workflow, record the exact source SHA, artifact identity/hash, Firebase run/report and result. If no configured/authorized Firebase lane exists, report FAIL for this new mandatory gate rather than fabricate an artifact result. This is additive, not a replacement for the signed iOS Production EAS build and App Store submission checks.

The command for the signed iOS release remains:
`eas build --platform ios --profile production` — **not preview**.

## Account-deletion scope

The owner accepts the **current user-facing account-deletion flow** for the candidate and defers the major deletion-lifecycle backend hardening (worker, CLI, held/grace records, out-of-band reconciler, storage coverage and backlog disposition) to **Build 36**. Preserve the existing route and user-request/restore experience; do not turn the worker on or perform destructive Production operations. Narrow DEL-01 source hardening in PR #534 may be merged when exact-head CI is fully green. The Build 36 backlog lives at `docs/build36/ACCOUNT_DELETION_LIFECYCLE_BACKLOG.md` when #534 merges.

Deferral is not evidence that deletion is fully correct, is not permission to misrepresent it, and is not a waiver of Apple's in-app account-deletion requirement. Retain iOS code-level proof of an accessible, functional account-deletion request route; any demonstrated critical privacy exposure or missing account-deletion capability still blocks launch. Do not require closure of the full existing Production deletion backlog as a **separate** Build 35 internal certification gate; keep tracking it for authorized Build 36 remediation.

## Revised binary gate interpretation

| Gate | Revised acceptance |
|---|---|
| G01–G04 | Authority, unified source, exact-head CI and governed Staging parity remain mandatory |
| G05 | Security holds and vulnerabilities unrelated to the deferred lifecycle remain mandatory; completed DEL-01 source fix and Build 36 deferral tracked rather than full worker redesign required |
| G06–G09 | Premium, Scanner, Elise/VTO and cross-feature behavior: prove enabled launch-scope paths; fail-closed held features must be truly OFF with honest UI, no unsupported claims |
| G10 | Android emulator smoke PASS **and** iOS code-level certification PASS. Physical iOS/Android evidence is explicitly DEFERRED, not PASS |
| G11 | Safe Production release flags, protected backend authority and functioning in-app deletion availability; comprehensive deletion worker/ledger overhaul deferred to Build 36 |
| G12 | Exact-source signed iOS production artifact verified (and Android artifact if Android is in the approved release scope) |
| G13 | Firebase artifact test PASS before release, plus artifact/build/deployment/feature contract integrity |

Missing required emulator/Firebase/iOS code evidence is FAIL. Unknown or untested required functionality is FAIL. Previous device-only checks cannot be called executed. Keep an independent post-candidate physical-device test plan without representing it as a pre-candidate blocker.

## Scanner qualification

The Scanner 20-point matrix evidence in PR #532 is ready for emulator testing (640 focused tests, 11/11 mutation reversals). Conditional P2 B35-SCAN-014 remains: `BACKEND_COMMERCE_FUNNEL_V127_ENABLED` plus a multi-image batch can leave item commerce empty. The current `build35-release` profile sets `EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED=false`; do NOT certify or enable the combined funnel-on batch path without repair and provider-spend validation.

## Next decision

Re-run the full binary report under this amended contract once the remaining CI and emulator/Firebase/iOS artifact evidence is produced. Do not silently revise the previous FAIL or declare PASS before these new proofs exist.

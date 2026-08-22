# Google XR Physical-Device-Candidate — Takeover State

**Date:** 2026-08-22
**Session:** Claude Code, working directory `kscan-website` (this repo is outside that session's configured directories; operated here with explicit user confirmation)

## Current native branch

`feature/google-xr-live-integration-closure-v1` in `kscan-google-xr-physical-device-candidate-v1`
HEAD at takeover: `d1906b854b2465083aa0a9f1b05b982eb8bceb96`
HEAD after this session: `230da8838805b5cd6462918491dbf4a15027ecf1`
Remote: 1 commit ahead of `origin/feature/google-xr-live-integration-closure-v1` (not pushed this session)

## Current mobile branch

`feature/google-xr-mobile-companion-candidate-v1` in `kscan-google-xr-mobile-companion-candidate-v1`
HEAD at takeover: `8a8bf30a6d37a532a9c8cab02cf94ce6430d7f8e` (with substantial uncommitted work)
HEAD after this session: `9ba013d461550039b3dd84167e14eb2ce42f3a92`
Remote: **this branch has never been pushed to origin** — all of it, including the pre-existing merge history, exists only on this machine.

## Last verified shared baseline

`105c22182df11fe4132219d6e8c68dd3e73ef697` — `feature/google-xr-phone-bridge-phase-a`, cited in the takeover brief as the last known-good Phase A HEAD. Confirmed present as an ancestor of the native repo's current HEAD.

## Correction to the takeover brief's premise

The brief names `kscan-google-glasses-canonical` as the authoritative workspace. That repo is still sitting exactly at the Phase A baseline with no code progress beyond it (only uncommitted doc edits). The actual continuation work — real phone bridge provider, ML Kit privacy sanitizer, hardware-candidate build flavor, idempotent actions, live diagnostics — lives in a separate clone, `kscan-google-xr-physical-device-candidate-v1`, which the brief never mentions. User confirmed treating that repo as authoritative for this session (see below).

## Commits since baseline (native, before this session)

```
fcaa5233 feat(xr): implement real K Scan phone bridge provider, API, and identity
6652a9f1 feat(xr): add native fail-closed privacy sanitizer with ML Kit face detection
866246a2 feat(xr): add hardware-candidate flavor, runtime state, and permission surface
478cbe82 feat(xr): refine HUD for phone-companion result-only mode and pairing flow
d1906b85 feat(xr): idempotent action frames, live diagnostics, metadata stripping guarantees, test alignment
```

## Completed work discovered (verified this session, not just claimed)

- Real phone bridge provider over HTTPS long-polling against a deployed Supabase Edge Function (`wearable-bridge`, plus `wearable-save`/`wearable-scan`/`wearable-open-on-phone`, all confirmed `ACTIVE` on staging project `yzqjvdfgefveprobvvyw` via Supabase MCP), backed by 6 `wearable_*` Postgres tables with RLS enabled.
- Pairing/session lifecycle enforced both client- and server-side: 15-minute session TTL, revoke-on-replace, stale-revision rejection, ownership checks.
- Fail-closed privacy sanitizer: real ML Kit on-device face detection, opaque masking, fresh JPEG re-encode (metadata stripped by construction). Mock sanitizer is double-gated out of non-debug builds.
- Result contract (resultId/revision dedup, stale rejection) enforced at both client and server.
- Mock-safety in the `candidate` build flavor: all four mock flags hardcoded false, plus a runtime guard (`ReleaseSafetyGuard`) that throws if a mock instance is ever injected outside debug.
- Manifest permissions are minimal and match intent: zero permissions in main, `INTERNET` only in the candidate flavor, non-exported debug-only scenario receiver.
- Mobile companion side (uncommitted at takeover, now preserved): `WearableCompanionHost`, `/wearables` and `/wearable-result` routes, native Android privacy-sanitizer module, `wearable-bridge` edge function source, wearable session/security migrations, and a 9-assertion security contract test (`wearableCandidateContract.test.js`) — all passing.

## Broken work found and repaired this session

1. **Idempotency guarantee did not actually hold end-to-end (P1).** The glasses computed a stable `actionId` (`"type:resultId"`) but the phone-side relay (`WearableCompanionHost.tsx`) forwarded `frame.requestId` (a fresh random UUID every send, including retries) to the backend's actionId-keyed dedup instead. A retried Save/Open-on-Phone was never recognized as a duplicate. Separately, `"type:resultId"` isn't a valid UUID and would have failed the backend's strict UUID regex even if forwarded correctly. Fixed both: `stableActionId()` now derives a deterministic UUIDv3 via `UUID.nameUUIDFromBytes`, and the phone relay now reads `frame.payload.actionId` instead of `frame.requestId`.
2. **Dead, unguarded phone-bridge fallback branch (P2).** `AppRuntimeFactory.kt` had a second `when` arm duplicating real-provider construction without the `isHardwareCandidate` guard — unreachable today only because no other build type populates the relevant `BuildConfig` fields, but a landmine for future build types. Removed.
3. Stale doc comment ("exactly three providers"; there are four) corrected.

## Untested / not attempted this session (explicitly out of scope, not silently skipped)

- XR emulator interactive validation (pairing flow, reconnect, Save/Open-on-Phone in a running emulator) — an `XR_Glasses` AVD exists and the Android SDK/emulator binary are present on this machine, so this is feasible in a follow-up session, but was not attempted here.
- The full reliability matrix (20/20 pairing cycles, 20/20 scan cycles, etc.) and the 30-minute long-run soak test — both require either physical hardware or an extended interactive emulator session well beyond this pass's scope.
- Physical Google XR hardware validation — no device available.
- Native Android XR camera capture — intentionally left as a stub (`GlassesCameraController.kt` throws `UnsupportedOperationException` with a TODO); this matches the brief's own instruction to leave a clean provider seam rather than invent an unverified API, so it was not touched.

## Blockers

**P1 (fixed this session):** actionId idempotency did not hold end-to-end — see above.
**P2 (fixed this session):** dead unguarded phone-bridge branch — see above.
**P2 (open, flagged, not fixed):** the mobile companion branch has never been pushed to origin — all of its history exists only on this machine.
**P3 (open, pre-existing, not a regression):** `__tests__/useKScanDuplicateGuard.test.js` in the mobile companion repo fails at HEAD~2 (before any of this session's or the prior uncommitted work) — its VM-sandboxed test harness never mocked `sanitizeImageBeforeUpload`/`getPrivacySanitizerStatus`, so the call throws inside `runAnalysis` before `analyzeImage` is ever reached. Confirmed pre-existing by checking out the parent commit and re-running. Not fixed (out of the agreed "newly introduced failures only" scope).

## Recommended immediate continuation point

Native HEAD `230da883`, mobile HEAD `9ba013d4`, both local-only at the time this document was written. Next session should: (1) decide whether to push both branches (mobile companion has never been pushed at all), (2) run an interactive XR-emulator pass now that the actionId fix is in place, (3) optionally fix the pre-existing duplicate-guard test harness gap, (4) plan the physical-hardware QA pass once a device is available.

## Addendum (same-session continuation)

Both branches were pushed in a follow-up turn per explicit user authorization (native `9d9be0b2`, mobile `9ba013d4` — mobile HEAD unchanged from above; native gained one further docs commit first). Neither was merged to `master`/`main`. This document remains the Phase 0 snapshot; `GOOGLE_XR_TAKEOVER_AND_CONTINUATION_REPORT.md` at the repo root is the live document for everything after this point, including the push confirmation with exact remote SHAs and all further verification work.

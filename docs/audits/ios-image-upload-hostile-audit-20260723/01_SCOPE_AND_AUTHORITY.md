# 01 — Scope and Authority

**Audit:** K Scan AI — Hostile iOS Image-Upload Regression Audit & Repair
**Date:** 2026-07-23
**Auditor role:** Independent hostile senior iOS release auditor + repair engineer
**Mode:** Full in-scope repair authority — commit and push on PASS. **Absolutely no build.**

## Authorized
- Inspect all source/history; reproduce at source/test level; compare v13/v14/v15.
- Create dedicated repair branch; modify source; add/repair tests.
- Repair confirmed in-scope defects (Blocker→P10) on the image-upload pipeline.
- Run unit / integration / full regression / typecheck.
- Commit and push the dedicated repair branch **only on a full PASS**.

## NOT authorized (hard prohibitions)
- `eas build`, `eas submit`, any iOS/Android build, TestFlight candidate, EAS allocation.
- OTA publish, Supabase deploy, Edge Function deploy, production secret/env change.
- Merge into integration/release branch, tag a release, open a PR, submit to Apple.

## Verdict rule
Exactly one of **PASS** or **FAIL**. No "pass with findings," no conditional pass.

## Build-prohibition attestation (this task)
- EAS BUILD CREATED: **NO**
- TESTFLIGHT BUILD CREATED: **NO**
- ANDROID BUILD CREATED: **NO**
- OTA UPDATE PUBLISHED: **NO**
- DEPLOYMENT PERFORMED: **NO**
- MERGE PERFORMED: **NO**

## Note on prior activity (inherited, not this task)
A prior repair effort (commit `79f1106`, present at this branch's base) recorded — in
`docs/audits/ios-v15-image-upload-regression/11_BUILD_REPORT.md` — a merge to
`integration/ios-v15-second-pass-test-ready`, PR #37, and EAS build 16
(`94685c6e-2341-4356-89c4-01976c99cbb9`). Those were performed **before** this task by a
prior agent. This audit performed **none** of them and does not endorse them; it
independently re-verifies the source-level repair only.

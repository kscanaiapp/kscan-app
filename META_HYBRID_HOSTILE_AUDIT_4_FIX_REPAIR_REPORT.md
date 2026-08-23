# K Scan AI — Meta Hybrid Hostile Audit: Four-Finding Repair Report

Date: 2026-08-23  
Scope: the four entries marked **OPEN** in `META_SHARED_BACKEND_HYBRID_HOSTILE_AUDIT.md`.

## P2-05 — wearable schema reconciliation

**Root cause.** The documented staging wearable schema and the committed migration history had
drifted, so a source-built environment could not be trusted to recreate the active constraints.

**Change.** Added shared-backend migration
`20260823141131_reconcile_wearable_schema_with_staging.sql`. It makes the documented pairing,
session, message, result, and action invariants explicit, including bounded result revisions and
the nullable `wearable_actions.result_id` contract. A companion static migration test checks the
critical expressions.

**Verification.** `node --test supabase/migrations/wearable_schema_reconciliation.test.mjs`
passed. The revision ceiling was deliberately mutated to `999`; the test failed, then the exact
`1..1000` bound was restored and passed.

**Status.** **BLOCKED — STAGING DB AUTHORITY.** No database password or other staging DDL source
authority was available, so the migration was not linked, applied, or represented as live.

**Follow-up.** A database owner must validate the current schema against the migration, apply it
to staging through the governed migration path, and then run the authenticated wearable matrix.

## P2-06 — large-request hosted ingress failure

**Root cause.** The audit's request did not enter function code; it failed at hosted ingress
after approximately 160 seconds. That behavior is outside the function handler and is consistent
with the hosted function idle-time envelope.

**Change.** None. Adding a client cap, retry, or fabricated handler error would conceal the
platform defect instead of repairing it.

**Verification.** The original hostile-audit request trace remains the evidence. No second
oversized staging request was sent because it would only consume the same hosted resource without
exercising new application code.

**Status.** **BLOCKED — HOSTED INGRESS / INFRASTRUCTURE.**

**Follow-up.** The platform owner needs to inspect request-body handling, gateway limits, and
function resource/bundle behavior, then provide a stable ingress contract for a bounded regression
test.

## P2-07 — ML Kit dependency-policy guard

**Root cause.** `services/metaWearablePrivacy.ts` depended on a top-level JavaScript ML Kit
wrapper, while this repository's guard requires ML Kit to be scoped as an Android Gradle dependency
inside the existing local native module.

**Change.** Brought the already-audited Android half of `kscan-pii-native` onto this branch,
registered it for Android autolinking, removed `@react-native-ml-kit/face-detection` and its patch,
and routed Meta privacy detection/masking through the local module. Missing module, malformed
native output, detector failure, missing sanitized URI, altered dimensions, and zero masks all
fail closed.

**Verification.**

- New boundary test passed; changing the native call name made the test fail, then was restored.
- Updated parity test now asserts Android registration, only the audited bundled ML Kit artifacts,
  no Play-delivered model, no model assets, and no new privacy permission.
- `:app:assembleDebug --rerun-tasks --no-daemon` passed, including
  `:kscan-pii-native:compileDebugKotlin`.
- `npm run test:all` passed: 6,190 pass, 0 fail, 58 skip.
- Debug APK SHA-256:
  `A7013E95713AF2A019759A900A67327EE4CF2718C623340EC2080529C1559BDF`.
  A binary-safe scan found no tested credential/MockDeviceKit/direct-wrapper markers.

**Status.** **REPAIRED — SOURCE, TEST, AND ANDROID BUILD VERIFIED.** No ADB target was attached,
so emulator/device runtime behavior is not claimed.

**Follow-up.** Close #193 with this evidence; device QA remains separate from the packaging-policy
repair.

## P3-04 — cross-client Save idempotency

**Root cause.** `wearable-save` keyed idempotency through `saved_scans.local_id`, while
`wearable-bridge` used a metadata path. One product could therefore be inserted twice when the
two Save entry points were used together.

**Change.** Added `findExistingWearableSave`, which prefers the current `local_id` contract and
retains the metadata lookup for legacy bridge rows. Bridge inserts now populate `local_id`, and a
unique-violation race re-reads the canonical/legacy records before reporting failure.

**Verification.** Two Deno tests cover current and legacy rows. Mutating `local_id` to a false
column made both controls fail, then restoration passed. `wearable-bridge` was deployed to K Scan
AI Staging (`yzqjvdfgefveprobvvyw`) as ACTIVE v7 and downloaded afterward with no source diff.

**Status.** **REPAIRED — STAGING SOURCE DEPLOYED.** Authenticated client-to-client behavior is
still unverified because #192 supplies no approved staging QA account; no fake account or auth
bypass was used.

**Follow-up.** With #192 resolved, run `wearable-save → wearable-bridge` and
`wearable-bridge → wearable-save` on one result and assert exactly one persisted `saved_scans` row.

## Staging deployment and test evidence

- Shared-backend commit: `ae1cd80`.
- Mobile commit: `de2755e`.
- Deployed staging functions: `wearable-scan` ACTIVE v9 and `wearable-bridge` ACTIVE v7;
  `verify_jwt: false` was preserved as the pre-existing governed posture.
- `wearable-scan` v9 re-applies the previously committed P2-01 grouping repair that had regressed
  in staging v8. This was a required deployment correction, not a fifth audit repair.
- Full web verification passed; lint emitted 32 pre-existing warnings and no errors.
- TestSprite CLI/auth/project discovery succeeded, but the existing staging backend suite could
  not run because the workspace had insufficient TestSprite credits (required 0.2, available 0).
- No staging database migration and no production action were performed.

## External gates

| Gate | State |
|---|---|
| #191 — DAT package access | Still blocked; not changed by these repairs. |
| #192 — approved staging QA account | Still blocked; prevents authenticated wearable E2E. |
| P2-06 hosted ingress | Still blocked; requires platform-owner investigation. |
| Staging wearable schema DDL authority | Still blocked; requires database-owner validation and governed apply. |

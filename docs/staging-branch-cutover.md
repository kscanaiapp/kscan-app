# Staging Branch Cutover — Governance Record

**Date:** 2026-08-04
**Status:** Branch established locally; cutover **HELD** at backend-parity verification.

## Summary

`ios/full-submission-readiness-v2` is **FROZEN — LEGACY TESTING FORK**. It was never based on
the released production client and is no longer an acceptable staging baseline.

`staging/production-parity` replaces it as the governing staging branch.

## Branch authority

| Role | Branch | Base |
|---|---|---|
| Governing staging branch | `staging/production-parity` | `5c761ba` (iOS production 1.0.1) + 7 reviewed infrastructure commits |
| Frozen legacy fork | `ios/full-submission-readiness-v2` | historical only |
| Recovery branch (preserved) | `recovery/staging-production-baseline` | `b42a16e` |

### Frozen branch — prohibited uses

`ios/full-submission-readiness-v2` must **not** be:

- merged into `staging/production-parity` or any successor
- used to deploy Edge Functions or migrations
- used to create builds
- extended with new staging features
- rebased onto, or used as a rebase target for, the production-derived line
- deleted or force-pushed

It is preserved for **historical comparison and selective commit recovery only**.

CI enforcement lives in `.github/workflows/security-staging-gate.yml`: the deploy job refuses
both pushes on and pull requests targeting the frozen branch. `__tests__/staging/stagingBranchAuthority.test.js`
pins that guard so it cannot silently regress.

## Production client authority

The two shipped release lines are **divergent, not one lineage**:

| | iOS | Android |
|---|---|---|
| Commit | `5c761ba` | `4d0ceb4` |
| Version | 1.0.1 build 25 | 1.0.1 versionCode 27 |
| Merge base | `e394261` (2026-07-16) | same |
| Divergence | 251 commits | 260 commits, 398 files |

Neither is an ancestor of the other. **No single commit is the shared client authority.**

`5c761ba` was chosen as the base for this branch. Its `app.json` records `buildNumber 23`, which
does *not* contradict store build 25: `eas.json` sets `appVersionSource: "remote"` with
`autoIncrement: true`, so EAS assigns store build numbers server-side.

### Android-only client behavior NOT present on this branch

These shipped on the Android production line and are absent from `5c761ba`:

- session-recovery state machine (`services/routingGuard.js` — `AUTH_STATE`, `isSessionRecoverable`)
- auth-gate "recovering" UI (`app/_layout.tsx`)
- `isRecoveringSession` / `retrySessionRecovery` (`contexts/AuthSessionContext.tsx`)
- account restoration route (`app/account/restore.tsx`)
- privacy-artifact purge on actor change (`services/privacy/*`)

Porting these onto the iOS-derived line would produce a client matching **neither** released
build, so it was deliberately not done here. An Android-line staging baseline is tracked as
separate follow-up work.

## Scanner rules

- Production scanner authority: **`certified-v140`**
- Phase 6 candidate `9e38168` (`scanner/phase6-candidate`, "Candidate A — PARTIAL"): **REJECTED** —
  must not be integrated or forward-ported.
- No scanner commits were ported in this cutover.
- Future scanner work branches from `staging/production-parity`, or from a scanner-specific base
  explicitly reconciled with it.

The frozen branch's 59 unmerged commits contain **no scanner changes** — they are entirely
security and staging infrastructure.

## Backend parity status — BLOCKING

Verified read-only against staging (`yzqjvdfgefveprobvvyw`) on 2026-08-04:

| Metric | Value |
|---|---|
| Local migrations | 79 |
| Staging migrations | 43 |
| Remote-only | 5 |
| Local-only | 41 |

This is **schema drift, not just history drift**. Staging is missing `saved_scans`,
`dressing_room_participants`, `product_catalog`, `scan_identify_usage_daily`,
`user_stylist_preferences`, `shared_room_memberships`, `elise_generation_operations`,
`style_outfit_usage`. The released client cannot run against staging as it stands.

Source-authority gaps:

- 4 remote-only migrations (`provider_request_security` ×3, `provider_request_ttl_tuning`) have
  source only on commits `9e4556e` / `222989f` / `8d356da`; their branch
  `security/public-ingress-perimeter-hardening` has been **deleted from origin**.
- `20260804101903_legal_acceptances` was applied to staging on 2026-08-04 and has **no source
  anywhere in the repository**.

Six production functions are missing on staging: `style-outfit-generate`, `stylist-speech`,
`shared-room-image-url`, `nike-shoe-details`, `tryon-clothes-pro`, `search-vinted-secondhand`.

Per the cutover instructions, migration parity must be exact before cutover completes. It is not,
so **this branch has not been pushed and no workflow authority has been transferred**.

## Deferred: account-deletion completeness gap

Live production deletion behavior does not purge:

- `elise_generation_operations`
- the `{userId}/saved-scans` storage prefix

`supabase/functions/_shared/deletion/userDataResources.ts` on this branch deliberately matches
**live production**, not the newer committed source. `__tests__/processDeletionRequest.test.js`
therefore fails one assertion. That red test is the correct signal and was **not** weakened.
Closing the gap is separate future work, out of scope for baseline recovery.

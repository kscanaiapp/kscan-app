# Build 36 — Account Deletion Lifecycle Hardening Backlog

Recorded: 2026-10-09. Owner release-scope decision: **full deletion lifecycle remediation is deferred from Build 35 to Build 36**. This does not waive App Store account-deletion requirements, erase a customer deletion request, authorize an unsafe purge, or certify the existing lifecycle as correct.

## Accepted Build 35 boundary

- Preserve the existing in-app account deletion request/restore flow and its user-facing terms. Independently verify that the iOS release still offers account deletion, without directing users solely to email support.
- Keep destructive deletion worker/CLI operations under their existing authorization and safety holds; no automatic Production re-enablement and no retroactive processing of the existing backlog.
- Merge narrow, fully-green source hardening when safe and correctly scoped. PR #534 covers **DEL-01 only**: a post-Auth-delete failure must not return a deletion request with `user_id IS NULL` to an unclaimable `deactivated` state.
- No acceptance of silent data retention, discarded requests, privacy violations, or an account-deletion flow that is missing or nonfunctional in the actual iOS release. The owner has explicitly deferred the major backend lifecycle refactor, not the customer-facing account-deletion capability.

## Build 36 hardening items

| ID | Known gap | Required work |
|---|---|---|
| DEL-01 residual | An Auth delete may time out after having succeeded; out-of-band deletions still strand requests. | Add persisted actor-independent post-delete reconciliation; test idempotent recovery and crash edges; ensure terminal-safe dispositions. |
| DEL-02 | Legacy `scripts/process-deletion-request.js` bypasses holds/grace and ledger semantics, leaves user-NULL rows and omits RevenueCat retirement. | Guard hold/grace, use governed ledger and actor closure; audit/delete the unsafe parallel CLI path. |
| DEL-03 | Disabled purge worker permits restore-token/ban lapse at day 30 with neither purge nor restoration. | Authorize a bounded worker schedule or adjust restoration windows, with alerting and monitoring. |
| DEL-04 | Claim/reconcile SQL does not close already-deleted-user requests. | Governed reconciliation RPC and migration; prove no double purge. |
| DEL-05 | Storage cleanup covers four static prefixes and lacks comprehensive post-purge verification. | Enumerate all actor-owned media namespaces; verify removal or required retention. |
| DEL-06..13 | Worker defaults/side effects, raw identifiers, wearable tables, guard gaps, zero-row patch, hold and refresh-token semantics. | Resolve independently with location-specific regressions from the Build 35 hostile audit defect register. |
| Operational | Production had eight overdue deactivated deletion requests at the last read. | Classify individually under privacy/retention policy, authorize safe disposition, record evidence without exposing PII. |

## Required Build 36 definition of done

1. Build a governed deletion-state machine, including requests that lose `auth.users`/profile references mid-purge.
2. Test legal holds, grace window, restores, repeated deletes, interrupted Auth removal, RevenueCat mirror retirement, and all data/storage paths.
3. Run privacy-preserving Staging end-to-end recovery and deletion tests, then separately authorize Production rollout and backlog disposition.
4. Prove irreversibility, account isolation, RLS/worker privileges, fail-closed defaults, observability and user-facing outcomes.

## Release-candidate note

This document is a backlog and **not a PASS certificate**. The Build 35 owner-directed change removes a comprehensive deletion-lifecycle overhaul and physical-device testing from the internal certification contract. The replacement device/evidence scope is Android emulator smoke, iOS code-level tests, and Firebase artifact verification before release; any required legal/account deletion functionality must still be verified in the shipped binary. No certified physical-device evidence is claimed.

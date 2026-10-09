# Shared iOS / Android Defect Handoff — Build 35

**Android source authority reviewed:** `f2f94e8bb9ca758d45f0d7db6e3206c3d0903bf4`  
**Rule:** shared implementation is documentation-only in the Android lane.

```
SHARED_DEFECTS_REPAIRED_BY_THIS_AGENT=0
```

## SHARED-001 — B35-SCAN-014

| Field | Value |
| --- | --- |
| Existing authority | Issue #536 |
| Severity | **P2** |
| Type | Shared Scanner / deferred-commerce result completeness |
| Locations | `app.js`; `hooks/useKScan.js`; `services/commerceHydration.ts` |
| Platforms | Android + iOS/shared |
| Expected | When multi-image scanning and deferred commerce are both active, each selected garment receives the expected shopping matches. |
| Actual | Some selected garments may not receive expected shopping matches. |
| Evidence | Existing Issue #536 and source/test campaign record. |
| Customer impact | Incomplete shopping options in multi-item scan results if both capabilities are enabled. |
| Suggested fix | Repair shared batch/commerce hydration ownership so every selected garment carries a stable request/result identity through deferred hydration; add cross-platform regression coverage for partial and out-of-order commerce completion. |
| Recommended owner | Shared Scanner / Commerce engineering |
| Android release blocker | **NO while multi-image remains held OFF** |
| Containment | Build 35 release guard rejects multi-image enablement; held-surface tests confirm controls are withheld. |
| Status | **NOT REPAIRED BY ANDROID AGENT** |

## SHARED-002 — DEL-01 deletion lifecycle edge case

| Field | Value |
| --- | --- |
| Existing authority | PR #534 |
| Severity | **P1 backend/shared lifecycle** |
| Type | Account deletion worker terminal-state handling |
| Location | Backend `process-account-deletions` lifecycle; see PR #534 |
| Platforms | Shared backend behavior used by Android and iOS |
| Expected | Once Auth deletion passes the point of no return, later failures must not strand an unclaimable deletion row. |
| Actual | Prior deployed logic can reschedule a post-Auth-delete failure into a state with no user ID that later claim/reconcile paths may not pick up. |
| Evidence | PR #534 failing-first lifecycle tests and defect description. |
| Customer impact | A deletion request may require operator remediation after a narrow post-auth-delete failure window. |
| Suggested fix | Use the reviewed PR #534 backend repair path and Build 36 deletion-lifecycle campaign; preserve explicit reconciliation/operator visibility. |
| Recommended owner | Build Manager / Backend authority owner |
| Android release blocker | **Not an Android source blocker under the owner's Build 36 deferral**, provided the in-app request path and external request path remain truthful and functional. |
| Containment | Android deletion UI submits the canonical request and does not claim immediate permanent purge; public web deletion request resource exists. |
| Status | **NOT REPAIRED BY ANDROID AGENT** |

## SHARED-003 — K-06 RevenueCat webhook secret-strength hardening

| Field | Value |
| --- | --- |
| Existing authority | PR #535 |
| Severity | **P3 backend/security** |
| Type | Server webhook authentication hardening |
| Location | Shared RevenueCat webhook authentication / `kplus-revenuecat-webhook` |
| Platforms | Shared backend authority |
| Expected | A configured webhook authorization/signing secret must meet the governed strength floor or the endpoint fails closed. |
| Actual | Current deployed source lineage predates the proposed minimum-length hardening; actual deployed secret strength is not readable from the Android lane. |
| Evidence | PR #535 source and tests; live production function is active. |
| Customer impact | If the configured secret were weak, a webhook-forgery boundary would be weaker than intended. |
| Suggested fix | Backend owner verifies live secret strength, then merges/deploys the reviewed hardening through backend authority if required. |
| Recommended owner | Backend / K+ security owner |
| Android release blocker | **Not an Android source blocker**; must be closed before paid K+ production rollout if live secret strength cannot be proven adequate. |
| Containment | Android purchase flow never grants canonical K+ from local store success; backend entitlement remains authoritative. |
| Status | **NOT REPAIRED BY ANDROID AGENT** |

## External configuration dependency — Google Play / RevenueCat

This is not a shared source defect, but must remain visible to Android, iOS and Build Managers.

- RevenueCat project: K Scan AI
- Play app package: `com.kscanai.app`
- Play monthly/annual products are active and attached to entitlement `k_plus`
- Android public SDK key in source matches the live RevenueCat Play app key
- **Google Play service-account credentials are not configured in RevenueCat**
- Direct read-only credential validation returned an explicit not-configured response

Recommended owner: monetization / Google Play / RevenueCat configuration owner.

Impact: blocks meaningful Android billing sandbox/lifecycle certification and should be resolved before paid K+ Android rollout. It does not require a client rebuild by itself.

## Handoff rule

Any future repair to SHARED-001/002/003 must be owned by the shared/backend lane. The Android submission manager must not cherry-pick a common-code fix merely to turn an Android gate green.

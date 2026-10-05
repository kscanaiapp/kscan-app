# K Scan AI — Build 35 Pre-RevenueCat Regression Baseline

Captured: 2026-10-05  
Current integration authority: `integration/build35-v1-convergence`  
Current pre-RC baseline SHA: `2616b08a0a7b892a47961358e41d00b8de14aec2`  
Prior post-#499 baseline SHA: `b9cdbd0699ffb8e4a22afd994c662752c6fa4fd7`  
Pre-#499 comparison SHA: `f016e3e172121f928c3a51305915b54296e9611c`

## Baseline authority note

The original pre-RC instruction named `b9cdbd0...` as the intended baseline. Integration intentionally advanced after that instruction when PR #506 was repaired, fully green, and merged. The branch now resolves to `2616b08a0a7b892a47961358e41d00b8de14aec2`, eight commits ahead of `b9cdbd0...` and zero commits behind it. Baselineing `b9cdbd0...` would therefore omit the merged K+ UUID reconciliation repair, the governed `build35-testing` APK profile, and their profile-parity updates.

This document characterizes the actual merged pre-RevenueCat tree at `2616b08a0a7b892a47961358e41d00b8de14aec2`. `b9cdbd0...` remains the post-#499 comparison anchor; `f016e3e1...` remains the pre-#499 comparison anchor.

The referenced `docs/audits/BUILD35_POST_MERGE_RECONCILIATION.md` is not present in the current integration tree. The feature-state section below carries forward the previously established post-merge reconciliation state and updates only verified merge/source-live deltas from #499, #505, and #506; it does not reopen or re-derive settled feature work.

No Supabase Production mutation, deployment, migration, secret change, RevenueCat configuration, paid VTO call, EAS build, or store action was performed in this regression pass.

---

# Output 1 — Failure Identity Contract

## Current merged-tree execution

The exact current integration merge SHA has no standalone GitHub Actions run attached to the merge commit. A dedicated diagnostic branch was created directly from `2616b08a0a7b892a47961358e41d00b8de14aec2` and changed only the test runner's logging so the governed observed failure identities would be printed. That diagnostic run completed successfully. The diagnostic line was removed before this artifact was finalized.

```text
FULL_SUITE_OBSERVED=13
FULL_SUITE_UNEXPECTED=0
FULL_SUITE_SKIPPED=0
KNOWN_BASELINE_FILE_IDENTITIES=19
OBSERVED_KNOWN_IDENTITIES=13
```

### FULL_SUITE_KNOWN_IDENTITIES

1. `media dimensions are inherited from the existing Closet store, not invented`
2. `no repo migration other than the blocking one assumes the internal schema`
3. `config.toml pins JWT posture so a deploy cannot silently change it`
4. `parity: every governed file exists and matches its recorded hash`
5. `parity: the generator agrees the committed manifest is current`
6. `edge source: production stage logs are present and do not leak sensitive data`
7. `edge source: authenticated image scan checks DB quota before Gemini`
8. `edge source: quota DB/RPC failure fails open and proceeds to Gemini`
9. `edge source: missing service role key fails open for authenticated quota`
10. `edge source: quota logs do not expose full user id, tokens, image, or text`
11. `main migration revokes anon EXECUTE from every function in the reviewed list`
12. `staging exposes exactly the production client-feature flag set`
13. `shared flags hold identical values unless allow-listed as environment-specific`

Six identities remain in `config/test-failure-baseline.json` but did not reproduce. Per the governed runner contract, fixed baseline failures may disappear and are not treated as regressions. No identity was added to the baseline.

## Required gates

```text
TYPESCRIPT=PASS
EDGE_PARITY=PASS
EDGE_MANIFEST_CURRENCY=PASS
NATIVE_CONFIG_PARITY=PASS
DEPENDENCY_REACHABILITY=PASS

SECURITY_GATES:
  Security - Code and Dependencies=PASS
  Security summary=PASS
  Security - Promotion Gate=PASS

VTO_BACKEND_E2E=PASS
ZAP_BASELINE_STAGING=PASS
ZAP_API_STAGING=PASS
K_SCAN_STAGING_SECURITY_GATE=PASS
```

Native-config evidence includes the governed Android Voice negative-control/self-check pair: removing `RECORD_AUDIO` from a Voice-capable manifest fails native config parity, while the unmutated fixture passes.

## Platform delta

```text
LINUX_CI_FAILURES=13 known / 0 unexpected
WINDOWS_LOCAL_FAILURES=NOT_ADMITTED_TO_BASELINE
```

A fresh Windows full-suite execution was not used as baseline authority in this pass. The preceding Build 35 production-readiness work repaired its documented Windows-only release-test harness defects and reported its governed readiness fence passing afterward. Host-only behavior is therefore documentation, not part of the Linux CI failure contract.

## Identity comparison

A second temporary diagnostic probe was run from `f016e3e172121f928c3a51305915b54296e9611c` solely to print the historical failure identities. It was closed without merge.

```text
FAILURES_AT_f016e3e1=13
FAILURES_AT_b9cdbd0=13 known / 0 unexpected
FAILURES_AT_2616b08a=13
IDENTICAL_f016e3e1_TO_2616b08a=YES
NEW_IDENTITIES=NONE
REMOVED_IDENTITIES=NONE
```

The thirteen names at `f016e3e1...` match the thirteen names listed above one-for-one. The archived post-#499 authority also reported 13 observed / 13 known / 0 unexpected. The current combined #499 + #506 tree therefore introduces no new full-suite failure identity.

---

# Output 2 — Tree State Map

## SOURCE_COMPLETE_AND_MERGED

- Elise Conversation Quality V2 (#454).
- Commerce / ProductShelf shopping UX refinement (#457).
- Packing and Concierge refinement quality (#458).
- RevenueCat provider pull-reconciliation source (#497).
- Dependency reachability repair (#498).
- Cross-platform haptics and optimistic interaction feedback (#427).
- VTO customer activation and discovery (#499), including the integrated customer discovery/presentation work and current VTO decision-loop behavior.
- K+ UUID reconciliation repair (#506).
- Governed `build35-testing` internal APK profile and its Voice / Push / Watchlist profile-parity contracts (#506).
- Canonical Build 35 backend-promotion source is merged into `rebuild/backend-authority-v2` through #505.

PR #455 remains closed/unmerged as a PR identity and is not reopened. Its relevant VTO decision-loop/customer-activation result is represented by the later merged #499 convergence.

## SOURCE_PRESENT_NOT_LIVE

- Receipt & Purchase Intelligence V1 (#456): merged source, deliberately flag-off / not activated for live receipt extraction.
- Build 35 production backend promotion (#505): canonical source is merged into backend authority, but this regression pass performed no Production Edge deployment.
- `kplus-offer-redeem`: source/governance exists, but live activation still depends on its governed production migration, server-only HMAC configuration, and deployment; none was performed here.
- Updated VTO / K+ / Elise backend bundles represented by #505 remain source-ready rather than newly proven live by this pass.
- `build35-testing` profile exists in source, but this pass did not create a fresh EAS APK.

## IN_PROGRESS_OR_PENDING_RC

- RevenueCat production configuration remains the known pre-release configuration lane.
- RevenueCat webhook authorization, approved product classification, reconciliation credential/environment, platform public SDK keys, and store/provider mapping must be verified in the RC lane.
- Purchase and restore behavior remains device-unverified until that RC configuration is completed.
- Fresh `build35-testing` APK generation and device login/account-switch/K+ certification follow configuration; they are certification tasks, not source regressions.
- No RC work was started in this pass.

## Source/live distinction

A merged feature is not labeled live merely because its source exists. The current baseline distinguishes:
- merged client/source behavior,
- canonical backend source prepared but not deployed,
- intentionally flag-off receipt functionality,
- configuration-dependent RevenueCat behavior,
- and device/runtime certification that still requires a fresh artifact.

---

# Output 3 — Regression Contract for RevenueCat

```text
BASELINE_SHA=2616b08a0a7b892a47961358e41d00b8de14aec2
BASELINE_CAPTURED_AT=2026-10-05T11:39:55Z
BASELINE_FAILURE_IDENTITIES=Output 1 / FULL_SUITE_KNOWN_IDENTITIES
BASELINE_UNEXPECTED_FAILURES=0
```

## WHAT_RC_MAY_CHANGE

RevenueCat work may change only the surfaces required to make the already-designed paid K+ lifecycle operational and correct:

- K+ entitlement authority.
- RevenueCat webhook ingestion.
- Canonical Supabase state.
- Mobile entitlement reader.
- Billing surfaces.
- Account lifecycle.

Changes in those areas still have to preserve the existing server/canonical-state authority model; "may change" is scope permission, not permission to create a second entitlement authority.

## WHAT_RC_MUST_NOT_CHANGE

- VTO eligibility authority: `services/vto/vtoEligibility.ts`.
- VTO authority chain.
- VTO consent gate: `components/vto/VirtualTryOnSheet.tsx`.
- Edge manifest generator: one authority only.
- Offer-code validation authority.
- Closet ownership authority.
- Receipt ownership rule: confirmation -> canonical ownership.

The current K+ and VTO invariants remain the regression oracle. RevenueCat/provider evidence may cause canonical reconciliation, but provider/mobile evidence must not independently become K+ truth.

## REGRESSION_TRIGGERS

Any RC PR is a red flag if it introduces any of the following:

- A new full-suite failure identity.
- A duplicate authority in the change list.
- An invariant violation in the K+ authority chain.
- An invariant violation in the VTO authority chain.
- Widening `config/test-failure-baseline.json`.
- Weakening or bypassing a release/security/parity gate.
- Unrelated file changes outside the RC lane.
- Direct entitlement mutation from RevenueCat client state instead of canonical reconciliation.
- Client/provider choice or paid-VTO authorization logic entering a RevenueCat change.
- Receipt-import ownership bypass.
- Offer-code validation moving into the client.

## RC comparison rule

The first RC candidate must be compared against this document by **failure identity**, not only by failure count. A count of 13 is insufficient if any name changes.

Required post-RC condition:

```text
unexpected failure identities = 0
new identities vs this baseline = NONE
baseline widening = NO
duplicate authorities = NO
K+ invariant violations = 0
VTO invariant violations = 0
unrelated changes = NONE
```

---

# Repairs performed before baseline

The following stabilization work was completed before this baseline was established:

- #506 profile-governance repair: the intentionally governed `build35-testing` profile is recognized by Voice, Push, Watchlist, and native-capability parity tests.
- #505 VTO mutation-boundary repair: only the exact audited Build 35 VTO backend files are authorized; the remainder of `vto-generate/**` remains protected.
- #505 post-#499 backend convergence: current VTO retry/failure semantics and server-authoritative offer-code source were carried into canonical backend authority.
- #505 stale regression-contract repairs aligned backend-authority tests with the already-merged Build 35 source.
- #505 migration reconciliation validator now recognizes `EXACT_VERSION_APPLIED` as reconciliation evidence only; it does not authorize replay.
- #505 stale Style Outfit no-result contract was aligned to canonical Closet behavior.

No new regression was discovered on the final combined integration tree after those repairs. Therefore this regression pass required no additional app/runtime repair.

---

# Verdict

```text
REGRESSION_BASELINE_ESTABLISHED
CURRENT_PRE_RC_BASELINE_SHA=2616b08a0a7b892a47961358e41d00b8de14aec2
OBSERVED_FAILURES=13
KNOWN_FAILURES=13
UNEXPECTED_FAILURES=0
NEW_IDENTITIES_VS_f016e3e1=NONE
REMOVED_IDENTITIES_VS_f016e3e1=NONE
TYPESCRIPT=PASS
EDGE_PARITY=PASS
EDGE_MANIFEST_CURRENCY=PASS
NATIVE_CONFIG_PARITY=PASS
DEPENDENCY_REACHABILITY=PASS
SECURITY_GATES=PASS
PRODUCTION_MUTATION=NONE
REVENUECAT_WORK_STARTED=NO
```

RevenueCat work should regress against this characterized baseline, not against `b9cdbd0...` alone.

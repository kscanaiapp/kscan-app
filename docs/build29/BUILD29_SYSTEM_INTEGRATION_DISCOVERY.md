# Build 29 System Integration — Discovery and Inclusion

Integration performed 2026-08-12 on branch `integration/build29-system-20260812`,
cut from `origin/staging/production-parity`.

## Baseline

| Fact | Value |
| --- | --- |
| Canonical integration base | `origin/staging/production-parity` |
| `CURRENT_STAGING_HEAD` | `194bbaa6bc410119bb3e14bab63c384c222e6c6d` |
| `CURRENT_MASTER_HEAD` | `dcafd944873c2659ad8b5400376a0b89f11c57c2` |
| Staging suite baseline | 5236 tests / 20 failures across 7 files |
| Staging `tsc` baseline | 33 errors, all in `security/release/*.mjs` |

`staging/production-parity` is a **release, security and provenance backbone**,
not a product line: every PR merged into it (#58 through #112) is CI, release
control-plane, or security infrastructure. The Build 29 product and compliance
surfaces reach it only through PR #111.

## What "Build 29" is

An inclusion decision is made from Git evidence, not from a branch name. A
branch is INCLUDED only if it has an open PR targeting the canonical base.

| Workstream | Source | Head | State | Decision |
| --- | --- | --- | --- | --- |
| Product + compliance restoration (consent, iOS GP-006/TextScan reporting, Apple authorization/revocation, Elise attach-first continuation loop, Android release hardening) | PR #111 `codex/build29-hostile-audit-20260811` | `89d6628` | draft, CI 22 pass / 4 skip | **INCLUDE** |
| Observability / Sentry foundation | PR #113 `ops/build29-observability-foundation-v1` | `ac7ce7a` | draft, CI 22 pass / 5 skip, hostile audit PASS, 0 open P0–P3 | **INCLUDE** |
| Release / provenance backbone (#107, #108, #109, #112) | merged | — | in base | **ALREADY_IN_STAGING** |
| Staging bootstrap registration | PR #110 → `master` | `9d05a3d1` | merged to master | **ALREADY_IN_STAGING** (content present) |
| Security / compliance baseline (#70, #71, #103, #105, #106) | merged | — | in base | **ALREADY_IN_STAGING** |
| `tar`, `undici`, npm_and_yarn bumps | PRs #100, #101, #102 | — | open against `master` | **NOT_BUILD29** — they target `master`, not the staging line |
| `integration/{ios,android}-elise-image-styling-loop-v1` | no PR | `cc17a3cd`, `1b0034f9` | — | **SUPERSEDED** — PR #111 restores the approved Elise attach-first continuation loop onto the staging lineage |
| `hotfix/ios-build29-apple-revocation`, `hotfix/ios-build29-appstore-readiness`, `hotfix/prod-deletion-worker-apple-revocation` | no PR | `e369fca9`, `1f70ce72`, `a9fa5ebe` | — | **SUPERSEDED** — PR #111 restores the Apple authorization-code/revocation source and iOS compliance posture, and the two Apple Edge Functions are present and release-classified in the candidate |
| `scanner/phase7-identification-recheck` | no PR | `46256450` | 293 commits / 759 files divergent | **DEFER — owner decision** |
| `scanner/phase7-fashion-brand-evidence` | no PR | `4dc0751c` | 294 commits / 764 files divergent | **DEFER — owner decision** |

### Why the Scanner Phase 7 branches are deferred, not integrated

They are not small feature branches that were overlooked. Both diverge from the
staging lineage at `e394261` (**2026-07-16**), roughly a month before any Build 29
staging work, and neither has ever had a pull request against any base. They sit
on the legacy product fork, which is the same divergence the staging baseline
cutover already records.

Integrating them would be a 750+ file cross-lineage merge of the unresolved
Scanner architecture fork (sequential-multiselect versus the shipped
parallel-multiimage design). That is a product decision with more than one
reasonable outcome, which is an explicit stop condition for this pass — not
something to settle inside an integration merge.

**Brand awareness is not lost by this deferral.** The brand-evidence commerce
gate (`hasBrandEvidenceForCommerce`) is present in the integrated candidate's
`scan-identify`. What is absent is the Phase 7 *identification recheck* loop
(`identificationRecheck` appears nowhere in the candidate). Build 29 therefore
ships brand-aware commerce gating **without** the Phase 7 recheck.

## Integration order

Dependency-aware, and deliberately not alphabetical:

1. **PR #111 first** — product, compliance and shared contracts.
2. **PR #113 second** — observability instrumentation lands *last*, so its hooks
   are verified against the restored product surfaces rather than only against
   the bare staging backbone.

Both merge cleanly against staging in isolation. Three conflicts appear only
when both are in the same tree; all three required keeping *both* sides.

| ID | Files | Features | Semantic decision |
| --- | --- | --- | --- |
| CONFLICT-1 | `contexts/AuthSessionContext.tsx` | auth/signup ↔ observability | #111 added the signup-name metadata import, #113 the correlation-reset import, same line. Both kept: actor-switch cleanup needs the reset, signup needs the metadata. |
| CONFLICT-2 | `services/style-chat/providers/edgeStyleChatProvider.ts` | Elise ↔ observability | #111 declared `hasFashionContext`, #113 declared `correlation`, same line. Independent locals, both used downstream. Both kept. |
| CONFLICT-3 | `app.json` | iOS compliance ↔ observability | #113 rewrote the whole file (Sentry wizard reformat) but its only *semantic* change was appending the `@sentry/react-native/expo` plugin. #111 carried the Apple compliance contract. Taking #113's file would have silently reverted orientation `default`, edge-to-edge, the `expo-location` always-permission denials, and a privacy manifest grown from 3 to 9 collected-data types. Resolved by keeping #111's file verbatim and inserting only the plugin, asserted on the parsed result. |

## Result

| Measure | Staging base | Integrated candidate |
| --- | --- | --- |
| Tests | 5236 | 5436 |
| Failures | 20 (7 files) | **4 (2 files)** |
| `tsc` errors | 33, all `security/release/*.mjs` | 33, unchanged |

The candidate has **fewer** failures than the base it was cut from: PR #111
repairs 16 of staging's 20 pre-existing failures. The 4 that remain are the same
`sharedRoomCollaborationHotfix` and `stagingBranchAuthority` conditions present
on `194bbaa`, both verified pre-existing by running them at the base SHA.

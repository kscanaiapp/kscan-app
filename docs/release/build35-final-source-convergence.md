# Build 35 final source convergence: governed integration of the nine P0–P3 repairs

**Date:** 2026-10-29. **Engineer:** Claude Code, continuing the Codex campaign under the owner's scope lock.
**Scope:** CI reconciliation, governed source merges, final-SHA validation. There were no deployments, migrations, flag changes, EAS builds, version bumps or store submissions.

## Authoritative SHAs after integration

| Authority | Before | After | Merges (owner-approved, in order) |
|---|---|---|---|
| `rebuild/backend-authority-v2` | `3efcb6cbf29eb10c1bc1510f05e9a3365755bd74` | **`f4df2a5a525fb7ee1b22f16c9a4bc55c1c8831af`** | #649 → `168799e2`; #653 → `69f76249`; #647 → `f4df2a5a` |
| `integration/build35-v1-convergence` | `65a1e7cd6c2bea790e87c009a41de999d6cf2fa8` | **`c86bf3d052806c6105ce7830a03ac2b1501d34a1`** | #648 → `c86bf3d0` |
| `release/kscan-pre-freeze-v1` | `840ba88e` | `840ba88e` (unchanged) | none. RP-108 Build 34 isolation preserved; #644 was not merged there. |

The tree of `c86bf3d0` is byte-identical to the validated candidate `751e3815`.

## Repair dispositions

| ID | Priority | Original PR | Disposition | Commit in authority |
|---|---|---|---|---|
| B35-G-001 | P2 | #644 | Superseded by #648 (never merged to Build 34) | `da480d9b`, `84fe1c89` (patch-identical) |
| B35-C-001 | P1 | #645 | Superseded by #648 (Option A) | `e2395662` (patch-identical) |
| B35-F-002 | P1 | #647 | **Merged** to backend authority | merge `f4df2a5a` (head `2a132026`) |
| B35-C-002 | P1 | #649 | **Merged** to backend authority | merge `168799e2` (head `6f768494`) |
| B35-COST-003 | P2 | #650 | Superseded by #648 | `1db2ef1c` (patch-identical) |
| B35-G-004 | P3 | #651 | Superseded by #648 | `29ba460c` (patch-identical) |
| B35-C-004 | P3 | #652 | Superseded by #648 | `50088fd0` (all files byte-identical) |
| B35-C-005 backend | P1 | #653 | **Merged** to backend authority | merge `69f76249` (head `5c754548`) |
| B35-C-005 client | P1 | #654 | Superseded by #648 | `53b93724`, `751e3815` (all files byte-identical) |
| B35-F-006 | P2 | #655 | Superseded by #648 | `9f0eb834`, `a376f2f7` (all files byte-identical) |
| — (#648) | — | #648 | **Merged** to Build 35 authority | merge `c86bf3d0` |

Supersede verification against `c86bf3d0`:
- Every replacement commit is an ancestor of the authority.
- #650, #651, #652, #654 and #655: every touched file is byte-identical in the authority.
- #644: one test file differs only because the later #651 repair (`29ba460c`) wired its new hook into the test loader. All #644 tests are present.
- #645: the only differences are a leading UTF-8 BOM removed by the candidate's newline normalization, and `package.json` override ordering plus the candidate's additional `node-forge` override.

#650/#651 failed only on their stale stacked base `7624ab3f` (migration reconciliation for `20261014210000`, and the VTO not-dispatched contract that #650 itself fixes). The same tests pass at the candidate: 81/81 and 140/0.

## CI recovery findings (no gate weakened, no test altered)

1. **Missing Contract tests / Migration validation artifacts** (#645, #648, #649, #652, #653, #654, #655).
   - Cause: `security-staging-gate.yml` uses the repo-wide concurrency group `kscan-staging-deployment` (one running plus one pending). The 19:20–19:40Z push burst cancelled the pending runs, so the promotion gates timed out after 65 minutes with `missingRequiredArtifact`.
   - Repair: serialized reruns of the cancelled `pull_request` runs, then reruns of the failed promotion gates.
   - Safety: the deploy job is allow-listed to `staging/production-parity` or a manual `DEPLOY-TO-STAGING` dispatch, so no Staging write occurred.
2. **#653 after retarget.**
   - The first `pull_request` run checked out a stale GitHub merge ref (`703edf3e`, parents `6f768494` + `394645c2`, created before the retarget). `backendAuthorityGovernance` correctly failed with `AUTHORITY_REF_MISMATCH`.
   - That failed check run is permanently attached to head `394645c2`. The promotion evaluator is fail-closed: any completed failure among same-named runs wins. So no later gate on that head could pass.
   - Repair: GitHub "update branch" merged the authority tip into #653, giving head `5c754548`. Its tree is byte-identical to the fresh merge ref `e02ebfb4` that was validated locally (13/13 governance tests; backend-authority verifier exit 0). All 14 latest runs on that head passed.
3. **#647 shared file with #649.**
   - `style-outfit-generate/index.ts` auto-merged to exactly the bytes reviewed in the candidate.
   - The only conflict was the generated `config/edge-function-manifest.json`, regenerated with `node scripts/generate-edge-function-manifest.js` (merge commit `2a132026`, no hand edits).
4. **#646 (this lane).** Its decoder backport's `package.json` lacked the authority's `node-forge` override. The merge resolves `package.json` and `package-lock.json` to the authority's bytes, so no dependency override is dropped.

The PRs were drafts. They were marked ready only to permit the approved merges.

## Final-SHA validation (each claim is bound to one SHA)

| SHA | Check | Result |
|---|---|---|
| `c86bf3d0` (Build 35) | `node scripts/run-all-tests.js` | 11,434 total: **11,336 pass / 0 fail / 98 skip**, exit 0 |
| `c86bf3d0` | `npx tsc --noEmit` | exit 0 |
| `c86bf3d0` | edge parity, backend authority, native config, migration provenance, dependency reachability, release profile | all exit 0 |
| `f4df2a5a` (backend) | `node scripts/run-backend-tests.js` (Deno) | **1,515 pass / 0 fail** |
| `f4df2a5a` | edge parity, backend authority, migration provenance, native config, dependency reachability | all exit 0 (release profile is a mobile-lane gate and is absent from the backend branch) |
| `f4df2a5a` | backend authority, staging/production migration reconciliation and permission SQL governance tests | 121/121 |
| `f4df2a5a` | branch-level push CI (7 workflows) | all success |
| `c86bf3d0` | branch-level push CI (9 workflows: iOS source certification, release profile guard, dependency reachability, staging gate, ZAP API/baseline, VTO E2E, code & dependencies, promotion gate) | all success |

Superseded PRs #644, #645, #650, #651, #652, #654 and #655 were closed after the replacement merged and passed these gates. Each has a comment linking its replacement commit and regression evidence.

The backend count (1,515 at `f4df2a5a`) and the earlier candidate count (1,531 at `53b93724`) are different trees and are not combined.

**Source parity between the two authorities:**
- All nine repair-touched backend files are byte-identical between `f4df2a5a` and `c86bf3d0`: `_shared/geminiConsent.ts` and its tests, outfit `index.ts` and `accountActiveGate.ts`, the scan-identify / stylechat-generate / purchase-import-extract entry points, `_shared/deletion/userDataResources.ts`, and migration `20261029184000`.
- Backend/mobile `supabase/**` drift fell from 19 files to 7. All seven are pre-existing lane differences; none was introduced by these merges.

## Rollout dependencies (not authorized in this pass)

Merging deployed nothing: every deploy workflow is a manual dispatch.

- Migration `20261029184000_gemini_processing_permission.sql` is **unapplied**.
- After these merges, any routine deploy of `scan-identify`, `stylechat-generate`, `style-outfit-generate` or `purchase-import-extract` from the backend authority ships strict v2 enforcement. Without the permission table, those functions fail closed for every user.
- The required order is: permission migration → a client build offering v2 consent (onboarding and Privacy settings) → backend function deploys. Each step needs separate owner authorization.

## Still open (unchanged by this pass, owner scope lock)

- B35-B-004 (P4 Scanner JSON `null` body), H-001 (analytics consent basis) and H-003 (native masking accuracy) remain in [the backlog](build35-hostile-audit-p4-p10-backlog.md).
- The original 3,096-cell probe matrix (54 PASS / 1 FAIL / 3,041 NOT TESTED) is unchanged.
- Device, signed-artifact and provider certification remain separate phases.

## Verdict

**Source convergence: PASS** for the nine P0–P3 repairs at `c86bf3d0` (Build 35) and `f4df2a5a` (backend).

**Overall release readiness: BLOCKED pending separately authorized stages:**
- the coordinated consent rollout described above;
- resolution of the open hostile-audit items;
- the iOS and Android candidate audits.

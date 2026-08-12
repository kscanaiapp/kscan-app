# Reconciliation defect log

## DEF-REL-001 — Unsupported TestSprite evidence represented as native mobile certification

- **Preexisting or introduced:** Preexisting.
- **Symptom:** Runtime certification required `TESTSPRITE_ANDROID_TEST_ID` and `TESTSPRITE_IOS_TEST_ID`, ran TestSprite against an HTTP target, and labeled the resulting frontend/backend evidence Android/iOS mobile evidence.
- **Root cause:** The certification design assumed native TestSprite project types that CLI 0.5.0 and the connected empty project inventory do not provide.
- **Security impact:** A web/API run could be mislabeled as native critical-flow coverage if IDs were supplied.
- **Release impact:** With no IDs the release was permanently blocked; fabricated IDs could have produced misleading evidence.
- **Files/workflows:** `staging-release-certification.yml`, `build-staging-certification.js`, `validate-promotion-request.js`, promotion body/docs/tests.
- **Fix:** Removed the mobile TestSprite parser and variables. Added exact native runner/build/run/SHA/flow/artifact evidence with calibrated results and same-repository workflow/run verification.
- **Regression test:** `stagingCertification.test.js`, `nativeMobileEvidence.test.js`.
- **Verification:** Certification matrix and native parser suites pass; workflow text contains no TestSprite Android/iOS IDs.
- **Final state:** Fixed; runtime without real native evidence remains blocked.

## DEF-REL-002 — Whole-tree equality conflated release content with branch-specific governance

- **Preexisting or introduced:** Preexisting.
- **Symptom:** The master check compared the promotion branch’s whole tree with the predicted merged tree. Intentional master-only governance made equivalence impossible even when runtime content could be equal.
- **Root cause:** The equivalence boundary was repository history/tree shape rather than governed runtime release content.
- **Security impact:** The fail-closed check itself was safe, but it incentivized unsafe history merging or broad exclusions to get a green result.
- **Release impact:** Genuine runtime promotion could never pass while master retained legitimate branch-only governance.
- **Files/workflows:** `master-promotion-validation.yml`, `compute-runtime-release-tree.js`, release-tree docs/tests.
- **Fix:** Added a tight projection covering app/server/native/Supabase runtime, migrations, dependencies, build/deploy manifests, and sensitive runtime configuration; only reviewed governance/tests/docs/evidence are outside it.
- **Regression test:** `releaseTreeEquivalence.test.js` proves governance-only divergence passes and any runtime blob change blocks.
- **Verification:** Fixture suite passes. Current live heads still block because the merge has runtime conflicts in `eas.json` and `supabase/functions/scan-identify/index.ts`.
- **Final state:** Fixed model; current runtime content remains correctly blocked.

## DEF-REL-003 — Provenance generator exceeded the bounded execution window

- **Preexisting or introduced:** Introduced during this pass and repaired before publication.
- **Symptom:** The first generation attempt spawned Git commands per commit/path and timed out after 124 seconds without producing the JSON map.
- **Root cause:** N×M process creation for 543 commits and head-blob comparisons.
- **Security impact:** None to runtime; an incomplete provenance artifact could have hidden unclassified history if accepted.
- **Release impact:** Blocked reproducible provenance generation.
- **Files/workflows:** `build-master-staging-provenance-map.js`, `provenanceMap.test.js`.
- **Fix:** Batch each divergent history with one `git log --diff-merges=first-parent` call and load each head tree once with `git ls-tree`.
- **Regression test:** The provenance test checks full 543-commit accounting and batched implementation structure.
- **Verification:** Generation completes in about three seconds and all 543 unique SHAs are present.
- **Final state:** Fixed.

## DEF-REL-004 — Native evidence source identity initially pinned only by workflow display name

- **Preexisting or introduced:** Introduced during this pass and repaired before publication.
- **Symptom:** The first acquisition draft verified repository, run ID, head SHA, and workflow display name but not the workflow path.
- **Root cause:** GitHub Actions run names are not unique security identities.
- **Security impact:** Another same-repository workflow with the same display name could have supplied a contract-shaped artifact.
- **Release impact:** Evidence provenance would have been weaker than the release contract requires.
- **Files/workflows:** `staging-release-certification.yml`, native evidence documentation/tests.
- **Fix:** Pin both workflow display name and exact workflow path for each platform before downloading artifacts.
- **Regression test:** `stagingCertification.test.js` requires both exact native workflow paths.
- **Verification:** Certification tests pass with the path assertions.
- **Final state:** Fixed.

## DEF-REL-005 — Runtime build/dependency manifests could skip staging deployment

- **Preexisting or introduced:** Preexisting classifier defect, exposed by this pass's temporary test-script aliases.
- **Symptom:** A PR that changed `package.json` was correctly labeled `RUNTIME_RELEASE` but still emitted `stagingImpact=false`, so the staging deployment job skipped. Its human-facing file classification also collapsed `BUILD/CI` into `DOCUMENTATION ONLY`. Post-merge runtime-tree verification caught the unexpected digest change.
- **Root cause:** `stagingImpact` required one of a narrow set of API/auth/storage tags. `package.json`, `package-lock.json`, `eas.json`, and `app.config.*` were tagged `BUILD/CI`, which the calculation treated as no-deploy even though these files are release content; a separate normalization branch mislabeled build-only files as documentation.
- **Security impact:** A dependency or security-sensitive build/config change could be certified without deploying the exact candidate through the staging path.
- **Release impact:** The deployment identity contract could fail later or, without the independent builder guard, misrepresent an undeployed candidate.
- **Files/workflows:** `classify-changed-surfaces.js`, `staging-release-certification.yml`, `package.json`, certification regression tests.
- **Fix:** Any file outside the strict control-plane allow-list now implies `RUNTIME_RELEASE` and `stagingImpact=true`. Build/dependency files retain `BUILD/CI`, while security/test paths report `CONTROL PLANE`. The temporary package test aliases were removed; the workflow invokes those tests directly so the release manifest returns to its prior content.
- **Regression test:** `stagingCertification.test.js` proves `package.json` is `BUILD/CI`, runtime, and staging-impacting, and that security scripts report `CONTROL PLANE`.
- **Verification:** Classifier/certification tests pass and the corrected branch's runtime-tree digest returns to the pre-change staging digest.
- **Final state:** Fixed through a follow-up protected staging PR.

## DEF-REL-006 — Two release-control surfaces asserted different canonical Supabase project refs

- **Preexisting or introduced:** Preexisting. Surfaced (not caused) by Phase 2A, which established exact environment identity as a governing requirement and therefore made the latent conflict a merge blocker.
- **Symptom:** `test:edge-parity` failed on `staging/production-parity` with `Project reference mismatch: config.toml declares "yzqjvdfgefveprobvvyw", manifest approves "wyyuqfdxucjksghsmhry"`, cascading into 6 failing tests. Reproduced identically against a pristine `git archive` export of the base commit, confirming it was not introduced by Phase 2A.
- **Root cause:** `config/edge-function-manifest.json` fused two different concerns. Its artifact inventory (governed function set, per-file SHA-256, bundle/tree hashes) is **environment-neutral** and is deliberately committed byte-identically on every branch — that identical-copy property is the mechanism by which "matches the manifest" transitively means "matches the other platform branch". But the same `parity` section also carried `approvedProjectRef`, an **environment-specific deploy-target claim** whose value was recorded from `supabase/config.toml` on the canonical (Android) line, where that file declares production. Committing the manifest onto the staging line therefore asserted a production deploy target on a branch whose `config.toml` correctly declares staging. `scripts/edge-function-manifest-lib.js` also kept its own `APPROVED_PROJECT_REF` copy of the mapping, duplicating authority that Phase 2A had centralized.
- **Security impact:** None realized — the conflict caused a fail-closed refusal, never a permissive one. The latent risk was the opposite of a bypass: a legitimate gate was permanently red on the integration branch, which is the condition under which teams learn to ignore or bypass a gate.
- **Release impact:** The live edge-parity gate could never pass on the canonical integration branch, blocking PR #107.
- **Files/workflows:** `scripts/edge-function-manifest-lib.js`, `scripts/check-edge-function-parity.js`, `scripts/generate-edge-function-manifest.js`, `scripts/deploy-edge-functions.js`, `config/edge-function-manifest.json`, `__tests__/edgeFunctionSourceParity.test.js`, `docs/release/ENVIRONMENT_AUTHORITY.md`.
- **Fix:** Separated the two roles rather than repointing the ref. The manifest is now explicitly `environmentScope: ENVIRONMENT_NEUTRAL` (v2) and names no project; the v1 production ref is preserved as provenance under `parity.deployAuthority.legacyV1ApprovedProjectRef` rather than deleted. Source parity now proves only that a checkout **has** a known environment identity, failing closed on missing/malformed/unknown refs, and resolves it through the shared `security/scripts/lib/environment-authority.js` instead of a local constant. Deploy-target authority stays where it belongs: `scripts/deploy-edge-functions.js` asserts `assertExpectedEnvironment('production', …)` before any production deploy, so its capability is unchanged. Zero function hashes changed.
- **Regression test:** `__tests__/edgeFunctionSourceParity.test.js` — `authority: a staging checkout passes source parity`, `authority: a production checkout passes source parity`, `authority: an unknown project reference fails the gate`, `authority: a malformed project reference fails the gate`, `authority: resolveCheckoutEnvironment fails closed and never guesses`, `authority: a manifest claiming to be environment-scoped is refused`, `deploy guard: a STAGING checkout cannot run the production deploy path`, `deploy guard: an unknown project reference aborts before deployment`, `deploy guard: a missing config.toml aborts before deployment`, plus the committed-manifest assertion that a project ref is absent from the parity section and the legacy ref is retained.
- **Verification:** `npm run test:edge-parity` 24/24 pass (was 11/17). `npm run test:release-control-plane` 91/91. `test:staging-parity` 23, `test:staging-certification` 35, `test:rpc-policy` 20, `test:provenance-quarantine` 12, `test:security` 27, `test:staging-deploy` 20, `test:staging-v2-guard` 67 — all pass. Full suite 4932 pass / 20 fail vs 4919 / 26 before: **zero new failures, six resolved**. Release-manifest `identityDigest` determinism re-verified; production eligibility still returns `false` with every prior blocker intact.
- **Final state:** Fixed. Environment identity, artifact identity, and deploy-target authority are now three distinct surfaces, and no file means two of them.

## DEF-REL-007 — verify-supabase had no self-contained environment refusal

- **Preexisting or introduced:** Preexisting; identified in Phase 1 discovery and repaired in Phase 2B.
- **Symptom:** `scripts/verify-supabase.js` probed whichever Supabase project the caller's `EXPO_PUBLIC_SUPABASE_URL` named. Unlike its sibling controls (`synthetic-staging-tests.js`, `verify-staging-parity.js`, `stagingBackendContract.test.js`), it carried no production-refusal guard of its own.
- **Root cause:** The script's staging-only safety was a property of the calling workflow's environment variables rather than of the script. Nothing in it asserted an expected environment, so a mis-set variable, a copied command line, or a local developer run could point a "staging verification" at production and it would proceed to probe.
- **Security impact:** Read-only probes only, so no mutation risk — but it could have produced a report labelled staging verification from production data, which is a provenance/labelling failure in a release-governance control.
- **Release impact:** A release could have been certified against evidence gathered from the wrong environment.
- **Files/workflows:** `scripts/verify-supabase.js`, `__tests__/release/verifySupabaseAuthority.test.js`.
- **Fix:** The expected environment is now explicit (`KSCAN_EXPECTED_ENVIRONMENT`, defaulting to `staging`) and validated through `security/scripts/lib/environment-authority.js`. The guard runs before the first probe and fails closed in every direction: production-when-staging-expected, staging-when-production-expected, unknown ref, malformed ref, and missing identity all BLOCK.
- **Regression test:** `__tests__/release/verifySupabaseAuthority.test.js` — 7 cases exercising the real script as a subprocess, including an assertion that no reachability section is printed on refusal (i.e. the guard refuses *before* probing), so removing or bypassing the guard fails the suite.
- **Verification:** 7/7 pass. `test:staging-deploy` 20/20 and the full suite show zero new failures.
- **Final state:** Fixed.

## DEF-REL-008 — health contract refactor broke a pre-existing staging-health security control

- **Preexisting or introduced:** Introduced during Phase 2B and repaired before publication.
- **Symptom:** `test:staging-deploy` failed on `health: staging-health response shape contains no secret markers`, which asserts the literal `environment: 'staging'` appears in the function source.
- **Root cause:** Adding the health contract v1 routes, I hoisted the environment name into a shared `const ENVIRONMENT = 'staging'` and emitted `environment: ENVIRONMENT` from each handler. Behaviour was unchanged, but the existing control asserts the *literal* at each response site.
- **Security impact:** None realized — the control caught it. The control's intent is stronger than it first appears: requiring the literal at each response site means a single edit cannot repoint every response's claimed environment at once, which a shared binding would allow.
- **Release impact:** Would have failed the staging deploy pipeline gate.
- **Files/workflows:** `supabase/functions/staging-health/index.ts`.
- **Fix:** Conformed to the existing control rather than rewriting it — the environment literal is inlined at every response site and the shared constant was removed, with a comment recording why the repetition is deliberate.
- **Regression test:** Added `every response hardcodes its environment as a literal` in `__tests__/release/releaseVerification.test.js`, which asserts no shared `const ENVIRONMENT =` binding exists and that at least four response sites carry the literal — so a future re-hoist fails from the release side too, not only the security side.
- **Verification:** `test:staging-deploy` 20/20, `test:release-verification` 58/58.
- **Final state:** Fixed.

## DEF-REL-009 — a failed release could be laundered into a verified trust root

- **Preexisting or introduced:** Introduced in Phase 2B, found by manager review before merge.
- **Symptom:** A release that failed exact attestation with `FULL_RUNTIME_ATTESTATION_GAP` could still have its manifest converted into a "previous verified state", allowing the next release to treat never-verified hashes as trusted carry-forward provenance.
- **Root cause:** `security/release/verify-exact-candidate.js` exposed `buildVerifiedState({ releaseId, manifest })`, which built a carry-forward baseline from manifest-DECLARED source hashes. It required no receipt, no exact-verification result, and no STAGING_VERIFIED evidence — only a manifest, which is a statement of intent rather than of outcome. The laundering path was: run 1 ends in `FULL_RUNTIME_ATTESTATION_GAP` with `STAGING_VERIFIED = NO`; call `buildVerifiedState(manifest)`; run 2 then reads unchanged components as `CARRIED_FORWARD_FROM_PREVIOUS_VERIFIED_STATE` from a release that was never verified. Phase 2B's own test suite used this path to construct its `previousVerifiedState` fixtures, which is how a fabricated baseline came to be exercised as if it were legitimate.
- **Security impact:** Provenance integrity. The carry-forward mechanism exists precisely so unchanged components need not be redeployed every release; if its trust root can be minted from a failed run, then `CARRIED_FORWARD_FROM_PREVIOUS_VERIFIED_STATE` degrades to an unverified assertion and every later release inherits it. No live impact — Phase 2B was never activated, so no baseline was ever minted against real staging.
- **Release impact:** Would have allowed a future release to reach exact-candidate PASS on the strength of laundered provenance.
- **Files/workflows:** `security/release/verified-baseline.js` (new), `security/release/verify-exact-candidate.js`, `security/release/build-release-evidence.js`, `__tests__/release/verifiedBaseline.test.js` (new), `__tests__/release/releaseVerification.test.js`, `docs/release/STAGING_RELEASE_VERIFICATION.md`.
- **Fix:** `buildVerifiedState` is removed outright rather than deprecated, so the manifest-only path cannot be reached. Minting moves to `mintVerifiedBaseline()`, which requires the complete evidence chain (present manifest/freeze/receipt/verification/evidence, receipt integrity, matching release ID + source SHA + tree SHA + manifest digest, `exactCandidateVerification.result === PASS`, zero `UNATTESTED` components, `stagingVerifiedEligible === true`, and `canEnterStagingVerified().allowed === true`) and throws `VERIFIED_BASELINE_NOT_ELIGIBLE` listing every failed requirement. Consumption is hardened symmetrically: `attestComponents` re-validates any supplied baseline (integrity digest, required fields, hash shape, no `UNATTESTED` or governance-excluded components) and a rejected baseline carries nothing forward. The first trust root is now created only through an explicit one-time `BOOTSTRAP_FULL_ATTESTATION` release that redeploys every already-live governed staging function and must itself reach `STAGING_VERIFIED`; bootstrap refuses to install a function that is not already live, excludes quarantined/heritage/excluded surfaces structurally, and never replays migrations. `canEnterStagingVerified` now delegates to a single shared predicate so minting and the state guard cannot drift apart.
- **Regression test:** `__tests__/release/verifiedBaseline.test.js` — 34 tests covering all 30 required cases: manifest-alone / attestation-gap / BLOCKED / OPERATIONAL_FAILURE / missing-verification / ineligible-evidence / refused-transition / one-UNATTESTED-component / receipt-integrity / SHA / tree / digest mismatches all refuse minting; the legitimate full-attestation path mints and binds SHA+tree+manifest+receipt+component hashes; fabricated, incomplete, tampered, malformed-hash and quarantine-claiming baselines are rejected on consumption; bootstrap rejects production, unknown project, missing identity, pre-existing baseline, invalid freeze and failed binding, plans exactly the already-live governed set, excludes quarantine/heritage/excluded, halts with `BOOTSTRAP_LIVE_INVENTORY_RECONCILIATION_REQUIRED` on a missing function, and reapplies no migrations; carry-forward works only from a valid baseline, changed-but-undeployed components become `UNATTESTED`, a fabricated baseline cannot rescue a release into PASS, production eligibility stays false and the leaked-password classification is unchanged.
- **Verification:** `test:release-verification` 92/92 (58 → 92 with the new suite). `test:release-control-plane` 92, `test:edge-parity` 24, `test:security` 27, `test:staging-parity` 23, `test:rpc-policy` 20, `test:provenance-quarantine` 12, `test:staging-deploy` 20, `test:staging-certification` 35, `test:staging-v2-guard` 67 — all pass. Full suite compared against the PR #108 pre-correction head: zero new failures.
- **Final state:** Fixed. No baseline has been minted and bootstrap has not been executed; Phase 2B remains unactivated.

## DEF-REL-010 — an unkeyed baseline checksum was treated as provenance

- **Preexisting or introduced:** Introduced by the DEF-REL-009 fix in Phase 2B.1, found by manager review before merge.
- **Symptom:** A fabricated baseline-shaped object could recompute its ordinary SHA-256 `baselineDigest` over its own contents and satisfy standalone baseline validation, despite never having been minted from a STAGING_VERIFIED release.
- **Root cause:** Consumption treated an unkeyed, self-contained checksum as evidence of provenance/authenticity rather than merely of internal consistency. The DEF-REL-009 test that was supposed to cover this used a forgery with a deliberately *wrong* digest (`'f'.repeat(64)`), so it only exercised an attacker who forgot to recompute the checksum — the very case that does not matter. The module and documentation both overstated the guarantee, with the docs asserting that "a hand-written, baseline-shaped object fails the digest check".
- **Security impact:** Provenance integrity. Anyone able to supply the `previousVerifiedState` input could have minted trust for arbitrary component hashes, re-enabling the laundering DEF-REL-009 set out to close. No live impact: Phase 2B has never been activated and no baseline has ever been minted against real staging.
- **Release impact:** A future release could have reached exact-candidate PASS on carry-forward provenance that nothing corroborated.
- **Files/workflows:** `security/release/verified-baseline.js`, `security/release/build-release-evidence.js`, `security/release/verify-exact-candidate.js`, `security/release/generate-release-manifest.js`, `__tests__/release/baselineEvidenceBinding.test.js` (new), `__tests__/release/verifiedBaseline.test.js`, `__tests__/release/releaseVerification.test.js`, `docs/release/STAGING_RELEASE_VERIFICATION.md`.
- **Fix:** Provenance now comes from corroboration rather than from a checksum. The authoritative release evidence gained a deterministic `evidenceDigest` (excluding itself), a minted baseline binds that digest plus the originating run id, and `validateVerifiedBaseline` requires the source evidence to be supplied and to agree on evidence digest, release id, source SHA, source tree SHA, manifest digest, receipt digest and per-component hashes/attestations — while the prior evidence must itself show `stagingVerifiedEligible`, an allowed staging-verified decision, an eligible verdict and `exactCandidateVerification.result === PASS`. `attestComponents`/`verifyExactCandidate` now take a `previousRelease: {baseline, evidence}` bundle; a baseline alone, evidence alone, or a mismatched pair all carry nothing forward. Validation reports `structurallyValid` separately from `valid` so the two concepts cannot be conflated again, and the code and docs now state plainly that Phase 2B provides integrity, not cryptographic authenticity — no HMAC/signing key was introduced.
- **Regression test:** `__tests__/release/baselineEvidenceBinding.test.js` — 25 tests. The key one is #1: a forgery whose digest is *correctly recomputed* is asserted to be `structurallyValid: true` and `valid: false`, which is the exact case the old test missed. Plus baseline-only, evidence-only and every cross-field mismatch (evidence digest, release id, source SHA, source tree, manifest digest, receipt digest), ineligible/denied/non-PASS prior evidence, the working legitimate path, evidence-digest determinism, mutation sensitivity, self-exclusion from its own hash, and secret-shape absence.
- **Verification:** `test:release-verification` 117/117 (92 → 117). All other required gates pass. Full suite compared against PR #108 head `2451bdf`: zero new failures.
- **Final state:** Fixed. No baseline minted, bootstrap not executed, Phase 2B still unactivated.

## DEF-REL-011 — bootstrap ignored environment applicability while claiming to honour it

- **Preexisting or introduced:** Introduced in Phase 2B, found by manager review before merge.
- **Symptom:** `planBootstrapFullAttestation()` selected its function set with `fn.class === 'GOVERNED' && fn.releaseIncluded`, and named the result "staging-applicable governed functions" — but applied no environment restriction at all.
- **Root cause:** `class` (release inclusion) and `environments` (deploy targeting) are independent axes, and only the first was consulted. Compounding it, the manifest's Edge Function inventory did not carry `environments` through from the governance file, so the planner had nothing to filter on even if it had tried.
- **Security impact:** None directly. The failure mode is availability of the bootstrap path, not a trust bypass — quarantined and heritage surfaces were already excluded by the class check.
- **Release impact:** A `GOVERNED` function scoped to production only would have been demanded by a *staging* bootstrap. Not being live on staging, it would have halted bootstrap with `BOOTSTRAP_LIVE_INVENTORY_RECONCILIATION_REQUIRED` — a spurious blocker pointing at a non-problem, and exactly the kind of false alarm that erodes trust in a gate. No such function exists today, so nothing was blocked in practice.
- **Files/workflows:** `security/release/verified-baseline.js`, `security/release/generate-release-manifest.js`, `__tests__/release/baselineEvidenceBinding.test.js`.
- **Fix:** `environments` now flows from the governance declaration into the manifest inventory and into the identity material (it is governance, so it belongs in the digest). One authoritative helper, `isApplicableToEnvironment(entry, environment)`, encodes the rule: GOVERNED + release-included, and either no `environments` (shared, applicable everywhere) or an `environments` list containing the target. Quarantined/heritage/excluded/unknown are never applicable regardless of what `environments` claims. Both the bootstrap plan and its `excludedByGovernance` report use that single helper.
- **Regression test:** `baselineEvidenceBinding.test.js` #19-#22 — a synthetic `environments: ["production"]` GOVERNED function is proven *not* required by a staging bootstrap even when absent from live staging; a `["staging"]` function is proven required; an unscoped shared function stays applicable; and every excluded class stays excluded even when it explicitly names staging.
- **Verification:** `test:release-verification` 117/117; zero new failures across the full suite.
- **Final state:** Fixed.

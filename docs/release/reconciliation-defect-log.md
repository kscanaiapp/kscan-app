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

## DEF-REL-012 — ACTIVATION_PIPELINE_MISSING

- **Preexisting or introduced:** Introduced across Phase 2B/2B.1/2B.2, found by the first live activation attempt, which correctly refused to mutate staging.
- **Symptom:** Phase 2B verification libraries could describe a verified release, but no governed execution path could set its release identity, drive the complete bootstrap deployment, produce live receipts/evidence, or persist the first baseline. The live activation reached Part 8 (candidate binding PASS) and stopped at Part 9.
- **Root cause:** Phase 2B implemented the release-verification MODEL and left activation orchestration and release-metadata delivery as assumed external concerns. Concretely: `staging-health` read six `KSCAN_*` variables that nothing anywhere set; no workflow or script invoked `planBootstrapFullAttestation`, `bindCandidate`, `mintVerifiedBaseline` or `buildReleaseEvidence`; and `staging-controlled-deploy.yml` deploys a single function from the runner's mutable checkout with no manifest binding and no receipt. Had activation proceeded regardless, the deterministic outcome was 17 real staging deployments followed by `/version` reporting `NOT_VERIFIABLE`, exact verification `OPERATIONAL_FAILURE`, and no baseline — real mutation, no trust root.
- **Security impact:** None realized; the gap caused a fail-closed refusal, not a permissive one. The residual risk was operational: a half-activated staging backend with no provenance record.
- **Release impact:** Phase 2B was not activatable as merged.
- **Files/workflows:** `security/release/run-bootstrap-activation.mjs` (new), `security/release/set-staging-release-metadata.mjs` (new), `security/release/staging-deploy-core.mjs` (new), `security/release/verified-release-package.mjs` (new), `.github/workflows/staging-release-bootstrap.yml` (new), `__tests__/release/activationPipeline.test.js` (new).
- **Fix:** A governed staging-only activation path. The orchestrator sequences the merged libraries (it reimplements none of them) in the order the trust model requires: deploy every governed function except `staging-health` → require all PASS → write exactly six allowlisted `KSCAN_*` values → deploy `staging-health` last → receipt → health/version → exact verification → smoke → certification → evidence → STAGING_VERIFIED → mint → persist. Metadata is written by a narrow writer with a static six-key allowlist, an explicit production deny, and an ephemeral `RUNNER_TEMP` env file deleted in a `finally`. Deployment input is materialized from git objects, never the worktree. `EXECUTE` fails closed outside the governed CI path; `PLAN_ONLY` writes nothing. Baseline + evidence persist as a staging prerelease anchored to the verified commit, so the source branch is never moved after verification.
- **Regression test:** `__tests__/release/activationPipeline.test.js` — 30 tests: six-key allowlist and unknown-seventh-key rejection, production/unknown/malformed target rejection, token never in argv, temp file cleanup, `PLAN_ONLY` zero-write, `EXECUTE` authority, prior-baseline and missing-live-function refusal, unsatisfied migration state, `staging-health` last with no hardcoded count, missing/duplicate health function, TOCTOU immutability, config-fingerprint identity semantics, persistence read-back mismatch, retrieval rejection of baseline-only/evidence-only/wrong-commit/non-staging-tag, quarantine exclusion, and workflow permission minimality.
- **Verification:** `test:release-verification` 147/147 (117 → 147). All nine other required gates pass. Full suite 5080 pass / 20 fail — zero new failures against merged staging `d73ac42`.
- **Final state:** Fixed. Not executed: this is a build pass, and the workflow has never been run.

## DEF-REL-013 — candidate materialization was not portable to the local platform

- **Preexisting or introduced:** Introduced in this pass and caught by its own TOCTOU regression test before review.
- **Symptom:** `materializeCandidate` failed on Windows with `tar: Cannot connect to C: resolve failed`, so the TOCTOU test could not run locally and a local `PLAN_ONLY` invocation would have broken.
- **Root cause:** The first implementation used `git archive --format=tar` piped to `tar -xf … -C <dest>`. GNU tar parses a `C:\…` destination as a `host:path` remote spec, so extraction never ran. It would have worked on the Linux CI runner, which is exactly why it would have gone unnoticed until someone ran the orchestrator locally.
- **Security impact:** None. Fail-closed: materialization raised `CANDIDATE_MATERIALIZATION_FAILED` rather than silently falling back to worktree bytes.
- **Release impact:** Local `PLAN_ONLY` — the dry run the activation brief requires before EXECUTE — would have been unusable on the maintainer's platform.
- **Files/workflows:** `security/release/staging-deploy-core.mjs`.
- **Fix:** Extraction is now `git ls-tree -r` + `git show` per file, writing into the temp root directly. No external archiver, portable everywhere git runs, and it is the same git-object read path `candidate-binding.js` already uses to hash the candidate — so the bytes deployed and the bytes hashed are obtained identically.
- **Regression test:** `deploy core: worktree mutation cannot change the deployed bytes (TOCTOU)` builds a throwaway repo, materializes, mutates the worktree, re-materializes, and asserts the hash is unchanged and the tampered content never appears.
- **Verification:** 30/30 in `activationPipeline.test.js`; zero new failures in the full suite.
- **Final state:** Fixed.

## DEF-REL-014 — REAL_EXECUTE_ADAPTERS_UNWIRED

- **Preexisting or introduced:** Introduced in Phase 2B.3, found by manager review before merge.
- **Symptom:** The orchestrator defaulted `probeHealth`, `certification` and `github` to null, and the CLI supplied none of them. A real EXECUTE would therefore have produced `health = OPERATIONAL_FAILURE` with absent certification and no persistence — STAGING_VERIFIED unreachable no matter how well every deployment went.
- **Root cause:** Adapters existed only as test injection points. The library was proven; the path that actually runs was not. Prior-baseline discovery had the same shape: the CLI always passed `priorVerifiedRelease = null`, so a second dispatch after a successful bootstrap would not have found its own trust root.
- **Security impact:** None realized (fail-closed). The risk was operational: a run that deployed 17 functions and then could not conclude.
- **Release impact:** Activation was not completable.
- **Files:** `security/release/activation-runtime-adapters.mjs` (new), `security/release/run-bootstrap-activation.mjs`.
- **Fix:** Real adapters implemented and wired by the CLI itself via `buildCliDeps()`. The health probe hits `/health/live`, `/health/ready` and `/version` with bounded timeouts and passes the verbatim `/version` body to the exact verifier; timeout, DNS failure, malformed JSON, non-2xx and a NOT_VERIFIABLE identity all resolve to OPERATIONAL_FAILURE rather than PASS. Certification consumes the repository's existing canonical report and blocks when missing or malformed rather than passing null. Prior verified releases are discovered read-only in both modes through `loadPriorVerifiedRelease` with a read-only GitHub adapter, and the package is fully re-validated — tag naming is never trusted.
- **Regression test:** `activationExecutionIntegrity.test.js` — CLI-wiring assertions (`buildCliDeps` returns all three adapters AND the CLI source passes them through), four health failure modes, the NOT_VERIFIABLE case, the healthy case, and four certification cases. Plus a subprocess test that runs the real CLI.
- **Verification:** 28/28 in the new suite; `test:release-verification` 175/175; zero new failures in the full suite.
- **Final state:** Fixed. Not executed.

## DEF-REL-015 — PERSISTENCE_EXECUTION_SPLIT

- **Preexisting or introduced:** Introduced in Phase 2B.3, found by manager review before merge.
- **Symptom:** The workflow expected `activation/verified-baseline.json` and three sibling files, but the orchestrator only printed one combined result to stdout, so the persistence job could never find the package. Separately, `publishPackage()` implemented upload + read-back + digest verification while the workflow published with its own inline `gh release create` block — the code that ran was the one WITHOUT the read-back.
- **Root cause:** Two publication implementations, and the reported guarantee ("read-back verified") belonged to the one the workflow bypassed.
- **Security impact:** A corrupted or truncated upload would have been reported as successful persistence, so a later release could have attempted carry-forward from an unusable package.
- **Release impact:** Persistence could not succeed, and its verification claim was untrue of the executed path.
- **Files:** `security/release/run-bootstrap-activation.mjs`, `security/release/persist-verified-release-package.mjs` (new), `.github/workflows/staging-release-bootstrap.yml`.
- **Fix:** `--output-dir` writes each artifact atomically (tmp + rename) the moment it legitimately exists; `verified-baseline.json` is written only after minting AND validation succeed, so a denied release cannot leave a "verified" file behind. Publication moved entirely into `persist-verified-release-package.mjs`, which calls `publishPackage()` — the single authority that uploads, reads back and compares digests. The workflow now invokes that executable and contains no publication algorithm. Per Part E the execute job keeps `contents: read` and legitimately ends `PERSISTENCE_PENDING`; only the persistence job publishes.
- **Regression test:** PLAN_ONLY writes plan artifacts but no baseline; persistence refuses a missing baseline; persistence refuses evidence that was not staging-verified; a full publish uploads four assets as a prerelease tagged at the exact candidate and a read-back mismatch returns `VERIFIED_BASELINE_PERSISTENCE_GAP`; the workflow contains no `gh release create`.
- **Verification:** 28/28; zero new failures.
- **Final state:** Fixed.

## DEF-REL-016 — DEPLOY_CORE_NOT_SHARED_AND_VERIFY_JWT_NOT_ENFORCED

- **Preexisting or introduced:** Introduced in Phase 2B.3. **I reported `SHARED_WITH_EXISTING_STAGING_PATH = YES` when `scripts/deploy-staging-function.mjs` had not been modified at all** — the claim was false, and the new core was a parallel second deployer.
- **Symptom:** Two deployment implementations. Worse, the new core recorded `verifyJwt` but never passed `--no-verify-jwt`, while the existing deployer did.
- **Root cause:** The refactor was described but not performed. The verify_jwt omission followed from building a new path instead of extending the proven one.
- **Security impact:** Real. `verify_jwt` is runtime AUTHORIZATION. Bootstrap would have deployed `staging-health` with JWT verification enabled — breaking the deliberately public health probe, which is the surface release verification depends on. The inverse error on another function would expose an authenticated endpoint.
- **Release impact:** Bootstrap would have produced a staging backend whose health contract was unreachable.
- **Files:** `security/release/staging-deploy-core.mjs`, `scripts/deploy-staging-function.mjs`.
- **Fix:** `buildDeployArgs()` is now the single command primitive and emits `--no-verify-jwt` when the posture is false; `scripts/deploy-staging-function.mjs` imports and uses it, so the hand-rolled flag push is gone and the two paths cannot drift. `resolveVerifyJwt()` resolves the posture from governed configuration — the manifest entry first, then the function's own `config.toml` (which is where `staging-health` declares `verify_jwt = false`, since the root file omits it) — and throws `VERIFY_JWT_UNRESOLVED` rather than defaulting. The controlled path's `EXPECTED_VERIFY_JWT` input is now cross-checked against the governed value instead of trusted.
- **Regression test:** the existing deployer imports the core and no longer pushes the flag itself; `--no-verify-jwt` present/absent by posture; `staging-health` resolves to `false` from `function-config.toml` and its command carries the flag; an undeclared posture is refused.
- **Verification:** 28/28 plus `test:staging-deploy` 20/20; zero new failures.
- **Final state:** Fixed.

## DEF-REL-017 — CANDIDATE_DEPLOY_HASH_CONTRACT_MISMATCH

- **Preexisting or introduced:** Introduced in Phase 2B.3, found by manager review before merge.
- **Symptom:** `candidate-binding.js` hashed entries keyed on REPO-relative paths (`supabase/functions/x/index.ts:<sha>`) while the deploy core hashed FUNCTION-relative paths (`index.ts:<sha>`). Measured directly: binding `838379e5...` vs deploy `c41dc2a3...` for the same untouched source. The binding hash could therefore never equal the deploy-input hash, and a real EXECUTE would have blocked **every** governed function with `SOURCE_HASH_MISMATCH`.
- **Root cause:** Three near-identical hashers with no shared definition, and a test that only proved the negative case — it supplied a deliberately wrong hash, so it passed whether or not the matching case worked.
- **Security impact:** None realized (fail-closed), but the control was inert: it would have blocked everything, which is indistinguishable from blocking nothing once someone "fixes" it by loosening the comparison.
- **Release impact:** Bootstrap could not deploy a single function.
- **Files:** `security/release/function-source-hash.js` (new), `security/release/candidate-binding.js`, `security/release/staging-deploy-core.mjs`.
- **Fix:** One canonical implementation with an explicit contract — paths relative to the function directory with POSIX separators, sorted byte-wise, every regular file included recursively, **raw bytes** hashed (not utf8-decoded, so binary content and newline translation cannot shift the digest), and `_shared` deliberately excluded because the manifest tracks it separately as `sharedDependencyHash`. Binding hashes git-object bytes through `hashFromFileMap`; the deploy core delegates to `hashFunctionSource`. Both now agree by construction rather than by coincidence.
- **Regression test:** the decisive positive test — bind a real candidate, materialize the same candidate, hash the deploy input, assert equality — for a normal function (`scan-identify`) AND `staging-health`. Plus: the canonical hasher is byte-based (a lone CR changes the digest), the deploy core delegates to it, and a mutated deploy input still blocks.
- **Verification:** equality proven for `scan-identify`, `staging-health` and `stylechat-generate`; 28/28; zero new failures.
- **Final state:** Fixed.

## DEF-REL-018 — ACTIVATION_PREFLIGHT_TOOLCHAIN_AND_FRESHNESS_GAPS

- **Preexisting or introduced:** Introduced in Phase 2B.3, found by manager review before merge.
- **Symptom:** Four distinct gaps in one workflow. (1) The workflow called `supabase` without installing the CLI. (2) `supabase migration list ... || echo '[]'` converted a CLI, auth, network or format failure into "zero migrations". (3) Staging HEAD and live inventory were checked only in preflight, so an environment-approval delay or a concurrent merge could make the evidence stale before mutation. (4) Each orchestrator invocation minted its own `releaseId` from its own clock, and `deploymentAttempt` was hardcoded to 1.
- **Root cause:** The workflow was written against library behaviour rather than runner reality, and time-of-check/time-of-use was not considered across an approval gate.
- **Security impact:** The empty-list fallback is the serious one: it would have let the bootstrap planner reconcile the candidate against a fabricated empty live state and reach a conclusion nobody measured.
- **Release impact:** A run could have deployed against stale evidence, under a releaseId that did not match the plan the operator approved.
- **Files:** `.github/workflows/staging-release-bootstrap.yml`, `security/release/build-activation-inventory.mjs` (new), `security/release/run-bootstrap-activation.mjs`.
- **Fix:** The pinned `supabase/setup-cli@v1` at `2.109.1` (the repository's existing standard) is installed in every job that invokes `supabase`, and the version is printed. Inventory is built by a fail-closed builder that validates shape and raises `ACTIVATION_INVENTORY_OPERATIONAL_FAILURE` on missing/empty/malformed/unknown-schema output — an empty *function* list is refused outright, while an empty *migration* list is accepted because it is structurally possible. EXECUTE re-fetches staging HEAD and blocks with `STALE_BOOTSTRAP_CANDIDATE` before any mutation, and re-reads the live inventory and compares it against the plan-stage snapshot. One `releaseId` is minted at preflight and threaded through plan, execute, receipt, metadata and tag; `deploymentAttempt` binds to `GITHUB_RUN_ATTEMPT`. A CLI arg-parsing defect found by these tests was fixed too: a missing `--inventory` flag resolved to `argv[0]`, making the CLI try to JSON.parse the node executable.
- **Regression test:** inventory shape/failure matrix incl. the real 103-migration case; no empty-list fallback in the workflow; CLI setup precedes every supabase command with the pinned version; both revalidation steps exist and precede the activation run; one releaseId minted and consumed by plan and execute; attempt bound to the run attempt; real-CLI subprocess tests for missing/empty/malformed inventory.
- **Verification:** 28/28; zero new failures.
- **Final state:** Fixed.

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

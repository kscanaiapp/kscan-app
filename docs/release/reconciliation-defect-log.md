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

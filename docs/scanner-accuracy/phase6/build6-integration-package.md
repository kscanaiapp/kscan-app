# Phase 6 — future physical Build 6 integration package

Not a release branch. Nothing here is integrated, activated, or deployed.

## Status

    PHASE 6 STATUS:                 BLOCKED
    FINAL CLASSIFICATION:           BLOCKED — PROVIDER CREDENTIAL UNAVAILABLE
    BLOCKING DEPENDENCY:            no working provider credential in this environment
    READY FOR OWNER REVIEW:         YES

Re-verified on the post-hotfix pass: `GEMINI_API_KEY` is present but unchanged
(19 characters) and the provider rejects it, HTTP 400, on a metadata-only probe
sent as a header with no image, no generation and no query parameter. No
placeholder was substituted and no filesystem, product config or shell history
was searched for a credential.

## Locked Elise hotfix inputs

Future-integration inputs only. Not merged, not built from, not modified.

    ANDROID BRANCH:   hotfix/android-elise-attach-first
    ANDROID BASELINE: 4d0ceb40655a7de7a2430bc4014ef0710aa8ca66
    ANDROID FINAL:    e63d5947b134ff3ee55034a77dd1279a2c3e4cea
    ANDROID STATE:    clean, pushed, 0 ahead / 0 behind

    IOS BRANCH:       hotfix/ios-elise-attach-first
    IOS BASELINE:     5c761ba7df2cfc7b22efa3d3326dca46850e02f0
    IOS FINAL:        1ace13ffe8c1032d9b1b913863b7ea61da33e095
    IOS STATE:        clean, pushed, 0 ahead / 0 behind

    HOTFIX CHANGES SCANNER PROVIDER PAYLOAD:        NO
    HOTFIX CHANGES IDENTIFICATION REQUEST CONTRACT: NO
    HOTFIX CHANGES IDENTIFICATION RESPONSE CONTRACT: NO
    HOTFIX CHANGES PARSER OR NORMALIZER:            NO

Verified from the **committed** diffs, not the previously inspected working
trees. Neither diff contains a `supabase/` path, a scanner service, a
identification type, a feature flag, `eas.json`, `app.json`, a lockfile, a
migration or any benchmark file. Zero changed lines touch an `identifyScanImage`
or `mapScanIdentifyToAnalysis` call site. The one removed `source: 'upload'`
line in each lane belongs to the deleted `saveScan({...})` persistence call, not
to an identification request.

Everything that does not require a provider call is complete: benchmark
certification, the frozen product-contract snapshot, dataset identity, failure
analysis, a benchmark repair with regression coverage, and Candidate A with a
written pre-registered hypothesis. Nothing that requires a provider call has
been attempted.

## Control identity

    CONTROL:                        certified-v140
    ENTRY:                          supabase/functions/scan-identify/index.ts
    CERTIFIED BUNDLE SHA-256:       28737e0c96047fa014c526886b32b3e5191283a9ed7441641da4d3b0ce632589
    ACTIVE PROMPT SHA-256:          6f2f4dd1c3c2e2d76dffb49fc24283ddfaf49a836f527c02ed2b82ef19b7dd1d
    RESPONSE SCHEMA SHA-256:        894722a6500756bd6eeae0e4beb4712a6b223c6ce4045d599f8d46682a5861a8
    GENERATION CONFIG SHA-256:      b6862722990cdfd3b387eaaf2d6a0e9880036b1fedab17fefd07c7db56c2d22e
    PROVIDER PARSER SHA-256:        332b713a7b7c516cf2d63fb4500c1a32a035464d862f783a9bc22f31b0ef8f79
    MODEL:                          gemini-3.6-flash, fallback gemini-3.5-flash-lite
    SAMPLING:                       temperature 0, maxOutputTokens 2048,
                                    responseMimeType application/json, no thinkingConfig
    ACTIVE SCANNER VERSION:         legacy-selected-item
    SINGLE DISPATCH:                proven
    ROLLBACK:                       trivially available — no candidate is registered in any
                                    product path, so rollback is the absence of a change

    HISTORICAL BASELINE REUSED:     NO
    FRESH CONTROL REQUIRED:         YES
    CONTROL RUN COMPLETE:           NO  (blocked on credential)
    CONTROL BASELINE LOCKED:        NO

Reuse was rejected mechanically, not by judgement. Provider payload, prompt,
schema, sampling, model and parser are byte-identical between certified-v140
and the current product, but the request contract and response contract differ,
and the governing rule requires every identity to match. See
`product-contract-snapshot.json`.

## Dataset identity

All hashes recomputed in this session, not copied from prior reports.

    DATASET VERSION:                0.3.1
    MANIFEST:                       evals/scanner-accuracy/tier-a-manifest.v0.3.1.json
    MANIFEST SHA-256:               5b2db5b9c0edf6093dbd982c64297e61b3677b0bb54b0cdcf3e70be2eb7b13af
    FREEZE RECORD:                  evals/scanner-accuracy/tier-a-freeze.v0.3.1.json
    FREEZE RECORD SHA-256:          e3781e9f5eedb00f8e71466055502757692f9c8e8f8b005763befbdea0963311
    FROZEN AGGREGATE SHA-256:       77e90edfe33d013285616ab1fa591112254b119be13620b606bfb57f37924883
    SELECTION CONTRACT:             tools/scanner-evaluation/lib/baselineInputSelection.js, v1.0.0
    SELECTION CONTRACT SHA-256:     2a3b84e8af60dc2b43bcfb94b630ea2629e11933bbde69437ec0698f92d3a159 (as recorded by the governed run)
    SCORING CONTRACT:               tools/scanner-evaluation/lib/scoreFields.js, v0.3.0
    SCORING CONTRACT SHA-256:       c2c8a53233d8e35272e76bb7885cf5f388caeedf5a9bdda3adb514aefaf57f6a
    TAXONOMY:                       v1.0.0, aggregate 3c93e35a66b34c42a8563d080794bafbaf640377c121622f3a10a3b2fb7a051a
                                    (single-file fashion-taxonomy.v1.json: 2417a9da3956860a11cd7016fad27ffa7cbeadd8765cc71efa3d124985e2a9d0)
    TOTAL GOVERNED CASES:           40
    DEVELOPMENT CASES:              33
    HOLDOUT CASES:                  7
    GOVERNED IMAGES:                56
    IMAGE HASHES VERIFIED:          56
    MISSING GOVERNED FILES:         0
    DUPLICATE IMAGE HASHES:         0
    EVALUATION IMAGES TRACKED BY GIT: 0
    STORAGE:                        KSCAN_EVAL_STORAGE_ROOT (outside every Git worktree)

`verify-frozen-dataset.js` returns `ok: true` with `errors: []`. The split was
frozen before any Phase 6 candidate existed. No label, denominator or split
member was changed in this session.

Holdout: 7 cases. **DESCRIPTIVE HOLDOUT EVIDENCE — NOT SUFFICIENT ALONE FOR
PRODUCTION PROMOTION.** It has not been opened, and its labels have not been
inspected.

## Candidate identity

    CANDIDATE:                      phase6-scanner-v1.0-a
    FAMILY:                         phase6-scanner-v1.0 (cap 3; one registered)
    OVERLAY ID:                     phase6-decisive-specificity-v1
    OVERLAY ARTIFACT:               tools/scanner-evaluation/adapter/phase6-scanner-v1.0-a-overlay.v1.json
    OVERLAY TEXT SHA-256:           b470706f3788912ee9d447a68bc9716a13c3f247a13fac0e5348b5be682e4764
    HYPOTHESIS RECORD:              docs/scanner-accuracy/phase6/candidate-a-hypothesis.md
    MECHANISM:                      append. Certified prompt never rewritten.
    MODEL CONFIGURATION:            certified-v140, unchanged
    OVERLAY SIZE:                   769 chars, ~192 tokens (rejected phase2a-v1.0.0: 3,996 chars, ~999 tokens)
    RESULTS:                        none. Candidate A has never been executed.
    CANDIDATE DECISION:             not yet measurable

Candidates B and C are designed in the hypothesis record and deliberately not
rendered — their designs depend on how A fails, and building all three before
the first measurement would spend the family's budget blind.

## Contract safety

    RESPONSE CONTRACT CHANGED:      NO
    RESPONSE SCHEMA CHANGED:        NO
    PARSER CHANGED:                 NO
    NORMALIZER CHANGED:             NO
    TAXONOMY CHANGED:               NO
    MOBILE CODE CHANGED:            NO
    PRODUCTION SCANNER MODIFIED:    NO
    PRODUCTION PROMPT MODIFIED:     NO
    FEATURE FLAGS CHANGED:          NO
    PACKAGE OR ROOT LOCKFILE CHANGED: NO
    EAS INPUTS CHANGED:             NO
    BACKEND DEPLOYED:               NO
    CANDIDATE ACTIVATED:            NO
    DUAL DISPATCH:                  NO
    EAS BUILD PERFORMED:            NO

## Expected integration files for Build 6

If Candidate A is measured, audited and approved, the forward-port touches
exactly one production concern: the text appended to the scanner prompt.

    supabase/functions/scan-identify/index.ts    IDENTIFY_PROMPT / SELECTED_ITEM path only

Nothing else. No schema file, no client file, no type, no flag.

## Expected shared-contract risks

Scanner output is consumed by Recent Scans, Closet intake, Build 2.5 Mirror
Selfie, Elise attachments, optional Elise-to-Closet save, commerce identity and
Dressing Room classification. A prompt change alters the *values* those
consumers receive, never the shape. The specificity rule makes `subtype` and
`material_estimate` more specific, which is visible in Closet classification
and commerce query construction.

Two live product facts a Build 6 integration must account for:

1. **The Elise attach-first hotfix is uncommitted work.** Both
   `hotfix/android-elise-attach-first` (`4d0ceb4`) and
   `hotfix/ios-elise-attach-first` (`5c761ba`) sit exactly at their baselines
   with zero commits; the implementation exists only as working-tree
   modifications across 23 files. It must be committed and locked before any
   Build 6 branch is cut from it.

2. **That hotfix does not change any scanner contract.** Verified file by file:
   it touches no identification service, no mapper, no type, and no Edge
   Function. It still calls `identifyScanImage(base64, { source, localPrivacyFiltered, signal })`
   through the same transport and still maps through `mapScanIdentifyToAnalysis`.
   What it changes is what happens *after* identification — persistence moves
   from `saved_scan` to the Closet candidate store, and the attachment identity
   field moves from `savedScanId` to `candidateId`. Phase 6 and that hotfix do
   not collide.

3. **The Android release branch has advanced** to `f5fb946`, one commit past
   the charter's pinned `4d0ceb4`, adding an internal Supabase staging EAS
   profile. `eas.json` is in no scanner closure path and the profile sets no
   scanner-candidate flag, so the scanner identity is unaffected.

## Required Build 6 regression tests

Not run during Phase 6; they cannot run without merging product sources.

- scanner benchmark: fresh control plus the approved candidate, same dataset version
- mobile scanner contract tests, both platform lines
- Elise direct upload and ATTACH TO ELISE
- optional Save to Closet after send
- Closet intake and manual classification
- Build 2.5 Mirror Selfie extraction
- Recent Scans persistence and separation
- commerce identity and ranking
- Dressing Room classification, owned-item and missing-piece handling
- complete Android and iOS suites
- physical-device validation on both platforms

## Product finding for owner decision — not implemented

The dominant scanner failure is not a prompt defect and cannot be fully
repaired by one. `maxOutputTokens` is 2,048 and no `thinkingConfig` is set, so
the response competes with the model's dynamic reasoning allowance for one
budget. All 20 invalid cases across both governed runs terminated within 20
tokens of that ceiling; no valid case came close. Successful responses need
only 130–186 tokens.

Raising the ceiling, or bounding the reasoning budget so the response is
guaranteed room, addresses the failure directly. Both are changes to the
certified generation configuration — production backend code, outside the Phase
6 candidate boundary, requiring owner decision and a separate deployment lane.

Recorded, not implemented.

## What unblocks Phase 6

A working `GEMINI_API_KEY` in the execution environment. The one present is
rejected by the provider (HTTP 400 on a metadata-only, zero-cost validation
call that sent no user data). With it, the remaining sequence is mechanical and
already built:

1. mock control, then token preflight
2. one-case live control
3. full 33-case development control → lock the baseline
4. Candidate A on the same 33 cases
5. compare; decide B or C only if A's result justifies one
6. leading candidate on the 7-case holdout, once
7. independent audit on `scanner/phase6-audit`

Estimated spend at the governed rates: ~$0.12 per 33-case run, ~$0.30 for
control plus Candidate A, well inside the $0.50-per-run and $2.00-per-session
ceilings.

# Phase 6 — fresh control run readiness

Everything a governed control run needs, verified and ready. The run itself is
blocked on one thing: a working provider credential.

    PROVIDER CALLS THIS PASS: 0
    SPEND THIS PASS:          $0.00

## Verified preconditions

| precondition | state |
|---|---|
| Elise hotfix locked, pushed, scanner-contract-neutral | verified from committed diffs |
| Phase 6 committed trees carry finishReason, invalidOutputCause, Candidate A, length guard | verified via `git show`, not the working tree |
| working tree identical to HEAD on both Phase 6 branches | 0 files differ |
| committed-tree suite | 549 tests, 548 pass, 0 fail, 1 optional skip |
| Candidate A length guard (§18 pre-execution gate) | PASS |
| dataset identity unchanged from frozen Phase 6 evidence | verified |
| evaluation media tracked by Git | 0 |
| `deno.lock` or unclassified generated file tracked | 0 |
| provider credential | **FAIL — HTTP 400** |

## Dataset identity

Recomputed this pass; identical to the frozen Phase 6 evidence, so no
`DATASET_IDENTITY_CHANGED` condition applies.

    DATASET VERSION:            0.3.1
    MANIFEST:                   evals/scanner-accuracy/tier-a-manifest.v0.3.1.json
    MANIFEST SHA-256:           5b2db5b9c0edf6093dbd982c64297e61b3677b0bb54b0cdcf3e70be2eb7b13af
    FREEZE RECORD:              evals/scanner-accuracy/tier-a-freeze.v0.3.1.json
    FREEZE RECORD SHA-256:      e3781e9f5eedb00f8e71466055502757692f9c8e8f8b005763befbdea0963311
    FROZEN AGGREGATE SHA-256:   77e90edfe33d013285616ab1fa591112254b119be13620b606bfb57f37924883
    SELECTION CONTRACT:         tools/scanner-evaluation/lib/baselineInputSelection.js, v1.0.0
    SELECTION CONTRACT SHA-256: 2a3b84e8af60dc2b43bcfb94b630ea2629e11933bbde69437ec0698f92d3a159
    SCORING CONTRACT:           tools/scanner-evaluation/lib/scoreFields.js, v0.3.0
    SCORING CONTRACT SHA-256:   c2c8a53233d8e35272e76bb7885cf5f388caeedf5a9bdda3adb514aefaf57f6a
    TAXONOMY:                   v1.0.0, aggregate 3c93e35a66b34c42a8563d080794bafbaf640377c121622f3a10a3b2fb7a051a
    TOTAL GOVERNED CASES:       40
    DEVELOPMENT / HOLDOUT:      33 / 7
    GOVERNED IMAGES:            56, all 56 hashes verified
    MISSING FILES:              0
    DUPLICATE CASE IDS:         0
    DUPLICATE IMAGE HASHES:     0
    EVALUATION MEDIA IN GIT:    0

## Governed smoke fixture

Selected from the benchmark contract, not invented. `smokePromotion.js` defines
the smoke as **one governed development case run under the final baseline run
id**, so it is promoted into the full baseline rather than discarded — which is
why the smoke and the baseline must share every governing configuration value.

    SMOKE CASE ID:      set-fishskin-jacket
    SELECTION SOURCE:   governed development split; the case the prior governed
                        smoke used, under run id
                        baseline-v0.3.1-v140-20260731-1107-4368067-development-exec
    EXPECTED CONTRACT:  certified-v140, legacy-selected-item, gemini-3.6-flash
    ESTIMATED COST:     ~$0.0036 (prior governed smoke: $0.003606)

## A finding that affects how the control must be read

The same governed case, under the same certified configuration and the same
prompt, produced opposite outcomes across two prior governed runs:

| run | reasoning tokens | response tokens | sum vs 2,048 ceiling | outcome |
|---|---|---|---|---|
| `phase3-smoke-control` | 1,737 | 146 | 1,883 | **success** |
| `phase3-dev-control` | 1,963 | 70 | 2,033 | **truncated** |

Identical input, identical configuration, 226 tokens of difference in the
model's own reasoning, and that difference alone decided validity.

Two consequences.

**It strengthens the budget-exhaustion reading.** A malformed-JSON defect would
tend to reproduce on the same input. A budget race does not — and this is a
budget race.

**It sets the anomaly rule before the run, not after.** If per-case truncation
is roughly a coin weighted at the historical p ≈ 0.182, the invalid count over
33 cases has a standard deviation of about 2.2 cases, or ~6.7 percentage
points. Two honest runs therefore differ by about 9.4 percentage points on
average from sampling alone — so a ten-point trigger fires at roughly one sigma
of ordinary noise. It would stop good runs constantly while saying nothing
about whether anything is actually wrong.

## Preregistered control-anomaly rule

Anomaly detection is **not** removed. It is moved off the rate and onto the
mechanism, and implemented as code rather than prose so it cannot be re-tuned
after a result exists: `tools/scanner-evaluation/lib/controlAnomaly.js`, with
14 tests in `__tests__/phase6ControlAnomaly.test.js`.

The invalid-rate delta is computed and reported, and is **never** an input to
the verdict. `assertRateDeltaIsNotAVerdictInput()` throws if a caller tries to
pass one in, a sweep test asserts the verdict is identical across all 34
possible invalid counts, and the delta is computed after the verdict so nothing
above it can consult it.

**EXPECTED_STOCHASTIC_VARIATION — the run is lockable** when all five hold:

| check | passes when |
|---|---|
| execution identity | dataset, prompt, model, generation config, request identity, parser and normalizer all match; an unreported identity fails rather than being assumed |
| capture consistency | completed equals planned, invalid causes sum to the invalid count, cost and latency accounting agree |
| provider attribution | invalid cases carry a finish reason; zero invalid cases is clean, not unattributable |
| dominant failure class | `output_budget_exhausted` still dominates; zero invalid cases passes |
| ceiling mechanism | every truncation-labelled case terminated within 5% of the configured ceiling (~102 tokens at 2,048; historical truncations landed within 20) |

**CONTROL_BASELINE_ANOMALY** only when one of those fails — an identity
drifted, a new dominant class appeared, truncation labels stopped matching the
ceiling, provider behaviour cannot be attributed, or the run disagrees with
itself.

The ceiling tolerance is a fraction rather than a token count because
`maxOutputTokens` is a certified constant this layer does not own; if it
changes, the tolerance scales with it instead of silently tightening.

**The fresh control becomes the locked Phase 6 baseline whenever the verdict is
EXPECTED_STOCHASTIC_VARIATION, regardless of how far its raw invalid count sits
from the historical 6/33.** Candidate A is compared against that fresh lock and
is never tuned against the historical count. The classifier also runs with no
historical input at all, which is the honest expression of the fresh run being
the baseline rather than a challenger to it.

## Resumption sequence

Once a working credential is injected, nothing else needs deciding:

1. metadata-only auth probe → PASS
2. governed smoke on `set-fishskin-jacket` under the final baseline run id
3. token preflight and atomic cost reservation against the $0.50 run ceiling
4. fresh control, 33 development cases, sequential
5. lock the control under `docs/scanner-accuracy/phase6/control-baselines/<run-id>/`,
   commit and push before Candidate A begins
6. classify the truncation hypothesis from `finishReason`, not token arithmetic
7. Candidate A on the same 33 cases under the locked identities
8. decide; create the generation-budget family only if Candidate A is PARTIAL or
   FAIL because valid outputs still terminate at the ceiling
9. independent audit from `scanner/phase6-audit`

Projected spend: ~$0.12 per 33-case run, ~$0.30 for control plus Candidate A —
inside both the $0.50 per-run and $2.00 per-session ceilings.

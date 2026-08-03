# Phase 6 control baseline — locked

    RUN ID:        baseline-v0.3.1-v140-20260803-0531-e4ac29c-development-exec
    BENCHMARK SHA: 6c46f1464c80042c0dfa35ef3e5d5714ee3dd3b8
    LOCKED:        immutable; edits require a new run and a new lock

## Result

| | |
|---|---|
| cases (denominator) | 33 |
| valid | 29 |
| invalid output (all truncation) | 3 |
| unmeasured (adapter fault, 0 attempts) | 1 |
| scored | 29 |

## Dominant failure mechanism — CONFIRMED

Every invalid output carries the provider's own finishReason MAX_TOKENS and terminated 15-18 tokens below the 2048 ceiling. Every valid case finished STOP. Confirmed from provider evidence, not token arithmetic.

finishReason: {"STOP":29,"MAX_TOKENS":3}
invalidOutputCause: {"output_budget_exhausted":3}

## Tokens

input 54320 · response 4779 · thinking 45506 — thinking is 90.5% of billed output.

## Latency

p50 9158 ms · p95 10960 ms · mean 8648 ms

## Cost

Ledger confirmed $0.458617, of which
$0.000000 is a conservative charge against the
zero-attempt adapter failure. True dispatched spend $0.458617.
Run ceiling $0.50, never altered.

## Anomaly classification

EXPECTED_STOCHASTIC_VARIATION — execution identity, capture consistency, provider
attribution, dominant failure class and ceiling mechanism all pass. The invalid-rate
delta against the historical control is reported (-9.1 pp) and was not consulted.

This run is the locked Phase 6 control. Candidate A is compared against THIS,
never against the historical 6/33.

# Candidate A — results

    RUN ID:    baseline-v0.3.1-v140-20260803-1117-b5cb36a-development-exec-phase6-scanner-v1.0-a
    CANDIDATE: phase6-scanner-v1.0-a  (overlay b470706f3788912e…)
    CONTROL:   baseline-v0.3.1-v140-20260803-0531-e4ac29c-development-exec
    DECISION:  PARTIAL

## Reliability — improved

| | control | Candidate A |
|---|---|---|
| valid | 29 | 31 |
| invalid output (all truncation) | 3 | 2 |
| adapter failures | 1 | 0 |
| thinking tokens | 45506 | 37302 |
| p50 latency | 9158 ms | 6967 ms |
| p95 latency | 10960 ms | 10178 ms |
| dispatched cost | $0.458617 | $0.411063 |

Paired: 3 control-invalid became valid, 1 control-valid became invalid.

## Accuracy — regressed

Strictly paired over 28 cases scoreable in BOTH runs. Discordant field-pairs:
8 favour the control, 3 favour the candidate.

| field | control-only | candidate-only | net |
|---|---|---|---|
| category | 3 | 2 | -1 |
| clothingType | 0 | 0 | 0 |
| subtype | 3 | 0 | -3 |
| primaryColor | 2 | 1 | -1 |
| material | 0 | 0 | 0 |
| pattern | 0 | 0 | 0 |
| brand | 0 | 0 | 0 |

## Not a suppression artifact

| | control | Candidate A |
|---|---|---|
| abstention rate | 34.4% | 31.1% |
| answered (classifiable) | 59 | 62 |
| correct | 40 | 36 |
| accuracy among answered | 67.8% | 58.1% |

Abstention FELL. The candidate answered more and got fewer right.

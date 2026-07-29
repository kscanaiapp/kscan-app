# Metric Definitions — Scanner Accuracy V2

Scanner accuracy is never reported as one number.

## Field dispositions

| Disposition | Meaning |
|-------------|---------|
| `correct` | Prediction matches ground truth |
| `acceptably_broad` | Broader than GT but still honest (e.g., jacket vs chore jacket) |
| `incorrect` | Concrete wrong prediction |
| `unsupported_certainty` | Concrete claim where GT is uncertain / abstention required |
| `unknown_when_evidence_exists` | Model abstained on a field that is labeled |
| `correct_abstention` | Expected abstention occurred |
| `incorrect_abstention` | Abstention missed or wrongly taken |
| `unscorable` | Insufficient GT or prediction structure to score |

Penalty multipliers (relative): correct 0 · acceptably_broad 0.25 · unknown_when_evidence 0.75 · incorrect 1 · incorrect_abstention 1.25 · unsupported_certainty **1.75**.

Wrong certainty is penalized more heavily than honest uncertainty.

## Required metric families

- category accuracy
- clothing-type accuracy
- subtype accuracy
- primary-color accuracy
- secondary-color accuracy
- material accuracy
- pattern accuracy
- brand precision
- brand false-positive rate
- exact-product precision
- incorrect exact-match rate
- similar-result relevance
- expected-abstention success
- incorrect abstention rate
- multi-image consistency
- duplicate-result rate
- commerce-link validity
- schema/parse failure rate
- latency
- model call count
- cost estimate (when evidence exists)

Phase 0A implements field dispositions + core aggregates deterministically.
Similar-result relevance, commerce-link validity, multi-image consistency, and duplicate-result rate are defined as gate categories and metric slots; live measurement requires authorized predictions.

## Examples

Ground truth `chore jacket`, prediction `jacket` → acceptably broad for subtype/clothing type.

Ground truth brand `unknown`, prediction luxury brand → brand false positive + unsupported certainty.

Ground truth insufficient evidence, prediction specific exact product → incorrect exact-match claim with severe certainty penalty.

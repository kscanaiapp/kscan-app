# Scanner Evaluation Tools (Build 4)

Offline, isolated evaluation harness for Scanner Accuracy & Trust V2.

**Do not import these modules from production application code, Edge Functions, or deploy scripts.**

## Commands

```bash
node tools/scanner-evaluation/validate-dataset.js evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json --dataset-version 0.1.0
node tools/scanner-evaluation/score-fields.js <labels.json> <predictions.json>
node tools/scanner-evaluation/compare-candidates.js <baseline.json> <candidate.json>
node tools/scanner-evaluation/regression-gate.js <baseline.json> <candidate.json> --mode report_only
node tools/scanner-evaluation/run-baseline.js
```

`run-baseline.js` produces a **static shell only** (empty predictions, zero model calls).
Paid model evaluation requires explicit owner authorization.

## Tests

```bash
node --test tools/scanner-evaluation/__tests__/*.test.js
```

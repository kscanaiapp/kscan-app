# Scanner Evaluation Tools (Build 4)

Offline, isolated evaluation harness for Scanner Accuracy & Trust V2.

**Do not import these modules from production application code, Edge Functions, or deploy scripts.**

## Commands

```bash
node tools/scanner-evaluation/validate-dataset.js evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json --dataset-version 0.1.0
node tools/scanner-evaluation/score-fields.js <labels.json> <predictions.json>
node tools/scanner-evaluation/compare-candidates.js <baseline.json> <candidate.json>
node tools/scanner-evaluation/regression-gate.js <baseline.json> <candidate.json> --mode report_only
node tools/scanner-evaluation/verify-frozen-dataset.js \
  --manifest evals/scanner-accuracy/tier-a-manifest.v0.3.0.json \
  --freeze-record evals/scanner-accuracy/tier-a-freeze.v0.3.0.json
node tools/scanner-evaluation/run-baseline.js --dry-run \
  --manifest evals/scanner-accuracy/tier-a-manifest.v0.3.0.json \
  --output-dir <dir>
```

The frozen verifier requires `KSCAN_EVAL_STORAGE_ROOT` and verifies the four
recorded frozen inputs plus every governed image hash. `run-baseline.js` performs
the same verification before planning. Its dry run produces a **static shell
only** (empty predictions, zero model calls). Paid model evaluation requires
approved cases, explicit owner authorization, and an injected certified adapter.

## Tests

```bash
node --test tools/scanner-evaluation/__tests__/*.test.js
```

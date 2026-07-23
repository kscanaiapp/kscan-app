# 10 — Full Regression Report

## Commands

```bash
node --test \
  __tests__/imageUploadRegression.test.js \
  __tests__/scanIdentification.test.js \
  __tests__/eliseVisualContext.test.js \
  __tests__/useKScanDuplicateGuard.test.js \
  __tests__/scanIdentifyEdgeContract.test.js \
  __tests__/scanHelpers.test.js \
  __tests__/scanResultObject.test.js \
  __tests__/scanMatchRobustness.test.js
```

## Totals

| Suite | Totals | Pass | Fail | Skipped |
|---|---|---|---|---|
| Upload + Elise + Identify | 100 | 100 | 0 | 0 |
| Scanner lifecycle / contracts | 164 | 164 | 0 | 0 |
| **Combined executed** | **264** | **264** | **0** | **0** |

## Feature preservation checklist (source/unit)

| Feature | Status |
|---|---|
| Scanner multi-item / selected-item | PASS (contracts) |
| Elise visual collection | PASS |
| Abort / duplicate guard | PASS |
| Auth fail-closed on missing session | PASS |
| Oversized image guard | PASS |

## Physical / live backend

Not executed in this host environment.

## Verdict

**FULL REGRESSION TESTING: PASS (automated) — physical QA still open**

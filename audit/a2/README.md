# Build 35 hostile audit — lane A2, batch 1 (issue #702)

Source tested: mobile `2c2c9da41121daa43f4f657ca1aaa2fcf7b7cb27` (== `origin/integration/build35-v1-convergence` at test time).
Scope: `purchase-import-extract` only. No production, shared handler, matrix, migration or manifest file was edited.

## Reproduce

```bash
git checkout 2c2c9da41121daa43f4f657ca1aaa2fcf7b7cb27 && git checkout <this branch> -- audit/a2
npm ci --ignore-scripts
deno test --allow-read --allow-env --allow-write=audit/a2/out audit/a2/receipt-batch1.test.ts
node audit/a2/build-ledger.cjs <mandatory-hostile-probes.json from PR #646 head 49ab7fad>
```

Baseline (existing suite, unmodified): `deno test --allow-read --allow-env --allow-run=deno supabase/functions/purchase-import-extract` → 16 passed / 0 failed.

## Files

- `receipt-batch1.test.ts` — 19 Deno tests against the actual `handler.ts`. Auth, quota and provider are injected, except probes 0737/0740/0767/0750, which run the real `requireUser` / real default `reserve` adapter over a stubbed `fetch`. Zero network.
- `out/receipt-batch1-results.json` — per-probe input / expected / actual / side effects / limits.
- `out/a2-batch1-ledger.json` — 28-cell mapping proposal and exact count reconciliation.
- `out/run1-initial-test-defect.txt` — first run: 18 pass / 1 fail. The failure was a false positive in my own static-scan regex (`member` matched "loyalty member numbers" in the sanitizer prompt text); fixed in the test, not a product defect.
- `out/run2-after-regex-fix.txt`, `out/run3-final-clean.txt` — 19 passed / 0 failed.

## Mutation controls (one guard at a time, handler restored afterwards, blob verified)

| Mutation | Tests that failed |
| --- | --- |
| M1 remove body-size guard | 0745 |
| M2 drop JPEG magic check | 0751, 0753 |
| M3 settle always billable | 0761, 0762, 0763 |
| M4 widen requestId allowlist | 0746, 0747, 0750 |
| M5 reserve failure fails open | 0767 |
| M6 actor read from `x-user-id` header | 0740 |

Not mutation-checked: 0737 (expired JWT), 0764–0766 (envelope/schema), and the static N/A scans.

## Limits

A mock is not a live provider; the Auth server is a stub. Nothing here validates a signed live JWT, a deployed function, or real provider behaviour.

---

# Batch 2: Live Camera VTO (43 cells)

Same source `2c2c9da41121daa43f4f657ca1aaa2fcf7b7cb27`. No production, shared handler, matrix, migration or manifest file edited.

## Reproduce

```bash
git checkout 2c2c9da41121daa43f4f657ca1aaa2fcf7b7cb27 && git checkout <this branch> -- audit/a2
npm ci --ignore-scripts
B35_AUDIT_SOURCE_ROOT=$PWD node --test --test-reporter=spec audit/a2/live-batch2.test.cjs               # 9 pass
B35_AUDIT_SOURCE_ROOT=$PWD node --test --test-reporter=spec audit/a2/live-remote-source-1102.test.cjs    # 10 pass (retained PR #646 evidence, verbatim)
node audit/a2/build-ledger-batch2.cjs <mandatory-hostile-probes.json from PR #646 head 49ab7fad>
```

## Files

- `live-batch2.test.cjs`: 9 `node:test` blocks. Real `useVtoLiveSession` with injected native/permission/sanitizer fakes (2775, 2776, 2791), real governed registry and resolver (2767-2769), real entitlement mapping and Studio gate (2791 composition), static scan of the Live source graph.
- `live-remote-source-1102.test.cjs`: verbatim copy of the retained PR #646 remote-config test (maps to 2782-2788).
- `out/live-batch2-results.json`: per-probe input / expected / actual / side effects / limits.
- `out/a2-batch2-ledger.json`: 43-cell mapping proposal and count reconciliation (alone and cumulative with batch 1).
- `out/live-batch2-mutations.md`: mutation controls, including two equivalent survivors.
- `out/live-run1-mounted-concurrency-remote.txt`: retained suites re-run at this head, 56/56. `out/live-run2-batch2-final.txt`: 9/9.

## Limits

Live is an on-device camera with no provider and no endpoint. Cells phrased as endpoint/provider probes are either N/A by construction (proposed) or mapped to the only remote dependency, the `app_config` availability read (2782-2788, flagged for a ruling). Nothing here is a device run; cells 2777-2780 stay device-excluded.

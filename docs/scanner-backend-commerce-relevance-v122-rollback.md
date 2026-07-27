# Scanner Backend Commerce Relevance Layer v122 — Deployment & Rollback

## Production baseline (pre-deploy)

- Project: `wyyuqfdxucjksghsmhry`
- Function: `scan-identify`
- Version: `v121`
- Status: `ACTIVE`
- JWT posture: `verify_jwt = false` (unchanged)
- Source SHA (repo): `fac878fa64f637447642fc59132d6cf015033c35`
- Line-ending-normalized source match to deployed v121: **proven** (17/17 files)
- Preserved rollback bundle: `C:\src\qa-evidence\scanner-commerce-relevance-v122\v121-rollback\`
- Rollback manifest: `C:\src\qa-evidence\scanner-commerce-relevance-v122\v121-rollback-manifest.json`

## What v122 adds (backend-only)

1. **Category-specific commerce query templates** (apparel / footwear / bags / accessories / general)
2. **Deterministic provider-result agreement scoring** (0–100, local only)
3. **Color and material certainty** for query construction
4. **Soft retailer / product diversity** (relevance-primary reranking)
5. **Structured, privacy-safe failure telemetry**

No mobile changes. No migration. No extra default model call. No JWT/provider/quota changes.
Primary commerce queries: max 1. Fallback: max 1.

## Feature controls

| Flag | OFF behavior | ON behavior |
|------|--------------|-------------|
| `BACKEND_QUALITY_TUNE_ENABLED` | v119-equivalent | v120 quality tune |
| `BACKEND_SCANNER_INTELLIGENCE_ENABLED` | exact v120 | v120 + routing + quality gate |
| `BACKEND_COMMERCE_RELEVANCE_ENABLED` | exact v121 | v121 + relevance layer |

Defaults for this release: all three default ON when unset (after validation).

## Approved deploy command

Superseded by Phase 2A.5 (IMG-006). The approved path is the guarded wrapper —
see [docs/edge-function-deployment.md](edge-function-deployment.md):

```bash
node scripts/deploy-edge-functions.js --function scan-identify --confirm-deploy scan-identify
```

Deploy **only** `scan-identify`. JWT posture is pinned to `verify_jwt = false`
by `supabase/config.toml` rather than by a remembered CLI flag. Do not invoke
`supabase functions deploy` directly — it skips every parity check.

## Rollback order

1. Set `BACKEND_COMMERCE_RELEVANCE_ENABLED=false`.
2. Verify v121-equivalent behavior (relevance OFF == original v121 helpers).
3. If needed, redeploy preserved v121 source from evidence bundle / git SHA `fac878fa64f637447642fc59132d6cf015033c35`.

Do **not** disable `BACKEND_SCANNER_INTELLIGENCE_ENABLED` or `BACKEND_QUALITY_TUNE_ENABLED` unless those layers are independently implicated.

## Mobile impact

- Mobile files changed: **NO**
- New app build / tester reinstall / APK / AAB / store submission: **NO**
- Response contract changed: **NO**

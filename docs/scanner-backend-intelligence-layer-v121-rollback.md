# Scanner Backend Intelligence Layer v121 — Deployment & Rollback

## Production baseline (pre-deploy)

- Project: `wyyuqfdxucjksghsmhry`
- Function: `scan-identify`
- Version: `v120`
- Status: `ACTIVE`
- JWT posture: `verify_jwt = false` (unchanged)
- Source SHA (repo): `18eaed8d10c7fb9fcf2d7f9beff6f24dfd77d0e6`
- Line-ending-normalized source match to deployed v120: **proven** (14/14 files)
- Preserved rollback bundle: `_rollback/v120-equivalent/` + `_rollback/v120-BASELINE.txt`

## What v121 adds (backend-only)

1. **Category-aware prompt routing** inside the existing Gemini call  
   Routes: `apparel | footwear | bags | accessories | general`
2. **Internal quality + consistency gate** (score 0–100) after v120 normalization  
   Drives commerce query detail, label cleanup, and privacy-safe telemetry

No mobile changes. No migration. No extra default model call. No JWT/provider/quota changes.

## Feature controls

| Flag | OFF behavior | ON behavior |
|------|--------------|-------------|
| `BACKEND_QUALITY_TUNE_ENABLED` | v119-equivalent | v120 quality tune |
| `BACKEND_SCANNER_INTELLIGENCE_ENABLED` | exact v120 | v120 + routing + quality gate |

Defaults for this release: both default ON when unset (after validation).

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

1. Set `BACKEND_SCANNER_INTELLIGENCE_ENABLED=false`.
2. Verify v120-equivalent behavior (intelligence OFF == original v120 helpers).
3. If needed, redeploy preserved v120-equivalent source from `_rollback/v120-equivalent/` / git SHA `18eaed8d10c7fb9fcf2d7f9beff6f24dfd77d0e6`.

Do **not** disable `BACKEND_QUALITY_TUNE_ENABLED` unless v120 itself is implicated.

## Mobile impact

- Mobile files changed: **NO**
- New app build / tester reinstall / APK / AAB / store submission: **NO**
- Response contract changed: **NO**

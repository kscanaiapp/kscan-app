# Scanner Backend Quality Tune v120 — Deployment & Rollback

## Production baseline (pre-deploy)

- Project: `wyyuqfdxucjksghsmhry`
- Function: `scan-identify`
- Version: `v119`
- Status: `ACTIVE`
- JWT posture: `verify_jwt = false` (unchanged)
- Source SHA (repo): `2824bbb775e83bbb12c2bb859da4f271040658f5`
- Line-ending-normalized source match to deployed v119: **proven**

## Quality-tune control

- Module version: `v120` (`QUALITY_TUNE_VERSION`)
- Flag: `BACKEND_QUALITY_TUNE_ENABLED`
  - unset / `true` → quality tune ON (default for this release)
  - `false` / `0` / `off` → exact v119-equivalent behavior (no prompt addendum, no taxonomy tune, legacy commerce query path)

## Approved deploy command

Superseded by Phase 2A.5 (IMG-006). The approved path is the guarded wrapper —
see [docs/edge-function-deployment.md](edge-function-deployment.md):

```bash
node scripts/deploy-edge-functions.js --function scan-identify --confirm-deploy scan-identify
```

Deploy **only** `scan-identify`. Do not change JWT posture, schema, or unrelated functions.

JWT posture is no longer a command-line flag to remember: `supabase/config.toml`
pins `scan-identify` to `verify_jwt = false`, and the parity gate fails if that
file is missing or points at a project other than the approved production one.

Do **not** invoke `supabase functions deploy scan-identify` directly. The raw
command performs none of the manifest, project-reference, tree-parity or
clean-checkout verification, and Phase 2A confirmed it would happily ship a
non-canonical branch copy.

If the CLI would flip JWT verification on, use the project’s existing documented flag to keep `verify_jwt=false`.

## Rollback order

1. **Preferred:** set Edge Function secret/config `BACKEND_QUALITY_TUNE_ENABLED=false`, then smoke-test one TextScan call.
2. **Fallback:** redeploy the preserved v119-equivalent source tree from git SHA `2824bbb775e83bbb12c2bb859da4f271040658f5` (files under `supabase/functions/scan-identify/` + `_shared/scanHelpers.ts` + `_shared/catalogRetrieval.ts`).

Do **not** use invented syntax such as `supabase functions deploy scan-identify --version v119` unless official tooling documents it.

## File hashes (v119-equivalent, LF-normalized SHA-256)

Recorded at preflight (see agent rollback manifest if present locally):

| Path | Role |
|------|------|
| `supabase/functions/scan-identify/index.ts` | entry |
| `supabase/functions/scan-identify/*.ts` (providers/router/matcher/capture/multiItem) | deps |
| `supabase/functions/_shared/scanHelpers.ts` | taxonomy helpers |
| `supabase/functions/_shared/catalogRetrieval.ts` | catalog |

## Tester monitoring (no client changes)

Observe: scan completion rate, generic-label rate, normalization correction rate, empty commerce-result rate, fallback-query rate, products per selected item, products removed by dedupe, category mismatch removals, provider error rate, p50/p95 total duration, quota events.

Neutral follow-up after sufficient usage: “Have Scanner results felt any different this week?”

# Scanner Backend TextScan Commerce Parity & Outcome Intelligence v123

## Production baseline (pre-deploy)

- Project: `wyyuqfdxucjksghsmhry`
- Function: `scan-identify`
- Required starting commit: `5e0b052aedf66687203e22176ef47b560be471c8` (repaired v122)
- JWT posture: `verify_jwt = false`

## What v123 adds (backend-only)

1. **TextScan commerce router parity** — TextScan uses `getScanCommerceResults` when enabled
2. **Unified commerce outcome persistence** — scrubbed `scan_commerce_events` rows
3. **Complete failure-reason wiring** — stable enum on early exits and commerce outcomes

## Feature controls

| Flag | OFF | ON |
|------|-----|----|
| `BACKEND_TEXTSCAN_COMMERCE_PARITY_ENABLED` | repaired-v122 TextScan (`getShoppingResults`) | TextScan via commerce router |
| `BACKEND_COMMERCE_OUTCOME_CAPTURE_ENABLED` | no DB persistence | scrubbed outcome insert |

TextScan parity requires quality + intelligence + relevance ON.

## Migration

`20260720120000_scan_commerce_events.sql` — additive `scan_commerce_events` table, service-role only.

## Rollback

1. `BACKEND_TEXTSCAN_COMMERCE_PARITY_ENABLED=false`
2. `BACKEND_COMMERCE_OUTCOME_CAPTURE_ENABLED=false`
3. If needed, redeploy `5e0b052aedf66687203e22176ef47b560be471c8`

Do not drop `scan_commerce_events` during emergency rollback.

## Mobile impact

- Mobile files changed: **NO**
- New app build / APK / AAB / IPA: **NO**
- Response contract changed: **NO**

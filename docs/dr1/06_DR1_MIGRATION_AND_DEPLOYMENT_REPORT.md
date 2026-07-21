# 06 — DR-1 Migration and Deployment Report

## Migrations

| File | Action | Production |
| ---- | ------ | ---------- |
| `20260720115423_scan_commerce_events.sql` | Reconciled into source | Already applied |
| New DR-1 columns | **None** | Prefer snapshot_payload |

No DR-1 migration applied. No Edge Function deployed.

## Deployment boundary (not executed)

1. Commit source, flags OFF  
2. Optional: deploy Edge Function with dressing_room_item resolver (flags/client independent)  
3. Enable canonical → commerce → dedupe in order for internal cohort  
4. Keep `SAVED_SCAN_CLOUD_IMAGES_V1` OFF  

## Rollback

| Unit | Action |
| ---- | ------ |
| Canonical | disable `DRESSING_ROOM_CANONICAL_ITEM_V1` |
| Commerce | disable `DRESSING_ROOM_COMMERCE_PRESERVATION_V1` |
| Dedupe | disable `DRESSING_ROOM_DEDUPE_V1` |
| Edge | redeploy prior `stylechat-generate` version |
| Migration reconcile file | leave in place (matches prod) |

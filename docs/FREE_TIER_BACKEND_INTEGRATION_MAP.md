# Free Tier Utility Expansion — Backend Integration Map

## 1. Branch and purpose

- **Branch:** `feature/free-tier-utility-backend-v1`
- **Parent branch:** `feature/free-tier-utility-expansion-v1`
- **Parent commit:** `a2b4fe9ef35783e9b6869b3c759d8357cc9b2240`
- **Purpose:** Add optional, feature-flagged, local-first backend sync
  groundwork for the Free Tier Utility Expansion prototype. No backend is
  enabled by default; no remote state is changed by this branch.

## 2. Tables proposed

| Table | Priority | Purpose |
|-------|----------|---------|
| `wardrobe_utility_items` | P0 | Normalized utility metadata attached to saved items. |
| `wardrobe_collections` | P0 | User-created collections / lookbooks. |
| `wardrobe_collection_items` | P0 | Many-to-many link between collections and items/outfits. |
| `wardrobe_brand_sizing_notes` | P1 | Per-brand sizing memory and fit notes. |
| `wardrobe_outfit_feedback` | P1 | Outfit/item ratings and feedback tags. |
| `wardrobe_care_notes` | P1 | Care tags and free-form care notes. |
| `wardrobe_wishlist_intents` | P1 | Shopping intent signals (want, wishlist, etc.). |
| `wardrobe_wear_events` | P2 | Cost-per-wear / "worn today" events. |
| `wardrobe_activity_log` | P2 | Recent activity timeline. |

## 3. Table priority summary

- **P0 (sync-first):** Collections and saved-item utility metadata are the
  highest-value sync targets and have the clearest ownership boundaries.
- **P1 (sync-next):** Notes, feedback, and intent data are valuable but
  benefit from P0 conflict-resolution patterns being validated first.
- **P2 (defer/optional):** Wear events and activity log are append-only
  streams with higher volume and should be addressed after P0/P1 are stable.

## 4. RLS policy summary

All proposed tables:
- Enable Row Level Security.
- Restrict `select`, `insert`, `update`, and `delete` to authenticated users.
- Each policy checks `user_id = auth.uid()`.
- No public read policies.
- No anonymous write policies.
- No service-role dependencies.

## 5. Existing conventions followed

- Table schema: `public.*`, `id uuid primary key default gen_random_uuid()`.
- Ownership: `user_id uuid not null references auth.users(id) on delete cascade`.
- Timestamps: `created_at`, `updated_at` defaults to `now()`.
- Soft delete: `deleted_at timestamptz` where reconciliation may need it.
- Metadata: `metadata jsonb not null default '{}'::jsonb` for forward-compatible
  sparse fields.
- RLS: policies use `auth.uid()` and `to authenticated`.
- `updated_at` triggers reuse the existing `public.set_updated_at()` function
  when present.

## 6. Supabase client import path

- Client file: `services/supabaseClient.ts`
- Export name: `supabase`
- Usage from free-tier services: `import { supabase } from '../supabaseClient';`
- No second Supabase client is created.

## 7. Local storage wrapper reused

- `services/free-tier/freeTierStorage.ts`
- Keys follow the existing namespace: `kscan.freeTier.*`
- Queue key: `kscan.freeTier.syncQueue.v1`
- `readStore`, `writeStore`, and `updateStore` are reused without modification.

## 8. Local-to-remote mapping strategy

- `services/free-tier/freeTierBackendMapper.ts` maps local shapes to remote
  shapes using defensive helpers.
- Mappers never mutate inputs.
- `client_id` is generated from a stable local identifier for reconciliation.
- `source_item_id` is preserved to link utility data back to scans/library/product.
- Raw image URIs are stripped (`data:`, `file://`, `content://` rejected).
- No precise location, auth tokens, or sensitive attributes are mapped.

## 9. Sync flags

All flags live in `constants/freeTierBackendFlags.ts` and default to `false`:

- `FREE_TIER_BACKEND_SYNC_ENABLED` — master switch.
- `FREE_TIER_BACKEND_READ_ENABLED` — allow reading remote data.
- `FREE_TIER_BACKEND_WRITE_ENABLED` — allow writing local data remotely.
- `FREE_TIER_BACKEND_QUEUE_ENABLED` — enable local pending-write queue.

Flags are read from environment variables and only activate when the value is
exactly `"true"`. Missing or any other value is treated as disabled.

## 10. Sync queue behavior

- `services/free-tier/freeTierSyncQueue.ts`
- Local storage only (`kscan.freeTier.syncQueue.v1`).
- Queue items contain `id`, `entity`, `operation`, `payload`, `createdAt`,
  `retryCount`, and optional `lastError`.
- Corrupt queue JSON is safely reset to empty.
- No network calls inside queue functions.
- No infinite retry logic.
- No app-startup side effects.

## 11. Failure behavior

- If sync flags are disabled, all sync functions return no-op success.
- If unauthenticated, sync returns a safe `UNAUTHENTICATED` error result.
- If Supabase client is unavailable, functions catch errors and return
  `SYNC_FAILED` results without throwing.
- If READ/WRITE flag is disabled, the corresponding direction returns
  `READ_DISABLED` / `WRITE_DISABLED`.
- `pullFreeTierUtilitySnapshot` and `pushFreeTierUtilitySnapshot` are safe
  stubs returning `NOT_IMPLEMENTED` until full sync is reviewed.

## 12. Privacy notes

- No raw images stored.
- `image_uri` is nullable text and only accepted if it is app-managed/public.
- No precise location stored.
- No auth tokens stored.
- No sensitive personal attributes stored.
- No service-role key usage in client code.

## 13. What remains local-only

By default (all flags off), everything remains local:
- Saved item utility metadata
- Brand sizing memory
- Outfit ratings
- Care notes
- Wishlist intent
- Collections
- Cost-per-wear / wear tracking
- Activity log
- Daily prompts and style challenges

## 14. What requires backend review

- Migration SQL review and approval.
- Conflict resolution strategy for `client_id` collisions.
- Pagination and batching for push/pull snapshots.
- Index review for query patterns.
- `updated_at` trigger function availability in target environments.
- Whether soft deletes or hard deletes are preferred per table.

## 15. How to apply migration later

**DO NOT APPLY NOW.**

When explicitly approved:

1. Review `supabase/migrations/20260704175544_free_tier_utility_tables.sql`.
2. Run `supabase db push` or `supabase migration up` in a non-production
   environment only after QA validation.
3. Verify `public.set_updated_at()` exists or create an equivalent function.
4. Test RLS policies with a non-superuser authenticated client.
5. Only then consider enabling environment flags:
   - `EXPO_PUBLIC_FREE_TIER_BACKEND_SYNC_ENABLED=true`
   - `EXPO_PUBLIC_FREE_TIER_BACKEND_READ_ENABLED=true`
   - `EXPO_PUBLIC_FREE_TIER_BACKEND_WRITE_ENABLED=true`
   - `EXPO_PUBLIC_FREE_TIER_BACKEND_QUEUE_ENABLED=true`

## 16. QA checklist

- [ ] TypeScript passes (`npx tsc --noEmit`).
- [ ] No secrets in diff.
- [ ] Migration SQL reviewed for syntax and RLS correctness.
- [ ] App builds and runs with all flags off (default).
- [ ] App builds and runs with flags enabled but no network (offline safe).
- [ ] Unauthenticated users cannot trigger backend writes.
- [ ] Existing free-tier features work unchanged when flags are off.
- [ ] No UI regressions in library, scan results, auth, onboarding, or StyleChat.

## 17. Rollback plan

- Revert the commit `feat(free-tier): add optional backend sync groundwork`.
- Ensure migration file is not applied to any environment.
- If migration was already applied, create a follow-up migration to drop the
  tables after confirming no dependent data exists.

## 18. Known limitations

- `pullFreeTierUtilitySnapshot` and `pushFreeTierUtilitySnapshot` are stubs.
- Full network sync is not implemented.
- Conflict resolution is documented but not wired.
- Activity log and wear events are P2 defer/optional.
- `client_id` generation is local; cross-device collision resolution is future work.

## 19. Conflict resolution note

Remote rows are upserted on `(user_id, client_id)`. The `client_id` is derived
from a stable local identifier (e.g. `${entityPrefix}:${localId}`). If two
 devices create utility data for the same source item independently, they will
 have different `client_id` values and therefore separate remote rows. A future
 reconciliation pass can merge by `source_item_id` and `user_id` if desired.

## 20. Explicit statement: no remote backend changed

No migration was applied, no Supabase function was deployed, and no staging or
production database was modified by this branch. All backend integration work
is local groundwork only.

## 21. Explicit statement: no sync UI integration added

No screen imports the sync hook by default. `hooks/useFreeTierSyncStatus.ts` is
fully standalone and does not require providers, root layout changes, polling,
or automatic network calls.

## Feature-to-table mapping

| Free-tier feature | Proposed table(s) |
|-------------------|-------------------|
| Saved item utility metadata | `wardrobe_utility_items` |
| Brand sizing memory | `wardrobe_brand_sizing_notes` |
| Outfit rating | `wardrobe_outfit_feedback` |
| Care notes | `wardrobe_care_notes` |
| Wishlist intent | `wardrobe_wishlist_intents` |
| Collections / lookbooks | `wardrobe_collections` + `wardrobe_collection_items` |
| Cost-per-wear / worn today | `wardrobe_wear_events` |
| Recent activity log | `wardrobe_activity_log` |

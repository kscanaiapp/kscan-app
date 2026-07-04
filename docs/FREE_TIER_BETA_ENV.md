# Free Tier Beta Environment Notes

Branch: `feature/free-tier-beta-supabase-v1`

## Preview profile (internal beta)

The `preview` profile in `eas.json` enables the full free-tier utility beta for internal Android (and later iOS) builds:

- `EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED=true`
- `EXPO_PUBLIC_FREE_TIER_BACKEND_SYNC_ENABLED=true`
- `EXPO_PUBLIC_FREE_TIER_BACKEND_READ_ENABLED=true`
- `EXPO_PUBLIC_FREE_TIER_BACKEND_WRITE_ENABLED=true`
- `EXPO_PUBLIC_FREE_TIER_BACKEND_QUEUE_ENABLED=true`
- All sub-feature flags (`OUTFIT_GENERATOR`, `DAILY_STYLE_PROMPT`, `WARDROBE_STATS`, `SHARE_CARD`, `COLLECTIONS`, `DUPLICATE_HINTS`, `BRAND_SIZING`, `OUTFIT_RATING`, `CARE_NOTES`, `COST_PER_WEAR`, `WISHLIST_INTENT`, `CLOSET_FILTERS`, `WEAR_AGAIN`, `ACTIVITY_LOG`, `STYLE_CHALLENGES`) are set to `true`.

## Development / Production defaults

- `development` profile intentionally does **not** set free-tier backend sync flags; local-first behavior remains the default for day-to-day development.
- `production` profile does **not** enable free-tier backend sync flags. Production defaults remain `false` until the beta is validated and explicitly approved.

## Supabase configuration

- Staging Supabase URL and anon key are configured through existing EAS environment variables in `eas.json` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`).
- No service-role key belongs in client code.
- No Supabase URL or key is hardcoded in source files under `app/`, `components/`, `hooks/`, `services/`, or `constants/`.

## Known beta limitation

- `wardrobe_collection_items` membership push is **deferred**. Local collection IDs (`col_*`) do not directly map to the remote server UUID foreign key, so pushing nested membership rows would cause guaranteed FK failures. Collection metadata (name, cover) syncs; local `itemIds` are preserved on device. This is not a beta blocker.

## iOS parity

- iOS Build #9 should use the same branch/head later. Do **not** create a future iOS catch-up branch.

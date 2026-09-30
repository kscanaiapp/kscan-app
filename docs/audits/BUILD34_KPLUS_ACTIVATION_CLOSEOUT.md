# Build 34 K+ server-side activation closeout

## Configuration changes

| Environment | Feature | Control | Prior state | New state | Change mechanism | Verification | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Staging | Packing Intelligence | `ELISE_PACKING_INTELLIGENCE_V1_ENABLED` | missing/default off | `true` | Supabase Edge Function secret configuration | secret metadata and deployed flag mapping | set |
| Production | Packing Intelligence | `ELISE_PACKING_INTELLIGENCE_V1_ENABLED` | missing/default off | `true` | Supabase Edge Function secret configuration | secret metadata and deployed flag mapping | set |
| Staging | Wardrobe Concierge | `ELISE_CONCIERGE_V1_ENABLED` | missing/default off | `true` | Supabase Edge Function secret configuration | secret metadata and deployed flag mapping | set |
| Production | Wardrobe Concierge | `ELISE_CONCIERGE_V1_ENABLED` | missing/default off | `true` | Supabase Edge Function secret configuration | secret metadata and deployed flag mapping | set |
| Staging | Wardrobe source | `ELISE_CLOSET_WARDROBE_CONTEXT_V1_ENABLED` | missing/default off | `true` | Supabase Edge Function secret configuration | secret metadata and deployed flag mapping | set |
| Production | Wardrobe source | `ELISE_CLOSET_WARDROBE_CONTEXT_V1_ENABLED` | missing/default off | `true` | Supabase Edge Function secret configuration | secret metadata and deployed flag mapping | set |
| Staging | Concierge transport | `ELISE_ADVICE_METADATA_CLIENT_V1_ENABLED` | missing/default off | `true` | Supabase Edge Function secret configuration | secret metadata and deployed flag mapping | set |
| Production | Concierge transport | `ELISE_ADVICE_METADATA_CLIENT_V1_ENABLED` | missing/default off | `true` | Supabase Edge Function secret configuration | secret metadata and deployed flag mapping | set |
| Staging | Watchlist worker authentication | `WATCHLIST_WORKER_SECRET` | present | rotated | Supabase and GitHub secret stores | successful governed staging sweep after rotation | updated |
| Production | Watchlist worker authentication | `WATCHLIST_WORKER_SECRET` | missing | present | Supabase and protected GitHub Environment secret stores | secret metadata | updated |
| Production | Watchlist scheduler origin | `SUPABASE_PRODUCTION_FUNCTIONS_URL` | missing | production Functions origin | protected GitHub Environment variable | GitHub Environment variable metadata | set |

`ELISE_ADVICE_METADATA_CLIENT_V1_ENABLED` is required because Concierge emits structured advice and display metadata through that established transport. The closet-context flag enables the K+-gated source; the Concierge flag enables the customer-visible capability. Packing is independently selected by its versioned request contract and independently gated by its own server-side K+ check.

## Existing controls verified

| Environment | Control | Verification result |
| --- | --- | --- |
| Staging | `mobile_feature_freeze.featureFreeze` | `false` |
| Production | `mobile_feature_freeze.featureFreeze` | `false` |
| Staging | `watchlist_worker_enabled.enabled` | `true` |
| Production | `watchlist_worker_enabled.enabled` | `true` |
| Staging | `vto_generation.enabled` | `true` |
| Production | `vto_generation.enabled` | `true` |
| Both | K+ entitlement and Closet authority | `user_entitlements`, `has_active_k_plus()`, and `user_closet_items` present |
| Both | Watchlist push storage | `user_device_push_tokens` and device-token RPCs present |
| Production | Android push build configuration | EAS `GOOGLE_SERVICES_JSON` file secret present |

## Scheduled invocation change

The staging workflow now uses the approved `17 */6 * * *` cadence and rejects any origin other than the staging Functions origin. The production sibling uses the same invocation contract, binds its job to the repository's protected `production` Environment, uses `SUPABASE_PRODUCTION_FUNCTIONS_URL`, and rejects any origin other than the production Functions origin. Both workflows retain manual dispatch confirmation and fail closed before an invocation when their secret or URL is absent. Neither writes or logs the worker secret.

## Live-evidence status

The worker-secret rotation is complete. A governed staging manual sweep completed
after the rotation with HTTP 200, `enabled: true`, and `claimed: 0`. No secret
value or hash is recorded here.

The new production workflow is intentionally a PR change and cannot schedule on
the default branch until it is reviewed and merged. A protected-environment
approval is expected before each production execution. Packing and Concierge
still require a valid authenticated K+ test identity for end-to-end contract
verification; no account credential is recorded in this closeout.

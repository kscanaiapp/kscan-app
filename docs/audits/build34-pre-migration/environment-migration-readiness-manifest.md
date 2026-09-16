# Build 34 — environment migration readiness manifest

Handoff into the later environment-migration campaign. **This campaign did not
perform the migration** and did not touch the destination environment.

Source of truth for this manifest: `release/kscan-pre-freeze-v1` @ `c6ee31ad`,
`rebuild/backend-authority-v2` @ `11580001`, and the effective state of staging
`yzqjvdfgefveprobvvyw`.

No secret values appear here — secrets are named only.

## MIGRATIONS_TO_APPLY

168 files in `supabase/migrations/`. 167 are applied to staging; the reconciliation
is in the ledger. Two carry migration-day caveats:

- `20260720120000_scan_commerce_events.sql` and
  `20260823120000_scan_commerce_events_accuracy_telemetry.sql` are **duplicate
  timestamps** of `20260720115423` / `20260823175314`. Staging applied the latter
  of each pair. Decide explicitly which member replays.
- `20260809120000_contribution_block_enforcement.sql` creates
  `can_contribute_to_dressing_room`, whose feature is deferred
  (`supabase/migrations-deferred/`). A from-scratch replay creates a SECURITY
  DEFINER function no policy references. See B34-GOV-004.

Not to be applied: everything in `supabase/migrations-deferred/`.

**New in this campaign:** `20260916203000_reaction_counts_require_live_room_access.sql`
(B34-SEC-001). Already applied to staging.

## EDGE_FUNCTIONS_TO_DEPLOY

25 governed functions (`supabase/functions/`, excluding `_shared`). 24 are deployed
to staging; **`reconcile-orphan-media` is deployed nowhere** and is deliberately
absent from the staging deployment allowlist.

Do **not** carry into the destination: the 10 slugs listed under `notGoverned` in
`config/backend-authority.json` — `privacy-controls`, `public-sale-share-opt-out`,
`product-match`, `wearable-bridge`, `wearable-save`, `wearable-open-on-phone`,
`wearable-scan`, `vto-provider-diag`, `rapidapi-key-diag`, `rapidapi-current-audit`
— unless each is separately governed there. `wearable-save` and `wearable-bridge`
matter most: both are `verify_jwt: false`, hold service_role, and write into
`saved_scans` (B34-SEC-002).

## FUNCTION_VERSIONS_EXPECTED

Staging versions at audit time range v4 (`deletion-status`) to v126
(`stylechat-generate`). Version numbers are per-project and do not transfer; use
`config/edge-function-manifest.json` hashes for parity, not version integers.

## STORAGE_CONFIGURATION_REQUIRED

| Bucket | Public | Size limit | MIME allowlist |
|---|---|---|---|
| `style-library-images` | no | 5 MiB | jpeg, png, webp |
| `image-ingestion-clean` | no | 10 MiB | jpeg, png, webp |
| `image-ingestion-quarantine` | no | 10 MiB | jpeg, png, webp |
| `legal-documents` | **yes** | none | none |
| `investor-docs` | no | none | none |

`legal-documents` is public-read by design and has no client write policy; keep it
that way. `investor-docs` must have no client policy.

## RLS_EXPECTED

135 policies across 83 tables. Every table has RLS **enabled** — reproduce that
first, because the five grant-but-no-policy tables (`product_catalog`,
`provider_request_limits`, `provider_security_events`, `style_chat_burst_usage`,
`style_outfit_burst_usage`) are safe *only* because RLS is on and no policy exists.
Enabling those grants without RLS would expose them (B34-SEC-003).

Storage: 6 policies on `storage.objects`, all owner-scoped by
`storage.foldername(name)[1] = auth.uid()`.

## RPC_GRANTS_EXPECTED

- **No `PUBLIC` EXECUTE grant** on any routine in `public` or `internal`.
- Exactly **3** `anon`-executable routines: `get_item_reaction_counts`,
  `get_public_room_preview`, `get_public_room_decision_preview`. Any fourth is a
  regression — `security/scripts/anon-grant-guard.js` is the gate.
- 50 `authenticated`-executable SECURITY DEFINER routines.
- Every routine taking a caller-supplied `p_user_id` must remain service-role only.

## TRIGGERS_EXPECTED

42 non-internal triggers. **Every trigger function must carry a pinned
`search_path`** — 0 unpinned is the required state and the Build 33 contract.

## INDEXES_EXPECTED

Reproduce the idempotency keys exactly; they are the concurrency contract:
`saved_scans (user_id, local_id) where local_id is not null`,
`user_closet_items (user_id, client_id)`,
`user_commerce_watches (user_id, canonical_url) where deleted_at is null`,
`vto_generation_requests (user_id, idempotency_key)`,
`kplus_entitlement_grants (user_id, entitlement_key, source, grant_key)` plus the
store-subscription partial, `dressing_room_item_reactions (item_id, user_id)`,
`dressing_room_collab_idempotency (room_id, actor_id, operation, request_id)`.

`dressing_room_items` has **no** idempotency key — see B33-CON-001. Migrating as-is
carries that defect forward.

## SECRETS_REQUIRED_BY_NAME_ONLY

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`RAPIDAPI_KEY`, `KICKSCREW_RAPIDAPI_KEY`, `FARFETCH_RAPIDAPI_KEY`,
`SHOPPING_SERPER_API_KEY`, `WATCHLIST_WORKER_SECRET`,
`PRODUCT_MATCH_INTERNAL_SECRET`, plus the Gemini, ElevenLabs, Resend, RevenueCat
and Apple credentials named in `docs/staging-rebuild/secret-name-manifest.md`,
which remains the authority. Values are not recorded anywhere in this campaign.

## RUNTIME_FLAGS_REQUIRED

Server-side: `app_config.watchlist_worker_enabled` (seeded **false**),
`app_config.vto_generation.enabled`. `PRODUCT_MATCH_ENABLED` defaults false and
`PRODUCT_MATCH_INTERNAL_SECRET` fails closed when unset — keep both that way.

Client-side, and deliberately off in every EAS profile — do **not** flip as part of
migration: `SHARED_ROOM_CONTRIBUTIONS_V1`, `DRESSING_ROOM_DEDUPE_V1`.

`supabase/config.toml` `project_id` is pinned to the staging ref and is the
**deploy target**. It must be flipped as a deliberate, reviewed step, together with
`approvedProjectRef` in `config/backend-authority.json` — the guard restored by
B34-GOV-002 reads the latter, so the two move together or CI fails.

## WEBHOOK_CONFIGURATION_REQUIRED

No inbound webhook endpoint is deployed in the governed Build 34 set. RevenueCat
reconciliation is pull-based via `kplus-reconcile-revenuecat`. Nothing to carry.

## SCHEDULED_JOBS_REQUIRED

**This is the largest migration-readiness gap (B34-OPS-001).** `pg_cron` and
`pg_net` are not installed on staging, and the only scheduled workflow
(`watchlist-tier2-sweep.yml`) has its cron deliberately commented out. Four workers
therefore have no active invoker:

| Worker | Consequence if never invoked |
|---|---|
| `process-account-deletions` | Deletion requests never execute automatically |
| `commerce-watch-refresh` | Watches never refresh |
| `kplus-reconcile-revenuecat` | Mirror never reconciles |
| `reconcile-orphan-media` | Orphaned media has no bounded lifetime |

For deletion this is **governed, not broken**: `docs/account-deletion-operations.md`
records a manual service-role operator script as the Build 34 process, completing
eligible requests within 30 days, and states explicitly that automated erasure must
not be claimed until a production job replaces it and is verified. Migration must
either carry that runbook or stand up the schedulers — and the App Review wording
in that doc depends on which.

## REVENUECAT_CONFIGURATION_REQUIRED

`NATIVE_REVENUECAT_PURCHASE_FLOW = NOT_IN_BUILD34_SHIPPING_SCOPE`. K+ ships as
complimentary activation with Supabase as the entitlement authority; the
RevenueCat surface is mirror/reconciliation only. No paid-product activation, price
or product change is in scope. The mirror code remains in privacy inventory
because it can transmit user-related identifiers.

## EXTERNAL_PROVIDER_CONFIGURATION_REQUIRED

Gemini (scanner/Elise), Serper + Brave (shopping), Farfetch and KicksCrew via
RapidAPI, ElevenLabs (stylist speech), AI Lab Tools (VTO), Resend (email).
`RAPIDAPI_KEY` is **shared** across `nike-shoe-details` and
`kickscrew-sneaker-description`, so exhausting it degrades Commerce broadly —
size its quota accordingly in the destination.

## POST_MIGRATION_RUNTIME_TESTS_REQUIRED

1. Re-run the B34-SEC-001 matrix: outsider and removed member must read no reaction
   counts; owner, active membership, active participant and the anonymous
   live-share preview must all still read them.
2. Assert 0 SECURITY DEFINER functions and 0 trigger functions with unpinned
   `search_path`.
3. Assert 0 `PUBLIC` EXECUTE grants and exactly 3 `anon`-executable RPCs.
4. Confirm every table has RLS enabled; probe the five grant-but-no-policy tables
   as `anon` and expect 0 rows.
5. Confirm `check_and_increment_scan_identify_daily_usage` exists and is
   service-role only; confirm the quota fails **closed** when it is unreachable.
6. Confirm storage policies are owner-scoped and `legal-documents` has no client
   write path.
7. Confirm `verify_jwt` on every deployed function matches `supabase/config.toml`
   — the drift on `tryon-clothes-pro` shows this is not automatic.
8. Run `list_orphan_owner_media` and record the baseline count.

## BACKWARD_COMPATIBILITY_CHECKS_REQUIRED

B34-SEC-001 is the only change here that narrows a response, and it narrows it only
for callers who already could not see the underlying items — a Build 33 client
that legitimately displayed reaction counts held one of the two access forms and is
unaffected. No RPC signature, return type, enum or endpoint was removed or renamed
in this campaign, so no release sequencing is required for it.

Independent of this campaign, `config/cross-path-parity-manifest.json` and
`__tests__/edgeFunctionSourceParity.test.js` (23/23 passing) remain the governing
iOS/Android contract gates.

## KNOWN_UNKNOWN_CHECKS_FOR_MIGRATION_DAY

- **B34-KU-001** — destination effective schema vs this candidate. Not answerable
  without destination access, which this campaign forbids.
- **B34-KU-002** — whether orphaned owner-less media exists in the destination.
- **B34-KU-003** — whether `tryon-clothes-pro` carries the same `verify_jwt` drift
  there.

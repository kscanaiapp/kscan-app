# Build 34: staging-to-production migration readiness manifest

Handoff to the separate, owner-authorized production migration campaign.
**Nothing here was executed against production.** Production
(`wyyuqfdxucjksghsmhry`) was not accessed, queried, or changed while this
manifest was produced. Every production fact must be re-derived read-only on
migration day before any action.

Evidence source: backend closure campaign, 2026-09-17, against staging
`yzqjvdfgefveprobvvyw`. Supersedes the earlier draft on the unmerged PR #431
branch (`claude/relaxed-noether-zqp4rl`). That draft predated the audit repairs,
the orphan reconciler deployment, and the closure indexes. Secrets are named
only; no value appears anywhere.

```text
FINAL_BACKEND_AUTHORITY_SHA=<the head of PR #437 as merged into rebuild/backend-authority-v2; see the closure record>
FINAL_BACKEND_CANDIDATE_BRANCH=repair/build34-backend-closure-20260917
PRE_CLOSURE_BACKEND_AUTHORITY_SHA=d24d4afd214b55ae10f9f360d82b83e8c29be0b9
STAGING_PROVEN_AUDIT_SOURCE_SHA=2314d29bb868f643fde2db52bf939643c7ee4eea (carried with its original SHA)
FINAL_RELEASE_SHA=c6ee31adb0932d4d476cc218c1a7bff434b10bc8 (release/kscan-pre-freeze-v1, unchanged; integration-convergence-non-authoritative)
STAGING_PROJECT=yzqjvdfgefveprobvvyw
PRODUCTION_PROJECT=wyyuqfdxucjksghsmhry (frozen target)
```

## MIGRATIONS_TO_APPLY

- **Source set:** all 172 files in `supabase/migrations/*.sql` at the final
  authority SHA. Staging's ledger has 172 rows and the governed preflight
  reports `remoteOnly=[]`, `localOnly=[]`. 30 local versions are reconciled
  renumbers or consolidations
  (`config/migration-authority-manifest.json → ledgerReconciliation`).
- **The production delta is not known here.** On migration day, list the
  production ledger read-only and diff it against the source set.
  `ledgerReconciliation` is keyed by project ref and carries **no** production
  entries, so the preflight fails closed on production until a production
  reconciliation is proven and declared. Do not copy the staging entries.
- **New in Build 34 backend closure** (all applied to staging; production state
  unknown):
  - `20260916233708_reaction_counts_bind_anonymous_share_token.sql`: anonymous
    reaction-count reads require the live share token. The
    `get_item_reaction_counts(uuid[], text)` signature replaces the one-argument
    form, which it drops.
  - `20260916235651_dressing_room_items_dedupe_key_idempotency.sql`: partial
    unique dedupe-key index. It stays inert while `DRESSING_ROOM_DEDUPE_V1` is off.
  - `20260917163000_b34_fk_delete_path_indexes.sql`: six lifecycle FK indexes
    (B34-BE-PERF-001). See the performance checks below.
- **Earlier Build 33/34 additions to confirm on the production ledger:**
  `20260914120000`, `20260915030553`, `20260915124849`, `20260915133739`,
  `20260915181554`, `20260915181910`, `20260915214857`, `20260915232402`,
  `20260916125206`, `20260916130553`, `20260916203000`.
- **Do not apply** anything in `supabase/migrations-deferred/`
  (`20260725100000_shared_room_item_contributions.sql` needs product sign-off).
- **Ordering caveat:** `20260916203000` and `20260916233708` both redefine
  `get_item_reaction_counts`. Apply them in version order; the later one is the
  contract (token-bound anonymous reads).
- **Competing lane:** open PR #435 carries **differently versioned** copies of
  the same two reaction/dedupe migrations (`20260917010000`, `20260917020000`).
  If both PRs merge, those duplicates must be dropped. The staging ledger
  versions above are authoritative.

## REMOTE_ONLY_MIGRATIONS_NOT_TO_REPLAY

| Version | Name | Classification | Why |
|---|---|---|---|
| `20260916234025` | `dressing_room_items_source_idempotency` | `OBSOLETE_REMOTE_ONLY` (staging only) | The ledger row exists, but its index `dressing_room_items_source_identity_key` is absent. Its "same product once per room" invariant is not the approved mutation-idempotency contract. Never replay it or add it to source. The governed preflight honours the declaration (B34-BE-GOV-004). |

## EDGE_FUNCTIONS_TO_DEPLOY

The 25 governed functions below all match staging byte-for-byte: the final
readback downloaded all 25 and hash-compared them against
`config/edge-function-manifest.json`. JWT posture matches for all 25 as well.
Version integers are informational only. They advance whenever function
secrets change, so use the manifest hashes, not versions, as parity evidence.

| Function | verify_jwt (declared) | verify_jwt (staging) | Bundle files | Manifest bundleHash | Staging version (informational) |
|---|---|---|---|---|---|
| `scan-identify` | false | false | 42 | `c94d477b4af6acd0…` | v75 |
| `commerce-watch-refresh` | false | false | 15 | `28358c4d9a11d071…` | v14 |
| `stylechat-generate` | true | true | 54 | `37090486e55f147a…` | v130 |
| `style-outfit-generate` | true | true | 6 | `4f2464847913e08e…` | v61 |
| `stylist-speech` | true | true | 11 | `5c3710d9fa54c69c…` | v71 |
| `handle-user-deletion` | true | true | 5 | `077c13e79c448c51…` | v83 |
| `process-account-deletions` | false | false | 6 | `9d597660f375c5c1…` | v70 |
| `apple-credential-link` | true | true | 5 | `c0edcc1978886460…` | v61 |
| `apple-revoke-credential` | false | false | 5 | `26f8854aa1f781dc…` | v59 |
| `privacy-correction-request` | true | true | 3 | `1a5704f34405724c…` | v67 |
| `privacy-data-export` | true | true | 3 | `f410151cf31a663e…` | v66 |
| `restore-account` | false | false | 2 | `f7e39200bfe4cb23…` | v62 |
| `resend-restoration-email` | false | false | 2 | `6fa7c413b9e92ac0…` | v62 |
| `kickscrew-sneaker-description` | true | true | 1 | `8ace88ee50800630…` | v78 |
| `kplus-activate` | true | true | 3 | `ed602058292b8cee…` | v23 |
| `kplus-reconcile-revenuecat` | false | false | 3 | `c1779621932eecc7…` | v23 |
| `nike-shoe-details` | true | true | 1 | `1b693c557542753c…` | v59 |
| `product-search-deals` | true | true | 3 | `2e2a8a98a2a986c8…` | v69 |
| `search-vinted-secondhand` | true | true | 3 | `6e2b00f7fd9bcc91…` | v61 |
| `shared-room-image-url` | true | true | 2 | `3937778b650e1cd5…` | v59 |
| `tryon-clothes-pro` | true | true | 2 | `260cfeb37bc93c76…` | v13 |
| `staging-health` | false (function config.toml) | false | 1 | `60555e3a1ac48a23…` | v64 |
| `deletion-status` | false | false | 2 | `03ba8050a6bcd210…` | v8 |
| `vto-generate` | true | true | 16 | `898983d46f2d3e4f…` | v16 |
| `reconcile-orphan-media` | false | false | 1 | `fcdec6f02bb3ff5f…` | v3 |

Notes:
- `tryon-clothes-pro` is the **retired** refusal stub. Production is recorded
  elsewhere as still running the legacy paid proxy under this slug, so deploying
  the stub there is a deliberate retirement decision, not a routine sync.
- `staging-health` is a staging-only probe; do not deploy it to production.
- `reconcile-orphan-media` must reach production only together with its
  dry-run locks (see WORKERS).
- The governed pipeline runs `deno check` with the latest Deno. All 25 entrypoints
  pass under Deno 2.8.2 / TypeScript 6 as of B34-BE-GOV-005. Pinning Deno in
  `staging-controlled-deploy.yml` (and in any production twin) is recommended
  follow-up work.

## EDGE_FUNCTIONS_EXCLUDED_FROM_MIGRATION

Every slug below carries `EXCLUDE_FROM_BUILD34_PRODUCTION_MIGRATION` in
`config/backend-authority.json → notGoverned`. Its presence on staging confers
no migration authority.

| Slug | Group | Staging state | Disposition |
|---|---|---|---|
| `wearable-bridge`, `wearable-save`, `wearable-open-on-phone`, `wearable-scan` | wearable (kscan-glasses-webapp) | `ACTIVE_STAGING_NON_SHIPPING_SURFACE` | **DO_NOT_PROMOTE**; `WEARABLE_BUILD34_SCOPE=OUT` |
| `privacy-controls` | website privacy stack | listed ACTIVE v13; **bundle missing** (every request returns 404 `NOT_FOUND_FUNCTION_BLOB`); no source in any repository | exclude; owner decides retire vs recover |
| `public-sale-share-opt-out` | website privacy stack (kscan-website@eed83bae) | listed ACTIVE v13; **bundle missing** (every request returns 404 `NOT_FOUND_FUNCTION_BLOB`) | exclude from Build 34; see WEBSITE-PRIV-001 |
| `product-match` | staging tooling | ungoverned | exclude |
| `vto-provider-diag`, `rapidapi-key-diag`, `rapidapi-current-audit` | diagnostic residue | ungoverned; the latter two are `verify_jwt=false` | exclude; owner should delete them from staging |

## VERIFY_JWT_POSTURE

Declared in `supabase/config.toml`, plus `supabase/functions/staging-health/config.toml`
for the health probe, and verified equal on staging for all 25 (see the table
above). `verify_jwt=false` is used only where the function authenticates the
caller itself:

- worker secret headers: `process-account-deletions`, `commerce-watch-refresh`,
  `kplus-reconcile-revenuecat`, `reconcile-orphan-media`;
- custom bearer validation with a non-anonymous requirement and a governed
  error contract: `scan-identify`;
- restoration/deletion token flows: `restore-account`,
  `resend-restoration-email`, `deletion-status`;
- server-to-server Sign in with Apple revocation from the purge path,
  authenticated by a constant-time service-role key compare:
  `apple-revoke-credential`;
- the health probe: `staging-health`.

Changing any posture changes authentication behaviour and is an owner decision.

## RPC_SIGNATURES

- `get_item_reaction_counts(p_item_ids uuid[], p_share_token text default null)`
  is the only overload (the one-argument form is dropped).
- Exactly **3** `anon`-executable routines:
  - `get_item_reaction_counts(uuid[], text)`
  - `get_public_room_preview(text)`
  - `get_public_room_decision_preview(text)`
- Service-role only (no `anon`/`authenticated` execute):
  - `check_and_increment_scan_identify_daily_usage`
  - `list_orphan_owner_media(text, integer, text)` (`stable`)
  - `claim_deletion_requests_for_purge`
  - `list_deletion_purge_candidates`
  - every routine that takes a caller-supplied `p_user_id`.

## RPC_GRANTS

- `PUBLIC` EXECUTE on routines in `public`/`internal`: **0**.
- `anon` EXECUTE: exactly the 3 routines above. `security/scripts/anon-grant-guard.js`
  is the gate.
- `authenticated` EXECUTE on SECURITY DEFINER routines: **52** on staging:
  block_dressing_room_user, can_access_room_messages,
  can_react_to_dressing_room_item, cast_outfit_decision_vote,
  check_and_increment_style_outfit_burst, check_and_increment_stylechat_burst,
  complete_provider_request, consume_stylechat_request_quota,
  create_dressing_room_message, create_look_from_dressing_room_items,
  create_look_from_owned_items, create_or_get_room_share,
  dressing_room_pair_has_interacted, ensure_privacy_settings,
  evaluate_provider_abuse_state, finalize_elise_generation_operation,
  get_item_reaction_counts, get_my_deletion_status,
  get_my_kplus_entitlement_summary, get_outfit_decision_vote_counts,
  get_public_room_decision_preview, get_public_room_preview,
  get_stylechat_daily_usage, has_active_k_plus, increment_style_chat_usage,
  increment_style_outfit_daily_usage, increment_stylechat_daily_usage,
  increment_stylechat_daily_usage_idempotent, is_active_account,
  is_dressing_room_pair_blocked, join_room_via_share_token,
  list_dressing_room_blocked_users, list_dressing_room_messages,
  list_shared_rooms_for_me, mark_elise_generation_generating,
  recompute_signature_style, register_user_device_session,
  release_provider_request, remove_shared_room_for_me,
  reserve_elise_generation_operation, reserve_provider_request,
  resolve_dressing_room_collaboration_access, revalidate_elise_generation_context,
  revoke_room_share, save_shared_room_for_me, set_dressing_room_item_reaction,
  set_outfit_decision_state, share_looks_to_outfit_decision,
  touch_shared_room_for_me, unblock_dressing_room_user, update_look_owned_items,
  upsert_style_memory_event.
- SECURITY DEFINER routines: 119. **0** have an unpinned `search_path`.

## RLS_POLICIES

- 83 `public` tables, **all** with RLS enabled, carrying 135 policies. Enable RLS
  first: the grant-but-no-policy tables are safe *only* because RLS is on.
- `app_config` has 3 public SELECT policies (keys `vto_generation` and
  `mobile_feature_freeze`) and **no** client write policy. A rolled-back probe
  showed `anon`/`authenticated` INSERT returns 42501 and UPDATE/DELETE affect
  0 rows. This is what protects the orphan-sweep and deletion-worker switches.
- `dressing_rooms`, `dressing_room_items` and `room_shares` intentionally OR
  owner access with live-share-recipient access, under the RESTRICTIVE
  `is_active_account()` guard.
- 6 `storage.objects` policies, all owner-scoped:
  - style-library-images: select, insert, update, delete
  - clean images: read
  - quarantine: insert

## TRIGGERS

48 non-internal triggers across `public`/`storage`/`auth` on staging. **0**
trigger functions have an unpinned `search_path`. There are no database
webhook triggers (no `net.http_*` callers).

## INDEXES_REQUIRED_FOR_CORRECTNESS

These unique keys are the idempotency and concurrency contract. Reproduce them
exactly:

- `saved_scans_user_local_id_unique_idx (user_id, local_id) WHERE local_id IS NOT NULL`
- `user_closet_items_user_client_uidx (user_id, client_id)`
- `user_commerce_watches_user_url_uidx (user_id, canonical_url) WHERE deleted_at IS NULL`
- `vto_generation_requests_user_id_idempotency_key_key (user_id, idempotency_key)`
- `kplus_entitlement_grants_identity_key (user_id, entitlement_key, source, grant_key)`
- `kplus_entitlement_grants_store_subscription_key (provider, store, grant_key) WHERE source = 'store_subscription'`
- `provider_request_reservations_fingerprint_inflight_idx (user_id, request_fingerprint) WHERE status = 'reserved'`
- `scan_identify_usage_daily_user_id_usage_date_mode_key (user_id, usage_date, mode)`
- `elise_generation_operations_user_id_operation_key_key (user_id, operation_key)`
- `elise_generation_operations_source_unique (user_id, session_id, source_message_id, operation_type) WHERE source_message_id IS NOT NULL`
- `style_chat_assistant_source_message_unique (user_id, session_id, sender, source_message_id) WHERE sender = 'assistant' AND source_message_id IS NOT NULL`
- `dressing_room_item_reactions_item_user_key (item_id, user_id)`
- `dressing_room_collab_idempotency_room_actor_op_request_key (room_id, actor_id, operation, request_id)`
- `dressing_room_items_dedupe_key_key` (partial, on the canonical dedupe key)

**Must be absent:** `dressing_room_items_source_identity_key`.

**Lifecycle indexes** (B34-BE-PERF-001; they bound account, session, room and
scan deletion):

- `style_chat_messages_source_message_idx`
- `elise_generation_operations_source_message_idx`
- `elise_generation_operations_session_idx`
- `dressing_room_messages_parent_message_idx`
- `look_items_source_dressing_room_item_idx`
- `outfit_decision_option_items_source_saved_scan_idx`

## STORAGE_BUCKET_CONFIG

| Bucket | Public | Size limit | MIME allowlist |
|---|---|---|---|
| `style-library-images` | no | 5 MiB (5242880) | image/jpeg, image/png, image/webp |
| `image-ingestion-clean` | no | 10 MiB (10485760) | image/jpeg, image/png, image/webp |
| `image-ingestion-quarantine` | no | 10 MiB (10485760) | image/jpeg, image/png, image/webp |
| `legal-documents` | **yes** | none | none |
| `investor-docs` | no | none | none |

## STORAGE_POLICIES

See RLS_POLICIES. `legal-documents` is public-read by design and has no client
write path. `investor-docs` has no client policy.

## WORKERS

| Worker | Auth | Server switches | Invoker |
|---|---|---|---|
| `process-account-deletions` | `x-deletion-worker-secret` (`ACCOUNT_DELETION_WORKER_SECRET`) | `app_config.account_deletion_worker_enabled` / `_dry_run` (staging: enabled, live) | `staging-account-deletion-worker.yml` (master, daily 09:15 UTC); `production-account-deletion-worker.yml` (manual, dry-run default, staged enablement) |
| `commerce-watch-refresh` | `x-watchlist-worker-secret` (`WATCHLIST_WORKER_SECRET`) | `app_config.watchlist_worker_enabled` (**false**) | `watchlist-tier2-sweep.yml` (manual; cron commented out) |
| `kplus-reconcile-revenuecat` | `x-kplus-reconcile-secret` (`KPLUS_RECONCILE_INTERNAL_SECRET`) | `REVENUECAT_SYNC_ENABLED` | none (pull-based mirror; invoker is an owner decision) |
| `reconcile-orphan-media` | `x-orphan-sweep-secret` (`ORPHAN_MEDIA_SWEEP_SECRET`) | `app_config.orphan_media_sweep_enabled` (absent = OFF), `orphan_media_sweep_dry_run`, `ORPHAN_MEDIA_SWEEP_DRY_RUN=true` | `staging-orphan-media-reconciler.yml` (dispatch; daily 09:40 UTC once on the default branch), **dry run only** |

For production, `reconcile-orphan-media` must be deployed with
`ORPHAN_MEDIA_SWEEP_DRY_RUN=true` and **no** `orphan_media_sweep_*` rows set to
enable deletion. A production invoker would be a new, reviewed workflow; the
staging workflow refuses the production ref.

## SCHEDULERS

GitHub Actions is the only scheduler. `pg_cron` and `pg_net` are **not**
installed. The extensions present are `pg_stat_statements`, `pgcrypto`,
`pgtap`, `plpgsql`, `supabase_vault` and `uuid-ossp`. `pgtap` is a staging test
artifact; do not carry it to production unless it is intended. GitHub runs
`schedule:` triggers only from the default branch, `master`.

## WEBHOOKS

No inbound vendor webhook is deployed in the governed set. RevenueCat is
pull-based. There are 0 database webhook triggers.

## FLAGS

- **Server `app_config` (staging):**
  - `account_deletion_worker_enabled=true`
  - `account_deletion_worker_dry_run=false`
  - `watchlist_worker_enabled=false`
  - `vto_generation=true`
  - `mobile_feature_freeze` (object)
  - `orphan_media_sweep_*` absent
- **Server function secrets that act as flags (staging values are readable as
  digests; set production deliberately):**
  - `BACKEND_COMMERCE_FUNNEL_V127_ENABLED`, `STYLECHAT_AI_ENABLED`
  - `SCAN_MULTI_ITEM_ENABLED`, `SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED`,
    `SCAN_PRODUCT_MATCH_ENABLED`, `SCAN_SIMILAR_ITEM_FLAG_ENABLED`,
    `SCAN_IDENTIFICATION_RECHECK_ENABLED`
  - `ELISE_*_V1_ENABLED` (advice intents, closet retrieval, compatibility
    scoring, concierge, multi-look, packing intelligence, purchase advice, room
    intelligence, wardrobe gap)
  - `FARFETCH3_ENABLED`, `KICKSCREW_ENABLED`, `POSHMARK_ENABLED`,
    `MODELSLAB_TRYON_ENABLED`, `PRODUCT_MATCH_ENABLED`,
    `REVENUECAT_SYNC_ENABLED`
  - `ORPHAN_MEDIA_SWEEP_DRY_RUN`
- **Client flags kept off in every EAS profile** (do not flip as part of the
  migration): `SHARED_ROOM_CONTRIBUTIONS_V1`, `DRESSING_ROOM_DEDUPE_V1`.
- `supabase/config.toml` `project_id` and `config/backend-authority.json`
  `approvedProjectRef` pin the staging deploy target. They move together, as a
  reviewed step, or CI fails.

## SECRETS_REQUIRED_BY_NAME_ONLY

These are the names present on staging (77); `docs/staging-rebuild/secret-name-manifest.md`
remains the authority. Platform-managed names are marked (P).

`ACCOUNT_DELETION_WORKER_SECRET`, `BACKEND_COMMERCE_FUNNEL_V127_ENABLED`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_FEMININE_VOICE_ID`, `ELEVENLABS_MASCULINE_VOICE_ID`,
`ELEVENLABS_MODEL_ID`, `ELEVENLABS_OUTPUT_FORMAT`, `ELEVENLABS_STYLIST_01..10_VOICE_ID`,
`ELISE_ADVICE_INTENTS_V1_ENABLED`, `ELISE_CLOSET_RETRIEVAL_V1_ENABLED`,
`ELISE_COMPATIBILITY_SCORING_V1_ENABLED`, `ELISE_CONCIERGE_V1_ENABLED`,
`ELISE_MULTI_LOOK_V1_ENABLED`, `ELISE_PACKING_INTELLIGENCE_V1_ENABLED`,
`ELISE_PURCHASE_ADVICE_V1_ENABLED`, `ELISE_ROOM_INTELLIGENCE_V1_ENABLED`,
`ELISE_WARDROBE_GAP_V1_ENABLED`, `FARFETCH3_ENABLED`, `FARFETCH3_RAPIDAPI_KEY`,
`FASHION4_RAPIDAPI_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `KICKSCREW_ENABLED`,
`KICKSCREW_RAPIDAPI_KEY`, `KPLUS_RECONCILE_INTERNAL_SECRET`, `KSCAN_DEPLOYED_AT`,
`KSCAN_ENVIRONMENT`, `KSCAN_HEALTH_CONTRACT_VERSION`, `KSCAN_MANIFEST_DIGEST`,
`KSCAN_RELEASE_ID`, `KSCAN_SOURCE_SHA`, `KSCAN_SOURCE_TREE_SHA`, `MODELSLAB_API_KEY`,
`MODELSLAB_TRYON_ENABLED`, `ORPHAN_MEDIA_SWEEP_DRY_RUN`, `ORPHAN_MEDIA_SWEEP_SECRET`,
`POSHMARK_ENABLED`, `POSHMARK_RAPIDAPI_HOST`, `POSHMARK_RAPIDAPI_KEY`,
`PRODUCT_MATCH_ENABLED`, `PRODUCT_MATCH_INTERNAL_SECRET`,
`RAPIDAPI_FASHION_DETECTION_HOST`, `RAPIDAPI_FASHION_DETECTION_KEY`, `RAPIDAPI_KEY`,
`REVENUECAT_KPLUS_ENTITLEMENT_ID`, `REVENUECAT_PROJECT_ID`, `REVENUECAT_SECRET_API_KEY`,
`REVENUECAT_SYNC_ENABLED`, `SCAN_IDENTIFICATION_RECHECK_ENABLED`,
`SCAN_MULTI_ITEM_ENABLED`, `SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED`,
`SCAN_PRODUCT_MATCH_ENABLED`, `SCAN_SIMILAR_ITEM_FLAG_ENABLED`,
`SHOPPING_BRAVE_API_KEY`, `SHOPPING_SERPER_API_KEY`, `SIMILAR_CLOTHES_RAPIDAPI_KEY`,
`STYLECHAT_AI_ENABLED`, `STYLECHAT_BURST_LIMIT_PER_MINUTE`, `STYLECHAT_GEMINI_MODEL`,
`WATCHLIST_WORKER_SECRET`, `XIMILAR_TOKEN`; (P) `SUPABASE_ANON_KEY`,
`SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`,
`SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`.

GitHub: the `staging` environment holds `ACCOUNT_DELETION_WORKER_SECRET` and
`ORPHAN_MEDIA_SWEEP_SECRET`. A `production` environment does not exist yet
(`production-account-deletion-worker.yml` expects one).

**Owner action, unresolved since Build 33:** staging and production still share
provider keys. Use distinct production values.

## PROVIDER_CONFIG

- Gemini (scanner, Elise; `GEMINI_MODEL`, `STYLECHAT_GEMINI_MODEL`)
- Serper and Brave (shopping)
- Farfetch, KicksCrew, Nike, Poshmark and Fashion4/fashion detection, all via
  RapidAPI. `RAPIDAPI_KEY` is shared by `nike-shoe-details` and
  `kickscrew-sneaker-description`, so size its quota for both.
- Apify Vinted (`search-vinted-secondhand`; account-state gate precedes the paid
  call)
- ElevenLabs (stylist speech)
- ModelsLab / AI Lab Tools (VTO; the provider **is** billing)
- Ximilar
- Resend (email)

## REVENUECAT_CONFIG

`NATIVE_REVENUECAT_PURCHASE_FLOW=NOT_IN_BUILD34_SHIPPING_SCOPE`. Supabase is the
K+ entitlement authority; RevenueCat is a mirror only
(`REVENUECAT_SYNC_ENABLED`, `REVENUECAT_PROJECT_ID`, `REVENUECAT_KPLUS_ENTITLEMENT_ID`,
`REVENUECAT_SECRET_API_KEY`). Account purge retires the mirrored grant
(KPLUS-P2-001). No product, price or paid-activation change is in scope.

## PERFORMANCE_MIGRATION_DAY_CHECKS

From `docs/audits/build34-backend-performance-disposition-2026-09-17.md` (204
advisor findings: 6 fixed, 12 migration-day, 7 not applicable, 179 safe-defer):

1. Before applying `20260917163000`, record destination row counts of
   `style_chat_messages`, `elise_generation_operations`,
   `dressing_room_messages`, `look_items` and `outfit_decision_option_items`.
   Plain `CREATE INDEX` briefly blocks writes.
2. Index the `user_id`/`actor_id` key of `user_commerce_watch_events`,
   `dressing_room_item_reactions`, `dressing_room_collab_idempotency` or
   `watchlist_push_receipts` if any exceeds 250,000 rows, **before** scheduled
   account deletion is enabled.
3. Index the inspiration FK of `dressing_room_inspiration_items` or
   `outfit_decision_option_items` if either exceeds 100,000 rows.
4. For the six hot RLS read paths, `EXPLAIN (ANALYZE, BUFFERS)` as a
   representative user (owner-index scan expected), then review
   `pg_stat_statements` mean/p95 after 24 hours:
   - `saved_scans` select
   - `style_chat_messages` read
   - `style_chat_sessions`
   - `dressing_rooms` select
   - `dressing_room_items` select
   - `look_items` select
5. Do not drop "unused" indexes on staging evidence. Re-evaluate after 30 days of
   production statistics.

```text
PRODUCTION_SCALE_P99_PROVEN=NO
```

## POST_MIGRATION_RUNTIME_TESTS

1. Download every deployed function and hash-compare it against
   `config/edge-function-manifest.json` in both directions (the method this
   campaign used for 25/25).
2. Compare `verify_jwt` for every function against `supabase/config.toml`.
3. `scan-identify`: missing or malformed JWT returns 401, health returns 200,
   and the MODE B boundary is enforced (authenticated, non-anonymous, durable
   quota before evidence parsing and provider work).
   `check_and_increment_scan_identify_daily_usage` is service-role only, and
   the quota fails **closed** when it is unreachable.
4. `search-vinted-secondhand`: missing or malformed JWT returns 401. For
   deactivated, pending, locked or unreadable accounts, zero upstream calls.
5. `process-account-deletions`: a request without the secret returns 401.
   Dry-run the worker first (staged enablement).
6. `reconcile-orphan-media`: a request without the secret returns 401. A dry
   run records the destination orphan baseline with `objectsDeleted=0`.
7. B34-SEC-001 reaction matrix:
   - outsider, removed member, and anonymous caller with a wrong, revoked or
     expired token: no counts;
   - owner, active member, active participant, and anonymous caller with the
     live token: counts.
8. Assert 0 unpinned SECURITY DEFINER/trigger `search_path`, 0 `PUBLIC`
   EXECUTE, and exactly 3 `anon`-executable RPCs.
9. Assert RLS is enabled on every table. As `anon`, the grant-but-no-policy
   tables return 0 rows, and `app_config` rejects client writes.
10. Assert the six lifecycle indexes exist and are valid, and that
    `dressing_room_items_source_identity_key` is absent.
11. Storage: policies are owner-scoped, and `legal-documents` has no client
    write path.

## FRONTEND_BLOCKERS_TO_RETEST_AFTER_MOBILE_FIXES

- **B34-FE-DR-001** (shared iOS/Android): the public Dressing Room route calls
  `get_item_reaction_counts` with only `p_item_ids`, but the backend contract
  requires the route's live `p_share_token`. Do not weaken the RPC. Retest the
  full reaction matrix (item 7 above) once the client passes the token,
  including wrong, revoked and expired tokens. Note that open PR #435 carries a
  client change to `app/(public)/rooms/[token].tsx` on the backend-authority
  base; it belongs to the mobile campaign.

## OUT-OF-SCOPE ESCALATION (website, not Build 34 mobile)

**WEBSITE-PRIV-001:** the website privacy stack on `yzqjvdfgefveprobvvyw` is
non-functional.
- `public-sale-share-opt-out` and `privacy-controls` return 404
  `NOT_FOUND_FUNCTION_BLOB` for every request; their platform bundles are gone.
- A real browser preflight to `public-sale-share-opt-out` was observed at
  2026-09-17T16:36:41Z, receiving 404.
- `kscan-website/.env.example` documents this ref as the waitlist/privacy
  project.

If the live website's Do-Not-Sell/GPC page uses this project, opt-out
preferences can be neither read nor recorded server-side. This needs a website
owner compliance review.

**Prepared plan (not performed):**
1. Confirm the website's `NEXT_PUBLIC_PRIVACY_SUPABASE_URL`.
2. Redeploy `public-sale-share-opt-out` from `kscan-website@eed83bae`, using
   `verify_jwt=false` per the website `supabase/config.toml`.
3. Verify with the non-mutating probe set: OPTIONS returns 200 `ok`; GET
   without an id returns 400; GET with a v1 UUID returns 400; GET with an
   unknown v4 UUID returns `{found:false}`; POST validators return
   413/400×5; PUT/DELETE return 405. The table signature must be unchanged.
4. Decide whether to retire `privacy-controls`, which has no source anywhere
   and no caller.

The redeploy cannot regress behaviour, because the function currently serves
nothing. It was not performed in this campaign because the target is a live
website dependency outside the Build 34 backend authority.

# Supabase Exposure Audit — Phase 2

- **Date**: 2026-08-03 · **Staging**: yzqjvdfgefveprobvvyw · **Production**: wyyuqfdxucjksghsmhry (read-only comparison only, no writes issued)

## Edge Functions

| Function | Deployed | verify_jwt | Source in repo | Shared security boundary | CORS | Rate limit |
|---|---|---|---|---|---|---|
| stylechat-generate | yes | true | yes | yes (`_shared/security`) | caller-aware | quota+concurrency |
| kickscrew-sneaker-description | yes | true | yes | yes | caller-aware | quota+concurrency |
| product-search-deals | yes | true | yes | yes | caller-aware | quota+concurrency, TTL-tuned |
| handle-user-deletion | yes | unknown (no repo record) | yes | **no** — hand-rolled auth, predates shared module | wildcard `*` | none |
| privacy-correction-request | yes | true (documented) | yes | **no** | wildcard `*` | none |
| privacy-data-export | yes | true (documented) | yes | **no** | wildcard `*` | none |
| privacy-controls | yes | true | **NO SOURCE ANYWHERE IN REPO HISTORY** | unknown | unknown | unknown |
| public-sale-share-opt-out | yes | **false** | **NO SOURCE ANYWHERE IN REPO HISTORY** | unknown | unknown | unknown |
| search-vinted-secondhand | **no** (held) | true | yes | yes | caller-aware | quota (inert) |
| tryon-clothes-pro | **no** (held) | true | yes | yes | caller-aware | quota (inert) |
| nike-shoe-details | **no** (held) | true | yes | yes | caller-aware | quota (inert), TTL-tuned |

Audit-fail conditions checked against the brief's criteria:
- Held function deployed? **No** — confirmed live via `list_edge_functions` (8 exactly) and direct HTTP 404 against all three held functions.
- Authenticated function with `verify_jwt` disabled undocumented? **`public-sale-share-opt-out`** has `verify_jwt=false` — but its name and one corroborating fact (the target table is service-role-only) suggest this is an *intentional* public CCPA opt-out design, not an accident. It cannot be fully confirmed either way without source — flagged, not assumed safe.
- Provider-backed function lacking the shared security boundary? None of the provider-cost functions lack it — `handle-user-deletion`/`privacy-correction-request`/`privacy-data-export` don't call external providers, so this specific failure condition doesn't apply to them, though they do lack rate limiting (a related, separate gap, noted above).
- Function accepting sensitive image data without bounded payload handling? None found outside the already-hardened `tryon-clothes-pro` (10MB cap, held/undeployed).
- Unintended public function reachable? Not found among functions with source; **cannot be ruled out** for the two unauditable functions.

## Database API Exposure

**Central finding**: this Supabase project's default privileges grant `EXECUTE` on newly created public-schema functions to `anon`/`public` unless explicitly revoked. This was already discovered once and fixed for the `provider_request_*` functions in PR #43 (`20260803020100_provider_request_security_revoke_anon.sql`). This pass found the identical pattern across nearly every other pre-existing RPC (`create_or_get_room_share`, `revoke_room_share`, `create_look_from_dressing_room_items`, `upsert_style_memory_event`, `check_and_increment_stylechat_burst`, `increment_stylechat_daily_usage`, `increment_style_chat_usage`, `get_stylechat_daily_usage`, `ensure_privacy_settings`, plus several trigger functions with an unnecessary `PUBLIC` grant).

**Read the actual function bodies (not just grants) before concluding risk**: every one of those RPCs already `raise exception` when `auth.uid() IS NULL` — so the stray grant was never actually exploitable. This is a defense-in-depth gap, not a live vulnerability, and the fix (revoke) is safe with zero behavior change for legitimate callers.

**One genuine gap**: `get_item_reaction_counts(uuid[])` — a `LANGUAGE sql`, `SECURITY DEFINER` function — had **no `auth.uid()` check of any kind**. Any caller, anonymous included, could pass arbitrary item UUIDs from any user's private dressing room and receive back reaction counts. Cross-referencing the app-ingress research: this function *is* called anonymously by design from the public shared-room preview screen (`app/(public)/rooms/[token].tsx` → `services/styleObjects.ts:587-589`), so the fix could not simply require authentication — it had to preserve that legitimate anonymous path while closing the arbitrary-UUID gap. Fix (applied to staging): restrict to items whose dressing room is either owned by the caller or currently has an active, non-revoked, non-expired share — mirroring the exact predicate `get_public_room_preview` already uses. See `supabase/migrations/20260803214145_harden_public_rpc_execution_grants.sql`. Validated end-to-end against staging with synthetic data (created a temporary dressing room/item/share/reaction owned by the `synthetic-active` account): anonymous call while the share was active returned the correct count; the same call after revoking the share returned nothing; the owner continued to see their own counts regardless of share state; a different authenticated (non-owner) user with no share saw nothing. All synthetic rows removed afterward.

**RLS enablement**: every table in `public` schema has `relrowsecurity = true` (confirmed via `pg_class`, 26 tables checked, zero exceptions).

**Table-level grants**: `anon`/`authenticated` have blanket `ALL`-privilege table grants across nearly every public table — this is Supabase's standard default-privilege pattern; the actual access boundary is enforced by RLS policies, not by the table grant. Verified this holds for every sensitive table checked (`profiles`, `privacy_settings`, `deletion_requests`, `privacy_correction_requests`, `privacy_export_requests`, `waitlist_signups`, `website_sale_share_opt_out_requests`, `dressing_rooms`, `dressing_room_items`, `dressing_room_item_reactions`, `room_shares`) — each either has no anon-usable policy (fails closed) or a correctly owner-scoped one. `app_config` is the sole intentional exception, correctly scoped to a single config key.

**SECURITY DEFINER search_path**: every `SECURITY DEFINER` function in `public` schema has an explicit `search_path` set (`'public'` or `''`) — **zero** lack a controlled search_path. (A handful of `SECURITY INVOKER` trigger functions have no `search_path` set, which is lower-risk since the classic search_path-hijack pattern is specific to `SECURITY DEFINER`, but they're included in the guardrail test as a hygiene baseline going forward.)

**RPCs accepting caller-supplied user IDs**: none found — every RPC that touches a `user_id` column derives it from `auth.uid()` internally; none accept a `p_user_id`-style parameter from the client for anything other than the already-scoped `evaluate_provider_abuse_state(p_user_id, ...)` (PR #43), which itself asserts `p_user_id = auth.uid()` before proceeding.

**pg_cron**: extension is listed but **not installed** (`installed_version: null`) — no scheduled jobs exist, not an active surface.

## Storage

| Bucket | Public | Size cap | MIME allowlist | Policies |
|---|---|---|---|---|
| style-library-images | false | 5MB | jpeg/png/webp | 4 policies, all owner-scoped via path-prefix = auth.uid() |
| investor-docs | false | none | none | **zero** client-facing policies — service-role only by omission |

No raw face, plate, biometric, or unmasked image is exposed through public storage. `investor-docs` has no size/MIME restriction, but since it has zero client-reachable policies, this is not currently an exploitable gap — flagged only as a documentation gap (purpose unclear, unrelated to the consumer app).

## Production comparison (read-only)

Production (`wyyuqfdxucjksghsmhry`) migration history was read for comparison only — no query or write was issued against production tables, functions, or storage. Production's migration history is substantially larger and diverges significantly from staging's (production has ~80 migrations covering features like `account_deletion_*`, `elise_generation_*`, `shared_room_memberships` that staging does not have applied) — this is expected drift given staging is explicitly the active target for mobile/QA work per `docs/apple-app-store-submission-runbook.md:25`, and production is out of scope for structural changes in this phase.

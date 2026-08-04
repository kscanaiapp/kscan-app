# Provider Cost Controls

Status: shared client module + migration file written and unit-tested; **migration not applied to any environment yet**. Requires explicit approval before `supabase db push` / `apply_migration` against staging (`yzqjvdfgefveprobvvyw`).

Migration: `supabase/migrations/20260803020000_provider_request_security.sql`
Client wrapper: `supabase/functions/_shared/security/quota.ts`

## Data model

| Table | Purpose | Client access |
|---|---|---|
| `provider_request_limits` | Per-function config: rolling/daily/concurrent limits, reservation TTL, cost units. | None — RLS enabled, no policy (service-role/RPC only, same pattern as `product_catalog`). |
| `provider_request_reservations` | One row per attempted provider call. | `SELECT` own rows only (RLS `user_id = auth.uid()`). No client INSERT/UPDATE/DELETE — mutation only via the RPCs below. |
| `provider_security_events` | Audit trail of throttle/block decisions, feeds `evaluate_provider_abuse_state`. | None — server-side audit trail only. |

None of these tables ever store raw images, image base64, faces, plates, access tokens, authorization headers, provider API keys, raw provider responses, raw prompts, or complete request bodies. `request_fingerprint` is a SHA-256 hex digest (`computeRequestFingerprint` in `quota.ts`) computed over identifying fields only (e.g. `userId + functionName + sessionId + message` for StyleChat) — irreversible, and tested (`quota.test.ts`) to never contain the raw input it was derived from.

## Flow

1. **Reserve** — `reserve_provider_request(function_name, provider_category, request_id, request_fingerprint, cost_units)`, a `SECURITY DEFINER` RPC scoped to `auth.uid()` (same pattern as the existing `increment_stylechat_daily_usage` / `check_and_increment_stylechat_burst` RPCs). Checks, in order:
   - **Duplicate replay**: an in-flight `reserved` row with the same `(user_id, request_fingerprint)` is returned as-is (`allowed: true`, same `reservation_id`) instead of creating a second reservation — retry-safe idempotency. A partial unique index on the same columns backstops this against a race between two concurrent identical requests.
   - **Concurrency**: count of the user's `reserved` (unexpired) rows for this function ≥ `concurrent_limit` → deny.
   - **Rolling window**: count of `reserved`+`completed` rows in the last `rolling_window_seconds` ≥ `rolling_limit` → deny, escalates via `evaluate_provider_abuse_state`.
   - **Daily**: count of `reserved`+`completed` rows since UTC midnight ≥ `daily_limit` → deny, escalates via `evaluate_provider_abuse_state`.
   - Otherwise inserts a `reserved` row with `expires_at = now() + reservation_ttl_seconds`.
   - No config row for a function → **conservative built-in default** (rolling 10/60s, daily 200, concurrent 2), never open-allow.
2. **Invoke provider.**
3. **Complete or release** — `complete_provider_request(reservation_id)` on success; `release_provider_request(reservation_id, reason)` on provider failure/timeout/caller-cancellation. Rolling/daily counts only include `reserved`/`completed` status, so a **released** reservation (provider-side failure, not the user's fault) never costs the user quota — this is the retry-safe accounting requirement.

## Deliberate fail-open boundary (read before deploying)

Until the migration above is applied, calling any of these RPCs errors with "function does not exist." `stylechat-generate`'s integration treats an **RPC-level error** (missing function, DB hiccup) as fail-open — it logs a warning and proceeds without this additive layer, relying on the pre-existing `increment_stylechat_daily_usage` / `check_and_increment_stylechat_burst` RPCs (already deployed, already enforced) as the real quota boundary. An **`allowed: false` result** from a working RPC is a genuine policy decision and is fail-closed (429).

This means the integrated `stylechat-generate` build is safe to deploy **before** the migration lands — it degrades to today's existing quota behavior — but the new concurrency/duplicate-detection/cost-bucket protections only take effect once the migration is applied. **Correct order: apply the migration first, then deploy.** Deploying first is not unsafe, but it means the new reservation layer stays inert (silently logging `reservation_unavailable`) until the migration catches up.

## Default limits seeded by the migration

| function_name | provider_category | rolling (per 60s) | daily | concurrent | cost_units |
|---|---|---|---|---|---|
| stylechat-generate | gemini_chat | 6 | 120 | 2 | 1 |
| product-search-deals | retail_search | 10 | 300 | 3 | 1 |
| search-vinted-secondhand | secondhand_search | 10 | 300 | 3 | 1 |
| tryon-clothes-pro | visual_tryon | 3 | 40 | 1 | 4 |
| kickscrew-sneaker-description | sneaker_data | 15 | 400 | 3 | 1 |
| nike-shoe-details | sneaker_data | 15 | 400 | 3 | 1 |
| scan-identify | vision_ai | 8 | 150 | 2 | 2 |

`scan-identify`'s row is seeded even though its function is not on this branch yet (see `provider-edge-authentication.md`), so config is ready the moment it's reconciled and an old/direct deployment can never end up with weaker limits than the hardened functions. These are starting points, not tuned production values — adjust via a follow-up migration once real staging traffic patterns are observed.

## Testing

`quota.test.ts` (7 tests) covers the client wrapper against a dependency-injected fake `SupabaseClient.rpc`: fingerprint determinism/irreversibility, allowed/denied/error/malformed RPC responses, and that `complete`/`release` pass the reservation ID through correctly. The SQL itself has been reviewed line-by-line but **not executed** — Docker/local Postgres was unavailable in this environment (`supabase status` fails: Docker Desktop not running), so first real execution will be the staging `apply_migration` call, which requires your explicit approval per the required pause.

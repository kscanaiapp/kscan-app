# Provider Edge Function Rollback

Status: no staging deployment or migration apply has happened yet — this documents the rollback path that will be exercised once Checkpoint 1 is approved and Phase 10 begins. Kept current as deployments actually happen.

## Rollback: shared security modules

`supabase/functions/_shared/security/*.ts` are pure, imported-only modules with no independent deployment or runtime state. Rolling back means reverting the Edge Function(s) that import them to a prior version (see below) — there is nothing to roll back in isolation.

## Rollback: an individual Edge Function (e.g. `stylechat-generate`)

Every `supabase functions deploy` creates a new numbered version; the prior version is not deleted.

```bash
# Find the prior version to restore.
supabase functions list --project-ref yzqjvdfgefveprobvvyw

# Redeploy the pre-hardening source. Two options:
#  (a) git checkout the last-known-good commit into a scratch worktree and deploy from there, or
#  (b) revert the merge commit on this branch and redeploy HEAD.
git show <prior-good-commit>:supabase/functions/stylechat-generate/index.ts > /tmp/rollback-index.ts
# then supabase functions deploy stylechat-generate --project-ref yzqjvdfgefveprobvvyw
```

Because the hardened build is designed to **fail open on the new quota-reservation layer specifically** (see `provider-cost-controls.md`) while keeping every pre-existing control (auth, session ownership, burst/daily RPCs) intact, a full functional rollback should rarely be necessary — the more common "rollback" is disabling one new control without reverting the whole function. That's documented per-control below.

## Rollback: the quota migration

The migration (`20260803020000_provider_request_security.sql`) is additive — it creates new tables/functions and seeds config rows; it does not alter, rename, or drop anything that existed before it. Rollback options, in order of preference:

1. **Tighten or loosen limits without a schema change**, by updating the config row:
   ```sql
   update public.provider_request_limits set enabled = false where function_name = 'stylechat-generate';
   ```
   Note this does **not** disable enforcement: `reserve_provider_request` treats a missing or disabled config row as "no config found" and falls back to its conservative built-in default limits, not "no limit." To fully bypass the new reservation layer for a function, revert the Edge Function's call site instead (option 2 below) — that's the actual off-switch.

2. **Revert the Edge Function's call to the new RPCs** (removes the new layer's effect while keeping the tables/RPCs deployed and harmless): redeploy a version of the function that doesn't call `reserveProviderRequest`/`completeProviderRequest`/`releaseProviderRequest`. The pre-existing burst/daily quota RPCs continue to enforce as before.

3. **Drop the new objects entirely** (last resort, only if the tables themselves are implicated in an incident):
   ```sql
   drop function if exists public.reserve_provider_request(text, text, uuid, text, numeric);
   drop function if exists public.complete_provider_request(uuid);
   drop function if exists public.release_provider_request(uuid, text);
   drop function if exists public.evaluate_provider_abuse_state(uuid, text);
   drop table if exists public.provider_security_events;
   drop table if exists public.provider_request_reservations;
   drop table if exists public.provider_request_limits;
   ```
   This is destructive and should only be run after confirming no Edge Function still calls these RPCs (a deployed function calling a dropped RPC fails closed at the reservation step — logged as `reservation_unavailable`, then proceeds per the fail-open design, so it degrades rather than 500s, but the new protections are gone).

## Rollback: a staging secret

No new secrets were introduced by this work — the hardened `stylechat-generate` build uses only secrets already present on staging (`GEMINI_API_KEY`, `GEMINI_MODEL`/`STYLECHAT_GEMINI_MODEL`, `STYLECHAT_AI_ENABLED`, `STYLECHAT_BURST_LIMIT_PER_MINUTE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`). Nothing to roll back here yet; this section will be updated if a later function (e.g. `search-vinted-secondhand`) needs a new secret.

## Rollback: a temporary block or throttle

Throttle/block state lives only in `provider_security_events` (audit) and the transient `reserved`-row counts in `provider_request_reservations` — there is no separate "block flag" to clear. To manually lift a block for a specific user during an incident:

```sql
-- Immediately end all of a user's in-flight reservations for a function (frees concurrency slot).
update public.provider_request_reservations
   set status = 'released', completed_at = now()
 where user_id = '<uuid>' and function_name = '<function_name>' and status = 'reserved';
```

`evaluate_provider_abuse_state` naturally de-escalates once its lookback windows (10 min / 24h) age out — no explicit "unblock" action is required in the common case.

## Rollback validation checklist (Phase 10)

- [ ] Previous function version confirmed restored (`supabase functions list` shows expected version/timestamp).
- [ ] Quota reservations remain consistent (no orphaned `reserved` rows past their `expires_at`).
- [ ] Synthetic test users/rows created during staging verification are removed.
- [ ] Security logs (`provider_security_events`, structured stdout logs) retained, not purged.
- [ ] Legitimate staging data unchanged: `waitlist_signups`, `privacy_settings`, `deletion_requests`, `website_sale_share_opt_out_requests`, `profiles`, `privacy_export_requests`, `privacy_correction_requests` row counts match pre-deployment snapshot.

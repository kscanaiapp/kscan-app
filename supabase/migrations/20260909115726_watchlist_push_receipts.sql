-- Build 34 / K+ Smart Watchlist V1 -- N-4: Expo push receipt consumption.
--
-- DEFECT. sendWatchPush (pushDelivery.ts) already distinguishes an Expo
-- TICKET (the immediate accept/reject from the send call) from a RECEIPT (the
-- later, asynchronous result of actually attempting delivery through
-- FCM/APNs), and already retains the ticket id for exactly this reason -- but
-- nothing ever looked the receipt up. A token that Expo accepted at send time
-- and only later reports DeviceNotRegistered on stays registered forever:
-- user_device_push_tokens.revoked_at never advances, so every future price
-- alert keeps re-attempting delivery to a route that can never succeed.
--
-- THE CRITICAL INVARIANT THIS SCHEMA EXISTS TO HOLD. A receipt is a verdict on
-- the EXACT token incarnation it was sent to, not on the device or the user. A
-- receipt that arrives after the OS refreshed the token (same device, new
-- token), after actor custody moved to someone else (claim_device_for_actor),
-- or after the row was independently revoked, must retire NOTHING. This table
-- stores only what is needed to prove "the row I am about to revoke is still
-- the exact route that generated this failure" at the moment of revocation --
-- never enough to revoke by device_id or user_id alone.
--
-- WHY A FINGERPRINT, NOT THE RAW TOKEN. user_device_push_tokens.push_token is
-- live delivery-routing material; duplicating it into a second table is an
-- unforced privacy cost this repair does not need to pay. The safety property
-- this table exists for -- "does the row I'm about to touch still hold the
-- token I sent to" -- only requires an equality check, and a SHA-256
-- fingerprint supports that check exactly as well as the plaintext would.
-- services/... callers never read this table at all (see grants below); only
-- the commerce-watch-refresh worker does, and it always has the live
-- push_token to hash and compare in hand at check time, computed with the
-- same helper (supabase/functions/commerce-watch-refresh/receiptProcessing.ts
-- hashPushToken) used when the row below was created.
--
-- WHY A NEW TABLE RATHER THAN REUSING user_device_push_tokens. A receipt is a
-- fact about ONE SEND, not about a device route -- a route can accumulate many
-- receipts (one per push) over its life, and a route's own row must not carry
-- transient per-send bookkeeping (attempt counts, retry timestamps) mixed into
-- its identity/registration state. No other governed table in this schema
-- already shapes "one row per outbound send, keyed by an opaque vendor
-- ticket id" -- this is genuinely new state, not a duplicate of existing
-- infrastructure.
--
-- SCOPE. Backend-only, service-role-only (§20). Clients never read Expo
-- receipt/ticket ids -- they have no use for them, and RLS is enabled with
-- zero policies so even a future policy-authoring mistake defaults closed
-- rather than exposing rows.
--
-- MIGRATION GOVERNANCE (§21). Inspected supabase/migrations/ lineage before
-- authoring this file: the only open migration-provenance issue on record
-- (supabase/migrations/ACCOUNT_DELETION_MIGRATION_DIVERGENCE.md) is scoped to
-- account-deletion migrations, explicitly out of N-4's reach, and does not
-- touch this table's dependencies (user_device_push_tokens,
-- user_commerce_watches). `node scripts/check-migration-version-collisions.js`
-- passes clean on the base authority before this file is added, and this
-- file's version prefix (20260909115726) is newer than every existing
-- migration and collides with none. No pre-existing Watchlist
-- migration-ordering defect was found that this addition would conceal or
-- depend on.

create table if not exists public.watchlist_push_receipts (
  id                    uuid primary key default gen_random_uuid(),
  ticket_id             text not null,
  token_row_id          uuid not null references public.user_device_push_tokens(id) on delete cascade,
  token_fingerprint     text not null,
  user_id               uuid not null references auth.users(id) on delete cascade,

  -- Bounded terminal-state machine (§12, §17). 'pending' covers both "Expo
  -- has no verdict yet" and "last attempt was a transient/rate-limited
  -- failure with retry budget remaining" -- both retry identically. Every
  -- other value is terminal: no further check is ever scheduled for it.
  state                 text not null default 'pending',
  -- Fine-grained reason for the CURRENT state, independent of the coarse
  -- state enum -- lets 'pending' distinguish "not yet available" from "was
  -- just told ProviderError" for observability without growing the state
  -- machine itself. Vocabulary matches the vendor's documented
  -- details.error values 1:1, plus the two states Expo's contract does not
  -- name (a ticket id absent from the response, and our own retry/age
  -- exhaustion).
  last_error_category  text,
  -- Populated only when state = 'device_not_registered'. Separates "what
  -- Expo told us" (state) from "what we did about it" (this column), which
  -- is what makes reprocessing the same receipt idempotent: a second pass
  -- over an already-terminal row changes neither.
  retirement_outcome    text,

  attempt_count         integer not null default 0,
  created_at            timestamptz not null default now(),
  -- Seeded 15 minutes out: Expo's own documented guidance is that a receipt
  -- is often available sooner but the service wants ~15 minutes before a
  -- first check is meaningful.
  next_check_at         timestamptz not null default (now() + interval '15 minutes'),
  updated_at            timestamptz not null default now(),

  constraint watchlist_push_receipts_state_enum check (
    state in ('pending', 'success', 'device_not_registered', 'terminal_other', 'expired')
  ),
  constraint watchlist_push_receipts_error_category_enum check (
    last_error_category is null or last_error_category in (
      'device_not_registered', 'transient_provider_failure', 'rate_limited',
      'payload_failure', 'credential_configuration_failure', 'developer_error',
      'unknown_malformed', 'not_yet_available', 'expired'
    )
  ),
  constraint watchlist_push_receipts_retirement_enum check (
    retirement_outcome is null or retirement_outcome in ('retired', 'skipped_stale')
  ),
  -- Bounded retry budget, enforced structurally rather than only in
  -- application code (§17: "no infinite pending receipt queue").
  constraint watchlist_push_receipts_attempt_bound check (attempt_count >= 0 and attempt_count <= 20),
  constraint watchlist_push_receipts_ticket_id_len check (char_length(ticket_id) between 1 and 200),
  constraint watchlist_push_receipts_fingerprint_len check (char_length(token_fingerprint) = 64)
);

comment on table public.watchlist_push_receipts is
  'N-4. Tracks one Expo push ticket id per outbound Watchlist send until its receipt resolves, so a permanently-dead device route can be retired. Backend/service-role only -- never exposes an Expo id to a client (§20). Stores a SHA-256 fingerprint of the push token that was sent to, never the raw token (§8), so retirement can be proven to apply to the exact token incarnation that failed and not to a device_id or user_id alone.';
comment on column public.watchlist_push_receipts.token_fingerprint is
  'SHA-256 hex digest of the exact push_token value this send used, computed by receiptProcessing.ts hashPushToken(). Never the raw token. A retirement is only performed when this still equals the fingerprint of the CURRENT push_token on token_row_id at the moment of the atomic conditional UPDATE -- the guard against the token-refresh and actor-transfer races.';
comment on column public.watchlist_push_receipts.token_row_id is
  'The user_device_push_tokens row this send targeted, by permanent row identity. A token refresh updates that row''s push_token column in place without changing its id, which is exactly why id alone is not a safe retirement key and must be paired with token_fingerprint.';

create unique index if not exists watchlist_push_receipts_ticket_uidx
  on public.watchlist_push_receipts (ticket_id);

comment on index public.watchlist_push_receipts_ticket_uidx is
  'Ticket creation must be idempotent: persisting the same ticket id twice (a retried write, a re-entrant call) must not create a second pending row.';

create index if not exists watchlist_push_receipts_due_idx
  on public.watchlist_push_receipts (next_check_at)
  where state = 'pending';

create index if not exists watchlist_push_receipts_token_row_idx
  on public.watchlist_push_receipts (token_row_id);

alter table public.watchlist_push_receipts enable row level security;

-- No policies for anon or authenticated, deliberately (§20): clients have no
-- legitimate use for an Expo ticket id and must never be able to enumerate
-- them. service_role bypasses RLS entirely, which is the only reader/writer
-- this table is designed to have.
revoke all on public.watchlist_push_receipts from anon, authenticated, public;
grant select, insert, update, delete on public.watchlist_push_receipts to service_role;
revoke truncate, references, trigger, maintain on public.watchlist_push_receipts
  from anon, authenticated, service_role;

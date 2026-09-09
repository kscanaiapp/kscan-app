-- F-03 History B fixture: the Watchlist state an EXISTING upgraded database
-- already carries before the repair migration is applied.
--
-- Seeds the exact rows §16 and §21 require to survive: Watchlist entries, an
-- active device route, a revoked device route (the N-6 "current device OFF" /
-- RP-104 / RP-109 shape), a second actor on a second device (multi-device and
-- actor isolation), and an N-4 receipt row bound to a specific token
-- incarnation by fingerprint.
--
-- Deliberately NOT seeded: any state that would activate anything. No cron
-- entry, no worker flag, no pending outbound push.

insert into auth.users (id, email, aud, role)
values
  ('a0000000-0000-4000-8000-000000000001', 'actor-a@f03.test', 'authenticated', 'authenticated'),
  ('b0000000-0000-4000-8000-000000000002', 'actor-b@f03.test', 'authenticated', 'authenticated');

-- ── Watchlist entries (must survive: §16 WATCHLIST_ROWS_PRESERVED) ────────
insert into public.user_commerce_watches
  (id, user_id, source, canonical_url, display_title, currency,
   initial_price_amount, current_price_amount, watch_intent, target_price_amount, push_enabled)
values
  ('11111111-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'scan', 'https://example.test/item/1', 'Actor A watched jacket', 'USD',
   180.00, 165.00, 'buy_under', 150.00, true),
  ('11111111-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'scan', 'https://example.test/item/2', 'Actor A watched boots', 'USD',
   90.00, 90.00, 'just_watching', null, false),
  ('11111111-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002',
   'scan', 'https://example.test/item/3', 'Actor B watched bag', 'USD',
   400.00, 380.00, 'buy_under', 350.00, true);

-- ── Push routes (must survive: §16 PUSH_ROUTE_ROWS_PRESERVED) ─────────────
--
--   route-1  actor A, device-1  LIVE      -- the deliverable route
--   route-2  actor A, device-2  REVOKED   -- N-6 current-device OFF / RP-109 logout
--   route-3  actor B, device-3  LIVE      -- multi-device, different actor
--   route-4  actor A, device-3  REVOKED   -- RP-104: A's route on a device that
--                                            changed hands to B, already retired
insert into public.user_device_push_tokens
  (id, user_id, push_token, platform, device_id, revoked_at, last_used_at, created_at, updated_at)
values
  ('22222222-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'ExponentPushToken[f03-actor-a-device-1]', 'ios', 'device-1',
   null, now(), now() - interval '10 days', now() - interval '10 days'),
  ('22222222-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'ExponentPushToken[f03-actor-a-device-2]', 'android', 'device-2',
   timestamptz '2026-09-01 00:00:00+00', now(), now() - interval '9 days', now() - interval '9 days'),
  ('22222222-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002',
   'ExponentPushToken[f03-actor-b-device-3]', 'ios', 'device-3',
   null, now(), now() - interval '8 days', now() - interval '8 days'),
  ('22222222-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001',
   'ExponentPushToken[f03-actor-a-device-3-old]', 'ios', 'device-3',
   timestamptz '2026-09-02 00:00:00+00', now(), now() - interval '8 days', now() - interval '8 days');

-- ── N-4 receipts (must survive: §16 RECEIPT_ROWS_PRESERVED) ───────────────
--
-- token_fingerprint is a SHA-256 of the delivery token, exactly as
-- commerce-watch-refresh/receiptProcessing.ts hashPushToken computes it. It is
-- captured here so the post-upgrade comparison can prove the fingerprint is
-- byte-identical afterwards (§21 item 20).
insert into public.watchlist_push_receipts
  (id, ticket_id, token_row_id, token_fingerprint, user_id, state, attempt_count)
values
  ('33333333-0000-4000-8000-000000000001', 'f03-ticket-pending-1',
   '22222222-0000-4000-8000-000000000001',
   encode(extensions.digest('ExponentPushToken[f03-actor-a-device-1]', 'sha256'), 'hex'),
   'a0000000-0000-4000-8000-000000000001', 'pending', 0),
  ('33333333-0000-4000-8000-000000000002', 'f03-ticket-dnr-1',
   '22222222-0000-4000-8000-000000000002',
   encode(extensions.digest('ExponentPushToken[f03-actor-a-device-2]', 'sha256'), 'hex'),
   'a0000000-0000-4000-8000-000000000001', 'device_not_registered', 1);

update public.watchlist_push_receipts
set retirement_outcome = 'retired', last_error_category = 'device_not_registered'
where id = '33333333-0000-4000-8000-000000000002';

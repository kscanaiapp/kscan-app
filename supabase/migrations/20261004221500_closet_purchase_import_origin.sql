-- Build 35 — Receipt & Purchase Intelligence V1.
--
-- WHAT: two additive changes, nothing else.
--
--   1. user_closet_items.origin accepts 'purchase_import' in addition to
--      'direct_intake' and 'recent_scan'. A Closet item the owner explicitly
--      confirmed from an order confirmation or receipt they reviewed is
--      mirrored as what it is, rather than being relabelled 'direct_intake'.
--      The CHECK is widened, never narrowed: every existing row already
--      satisfies the new constraint.
--
--   2. A per-actor provider limit row for the purchase-import-extract Edge
--      Function, so the extraction endpoint is bounded by the existing
--      reserve_provider_request authority (BLOCK-RPI-31) at a tighter limit
--      than the built-in default:
--        8 imports per rolling hour, 25 per day, 1 in flight, 60s reservation
--      Released (non-billable) attempts do not count against either limit.
--
-- WHAT THIS DOES NOT DO: it adds no column, stores no receipt, image, OCR
-- text, merchant, price or any purchase detail server-side (purchase
-- provenance stays on the device in V1), creates no table, grants nothing, and
-- touches no RLS policy.
--
-- DEPLOY ORDER: this must be applied before the client flag
-- EXPO_PUBLIC_RECEIPT_INTELLIGENCE_V1 is enabled in a build that also has
-- Closet cloud sync on. Until then a 'purchase_import' row would be refused by
-- the old CHECK and the sync engine would park it as a permanent failure. It
-- stays local and is not lost, but it is not mirrored.

alter table public.user_closet_items
  drop constraint if exists user_closet_items_origin_enum;

alter table public.user_closet_items
  add constraint user_closet_items_origin_enum
  check (origin in ('direct_intake', 'recent_scan', 'purchase_import'));

insert into public.provider_request_limits
  (function_name, provider_category, rolling_window_seconds, rolling_limit, daily_limit, concurrent_limit, reservation_ttl_seconds, cost_units)
values
  ('purchase-import-extract', 'vision_ai', 3600, 8, 25, 1, 60, 2)
on conflict (function_name) do nothing;

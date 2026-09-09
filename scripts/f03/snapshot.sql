-- F-03 data-preservation snapshot. Emits a stable, ordered, fully-qualified
-- text rendering of every Watchlist row whose survival §16 requires, so the
-- pre-upgrade and post-upgrade snapshots can be compared byte for byte.
-- revoked_at is included verbatim: a repair that "fixed" replay by retiring or
-- un-retiring a live route would change this text and fail the diff.
\pset tuples_only on
\pset format unaligned

select 'WATCH|' || id || '|' || user_id || '|' || display_title || '|' || currency
       || '|' || coalesce(current_price_amount::text,'-') || '|' || coalesce(watch_intent,'-')
       || '|' || coalesce(target_price_amount::text,'-') || '|' || coalesce(status,'-')
       || '|push_enabled=' || push_enabled::text || '|deleted_at=' || coalesce(deleted_at::text,'-')
from public.user_commerce_watches order by id;

select 'ROUTE|' || id || '|' || user_id || '|' || device_id || '|' || platform
       || '|token=' || push_token
       || '|revoked_at=' || coalesce(revoked_at::text,'LIVE')
from public.user_device_push_tokens order by id;

select 'RECEIPT|' || id || '|' || ticket_id || '|' || token_row_id || '|' || user_id
       || '|fingerprint=' || token_fingerprint
       || '|state=' || state
       || '|retirement_outcome=' || coalesce(retirement_outcome,'-')
       || '|last_error_category=' || coalesce(last_error_category,'-')
       || '|attempt_count=' || attempt_count::text
from public.watchlist_push_receipts order by id;

select 'COUNTS|watches=' || (select count(*) from public.user_commerce_watches)
       || '|routes=' || (select count(*) from public.user_device_push_tokens)
       || '|live_routes=' || (select count(*) from public.user_device_push_tokens where revoked_at is null)
       || '|receipts=' || (select count(*) from public.watchlist_push_receipts)
       || '|users=' || (select count(*) from auth.users);

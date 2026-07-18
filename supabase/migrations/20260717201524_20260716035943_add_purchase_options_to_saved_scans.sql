-- Additive purchase-option snapshot for Saved Scans.
--
-- Live commerce results returned by scan-identify are persisted alongside
-- catalog similarity matches so reopened Saved Scans can restore buy-now
-- options without re-running commerce providers.
--
-- This migration changes only public.saved_scans and preserves all existing
-- columns, including remote-media backing fields when they are present.
--
-- Created via `supabase migration new add_purchase_options_to_saved_scans`
-- after authoritative head 20260716000001_shared_room_memberships.

alter table public.saved_scans
  add column if not exists purchase_options jsonb
  not null
  default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.saved_scans'::regclass
      and conname = 'saved_scans_purchase_options_is_array'
  ) then
    alter table public.saved_scans
      add constraint saved_scans_purchase_options_is_array
      check (jsonb_typeof(purchase_options) = 'array');
  end if;
end
$$;

comment on column public.saved_scans.purchase_options is
  'Snapshot of live commerce purchase options returned by scan-identify. Kept distinct from products (catalog similarity matches). Empty array when no options were returned or for legacy rows.';
;

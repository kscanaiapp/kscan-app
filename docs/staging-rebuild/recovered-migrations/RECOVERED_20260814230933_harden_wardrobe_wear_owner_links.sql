-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260814230933
-- name: harden_wardrobe_wear_owner_links
-- statement_count: 9

-- Build 29 Closet V2 hostile-audit repair.
--
-- RLS scopes both wear tables by their denormalized user_id, but the original
-- foreign keys related rows by id alone. A caller could therefore stamp its
-- own user_id on a child row while pointing at another user's wear event (or
-- attach another user's Saved Look to its own event) if it learned the UUID.
-- Composite owner foreign keys make those states impossible below RLS.

begin;

-- PostgreSQL requires the referenced column pair to be unique. `id` remains
-- the primary identity; these indexes exist solely as composite FK arbiters.
create unique index if not exists wardrobe_wear_events_id_user_id_uidx
  on public.wardrobe_wear_events (id, user_id);

create unique index if not exists looks_id_user_id_uidx
  on public.looks (id, user_id);

-- Preserve the existing deletion behavior while binding the child owner to
-- the event owner. The legacy id-only FK remains in place as a redundant,
-- non-destructive guard; the composite FK is the constraint that enforces
-- actor ownership.
alter table public.wardrobe_wear_event_items
  add constraint wardrobe_wear_event_items_event_owner_fkey
  foreign key (wear_event_id, user_id)
  references public.wardrobe_wear_events (id, user_id)
  on delete cascade
  not valid;

alter table public.wardrobe_wear_event_items
  validate constraint wardrobe_wear_event_items_event_owner_fkey;

-- PostgreSQL 17's column-subset SET NULL keeps the immutable event owner while
-- clearing only the optional live Saved Look link. saved_look_ref continues to
-- preserve the historical identity exactly as the original contract requires.
alter table public.wardrobe_wear_events
  add constraint wardrobe_wear_events_saved_look_owner_fkey
  foreign key (saved_look_id, user_id)
  references public.looks (id, user_id)
  on delete set null (saved_look_id)
  not valid;

alter table public.wardrobe_wear_events
  validate constraint wardrobe_wear_events_saved_look_owner_fkey;

-- Supports the reverse lookup PostgreSQL performs when a Saved Look is
-- deleted. The earlier (user_id, saved_look_id) index serves user history
-- reads but cannot efficiently answer a lookup starting with saved_look_id.
create index if not exists wardrobe_wear_events_saved_look_owner_idx
  on public.wardrobe_wear_events (saved_look_id, user_id)
  where saved_look_id is not null;

commit;

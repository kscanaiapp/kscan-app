-- Runtime pgTAP coverage for the Build 29 Closet V2 / S5 wear-history model.
-- The transaction is rolled back, so no fixture data persists.

begin;
select no_plan();

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000a1', 'wear-owner@example.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'wear-other@example.invalid');

insert into public.looks (id, user_id, title)
values ('20000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Monday Look');

-- ── Structure ───────────────────────────────────────────────────────────────

select has_table('public', 'wardrobe_wear_event_items', 'the relationship table exists');
select has_column('public', 'wardrobe_wear_events', 'saved_look_id', 'events carry an optional look');
select col_is_null(
  'public', 'wardrobe_wear_events', 'source_item_id',
  'source_item_id is nullable so an outfit-level wear need not elect one garment'
);

-- ── Identity constraint ─────────────────────────────────────────────────────

-- A wear that identifies neither a garment nor a look is meaningless.
select throws_ok(
  $$insert into public.wardrobe_wear_events (user_id, client_id, source_item_id, saved_look_id)
    values ('00000000-0000-0000-0000-0000000000a1', 'bad-1', null, null)$$,
  '23514',
  null,
  'an event with neither an item nor a look is rejected by the database'
);

-- Legacy single-item shape still accepted.
insert into public.wardrobe_wear_events (id, user_id, client_id, source_item_id, worn_at)
values (
  '30000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000a1',
  'wear:item:blazer:2026-08-14',
  'item-blazer',
  '2026-08-14T10:00:00Z'
);
select pass('a Build 28 shaped single-item event still inserts');

-- Outfit-level shape accepted with a null source item.
insert into public.wardrobe_wear_events
  (id, user_id, client_id, source_item_id, saved_look_id, saved_look_ref, worn_at)
values (
  '30000000-0000-0000-0000-0000000000c2',
  '00000000-0000-0000-0000-0000000000a1',
  'wear:saved_look:look1:2026-08-14',
  null,
  '20000000-0000-0000-0000-0000000000b1',
  '20000000-0000-0000-0000-0000000000b1',
  '2026-08-14T11:00:00Z'
);
select pass('an outfit-level event inserts with a null source_item_id');

-- ── One event, many garments ────────────────────────────────────────────────

insert into public.wardrobe_wear_event_items
  (user_id, wear_event_id, client_id, source_item_id, source_type, title_snapshot)
values
  ('00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000c2', 'k#blazer', 'item-blazer', 'saved_scan', 'Black blazer'),
  ('00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000c2', 'k#shirt',  'item-shirt',  'saved_scan', 'White shirt'),
  ('00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000c2', 'k#jeans',  'item-jeans',  'saved_scan', 'Jeans');

select is(
  (select count(*)::int from public.wardrobe_wear_event_items
     where wear_event_id = '30000000-0000-0000-0000-0000000000c2'),
  3,
  'one logical look wear holds three garment relationships'
);

select is(
  (select count(*)::int from public.wardrobe_wear_events
     where saved_look_id = '20000000-0000-0000-0000-0000000000b1'),
  1,
  'three garments did NOT become three top-level wear events'
);

-- ── Duplicate protection ────────────────────────────────────────────────────

select throws_ok(
  $$insert into public.wardrobe_wear_event_items
      (user_id, wear_event_id, client_id, source_item_id)
    values ('00000000-0000-0000-0000-0000000000a1',
            '30000000-0000-0000-0000-0000000000c2',
            'k#blazer-again', 'item-blazer')$$,
  '23505',
  null,
  'the same garment cannot be counted twice within one wear event'
);

-- A soft-deleted relationship must not block re-adding the garment later.
update public.wardrobe_wear_event_items
  set deleted_at = now()
  where wear_event_id = '30000000-0000-0000-0000-0000000000c2'
    and source_item_id = 'item-jeans';

insert into public.wardrobe_wear_event_items
  (user_id, wear_event_id, client_id, source_item_id)
values ('00000000-0000-0000-0000-0000000000a1',
        '30000000-0000-0000-0000-0000000000c2',
        'k#jeans-2', 'item-jeans');
select pass('a soft-deleted relationship does not permanently block the garment');

-- ── Historical stability ────────────────────────────────────────────────────

-- Deleting the Saved Look must not delete the record that it was worn.
delete from public.looks where id = '20000000-0000-0000-0000-0000000000b1';

select is(
  (select count(*)::int from public.wardrobe_wear_events
     where id = '30000000-0000-0000-0000-0000000000c2'),
  1,
  'deleting a Saved Look leaves the wear event standing'
);
select is(
  (select saved_look_id from public.wardrobe_wear_events
     where id = '30000000-0000-0000-0000-0000000000c2'),
  null,
  'the live FK is nulled, not cascaded'
);
select is(
  (select saved_look_ref from public.wardrobe_wear_events
     where id = '30000000-0000-0000-0000-0000000000c2'),
  '20000000-0000-0000-0000-0000000000b1',
  'the durable look reference survives so the event keeps its identity'
);
select is(
  (select count(*)::int from public.wardrobe_wear_event_items
     where wear_event_id = '30000000-0000-0000-0000-0000000000c2'
       and deleted_at is null),
  3,
  'the garments worn that day are still recorded after the look is deleted'
);
select is(
  (select title_snapshot from public.wardrobe_wear_event_items
     where wear_event_id = '30000000-0000-0000-0000-0000000000c2'
       and source_item_id = 'item-blazer'),
  'Black blazer',
  'the point-in-time title survives deletion of the source look'
);

-- ── Cascade on the event itself ─────────────────────────────────────────────

delete from public.wardrobe_wear_events where id = '30000000-0000-0000-0000-0000000000c1';
select is(
  (select count(*)::int from public.wardrobe_wear_events
     where id = '30000000-0000-0000-0000-0000000000c1'),
  0,
  'deleting an event removes it'
);

-- ── RLS + privileges ────────────────────────────────────────────────────────

select is(
  (select relrowsecurity from pg_class where oid = 'public.wardrobe_wear_event_items'::regclass),
  true,
  'row level security is enabled on the relationship table'
);

select is(
  (select count(*)::int from pg_policies
     where schemaname = 'public' and tablename = 'wardrobe_wear_event_items'),
  4,
  'select/insert/update/delete are each owner-scoped'
);

-- RLS alone yields 42501 in this project; the GRANT is load-bearing.
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_event_items', 'SELECT'),
  'authenticated holds SELECT'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_event_items', 'INSERT'),
  'authenticated holds INSERT'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_event_items', 'UPDATE'),
  'authenticated holds UPDATE'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_event_items', 'DELETE'),
  'authenticated holds DELETE'
);

-- The mirror of the GRANT above, and the one that regressed for real: applied
-- to staging, this table came up holding all four privileges for anon via that
-- database's ALTER DEFAULT PRIVILEGES. Asserting only SELECT would have let
-- three of the four back in, so every verb is named. has_table_privilege
-- resolves inherited PUBLIC grants too, which is the second route the REVOKE in
-- the migration closes.
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_event_items', 'SELECT'),
  'anonymous callers hold no read privilege on private wear history'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_event_items', 'INSERT'),
  'anonymous callers cannot write wear history'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_event_items', 'UPDATE'),
  'anonymous callers cannot alter wear history'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_event_items', 'DELETE'),
  'anonymous callers cannot erase wear history'
);

-- ── Account isolation ───────────────────────────────────────────────────────

delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select count(*)::int from public.wardrobe_wear_event_items
     where user_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'deleting the account cascades the wear relationships'
);

select * from finish();
rollback;

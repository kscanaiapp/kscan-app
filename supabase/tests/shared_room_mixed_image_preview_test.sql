-- Runtime pgTAP coverage for the composed public Dressing Room image contract.
-- All fixtures are transaction-scoped and rolled back.

begin;
select no_plan();

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000001', 'mixed-preview-owner@example.invalid');

insert into public.dressing_rooms (id, user_id, title)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Mixed room'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Inspiration room'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Scanned room'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Cap room'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'Other room'),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'Revoked room'),
  ('10000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'Expired room');

insert into public.room_shares (id, room_id, owner_id, share_token, is_active, revoked_at, expires_at)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', true, null, null),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', true, null, null),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000003', true, null, null),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000004', true, null, null),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000005', false, now(), null),
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000006', true, null, now() - interval '1 hour');

insert into public.dressing_room_items (
  id, dressing_room_id, created_by, source_type, snapshot_version, snapshot_payload,
  title, storage_bucket, storage_path, created_at
)
values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'live_scan', 1, '{}'::jsonb, 'Mixed scan newest', 'style-library-images', '00000000-0000-0000-0000-000000000001/scans/mixed-new.jpg', '2026-07-18T04:00:00Z'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'live_scan', 1, '{}'::jsonb, 'Mixed scan duplicate', 'style-library-images', '00000000-0000-0000-0000-000000000001/inspirations/shared-object.jpg', '2026-07-18T02:00:00Z'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'live_scan', 1, '{}'::jsonb, 'Scanned only', 'style-library-images', '00000000-0000-0000-0000-000000000001/scans/only.jpg', '2026-07-18T01:00:00Z');

insert into public.inspiration_items (
  id, user_id, storage_bucket, storage_path, source, content_type, width, height, created_at, deleted_at
)
values
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'style-library-images', '00000000-0000-0000-0000-000000000001/inspirations/mixed.jpg', 'upload', 'image/jpeg', 1200, 1600, '2026-07-18T03:00:00Z', null),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'style-library-images', '00000000-0000-0000-0000-000000000001/inspirations/shared-object.jpg', 'upload', 'image/jpeg', 1200, 1600, '2026-07-18T05:00:00Z', null),
  ('40000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'style-library-images', '00000000-0000-0000-0000-000000000001/inspirations/only.jpg', 'upload', 'image/jpeg', 1200, 1600, '2026-07-18T01:00:00Z', null),
  ('40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'style-library-images', '00000000-0000-0000-0000-000000000001/inspirations/deleted.jpg', 'upload', 'image/jpeg', 1200, 1600, '2026-07-18T06:00:00Z', now()),
  ('40000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'style-library-images', '00000000-0000-0000-0000-000000000001/inspirations/detached.jpg', 'upload', 'image/jpeg', 1200, 1600, '2026-07-18T07:00:00Z', null),
  ('40000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'style-library-images', '00000000-0000-0000-0000-000000000001/inspirations/other-room.jpg', 'upload', 'image/jpeg', 1200, 1600, '2026-07-18T08:00:00Z', null);

insert into public.dressing_room_inspiration_items (
  id, room_id, inspiration_id, user_id, created_at, deleted_at
)
values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '2026-07-18T03:00:00Z', null),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '2026-07-18T05:00:00Z', null),
  ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '2026-07-18T01:00:00Z', null),
  ('50000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '2026-07-18T06:00:00Z', null),
  ('50000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '2026-07-18T07:00:00Z', now()),
  ('50000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', '2026-07-18T08:00:00Z', null);

insert into public.dressing_room_items (
  id, dressing_room_id, created_by, source_type, snapshot_version, snapshot_payload,
  title, storage_bucket, storage_path, created_at
)
select
  ('31000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  '10000000-0000-0000-0000-000000000004'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'live_scan', 1, '{}'::jsonb, 'Cap scan ' || n,
  'style-library-images',
  '00000000-0000-0000-0000-000000000001/scans/cap-scan-' || n || '.jpg',
  '2026-07-17T00:00:00Z'::timestamptz + n * interval '1 minute'
from generate_series(1, 12) n;

insert into public.inspiration_items (
  id, user_id, storage_bucket, storage_path, source, content_type, created_at
)
select
  ('41000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'style-library-images',
  '00000000-0000-0000-0000-000000000001/inspirations/cap-inspiration-' || n || '.jpg',
  'upload', 'image/jpeg',
  '2026-07-17T01:00:00Z'::timestamptz + n * interval '1 minute'
from generate_series(1, 13) n;

insert into public.dressing_room_inspiration_items (id, room_id, inspiration_id, user_id, created_at)
select
  ('51000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  '10000000-0000-0000-0000-000000000004'::uuid,
  ('41000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  '2026-07-17T01:00:00Z'::timestamptz + n * interval '1 minute'
from generate_series(1, 13) n;

create temporary table mixed_preview as
select public.get_public_room_preview('60000000-0000-0000-0000-000000000001') as value;

select is((select value ->> 'status' from mixed_preview), 'available', 'mixed room is available');
select is((select (value ->> 'itemCount')::integer from mixed_preview), 3, 'mixed room includes both domains and suppresses duplicate media');
select is((select jsonb_array_length(value -> 'items') from mixed_preview), 3, 'mixed room returns three normalized cards');
select is(
  (select string_agg(item ->> 'sourceType', ',' order by ordinal)
   from mixed_preview cross join lateral jsonb_array_elements(value -> 'items') with ordinality as x(item, ordinal)),
  'dressing_room_item,inspiration_item,dressing_room_item',
  'combined ordering is deterministic by timestamp across domains'
);
select is(
  (select count(*) from mixed_preview cross join lateral jsonb_array_elements(value -> 'items') item
   where item ->> 'sourceId' = '40000000-0000-0000-0000-000000000002'),
  0::bigint,
  'duplicate underlying inspiration is suppressed in favor of scanned record'
);
select ok(
  (select bool_and(item ? 'sourceId' and item ? 'sourceType' and item ? 'id')
   from mixed_preview cross join lateral jsonb_array_elements(value -> 'items') item),
  'every result has normalized typed identity plus legacy id alias'
);
select ok(
  (select bool_and((item -> 'imageStorageBucket') = 'null'::jsonb and (item -> 'imageStoragePath') = 'null'::jsonb)
   from mixed_preview cross join lateral jsonb_array_elements(value -> 'items') item),
  'private storage coordinates are never exposed'
);
select is(
  (select count(*) from mixed_preview cross join lateral jsonb_array_elements(value -> 'items') item
   where item ->> 'sourceId' in (
     '40000000-0000-0000-0000-000000000004',
     '40000000-0000-0000-0000-000000000005',
     '40000000-0000-0000-0000-000000000006'
   )),
  0::bigint,
  'deleted, detached, and other-room inspirations are excluded'
);

select is(
  (public.get_public_room_preview('60000000-0000-0000-0000-000000000002') ->> 'itemCount')::integer,
  1,
  'inspiration-only room is represented'
);
select is(
  public.get_public_room_preview('60000000-0000-0000-0000-000000000002') #>> '{items,0,sourceType}',
  'inspiration_item',
  'inspiration-only card has inspiration source type'
);
select is(
  (public.get_public_room_preview('60000000-0000-0000-0000-000000000003') ->> 'itemCount')::integer,
  1,
  'scanned-only legacy room is unchanged'
);
select is(
  public.get_public_room_preview('60000000-0000-0000-0000-000000000003') #>> '{items,0,sourceType}',
  'dressing_room_item',
  'scanned-only card has dressing-room source type'
);

select is(
  (public.get_public_room_preview('60000000-0000-0000-0000-000000000004') ->> 'itemCount')::integer,
  25,
  'combined count spans both tables before the cap'
);
select is(
  jsonb_array_length(public.get_public_room_preview('60000000-0000-0000-0000-000000000004') -> 'items'),
  24,
  'one 24-item cap applies to the combined ordered set'
);
select is(
  (public.get_public_room_preview('60000000-0000-0000-0000-000000000004') ->> 'isCapped')::boolean,
  true,
  'combined overflow is reported as capped'
);
select is(
  public.get_public_room_preview('60000000-0000-0000-0000-000000000004') ->> 'nextCursor',
  null::text,
  'legacy no-cursor pagination contract remains unchanged'
);

select is(
  public.get_public_room_preview('not-a-token'),
  jsonb_build_object('status', 'malformed'),
  'malformed token is rejected'
);
select is(
  public.get_public_room_preview('60000000-0000-0000-0000-000000000005'),
  jsonb_build_object('status', 'unavailable'),
  'revoked share is unavailable'
);
select is(
  public.get_public_room_preview('60000000-0000-0000-0000-000000000006'),
  jsonb_build_object('status', 'unavailable'),
  'expired share is unavailable'
);

select * from finish();
rollback;

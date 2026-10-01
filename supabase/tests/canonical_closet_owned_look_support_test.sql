-- Build 34 / Repair 04 staging database contract.
-- Transactional fixtures only: every row and hard-delete is rolled back.

begin;
select no_plan();

insert into auth.users (id, email)
values
  ('10000000-0000-4000-8000-000000000001', 'repair04-a@example.invalid'),
  ('10000000-0000-4000-8000-000000000002', 'repair04-b@example.invalid'),
  ('10000000-0000-4000-8000-000000000003', 'repair04-no-kplus@example.invalid');

insert into public.user_entitlements (
  user_id, entitlement_key, status, grant_reason, expires_at
)
values
  ('10000000-0000-4000-8000-000000000001', 'k_plus', 'active', 'staff', now() + interval '1 day'),
  ('10000000-0000-4000-8000-000000000002', 'k_plus', 'active', 'staff', now() + interval '1 day');

-- Seed actor A through the real authenticated + K+ RLS path.
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into public.user_closet_items (
  id, user_id, client_id, title, category, clothing_type, subtype,
  brand, primary_color, secondary_colors, material, schema_version, deleted_at
)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'repair04-a-1', 'White hoodie', 'Tops', 'Hoodie', 'Pullover hoodie',
    'QA', 'White', array['Silver'], array['Cotton'], 1, null
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'repair04-a-2', 'Blue jeans', 'Bottoms', 'Jeans', 'Straight-leg jeans',
    'QA', 'Blue', '{}'::text[], array['Denim'], 1, null
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'repair04-a-deleted', 'Deleted gown', 'Dresses', 'Gown', null,
    null, 'White', '{}'::text[], array['Silk'], 1, now()
  );

reset role;

-- Actor B owns the foreign row.
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into public.user_closet_items (
  id, user_id, client_id, title, category, clothing_type, schema_version
)
values (
  '20000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000002',
  'repair04-b-1', 'Foreign sneakers', 'Shoes', 'Sneakers', 1
);
reset role;

-- Seed two rows for an actor without K+ under service role. The rows model a
-- lapsed entitlement: data may remain, but it must not become readable/styleable.
set local role service_role;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-000000000003","role":"service_role"}';
insert into public.user_closet_items (
  id, user_id, client_id, title, category, clothing_type, schema_version
)
values
  (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000003',
    'repair04-c-1', 'Lapsed top', 'Tops', 'Top', 1
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000003',
    'repair04-c-2', 'Lapsed shoes', 'Shoes', 'Sneakers', 1
  );
reset role;

-- Legacy fixtures remain first-class regression inputs.
insert into public.saved_scans (
  id, user_id, title, analysis_result, products, source
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Legacy top', '{"metadata":{"category":"Top"}}', '[]', 'mobile'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'Legacy shoes', '{"metadata":{"category":"Shoes"}}', '[]', 'mobile'
  );

insert into public.inspiration_items (
  id, user_id, storage_bucket, storage_path, source, note
)
values
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'style-library-images',
    '10000000-0000-4000-8000-000000000001/inspirations/repair04-1.jpg',
    'upload', 'Legacy inspiration one'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'style-library-images',
    '10000000-0000-4000-8000-000000000001/inspirations/repair04-2.jpg',
    'upload', 'Legacy inspiration two'
  );

-- Constraint and ACL shape.
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.look_items'::regclass
      and conname = 'look_items_source_type_check'
      and pg_get_constraintdef(oid) like '%closet_item%'
  ),
  'source_type constraint accepts the closed closet_item literal'
);

select fk_ok(
  'public', 'look_items', 'source_closet_item_id',
  'public', 'user_closet_items', 'id',
  'source_closet_item_id references canonical Closet'
);

select ok(
  not has_function_privilege('anon', 'public.build_owned_item_snapshot(text,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.build_owned_item_snapshot(text,uuid,uuid)', 'EXECUTE'),
  'internal snapshot helper is not Data API executable'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.create_look_from_owned_items(text,text,text,text,text,text,text,text,text,text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.update_look_owned_items(uuid,text,text,text,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated retains create/update RPC execution only'
);

-- Helper behavior is tested as postgres while auth.uid() is still actor A;
-- ordinary authenticated callers cannot invoke this internal function.
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  public.build_owned_item_snapshot(
    'closet_item',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001'
  ) ->> 'sourceType',
  'closet_item',
  'own active canonical snapshot succeeds'
);

select is(
  public.build_owned_item_snapshot(
    'closet_item',
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000002'
  ),
  null,
  'foreign canonical snapshot returns NULL'
);

select is(
  public.build_owned_item_snapshot(
    'closet_item',
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001'
  ),
  null,
  'deleted canonical snapshot returns NULL'
);

create temporary table repair04_looks (kind text primary key, id uuid not null);
grant select, insert, update, delete on repair04_looks to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into repair04_looks(kind, id)
select 'canonical', (public.create_look_from_owned_items(
  'Canonical QA', null, 'ai', null, null, null, null,
  'Canonical outfit', '1', '1',
  '[{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000001","role":"top"},{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000002","role":"bottom"}]'::jsonb
)).id;

select is(
  (
    select count(*)::int from public.look_items li
    join repair04_looks q on q.id = li.look_id and q.kind = 'canonical'
    where li.source_type = 'closet_item'
      and li.source_closet_item_id is not null
      and li.source_saved_scan_id is null
      and li.source_inspiration_item_id is null
      and li.snapshot_payload ->> 'sourceType' = 'closet_item'
  ),
  2,
  'create persists canonical FK shape and bounded snapshots'
);

insert into repair04_looks(kind, id)
select 'mixed', (public.create_look_from_owned_items(
  'Mixed QA', null, 'manual', null, null, null, null,
  null, null, null,
  '[{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000001"},{"sourceType":"saved_scan","sourceId":"30000000-0000-4000-8000-000000000001"}]'::jsonb
)).id;

select lives_ok(
  $$ select public.update_look_owned_items(
    (select id from repair04_looks where kind = 'canonical'),
    'Canonical QA edited', null, null, null, null, null,
    '[{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000002","role":"bottom"},{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000001","role":"top"}]'::jsonb
  ) $$,
  'update Look with canonical items succeeds without source conversion'
);

select throws_ok(
  $$ select public.create_look_from_owned_items(
    'Duplicate QA', null, 'manual', null, null, null, null, null, null, null,
    '[{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000001"},{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000001"}]'::jsonb
  ) $$,
  '22023',
  'Duplicate items are not allowed in a Look',
  'duplicate canonical refs are rejected'
);

select throws_ok(
  $$ select public.create_look_from_owned_items(
    'Foreign QA', null, 'manual', null, null, null, null, null, null, null,
    '[{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000001"},{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000004"}]'::jsonb
  ) $$,
  '42501',
  'One or more selected items are unavailable',
  'foreign canonical ref is rejected'
);

insert into repair04_looks(kind, id)
select 'saved', (public.create_look_from_owned_items(
  'Legacy saved QA', null, 'manual', null, null, null, null, null, null, null,
  '[{"sourceType":"saved_scan","sourceId":"30000000-0000-4000-8000-000000000001"},{"sourceType":"saved_scan","sourceId":"30000000-0000-4000-8000-000000000002"}]'::jsonb
)).id;

select lives_ok(
  $$ select public.update_look_owned_items(
    (select id from repair04_looks where kind = 'saved'),
    'Legacy saved QA edited', null, null, null, null, null,
    '[{"sourceType":"saved_scan","sourceId":"30000000-0000-4000-8000-000000000002"},{"sourceType":"saved_scan","sourceId":"30000000-0000-4000-8000-000000000001"}]'::jsonb
  ) $$,
  'legacy saved_scan create/update still succeeds'
);

insert into repair04_looks(kind, id)
select 'inspiration', (public.create_look_from_owned_items(
  'Legacy inspiration QA', null, 'manual', null, null, null, null, null, null, null,
  '[{"sourceType":"inspiration_item","sourceId":"40000000-0000-4000-8000-000000000001"},{"sourceType":"inspiration_item","sourceId":"40000000-0000-4000-8000-000000000002"}]'::jsonb
)).id;

select lives_ok(
  $$ select public.update_look_owned_items(
    (select id from repair04_looks where kind = 'inspiration'),
    'Legacy inspiration QA edited', null, null, null, null, null,
    '[{"sourceType":"inspiration_item","sourceId":"40000000-0000-4000-8000-000000000002"},{"sourceType":"inspiration_item","sourceId":"40000000-0000-4000-8000-000000000001"}]'::jsonb
  ) $$,
  'legacy inspiration create/update still succeeds'
);

reset role;

select throws_ok(
  $$ update public.look_items
       set source_type = 'arbitrary_source'
       where look_id = (select id from repair04_looks where kind = 'canonical') $$,
  '23514',
  null,
  'arbitrary source_type remains rejected'
);

select throws_ok(
  $$ update public.look_items
       set source_saved_scan_id = '30000000-0000-4000-8000-000000000001'
       where look_id = (select id from repair04_looks where kind = 'canonical')
         and source_closet_item_id is not null $$,
  '23514',
  null,
  'single-owned-source invariant rejects multiple source FKs'
);

-- Physical source deletion is staging-only and rolled back. The nullable FK is
-- cleared while the v2 snapshot stays renderable.
delete from public.user_closet_items
where id = '20000000-0000-4000-8000-000000000001';

select ok(
  exists (
    select 1 from public.look_items li
    join repair04_looks q on q.id = li.look_id and q.kind = 'canonical'
    where li.source_closet_item_id is null
      and li.snapshot_payload ->> 'sourceType' = 'closet_item'
      and li.snapshot_payload ->> 'title' = 'White hoodie'
  ),
  'source deletion clears FK but preserves renderable snapshot payload'
);

-- A lapsed/non-entitled actor can neither see their retained canonical rows
-- through RLS nor route around RLS through the owned-Look RPC.
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  (select count(*)::int from public.user_closet_items where user_id = auth.uid()),
  0,
  'non-K+ actor cannot read retained canonical Closet rows'
);

select throws_ok(
  $$ select public.create_look_from_owned_items(
    'No K+ QA', null, 'manual', null, null, null, null, null, null, null,
    '[{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000005"},{"sourceType":"closet_item","sourceId":"20000000-0000-4000-8000-000000000006"}]'::jsonb
  ) $$,
  '42501',
  'One or more selected items are unavailable',
  'owned-Look RPC does not bypass the canonical K+ boundary'
);

reset role;

-- `true` makes pgTAP raise if any assertion failed, so remote `db query`
-- cannot return a false-green exit code while only showing the final result set.
select * from finish(true);
rollback;

-- B34-SEC-001 — behavioural coverage for public.get_item_reaction_counts().
-- The transaction is rolled back, so no fixture data persists.
--
-- Run against the pre-fix predicate, assertions 1 and 2 fail: the outsider and
-- the removed member both read counts. Assertion 3 passed pre-fix too — the
-- block check was already there, which is precisely why removal standing open
-- was easy to miss. Verified by restoring the pre-fix body inside a rolled-back
-- transaction on staging: outsider leaked true, blocked participant leaked
-- false. So this suite is a real regression guard, not a restatement of the code.

begin;
select no_plan();

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000a1', 'b34sec001-owner@example.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'b34sec001-outsider@example.invalid'),
  ('00000000-0000-0000-0000-0000000000a3', 'b34sec001-recipient@example.invalid');

insert into public.dressing_rooms (id, user_id, title)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'B34-SEC-001 room');

insert into public.dressing_room_items (id, dressing_room_id, snapshot_payload, title)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', '{}'::jsonb, 'Item');

insert into public.room_shares (id, room_id, owner_id, share_token, is_active)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1',
        '00000000-0000-0000-0000-0000000000a1', 'b34sec001-token', true);

insert into public.dressing_room_item_reactions (item_id, user_id, reaction_type)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'like');

-- ── the two leak paths ──────────────────────────────────────────────────────

-- 1. authenticated outsider: never a recipient, holds the item id only.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'authenticated outsider reads no reaction counts'
);
reset role; reset request.jwt.claims;

-- 2. removed member: held access once, so legitimately retains the item id.
insert into public.shared_room_memberships (share_id, recipient_user_id, removed_at)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3', now());
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'removed member reads no reaction counts'
);
reset role; reset request.jwt.claims;
delete from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-0000000000a3';

-- 3. blocked participant stays excluded (20260902130000 must not regress).
insert into public.dressing_room_participants (dressing_room_id, user_id, joined_via_share_id)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3',
        '00000000-0000-0000-0000-0000000000d1');
insert into public.dressing_room_user_blocks (blocker_user_id, blocked_user_id)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'blocked participant reads no reaction counts'
);
reset role; reset request.jwt.claims;
delete from public.dressing_room_user_blocks where blocked_user_id = '00000000-0000-0000-0000-0000000000a3';

-- ── the legitimate readers, which must keep working ─────────────────────────

-- 4. active participant (join_room_via_share_token model).
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select isnt_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'active participant still reads reaction counts'
);
reset role; reset request.jwt.claims;
delete from public.dressing_room_participants where user_id = '00000000-0000-0000-0000-0000000000a3';

-- 5. active membership (save_shared_room_for_me model).
insert into public.shared_room_memberships (share_id, recipient_user_id)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select isnt_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'active membership still reads reaction counts'
);
reset role; reset request.jwt.claims;

-- 6. owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select isnt_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'room owner still reads reaction counts'
);
reset role; reset request.jwt.claims;

-- 7. anonymous public preview is deliberately preserved: the share link is the
--    capability. app/(public)/rooms/[token].tsx depends on this.
set local role anon;
set local request.jwt.claims = '';
select isnt_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'anonymous public preview still reads reaction counts while the share is live'
);
reset role; reset request.jwt.claims;

-- 8. and it closes with the share, which is the bound that makes 7 acceptable.
update public.room_shares set is_active = false, revoked_at = now()
where id = '00000000-0000-0000-0000-0000000000d1';
set local role anon;
set local request.jwt.claims = '';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'revoking the share ends anonymous public preview access'
);
reset role; reset request.jwt.claims;

select * from finish();
rollback;

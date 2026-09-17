-- B34-SEC-003 — behavioural coverage for public.get_item_reaction_counts().
-- The transaction is rolled back, so no fixture data persists.
--
-- Scenarios 1-6 restate #431's coverage (the authenticated non-owner leak) so
-- a later edit cannot silently reopen it. Scenarios 7-11 are new: they prove
-- the anonymous branch is bound to the SPECIFIC live share token, not to "this
-- room has a live share" -- including the exact bypass this migration closes,
-- where a removed member (or an unrelated authenticated account) simply omits
-- their JWT and, pre-fix, would have been re-admitted by the token-less
-- anonymous branch as long as the room carried any live share.

begin;
select no_plan();

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000a1', 'b34sec003-owner@example.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'b34sec003-outsider@example.invalid'),
  ('00000000-0000-0000-0000-0000000000a3', 'b34sec003-recipient@example.invalid');

insert into public.dressing_rooms (id, user_id, title)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'B34-SEC-003 room');

insert into public.dressing_room_items (id, dressing_room_id, snapshot_payload, title)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', '{}'::jsonb, 'Item');

insert into public.room_shares (id, room_id, owner_id, share_token, is_active)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1',
        '00000000-0000-0000-0000-0000000000a1', 'b34sec003-live-token', true);

insert into public.dressing_room_item_reactions (item_id, user_id, reaction_type)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'like');

-- ── #431 coverage restated: authenticated leak paths stay closed ───────────

-- 1. authenticated outsider: never a recipient, holds the item id only.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'authenticated outsider reads no reaction counts'
);
reset role; reset request.jwt.claims;

-- 2. removed member, WITH their JWT: held access once, legitimately retains
--    the item id, but removal must end access.
insert into public.shared_room_memberships (share_id, recipient_user_id, removed_at)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3', now());
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'removed member reads no reaction counts while presenting their JWT'
);
reset role; reset request.jwt.claims;

-- ── the bypass this migration closes ────────────────────────────────────────

-- 3. THE BYPASS: the same removed member, now WITHOUT a JWT (auth.uid() is
--    null) and WITHOUT the room's share token -- only the item id, which they
--    still hold from before removal. Pre-fix, the anonymous branch admitted
--    any caller once the room had any live share at all, so this returned
--    counts. It must not.
set local role anon;
set local request.jwt.claims = '';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'BYPASS CLOSED: removed member cannot regain access by dropping their JWT and omitting the share token'
);
reset role; reset request.jwt.claims;

-- 4. same bypass attempt, this time WITH a token -- but a foreign one that
--    does not belong to this room. Must still fail.
set local role anon;
set local request.jwt.claims = '';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(
       array['00000000-0000-0000-0000-0000000000c1'::uuid],
       'not-this-rooms-token'
     ) $$,
  'a token that does not match this room''s live share grants nothing'
);
reset role; reset request.jwt.claims;

delete from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-0000000000a3';

-- 5. blocked participant stays excluded (20260902130000 must not regress).
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

-- 6. active participant (join_room_via_share_token model).
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select isnt_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'active participant still reads reaction counts'
);
reset role; reset request.jwt.claims;
delete from public.dressing_room_participants where user_id = '00000000-0000-0000-0000-0000000000a3';

-- 7. active membership (save_shared_room_for_me model).
insert into public.shared_room_memberships (share_id, recipient_user_id)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select isnt_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'active membership still reads reaction counts'
);
reset role; reset request.jwt.claims;

-- 8. owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select isnt_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'room owner still reads reaction counts'
);
reset role; reset request.jwt.claims;

-- 9. anonymous public preview presenting the CORRECT live share token: the
--    actual capability the public-share surface grants, unchanged.
set local role anon;
set local request.jwt.claims = '';
select isnt_empty(
  $$ select 1 from public.get_item_reaction_counts(
       array['00000000-0000-0000-0000-0000000000c1'::uuid],
       'b34sec003-live-token'
     ) $$,
  'anonymous caller presenting this room''s live share token still reads reaction counts'
);
reset role; reset request.jwt.claims;

-- 10. anonymous, correct token, but the share has since been revoked: closes
--     with the share, which is the bound that makes 9 acceptable.
update public.room_shares set is_active = false, revoked_at = now()
where id = '00000000-0000-0000-0000-0000000000d1';
set local role anon;
set local request.jwt.claims = '';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(
       array['00000000-0000-0000-0000-0000000000c1'::uuid],
       'b34sec003-live-token'
     ) $$,
  'revoking the share ends anonymous access even with the previously-valid token'
);
reset role; reset request.jwt.claims;
update public.room_shares set is_active = true, revoked_at = null
where id = '00000000-0000-0000-0000-0000000000d1';

-- 11. anonymous, no token at all, share otherwise live: must fail. This is
--     the control that proves scenario 3 is not merely a coincidence of the
--     item id -- token-less anonymous access is refused unconditionally now,
--     not just for a caller who used to be a member.
set local role anon;
set local request.jwt.claims = '';
select is_empty(
  $$ select 1 from public.get_item_reaction_counts(array['00000000-0000-0000-0000-0000000000c1'::uuid]) $$,
  'anonymous caller with no share token at all reads nothing, even while the room has a live share'
);
reset role; reset request.jwt.claims;

select * from finish();
rollback;

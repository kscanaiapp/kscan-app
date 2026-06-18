-- KS-REL-005E follow-up
-- Ensure StyleChat messages are scoped to the authenticated user's own session,
-- not only to the message row's user_id.

drop policy if exists "Users read own messages" on public.style_chat_messages;
drop policy if exists "Users insert own messages" on public.style_chat_messages;

create policy "Users read own messages"
on public.style_chat_messages
for select
to authenticated
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.style_chat_sessions scs
    where scs.id = style_chat_messages.session_id
      and scs.user_id = auth.uid()
  )
);

create policy "Users insert own messages"
on public.style_chat_messages
for insert
to authenticated
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.style_chat_sessions scs
    where scs.id = style_chat_messages.session_id
      and scs.user_id = auth.uid()
  )
);

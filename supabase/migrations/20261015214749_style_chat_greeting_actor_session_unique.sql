-- EL-014 / #592: process-local greeting insertion locks cannot serialize two
-- devices. Keep the existing actor/session RLS and source-message index intact.
-- This additive index alone arbitrates assistant greeting insertion. A dirty
-- legacy duplicate group makes CREATE UNIQUE INDEX fail; never delete/rewrite
-- conversation history merely to make the migration pass.
-- Generated using Supabase CLI 2.109.1:
-- supabase migration new style_chat_greeting_actor_session_unique
create unique index style_chat_one_assistant_greeting_per_actor_session
  on public.style_chat_messages (user_id, session_id)
  where sender = 'assistant'
    and ui_blocks @> '[{"type":"greeting"}]'::jsonb;

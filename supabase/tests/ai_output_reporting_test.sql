-- GP-006 runtime pgTAP coverage for the in-app AI-output report contract.
-- Every fixture is rolled back; this test never mutates production data.

begin;
select no_plan();

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000006001', 'ai-report-reporter@example.invalid'),
  ('00000000-0000-0000-0000-000000006002', 'ai-report-other-user@example.invalid');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.content_reports'::regclass),
  'content_reports keeps RLS enabled for AI-output reports'
);

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'content_reports'
     and grantee = 'anon'),
  0::bigint,
  'anon has no content_reports privileges'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000006001', true);
select lives_ok(
  $$insert into public.content_reports (target_type, target_id, reason_category, ai_output_context)
    values (
      'ai_output',
      'assistant-message-6001',
      'other',
      '{"feature":"StyleChat","reason_detail":"incorrect_or_misleading","session_id":"session-6001","message_id":"assistant-message-6001"}'::jsonb
    )$$,
  'an authenticated user can create a legitimate AI-output report'
);

select throws_ok(
  $$insert into public.content_reports (reporter_user_id, target_type, target_id, reason_category, ai_output_context)
    values (
      '00000000-0000-0000-0000-000000006002',
      'ai_output',
      'assistant-message-forged',
      'other',
      '{"feature":"StyleChat","reason_detail":"other","message_id":"assistant-message-forged"}'::jsonb
    )$$,
  '42501',
  null,
  'an authenticated user cannot impersonate a different AI-report reporter'
);

select throws_ok(
  $$insert into public.content_reports (target_type, target_id, reason_category, ai_output_context)
    values (
      'ai_output',
      'assistant-message-invalid',
      'other',
      '{"feature":"StyleChat","reason_detail":"other","message_id":"assistant-message-invalid","raw_output":"must not persist"}'::jsonb
    )$$,
  '23514',
  null,
  'AI-output context rejects unapproved fields such as raw response text'
);

select throws_ok(
  $$select * from public.content_reports$$,
  '42501',
  null,
  'ordinary authenticated users cannot read moderation reports'
);

reset role;
select is(
  (select reporter_user_id from public.content_reports where target_id = 'assistant-message-6001'),
  '00000000-0000-0000-0000-000000006001'::uuid,
  'the reporter identity comes from auth.uid(), not client input'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000006001', true);
select lives_ok(
  $$insert into public.content_reports (target_type, target_id, reason_category)
    values ('message', 'message-non-ai-6001', 'inappropriate')$$,
  'existing non-AI message reporting remains valid'
);
reset role;

select * from finish();
rollback;

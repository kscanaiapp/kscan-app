-- GP-006: persist AI-response reports through the existing moderation log.
--
-- The context intentionally allows only feature and stable response/session/item
-- identifiers. It cannot carry raw response text, photos, scan media, or an
-- arbitrary client object. RLS remains insert-only for authenticated reporters;
-- moderation remains service-role/admin-only.

alter table public.content_reports
  drop constraint if exists content_reports_target_type_check;

alter table public.content_reports
  add column if not exists ai_output_context jsonb null;

alter table public.content_reports
  add constraint content_reports_target_type_check
    check (target_type in ('room', 'message', 'reaction', 'item', 'image', 'profile', 'user', 'ai_output'));

alter table public.content_reports
  add constraint content_reports_ai_output_context_check
    check (
      (
        target_type <> 'ai_output'
        and ai_output_context is null
      )
      or (
        target_type = 'ai_output'
        and jsonb_typeof(ai_output_context) = 'object'
        and ai_output_context - array['feature', 'reason_detail', 'session_id', 'message_id', 'item_id'] = '{}'::jsonb
        and jsonb_typeof(ai_output_context -> 'feature') = 'string'
        and ai_output_context ->> 'feature' in ('StyleChat', 'TextScan', 'Scan Results')
        and jsonb_typeof(ai_output_context -> 'reason_detail') = 'string'
        and ai_output_context ->> 'reason_detail' in (
          'offensive_or_inappropriate',
          'harmful_or_unsafe',
          'incorrect_or_misleading',
          'biased',
          'other'
        )
        and (
          not ai_output_context ? 'session_id'
          or (
            jsonb_typeof(ai_output_context -> 'session_id') = 'string'
            and length(ai_output_context ->> 'session_id') between 1 and 200
          )
        )
        and (
          not ai_output_context ? 'message_id'
          or (
            jsonb_typeof(ai_output_context -> 'message_id') = 'string'
            and length(ai_output_context ->> 'message_id') between 1 and 200
          )
        )
        and (
          not ai_output_context ? 'item_id'
          or (
            jsonb_typeof(ai_output_context -> 'item_id') = 'string'
            and length(ai_output_context ->> 'item_id') between 1 and 200
          )
        )
        and target_id = coalesce(
          nullif(ai_output_context ->> 'message_id', ''),
          nullif(ai_output_context ->> 'item_id', ''),
          nullif(ai_output_context ->> 'session_id', '')
        )
        and reported_user_id is null
        and room_id is null
        and (
          (ai_output_context ->> 'reason_detail' = 'offensive_or_inappropriate' and reason_category = 'offensive')
          or (ai_output_context ->> 'reason_detail' = 'harmful_or_unsafe' and reason_category = 'inappropriate')
          or (
            ai_output_context ->> 'reason_detail' in ('incorrect_or_misleading', 'biased', 'other')
            and reason_category = 'other'
          )
        )
      )
    );

comment on column public.content_reports.ai_output_context is
  'AI-output report metadata: feature, reason_detail, and optional stable session/message/item identifiers only. No raw response text, user image, or scan media is permitted.';

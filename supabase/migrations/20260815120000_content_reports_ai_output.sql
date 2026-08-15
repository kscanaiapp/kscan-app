-- KSB29-036 — AI-output reporting: reverse source/staging drift.
--
-- PRODUCTION ALREADY SERVES THIS. `content_reports.ai_output_context` and
-- `target_type = 'ai_output'` are live in production and the mobile client
-- writes them (services/reportAiOutput.ts -> services/contentReports.ts). But
-- no migration in this repository ever declared them, so a database built from
-- migration history — which is what App Staging is — rejects EVERY AI-output
-- report at content_reports_target_type_check. Production works; staging cannot
-- faithfully certify the feature that ships on it.
--
-- The defect is therefore source-of-truth drift, not an unwanted production
-- capability. This migration is a NEW FORWARD migration that makes the
-- repository state what production already is. Migration history is not
-- rewritten, and nothing is removed from production.
--
-- Verified against both projects on 2026-08-15 before writing:
--   production  (wyyuqfdxucjksghsmhry) : ai_output present, ai_output_context jsonb present
--   app staging (yzqjvdfgefveprobvvyw) : both absent
-- The constraint bodies below are transcribed from production's live
-- pg_get_constraintdef output, so applying this to staging converges it on
-- production rather than on a re-derived approximation.
--
-- Fully idempotent: safe to re-run, and a no-op against production.
--
-- KNOWN PRE-EXISTING GAP, DELIBERATELY REPRODUCED AS-IS: because the guard is a
-- CHECK, a row with target_type = 'ai_output' and ai_output_context IS NULL
-- evaluates to NULL rather than FALSE and is therefore admitted. The client
-- refuses that shape before it can be sent (submitContentReport returns
-- 'Invalid AI output report context.'), so it is not reachable from the app.
-- Closing it in the database is a behavioural change to a live production
-- constraint and belongs to its own governed change — reproducing production
-- exactly is this migration's whole purpose, so it is NOT tightened here.

begin;

-- 1. The context column.
alter table public.content_reports
  add column if not exists ai_output_context jsonb;

comment on column public.content_reports.ai_output_context is
  'Allowlisted identifier context for AI-output reports. Never raw model text, scan media, or user prose; the CHECK below rejects any key outside the allowlist.';

-- 2. Admit the 'ai_output' target type.
alter table public.content_reports
  drop constraint if exists content_reports_target_type_check;

alter table public.content_reports
  add constraint content_reports_target_type_check
  check (target_type in ('room', 'message', 'reaction', 'item', 'image', 'profile', 'user', 'ai_output'));

-- 3. The AI-output context contract.
--
-- This is what keeps an AI-output report a report rather than an open jsonb
-- column: the payload must be an object containing ONLY the five allowlisted
-- keys, `feature` and `reason_detail` must be governed enumerations,
-- target_id must equal whichever identifier the report is actually about, the
-- report may not carry a reported user or a room, and reason_category must
-- agree with reason_detail so the two cannot disagree about severity.
--
-- The `- ARRAY[...] = '{}'` form is the key allowlist: subtracting the
-- permitted keys must leave an empty object, so an unexpected key (raw prose,
-- an image URI, a token) fails rather than being silently stored.
alter table public.content_reports
  drop constraint if exists content_reports_ai_output_context_check;

alter table public.content_reports
  add constraint content_reports_ai_output_context_check
  check (
    (target_type <> 'ai_output' and ai_output_context is null)
    or (
      target_type = 'ai_output'
      and jsonb_typeof(ai_output_context) = 'object'
      and (ai_output_context - array['feature', 'reason_detail', 'session_id', 'message_id', 'item_id']) = '{}'::jsonb
      and jsonb_typeof(ai_output_context -> 'feature') = 'string'
      and (ai_output_context ->> 'feature') in ('StyleChat', 'TextScan', 'Scan Results')
      and jsonb_typeof(ai_output_context -> 'reason_detail') = 'string'
      and (ai_output_context ->> 'reason_detail') in (
        'offensive_or_inappropriate', 'harmful_or_unsafe', 'incorrect_or_misleading', 'biased', 'other'
      )
      and (
        not (ai_output_context ? 'session_id')
        or (
          jsonb_typeof(ai_output_context -> 'session_id') = 'string'
          and length(ai_output_context ->> 'session_id') between 1 and 200
        )
      )
      and (
        not (ai_output_context ? 'message_id')
        or (
          jsonb_typeof(ai_output_context -> 'message_id') = 'string'
          and length(ai_output_context ->> 'message_id') between 1 and 200
        )
      )
      and (
        not (ai_output_context ? 'item_id')
        or (
          jsonb_typeof(ai_output_context -> 'item_id') = 'string'
          and length(ai_output_context ->> 'item_id') between 1 and 200
        )
      )
      -- The report must be filed against the identifier it describes.
      and target_id = coalesce(
        nullif(ai_output_context ->> 'message_id', ''),
        nullif(ai_output_context ->> 'item_id', ''),
        nullif(ai_output_context ->> 'session_id', '')
      )
      -- An AI-output report is about a model response, never about a person or
      -- a room, so it may not carry either.
      and reported_user_id is null
      and room_id is null
      -- reason_category is derived from reason_detail by the client; pinning the
      -- mapping here stops the two from disagreeing.
      and (
        ((ai_output_context ->> 'reason_detail') = 'offensive_or_inappropriate' and reason_category = 'offensive')
        or ((ai_output_context ->> 'reason_detail') = 'harmful_or_unsafe' and reason_category = 'inappropriate')
        or ((ai_output_context ->> 'reason_detail') in ('incorrect_or_misleading', 'biased', 'other') and reason_category = 'other')
      )
    )
  );

commit;

-- Repair for Finding P2-9 (docs/audits/deletion-hostile-audit-findings-2026-07-22.md):
-- deletion_state_transitions.sanitized_metadata was "sanitized" by naming
-- convention only. append_deletion_state_transition stripped a fixed set of
-- sensitive KEYS ('email', 'token', ...), but nothing scrubbed sensitive
-- VALUES -- a caller passing {"note": "contact bob@example.com about ..."}
-- would persist that email into the surviving, append-only ledger.
--
-- This redefines the function (additive create-or-replace, no data change) to
-- also redact email-address-shaped substrings from the metadata before insert,
-- as defense-in-depth. The value scrub is done via a text round-trip: the
-- replacement token contains no quotes or backslashes, so the JSON stays valid.

create or replace function public.append_deletion_state_transition(
  p_request_id uuid,
  p_subject_ref uuid,
  p_from_state text,
  p_to_state text,
  p_actor_type text,
  p_actor_ref text default null,
  p_reason_code text default null,
  p_sanitized_metadata jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  meta jsonb;
begin
  meta := p_sanitized_metadata;
  if meta is not null then
    -- 1) Strip obviously sensitive keys if a caller slips.
    meta := meta - 'email' - 'token' - 'restoration_token' - 'password' - 'authorization';
    -- 2) Redact email-address-shaped substrings from any remaining key or
    --    value (P2-9). Case-insensitive; the replacement is bracket/alnum only
    --    so the round-tripped JSON remains valid.
    meta := regexp_replace(
      meta::text,
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
      '[redacted-email]',
      'gi'
    )::jsonb;
  end if;

  insert into public.deletion_state_transitions (
    request_id,
    subject_ref,
    from_state,
    to_state,
    actor_type,
    actor_ref,
    reason_code,
    sanitized_metadata
  ) values (
    p_request_id,
    p_subject_ref,
    p_from_state,
    p_to_state,
    p_actor_type,
    p_actor_ref,
    p_reason_code,
    meta
  )
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.append_deletion_state_transition(
  uuid, uuid, text, text, text, text, text, jsonb
) from public;
grant execute on function public.append_deletion_state_transition(
  uuid, uuid, text, text, text, text, text, jsonb
) to service_role;

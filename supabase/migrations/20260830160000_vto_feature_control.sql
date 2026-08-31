-- Virtual Try-On remote feature control (VTO Alpha Foundation).
--
-- VTO deliberately introduces NO new table. It reuses the existing governed
-- remote-control surface -- public.app_config, the same key/value table that
-- already carries 'mobile_feature_freeze' -- because the requirement is
-- exactly what that table already does: one operator-settable value the
-- server reads before doing anything expensive.
--
-- Nothing here stores VTO media, VTO results, VTO history, or any per-user
-- VTO state. The Alpha foundation is ephemeral by design: the person image
-- exists for the life of one request and the result is returned inline.
--
-- Default is DISABLED. Turning VTO on is a deliberate operator action (an
-- UPDATE to this row), and turning it off again is the kill switch -- no app
-- release is involved in either direction.
--
-- The RLS read policy is a SECOND, additive policy rather than a rewrite of
-- the feature-freeze one: policies are OR'd, so this widens read access to
-- exactly one more key and leaves the existing grant untouched. Clients read
-- it for UX only (whether to render the entry point at all);
-- supabase/functions/vto-generate re-reads it with the service role and its
-- answer is the one that decides whether a provider is ever called.

insert into public.app_config (key, value)
values (
  'vto_generation',
  '{
    "schemaVersion": 1,
    "enabled": false,
    "provider": "mock",
    "supportedCategories": ["top", "outerwear", "blazer", "dress"],
    "mockLatencyMs": 6000,
    "mockScenario": "success",
    "updatedAt": "2026-08-30T16:00:00Z"
  }'::jsonb
)
on conflict (key) do nothing;

drop policy if exists "Allow public read for VTO feature control" on public.app_config;

create policy "Allow public read for VTO feature control"
  on public.app_config
  for select
  to anon, authenticated
  using (key = 'vto_generation');

comment on table public.app_config is
  'Operator-settable client/server control values. One row per key; each key is exposed by its own narrowly-scoped SELECT policy. Currently: mobile_feature_freeze, vto_generation.';

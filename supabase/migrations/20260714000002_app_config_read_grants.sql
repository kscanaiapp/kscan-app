-- RLS already limits mobile reads to the single feature-freeze row, but the
-- table-level privilege is also required before PostgreSQL evaluates RLS.
grant select on table public.app_config to anon, authenticated;

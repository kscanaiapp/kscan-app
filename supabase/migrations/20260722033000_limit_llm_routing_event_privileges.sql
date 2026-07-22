-- Keep the privacy-safe routing ledger append-only for the backend role.
-- A historical schema-wide service_role grant can otherwise leave UPDATE and
-- DELETE privileges in place even though the create migration grants only
-- SELECT and INSERT.

revoke all on table public.llm_routing_events from service_role;
grant select, insert on table public.llm_routing_events to service_role;

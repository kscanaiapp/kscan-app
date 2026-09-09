-- Repair 06 — post-auth terminal deletion-status capability.
--
-- WHY. Deletion intake revokes the caller's sessions and bans the Auth user for
-- the grace window; the purge worker later deletes the Auth identity entirely.
-- A client therefore has no authenticated way to learn whether its deletion
-- eventually completed. This column stores the SHA-256 hash of an opaque
-- capability the client holds, so a later unauthenticated lookup can resolve
-- exactly one lifecycle row.
--
-- ADDITIVE AND NULLABLE. Every existing row predates the capability and keeps
-- status_receipt_hash IS NULL. Nothing reads the column as NOT NULL, and the
-- intake path treats a missing column as "no receipt binding" rather than an
-- error, so this migration is safe to apply before or after the Edge Function
-- source that writes it.
--
-- ONLY THE HASH. The raw receipt is never stored, logged, or placed in a URL.
-- A hash is sufficient because the server only ever needs to RECOGNISE a
-- capability presented by a caller, never to reproduce one; reversible
-- encryption would retain a recoverable secret for no purpose.
--
-- INDEX SHAPE mirrors deletion_requests_restoration_token_hash_uidx from
-- 20260722191013_account_deletion_lifecycle.sql: unique where present, so the
-- lookup is a single index probe and two lifecycles can never share a
-- capability, while unlimited legacy rows keep NULL without colliding.

alter table public.deletion_requests
  add column if not exists status_receipt_hash text;

comment on column public.deletion_requests.status_receipt_hash is
  'SHA-256 (lowercase hex) of the post-auth deletion-status capability. Never '
  'the raw receipt. Read-only lookup key for the deletion-status Edge Function; '
  'grants no restoration, deletion or account access. NULL for lifecycles '
  'created before Repair 06 and for clients that supplied none.';

create unique index if not exists deletion_requests_status_receipt_hash_uidx
  on public.deletion_requests (status_receipt_hash)
  where status_receipt_hash is not null;

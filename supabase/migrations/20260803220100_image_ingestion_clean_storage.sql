-- Secure Image Ingestion Gate — Phase 4/8: clean storage.
--
-- Only the scan worker (service_role) ever writes here -- there is no INSERT,
-- UPDATE, or DELETE policy for `authenticated`/`anon` anywhere in this
-- migration, by design ("no client ability to mark an object clean"). Owners
-- MAY read their own promoted objects, since downstream features (Style
-- Library display, a future tryon-clothes-pro activation) need to serve the
-- image back to its owner.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'image-ingestion-clean',
  'image-ingestion-clean',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read own clean images" on storage.objects;
create policy "Users can read own clean images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'image-ingestion-clean'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Deliberately no insert/update/delete policy for authenticated/anon.
-- Guardrail comment for security/scripts/rls-storage-guard.js: this bucket
-- must NEVER be added to PUBLIC_BUCKET_ALLOWLIST.

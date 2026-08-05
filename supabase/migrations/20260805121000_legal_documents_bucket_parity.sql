-- Storage parity: create the production-required `legal-documents` bucket.
--
-- Production (wyyuqfdxucjksghsmhry, read-only) defines exactly two buckets:
--
--   legal-documents       public = true,  file_size_limit = null, mime = null
--   style-library-images  public = false, file_size_limit = 5242880,
--                         mime = {image/jpeg, image/png, image/webp}
--
-- Staging already carried style-library-images with byte-identical configuration
-- and all four of production's owner-scoped storage.objects policies, but had no
-- legal-documents bucket at all. This adds it with production's configuration.
--
-- No storage.objects policy is created for it, matching production: the bucket
-- is public, so reads are served through the public path and production defines
-- no row-level policy for it. Writes remain service-role only, which is also
-- what production's zero-policy configuration produces.
--
-- No production Storage object is copied. Non-sensitive test artifacts are
-- placed by the staging fixture tooling, never by this migration.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('legal-documents', 'legal-documents', true, null, null)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

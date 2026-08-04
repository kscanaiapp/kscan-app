-- Secure Image Ingestion Gate — Phase 7: non-forgeable clean-verdict records.
--
-- One row per scan attempt (not per object -- a rejected upload still gets a
-- row, so ops can see rejection volume/category without ever storing the
-- rejected bytes). Only CLEAN verdicts carry a clean_object_id. Written only
-- by service_role (the scan worker); RLS grants owners read-only access to
-- their own rows and nothing else -- "no client ability to mark an object
-- clean" is enforced here, not just by convention.

create table if not exists public.image_scan_verdicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  quarantine_object_id text not null,
  clean_object_id text,
  request_id text,

  sha256_original text not null,
  sha256_canonical text,
  detected_format text,
  width integer,
  height integer,
  compressed_bytes bigint,

  scanner_engine text not null default 'not_run',
  scanner_signature_version text,
  scanned_at timestamptz,

  verdict text not null check (verdict in (
    'PENDING',
    'CLEAN',
    'REJECTED_TYPE',
    'REJECTED_SIZE',
    'REJECTED_DIMENSIONS',
    'REJECTED_MALWARE',
    'REJECTED_MALFORMED',
    'SCANNER_UNAVAILABLE',
    'SCAN_TIMEOUT',
    'REENCODE_FAILED'
  )),
  rejection_category text,

  expires_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.image_scan_verdicts is
  'Non-forgeable scan verdict per upload attempt. Only CLEAN rows carry a clean_object_id. Written only by service_role -- see security/scan-worker/scanQuarantineObject.js. Never stores raw image bytes, base64, or full scanner output.';

alter table public.image_scan_verdicts enable row level security;

-- Owners can read their own verdict history (e.g. to poll for CLEAN, or to
-- see why an upload was rejected). No insert/update/delete policy exists for
-- authenticated/anon -- those require service_role, which bypasses RLS.
drop policy if exists "Users can read own scan verdicts" on public.image_scan_verdicts;
create policy "Users can read own scan verdicts"
on public.image_scan_verdicts
for select
to authenticated
using (user_id = auth.uid());

-- Pending-scan lookup (worker's own queue query / stuck-scan monitoring).
create index if not exists image_scan_verdicts_pending_idx
on public.image_scan_verdicts (created_at)
where verdict = 'PENDING';

-- Retention/cleanup job: find expired rows and their objects to delete.
create index if not exists image_scan_verdicts_expires_at_idx
on public.image_scan_verdicts (expires_at)
where expires_at is not null;

-- Duplicate-hash lookup (Phase 10: reuse an existing unexpired CLEAN verdict
-- for the same user + original-bytes hash instead of rescanning/restoring).
create index if not exists image_scan_verdicts_user_hash_idx
on public.image_scan_verdicts (user_id, sha256_original);

-- Downstream enforcement lookup (Phase 9: resolve a clean_object_id back to
-- its verdict row to check ownership/hash/expiry before use).
create unique index if not exists image_scan_verdicts_clean_object_id_idx
on public.image_scan_verdicts (clean_object_id)
where clean_object_id is not null;

revoke all on public.image_scan_verdicts from anon;
grant select on public.image_scan_verdicts to authenticated;

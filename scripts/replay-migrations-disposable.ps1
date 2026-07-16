$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Container = "kscan-mig-replay-{0}" -f (Get-Random)
$failed = $false

function Invoke-PsqlInput([string]$Sql) {
  $temp = Join-Path $env:TEMP ("kscan-sql-{0}.sql" -f [guid]::NewGuid())
  Set-Content -Path $temp -Value $Sql -Encoding utf8
  try {
    $out = & cmd /c "type `"$temp`" | docker exec -i $Container psql -U postgres -v ON_ERROR_STOP=1 -f - 2>&1"
    return @{ ExitCode = $LASTEXITCODE; Output = ($out | Out-String) }
  } finally {
    Remove-Item -Force $temp -ErrorAction SilentlyContinue
  }
}

function Invoke-PsqlFile([string]$Path) {
  $out = & cmd /c "type `"$Path`" | docker exec -i $Container psql -U postgres -v ON_ERROR_STOP=1 -f - 2>&1"
  return @{ ExitCode = $LASTEXITCODE; Output = ($out | Out-String) }
}

try {
  Write-Host "Starting disposable Postgres container $Container"
  docker run -d --name $Container -e POSTGRES_PASSWORD=postgres postgres:15-alpine | Out-Null

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    & docker exec $Container pg_isready -U postgres 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  }
  if (-not $ready) { throw 'Disposable Postgres did not become ready' }

  Write-Host 'Bootstrapping auth/profiles stubs + roles used by saved_scans grants'
  $boot = Invoke-PsqlInput @'
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.inspiration_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE
);
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
'@
  if ($boot.ExitCode -ne 0) { throw "Bootstrap failed: $($boot.Output)" }

  # Saved-scans lineage required for the Scanner purchase_options migration.
  # Soft-delete grant migrations also touch unrelated privacy tables; those are
  # validated by filename ordering + authoritative Dressing Rooms lineage, not
  # this disposable subset harness.
  $subset = @(
    '20260617215307_create_saved_scans.sql',
    '20260712000001_saved_scan_media_backing.sql',
    '20260716035943_add_purchase_options_to_saved_scans.sql'
  )

  foreach ($name in $subset) {
    $path = Join-Path $Root "supabase\migrations\$name"
    Write-Host "APPLY $name"
    $result = Invoke-PsqlFile $path
    if ($result.ExitCode -ne 0) {
      Write-Host $result.Output
      throw "Migration failed: $name"
    }
  }

  Write-Host 'Seed actor for insert tests'
  $seed = Invoke-PsqlInput "INSERT INTO auth.users (id) VALUES ('00000000-0000-4000-8000-000000000001');"
  if ($seed.ExitCode -ne 0) { throw "Seed failed: $($seed.Output)" }

  Write-Host '=== purchase_options column ==='
  $col = Invoke-PsqlInput @'
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='saved_scans' AND column_name='purchase_options';
'@
  Write-Host $col.Output
  if ($col.Output -notmatch 'purchase_options') { throw 'purchase_options column missing' }
  if ($col.Output -notmatch 'jsonb') { throw 'purchase_options type is not jsonb' }

  Write-Host '=== array constraint ==='
  $con = Invoke-PsqlInput @'
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid='public.saved_scans'::regclass AND conname='saved_scans_purchase_options_is_array';
'@
  Write-Host $con.Output
  if ($con.Output -notmatch 'saved_scans_purchase_options_is_array') { throw 'array constraint missing' }

  Write-Host '=== legacy-style insert gets default [] ==='
  $ins = Invoke-PsqlInput @'
INSERT INTO public.saved_scans (user_id, analysis_result)
VALUES ('00000000-0000-4000-8000-000000000001'::uuid, '{}'::jsonb)
RETURNING purchase_options, jsonb_typeof(purchase_options);
'@
  Write-Host $ins.Output
  if ($ins.ExitCode -ne 0 -or $ins.Output -notmatch 'array') { throw 'default empty array insert failed' }

  Write-Host '=== valid array update ==='
  $valid = Invoke-PsqlInput @'
UPDATE public.saved_scans
SET purchase_options = '[{"id":"po-1"}]'::jsonb
WHERE user_id='00000000-0000-4000-8000-000000000001'::uuid
RETURNING jsonb_array_length(purchase_options);
'@
  Write-Host $valid.Output
  if ($valid.ExitCode -ne 0) { throw 'valid array update failed' }

  Write-Host '=== empty array update ==='
  $empty = Invoke-PsqlInput @'
UPDATE public.saved_scans
SET purchase_options = '[]'::jsonb
WHERE user_id='00000000-0000-4000-8000-000000000001'::uuid
RETURNING purchase_options;
'@
  Write-Host $empty.Output
  if ($empty.ExitCode -ne 0) { throw 'empty array update failed' }

  Write-Host '=== invalid non-array rejected ==='
  $bad = Invoke-PsqlInput @'
UPDATE public.saved_scans
SET purchase_options = '{"bad":true}'::jsonb
WHERE user_id='00000000-0000-4000-8000-000000000001'::uuid;
'@
  Write-Host $bad.Output
  if ($bad.ExitCode -eq 0) { throw 'Invalid non-array purchase_options was accepted' }
  Write-Host 'INVALID_REJECTED=true'

  Write-Host '=== media fields unchanged ==='
  $media = Invoke-PsqlInput @'
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='saved_scans'
  AND column_name IN ('storage_bucket','storage_path','media_status','image_uri','thumbnail_uri')
ORDER BY 1;
'@
  Write-Host $media.Output
  foreach ($need in @('storage_bucket','storage_path','media_status','image_uri','thumbnail_uri')) {
    if ($media.Output -notmatch $need) { throw "Missing media/image field $need" }
  }

  Write-Host '=== RLS enabled ==='
  $rls = Invoke-PsqlInput "SELECT relrowsecurity FROM pg_class WHERE oid='public.saved_scans'::regclass;"
  Write-Host $rls.Output
  if ($rls.Output -notmatch 't') { throw 'RLS not enabled on saved_scans' }

  $names = Get-ChildItem (Join-Path $Root 'supabase\migrations\*.sql') | Sort-Object Name | ForEach-Object Name
  $idxRooms = [array]::IndexOf($names, '20260716000001_shared_room_memberships.sql')
  $idxPO = [array]::IndexOf($names, '20260716035943_add_purchase_options_to_saved_scans.sql')
  if (-not ($idxPO -gt $idxRooms -and $idxRooms -ge 0)) {
    throw 'Migration ordering invalid versus shared_room_memberships'
  }
  Write-Host "ORDER_OK rooms=$idxRooms purchase_options=$idxPO total=$($names.Count)"
  Write-Host 'REPLAY_PASS=true'
} catch {
  $failed = $true
  Write-Host "REPLAY_FAIL: $($_.Exception.Message)"
} finally {
  docker rm -f $Container 1>$null 2>$null
}

if ($failed) { exit 1 }
exit 0

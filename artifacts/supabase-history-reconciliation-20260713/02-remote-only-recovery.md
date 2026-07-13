# Remote-only migration recovery

Migration: `20260709130346_android_backend_runtime_fixes.sql`

Classification: `A — EXACT_CANONICAL_SQL_RESTORED`

## Provenance search

The canonical file was not found in current branches, remote-tracking branches,
tags, stashes, worktrees, reflogs, reachable Git object paths, inspected
unreachable commits/blobs, sibling repositories under `C:\src`, the secondary
K Scan checkout, Documents, or Downloads. Remote refs were fetched read-only and
searched again. The only attachment hit was the reconciliation request itself.

The authoritative remote ledger retained the complete migration record:

- Name: `android_backend_runtime_fixes`
- Statement count: `19`
- Combined statement MD5: `fcde4716713ae20eda9a70481df2a468`

The ledger statements were restored in timestamp/name order at:

`supabase/migrations/20260709130346_android_backend_runtime_fixes.sql`

Every locally parsed statement has the same character count and MD5 as the
corresponding ledger statement. The reconstructed 19-statement combined MD5 is
also `fcde4716713ae20eda9a70481df2a468`.

Recovered file SHA-256:
`49d9fa5f840f077a17a9dc66e57b4afd9c6fda266dd6e824467f756bf59ae521`

## Remote-effect verification

Catalog verification confirmed all three effect groups represented by the
ledger SQL:

1. `app_config` has narrow `anon`/`authenticated` SELECT access and the
   `Public read safe mobile config` RLS policy.
2. `check_and_increment_scan_identify_daily_usage(uuid,text,integer)` is present
   with the qualified usage-date implementation.
3. `scan_intelligence_events` exists with RLS, its expected 29-column shape,
   primary/user/created indexes, service-role-only policy, and no anon or
   authenticated table privileges.

After restoration, `supabase migration list --linked` aligned local and remote
at `20260709130346`. No `migration repair` command was required or run.

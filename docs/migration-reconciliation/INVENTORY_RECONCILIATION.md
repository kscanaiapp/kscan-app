# Production migration inventory — canonical reconciliation

**Regenerated read-only on 2026-07-25** against Supabase project `wyyuqfdxucjksghsmhry`
(KScan App Production, us-east-2). No migration was applied, re-applied, altered,
repaired, or pushed. No production mutation occurred.

## Resolution of the 84 / 81 discrepancy

**The production ledger contains exactly 81 rows. `84` has no basis in any queried source
and was a narrative counting error, not a data discrepancy.**

Proof, reproducible by the documented process below:

- `select count(*) from supabase_migrations.schema_migrations` returns **81**.
- The category partition sums exactly: 73 + 6 + 2 = **81**, with no row uncategorised.
- `min(version)` = `202605122359` (`profiles_base`) and `max(version)` = `20260724221634`
  (`shared_room_memberships_select_grant`), which bound the same set returned by the
  Supabase management `list_migrations` endpoint — the two sources read the same table
  and agree at both ends.
- The 81 transcribed rows reproduce the ledger fingerprint exactly (below). A missing or
  extra row would change the hash.

No artefact delivered to the owner ever asserted 84; the figure originated in intermediate
working notes and is retracted here.

## Canonical inventory table

| Category | Count | Notes |
|---|---:|---|
| **Production ledger rows** | **81** | `supabase_migrations.schema_migrations` |
| Production-applied, executable SQL recorded | 73 | `statements` contains real DDL/DML |
| Production placeholder / stub records | 2 | `20260722191013`, `20260723021514` — prose or `select 1;` |
| Production rows with no SQL recorded at all | 6 | `statements` empty; repository file is the sole source of record |
| **Repository active migrations — iOS RC** | **71** | `integration/ios-v18-release-candidate` |
| — exact production version match | 60 | |
| — alias / duplicate under a non-production version | 10 | |
| — repository-only, never applied | 1 | `20260725100000_shared_room_item_contributions.sql` |
| — archived / non-executable files | 0 | |
| **Repository active migrations — Android RC** | **73** | `integration/android-v27-closet-release-candidate` |
| — exact production version match | 59 | |
| — alias / duplicate under a non-production version | 14 | |
| — repository-only, never applied | 0 | |
| — archived / non-executable files | 1 | `ACCOUNT_DELETION_MIGRATION_DIVERGENCE.md` |

The 6 rows with no recorded SQL are `dressing_room_participants_shared_messaging`,
`dressing_room_item_reactions_participant_rls`, `product_catalog`,
`free_tier_utility_tables`, `fix_inspiration_closet_delete_and_room_link`,
`scan_identify_daily_usage`. All 6 have an exact-version repository file on both RCs, so
the repository file is the canonical source of record for them.

iOS shows 60 exact matches and Android 59 because iOS carries
`20260717201524_20260716035943_add_purchase_options_to_saved_scans.sql`, which matches the
production version exactly, while Android carries the alias
`20260716035943_add_purchase_options_to_saved_scans.sql`.

## Fingerprint document

| Field | Value |
|---|---|
| Data source | `supabase_migrations.schema_migrations` (production ledger), read-only `select` |
| Source command | `select version, name, coalesce(array_length(statements,1),0), length(...), md5(...) from supabase_migrations.schema_migrations order by version` |
| Sort order | ascending by `version`, compared as **text** |
| Fields included | `version`, `name` — joined per row as `version` `|` `name` |
| Row separator | `\n` (LF), no trailing newline |
| Normalisation | none applied to `version` or `name`; values used verbatim as stored |
| Hash algorithm | MD5 over the UTF-8 encoding of the joined string |
| Row count | **81** |
| **Fingerprint** | **`dbcfc5bfd6a93952f8ab5527d82f3ecf`** |
| Generated | 2026-07-25, read-only session |

Server-side computation:
`md5(string_agg(version || '|' || name, E'\n' order by version))`.
The locally transcribed inventory reproduces this hash exactly, which is what establishes
that the transcription is complete and faithful.

## Status

The manifest reproduces both the row count (81) and the fingerprint
(`dbcfc5bfd6a93952f8ab5527d82f3ecf`) by the documented process, so the **inventory** is
complete. This does **not** make the reconciliation complete — see
`RECONCILIATION_MANIFEST.md` and `FORENSIC_ADDENDUM.md`. Migration-history reconciliation
remains FAIL / BLOCKED pending an owner ruling on reconciliation strategy.

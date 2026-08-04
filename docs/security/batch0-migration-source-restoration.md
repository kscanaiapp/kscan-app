# Batch 0 -- Migration Source Restoration

Restores exact source for 11 production migrations that were missing from this branch.
Files are named with the **exact production version ID**.

## Encoding disclosure

The three production-record extractions are byte-identical to the stored statement,
with exactly one deviation: a single trailing newline is appended, because a text file
ends with a newline and the stored statement does not. Verification md5s below are
computed on the content with that trailing newline removed, and match production exactly.
No reformatting, normalization, or 'improvement' was applied to any recovered SQL.

## Restored files

| Production version | Name | Origin | Origin ref | Prod record chars | File bytes | File sha256 (16) | Confidence |
|---|---|---|---|---|---|---|---|
| `20260723021635` | account_deletion_device_sessions_and_revoke | production supabase_migrations.schema_migrations.statements | `production row` | 4283 | 4284 | `94ade076b6f2d3a7` | EXACT -- md5 verified byte-for-byte |
| `20260723021735` | account_deletion_claim_retry_peek_v2 | production supabase_migrations.schema_migrations.statements | `production row` | 6192 | 6193 | `3465152851328cfb` | EXACT -- md5 verified byte-for-byte |
| `20260723132813` | harden_deletion_trigger_function_grants | production supabase_migrations.schema_migrations.statements | `production row` | 631 | 632 | `0d390672f8ff7902` | EXACT -- md5 verified byte-for-byte |
| `20260720115423` | scan_commerce_events | git | `84a3453` | 2475 | 2678 | `c498e918cb5c7fe4` | DIVERGENT -- see note |
| `20260721201218` | dr3_collaborative_interactions | git | `a75a1ff` | 25195 | 25893 | `5c30247fbb778886` | DIVERGENT -- see note |
| `20260721201347` | dr4_collab_idempotency_room_scope | git | `a75a1ff` | 8271 | 8315 | `532915b5144b3762` | DIVERGENT -- see note |
| `20260722004639` | stylechat_request_quota_events | git | `65c436b` | 5708 | 6127 | `5b77d1ba581c8e72` | DIVERGENT -- see note |
| `20260722022830` | lock_down_stylechat_quota_refunds | git | `54991fd` | 2732 | 2733 | `4f439a3173cd563b` | NEAR-EXACT -- differs by trailing newline only |
| `20260722024920` | fix_stylechat_quota_rpc_ambiguity | git | `8f249a2` | 6113 | 5776 | `e8095d34bd5051b0` | DIVERGENT -- production record is LARGER |
| `20260722030304` | create_llm_routing_events | git | `72a6fab` | 2017 | 2018 | `00dc34b9643680e0` | NEAR-EXACT -- differs by trailing newline only |
| `20260722031812` | limit_llm_routing_event_privileges | git | `721e76c` | 390 | 388 | `6334bd7d5742a3cd` | DIVERGENT -- production record is LARGER |

## CRITICAL: production migration history is NOT a uniform source of truth

`supabase_migrations.schema_migrations.statements` in production contains a **mix** of
real applied DDL and backfilled placeholders. Confirmed placeholders:

| Version | Name | Stored statement |
|---|---|---|
| `20260722191013` | account_deletion_lifecycle | `applied via lifecycle rollout` (29 chars, not SQL) |
| `20260723021514` | account_deletion_security_hardening | a comment plus `select 1;` (121 chars) |

Both are **Batch 1** migrations, and both are among the highest-risk in the batch.
There is therefore **no recorded evidence** of the DDL actually applied to production for
them. The local files are the only candidate source, and their fidelity to production's
live state cannot be proven from migration history alone.

Resolution path: the **live production schema is authoritative**. Equivalence must be
established by applying the local files to a shadow database and diffing the resulting
functions, policies, and grants against production's live catalog.

## Divergence note for the eight git-recovered files

Six of the eight differ in length from the production record beyond a trailing newline.
Because production records are known to contain stubs, a difference does not by itself
prove the git file is wrong -- it proves the two disagree. **None of these eight are in
Batch 1**, so they do not gate the current shadow test. They must NOT be applied to any
environment until each is reconciled against production's live schema.

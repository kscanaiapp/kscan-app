# Migration provenance (B34-DEF-009)

## The problem

The Android and iOS branches each carry a migration adding `purchase_options`
to `public.saved_scans`, under two different filenames:

- Android: `20260716035943_add_purchase_options_to_saved_scans.sql`
- iOS: `20260717201524_20260716035943_add_purchase_options_to_saved_scans.sql`

Both staging (`yzqjvdfgefveprobvvyw`) and production (`wyyuqfdxucjksghsmhry`)
have this migration **applied under the iOS filename's version, `20260717201524`**
— confirmed read-only via `list_migrations` on both projects on 2026-08-29.
The Android-named file has never been applied under its own name in either
environment. The SQL is logically equivalent between the two files but not
byte-identical: the iOS copy carries one extra trailing `;` line.

## What this pass did NOT do

- Did not rename, delete, or otherwise rewrite either file.
- Did not touch the applied migration history on staging or production.
- Did not guess which file is "correct" beyond what the live ledger evidence
  showed.

## What this pass did

Added `config/migration-provenance-manifest.json`, which declares both
filenames as historical aliases of one logical migration
(`add_purchase_options_to_saved_scans`), recording:

- the applied ledger version/name and which environments it is applied on;
- a normalization-tolerant canonical SHA-256 (blank lines and no-op `;`
  statements stripped before hashing) that both files hash to identically.

`scripts/check-migration-provenance.js` verifies, on every checkout:

1. any two migration files that hash identically after normalization are
   declared aliases of the same logical migration — an undeclared duplicate
   fails the gate;
2. any declared alias present in the current checkout still hashes to the
   manifest's canonical value — a tampered or drifted file fails the gate;
3. at least one declared alias for each logical migration exists in the
   current checkout — this is what proves the migration itself hasn't been
   silently deleted from a branch.

A future migration that duplicates an existing logical migration's SQL under
a new filename will fail this gate until it is either declared as an
approved alias here (with evidence) or given genuinely new content.

## Owner follow-up

Reconciling the two filenames into one (so a future `supabase migration
list` diff stops showing this as drift) is a deliberate decision left to the
owner — see the "Preferred Repair" guidance in the Build 34 maintenance
brief. This pass only makes the current duplication explicit and gated.

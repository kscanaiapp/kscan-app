# Recovered migrations — staging migration-authority drift investigation

**Status: read-only investigation. Nothing in this directory has been applied
anywhere, and nothing outside this directory was changed by this pass.**

## Why this exists

`supabase db push --linked --dry-run` from the canonical backend authority
(`maintenance/b34-def001-backend-authority`, and any branch descending from
it, including the K+ complimentary-access work) refuses to run against
staging (`yzqjvdfgefveprobvvyw`, "K Scan AI Staging"). It reports 22 remote
migration versions with no corresponding file in this branch's
`supabase/migrations/`.

Per the owner's explicit instruction: **do not run
`supabase migration repair --status reverted`** on these (that would tell
Supabase changes which demonstrably did happen never happened, risking
reapplication or a false history), and **do not `supabase db pull`** directly
into a feature branch (that would mix unreviewed historical staging state
into a clean candidate). This investigation instead recovers the truth first.

## What was recovered, and how

All 22 migrations' **exact executed SQL** was recovered directly from
Postgres's own migration ledger:

```sql
select version, name, statements
from supabase_migrations.schema_migrations
where version in (...)
```

`statements` is the literal array of SQL statements the Supabase CLI ran for
that migration, preserved verbatim by Postgres regardless of whether the
originating `.sql` file was ever committed anywhere. This is **ground truth
for "what ran"** — it is not a schema diff, not a reconstruction, and not a
guess. Each `RECOVERED_<version>_<name>.sql` file in this directory is that
ledger content, verbatim, with a provenance header prepended.

Live-schema spot check (2026-08-29, read-only `information_schema` /
`pg_catalog` queries against staging) confirms these aren't inert ledger rows
either — the columns/tables they describe are genuinely live on staging right
now (e.g. `scan_commerce_events.query_strategy` and siblings exist;
`investor_inquiries` exists with exactly the recovered column set).

## What was NOT recovered by this step alone

The ledger gives the **executed SQL**, not necessarily the **original
authored file** (filename, header commentary as originally written, or
which branch/commit it came from) when that file was applied from a
checkout that was never pushed anywhere. A companion investigation (see
the parent directory's provenance findings, gathered via cross-repo and
cross-branch search) fills in origin/classification per migration.

## Headline findings so far (before the cross-branch search completes)

- **4 of the 22 almost certainly belong to different repositories entirely**,
  not to `kscan-app`:
  - `20260819125404`, `20260819151224`, `20260823170850` (wearable_pairings /
    wearable_security_hardening / reconcile_wearable_schema_with_staging) —
    confirmed: `kscan-glasses-webapp/supabase/migrations/` has both
    `20260819000001_add_wearable_pairing_session.sql` (a superset/precursor,
    with real content differences — see below) and
    `20260823170850_reconcile_wearable_schema_with_staging.sql`, which is
    **byte-identical** to the ledger-recovered content for that version.
  - `20260824175813` (`create_investor_inquiries`) — confirmed:
    `kscan-website/app/api/investor-inquiry/route.ts` reads
    `INQUIRY_TABLE = "investor_inquiries"`, so this table is real,
    load-bearing application state for the **website**, not the mobile app.
    However, `git log --all` in `kscan-website` for `*investor_inquiries*`
    also returns **nothing** — this table's migration was never committed to
    that repository either. Same ad-hoc-apply pattern, third repository.
  - `20260819125700`, `20260819144630` (`saved_scans_wearable_source`,
    `widen_saved_scans_source_for_meta_wearable`) — these DO touch a real
    `kscan-app` table (`saved_scans`), but are simple, additive,
    superseded-by-each-other CHECK-constraint widenings; low provenance risk
    either way.
- **`kscan-glasses-webapp`'s own committed `20260819000001_...` migration
  does not match what's live on staging**: it sets
  `device_model text NOT NULL DEFAULT ''` with no length check, while
  staging enforces `check (char_length(device_model) between 1 and 80)` with
  no default (per both the original `20260815015710_wearable_pairings_sessions`
  ledger content and the later `reconcile_wearable_schema_with_staging`
  hardening pass). That repo's own migration is itself stale relative to
  staging, independent of this investigation.
- **`20260823175314` (`scan_commerce_events_accuracy_telemetry`) is a live
  self-contradiction**: its own SQL comment says *"NOT APPLIED as part of
  this change... activation and staging validation are separate, later
  steps,"* yet it demonstrably IS applied (ledger + live schema both confirm
  it). Either the "not applied" claim was aspirational at authoring time and
  someone later approved and applied it without updating the comment, or an
  unrelated push swept up a dirty working tree that happened to include this
  file. **Flag for the owner** — this is the one entry in this batch where
  the applied state may not reflect an actual approved decision, independent
  of whether the file is committed anywhere.
- **`20260814140000` (`harden_wardrobe_wear_anon_privileges`) claims in its
  own comment**: *"Source of truth:
  supabase/migrations/20260814140000_harden_wardrobe_wear_anon_privileges.sql"*
  — i.e. it asserts a real committed file exists with that exact path. Not
  found on `maintenance/b34-def001-backend-authority` or either mobile
  `integration/*-build34-maintenance-v1` branch. Cross-branch/worktree search
  in progress.

The remaining ~13 kscan-app-specific migrations (dressing room blocking,
Apple auth credential storage, RPC privilege hardening, wardrobe wear-event
model, content-report AI-output support, stylist-preference columns, etc.)
are still being searched across every local branch, every local worktree
checkout, and GitHub PR/commit history before final classification.

**See `LEDGER_INTEGRITY_CHECK.md` in this directory for the corrected,
authoritative 22-row master table with source/ledger SHA-256 hashes for
every entry, and `CLASSIFICATION.md` for the narrative classification.**

## Classification scheme (per migration, final table to follow)

- `EXACT_SOURCE_RECOVERED` — a committed file exists (any branch/repo) whose
  content matches the ledger-recovered SQL exactly or near-exactly.
- `LOGICALLY_RECOVERABLE` — related/superseding committed content exists but
  not an exact original (e.g. a later hardening migration folds in the same
  effect idempotently).
- `SUPERSEDED` — a later migration fully replaces this one's effect.
- `SCHEMA_EFFECT_ALREADY_CANONICAL` — the resulting schema state is itself
  the reference/target (e.g. reconciliation migrations whose whole purpose
  is "match what staging already, deliberately, runs").
- `UNKNOWN` — genuinely not found anywhere; the ledger recovery in this
  directory is the only record.

## What this investigation is NOT proposing

This directory does not decide the eventual canonicalization strategy
(whether recovered migrations get committed under their original names, a
`supabase migration repair --status applied` pass is run once every version
is accounted for, or a fresh baseline checkpoint is established similar in
spirit to DEF-009). That is an owner decision once the full classification
table lands. This pass only establishes truthful provenance.

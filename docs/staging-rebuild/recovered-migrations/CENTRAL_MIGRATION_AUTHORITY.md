# Central shared-Supabase migration authority

## Governing model

One shared Supabase project (staging: `yzqjvdfgefveprobvvyw`; production:
`wyyuqfdxucjksghsmhry`) has **one central migration deployment authority**.
Individual repositories retain full logical/product ownership of their own
features and schema, but **no repository independently owns the shared
migration ledger**. A migration centralized here is a **database authority
copy** of a historically-executed shared-database change — centralizing it
is a provenance/reconciliation act, not a transfer of product ownership.

```
SHARED SUPABASE
      |
CENTRAL DATABASE MIGRATION AUTHORITY  (this repo's supabase/migrations/)
      |
      +-- source_repo = kscan-app             (18 migrations)
      +-- source_repo = kscan-glasses-webapp  (3 migrations)
      +-- source_repo = kscan-website         (1 migration)
```

## Governing rule (future flow)

> **No repository may apply a migration to the shared K Scan Supabase
> project unless that migration is first represented in the central
> database migration authority** (this repo, `supabase/migrations/`,
> filename version = the version Supabase's Management API will assign at
> apply time).

```
feature repo authors migration
        |
review
        |
migration enters central authority (this repo) with source_repo provenance
        |
migration provenance gate
        |
staging
        |
validation
        |
production
```

This is a narrow governance statement, not a CI redesign. The concrete,
low-risk enforcement point already exists and needs no new tooling: the
canonical `scripts/deploy-edge-functions.js` / `config/backend-authority.json`
pattern already refuses to run for any checkout lacking the
`backend-deployment-authority` marker. The same principle — "only the
authority checkout may write to the shared project" — already governs Edge
Function deploys; this document states it applies equally to migrations, and
`supabase db push` from this repo's canonical branch is the only sanctioned
path. Broader per-repo CI enforcement (e.g. a pre-merge hook in
kscan-glasses-webapp or kscan-website that blocks a direct `supabase db
push` against this shared project ref) is a real follow-up but is
deliberately **not** built in this pass — it would touch two other
repositories' CI configuration, which is out of this task's narrow scope.

## Provenance metadata — the 4 centralized foreign migrations

| Field | 20260819125404 | 20260819151224 | 20260823170850 | 20260824175813 |
|---|---|---|---|---|
| `ledger_version` | 20260819125404 | 20260819151224 | 20260823170850 | 20260824175813 |
| `logical_name` | wearable_pairings_sessions | wearable_security_hardening | reconcile_wearable_schema_with_staging | create_investor_inquiries |
| `source_repo` | kscan-glasses-webapp | kscan-glasses-webapp | kscan-glasses-webapp | kscan-website |
| `source_commit` | `9311442` | none standalone (content folded into `fea5712`) | `fea5712` | none found |
| `source_original_filename` | `supabase/migrations/20260819000001_add_wearable_pairing_session.sql` (ledger embeds orig. name `20260815015710_wearable_pairings_sessions`) | none (folded into the reconcile migration below) | `supabase/migrations/20260823170850_reconcile_wearable_schema_with_staging.sql` (exact match) | none — `git log --all` in kscan-website returns zero hits |
| `canonical_filename` | `supabase/migrations/20260819125404_wearable_pairings_sessions.sql` | `supabase/migrations/20260819151224_wearable_security_hardening.sql` | `supabase/migrations/20260823170850_reconcile_wearable_schema_with_staging.sql` | `supabase/migrations/20260824175813_create_investor_inquiries.sql` |
| `ledger_sql_hash` (sha256) | `ebc15fa4a49781d9…` | `b50384ede15f7d04…` | `d5d4f83c6593094c…` | `77f6e57c793ae30d…` |
| `canonical_sql_hash` (sha256) | `a7fad73aaa16e959…` | `9221c264072628252…` | `501005b170300cff…` | `2889679adda85337…` |
| `logical_owner` | kscan-glasses-webapp | kscan-glasses-webapp | kscan-glasses-webapp | kscan-website |
| `reason_centralized` | shared_supabase_central_migration_authority | shared_supabase_central_migration_authority | shared_supabase_central_migration_authority | shared_supabase_central_migration_authority |

Canonical vs. ledger hash differences (all 4) are formatting/comment-only —
Postgres's ledger stores a post-parse statement array, not the original
prose file; content equivalence was verified by direct diff, not inferred
from hash equality (see `LEDGER_INTEGRITY_CHECK.md` for the same convention
applied to the 18 kscan-app-owned entries, several of which show identical
hash behavior).

`kscan-app` does not own, and this centralization does not claim it owns,
the wearable feature or the investor-inquiries website form. These four
files exist here solely so `supabase db push` for the shared project can
reconcile against complete, truthful history.

## Process finding: source comment ≠ deployment evidence

`20260823175314_scan_commerce_events_accuracy_telemetry.sql` (one of the 18
kscan-app-owned migrations, restored in the prior commit) contains, in its
own original author's comment, the sentence *"NOT APPLIED as part of this
change... activation and staging validation are separate, later steps."*
Cross-referencing every recovered source commit (`dbfd66f`, `99954d6`,
`02cc2c4`, `a329f71` — all four identical) confirms **the committed source
itself carries this same claim** — it was never edited between authoring
and (someone else's) later ad-hoc apply. The comment was aspirational or
simply wrong at the time it was written; it is not evidence the migration
was withheld, and it is not evidence of tampering either. The live ledger
and this migration's confirmed-live schema effect (`scan_commerce_events`
has all five documented columns, verified via `information_schema.columns`)
are what actually happened, contradicting the comment.

**This migration's historical comment is intentionally left unmodified.**
Rewriting it would require either breaking the hash-provenance model this
whole reconciliation depends on (the canonical file is defined as "the
exact SQL Postgres executed," and the executed SQL includes that comment
verbatim) or maintaining a second, edited-for-clarity copy that would itself
need its own provenance trail. Documenting the discrepancy here is
preferred over touching the historical artifact.

### Standing process rule

```
SOURCE COMMENT           ≠ DEPLOYMENT EVIDENCE
BRANCH NAME              ≠ DEPLOYMENT EVIDENCE
MIGRATION FILENAME       ≠ DEPLOYMENT EVIDENCE

LIVE LEDGER
  + GOVERNED DEPLOYMENT PROVENANCE
  = DEPLOYMENT EVIDENCE
```

Any future audit asking "was X actually deployed / actually applied" must
answer from `supabase_migrations.schema_migrations` (or the equivalent
Edge Function manifest/version-hash record for deploys), not from what a
comment, branch name, or filename *claims*. This entire reconciliation
exists because that exact substitution — trusting the repository's
narrative over the shared database's own ledger — is what let 22 real,
executed schema changes go undetected in the first place.

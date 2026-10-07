# Build 35 migration parity: Staging to Production October set

This records why the migration tooling changed, what the authority now says, and how the Staging campaign runs. Nothing here executes a migration. Production is read only.

## State when the campaign started

Live ledgers were read read-only on 2026-10-07 and are frozen in `__tests__/fixtures/staging-ledger-2026-10-07.json`.

| Version | Name | Production | Staging |
| --- | --- | --- | --- |
| 20261002010000 | kplus_paid_lifetime_entitlement_foundation | present | absent |
| 20261003195716 | kplus_provider_pull_reconciliation | present | absent |
| 20261004184118 | kplus_offer_code_redemption_authority | present | absent |
| 20261004221500 | closet_purchase_import_origin | present | absent |
| 20261004231628 | fix_kplus_reconciliation_uuid_selection | present | absent |

Production 5/5, Staging 0/5. Every governed Staging deploy from the Build 35 line was blocked in preflight: the line never carried the reconciliation authority from `rebuild/backend-authority-v2`, and its preflight allowed only one pending migration.

## What changed

- `scripts/lib/migration-reconciliation.mjs`, the modern `scripts/staging-deploy-preflight.mjs`, the production-aware `config/migration-authority-manifest.json` and four September provenance migrations were ported from `rebuild/backend-authority-v2` as files (a verbatim first commit, then the Build 35 adaptation). Nothing else from that branch came across.
- Staging now **declares** the five October migrations as `KNOWN_FUTURE_UNAPPLIED`. A declaration is documentation of reality, never permission to apply.
- Each declaration carries `applyAfter`, which chains the campaign order. Approving a later step first is refused; so is a declaration whose `applyAfter` names a non-existent version.
- Production's entry for `20261004184118` was stale (declared pending; the live ledger holds it). It is now `reconciled` / `EXACT_VERSION_APPLIED` like its four siblings. This is a provenance correction and runs nothing.
- `apply-staging-migration.mjs` no longer requires `pending.length === 1`. Its decision is `selectMigrationForApply`, built on the preflight's own `compareMigrations`, so the two cannot disagree. `MIGRATION_FILE` may only restate the governed file.
- A deploy-only preflight reports `selectedMigration: NONE` and `knownPendingCount: 5` and executes nothing.

### September history (provenance only, never executed)

| Staging ledger | Local file | Classification |
| --- | --- | --- |
| 20260916204355 | 20260916203000 | EQUIVALENT_RENUMBER |
| 20260916233708 | 20260916233708 | same version |
| 20260916234025 | none | OBSOLETE_REMOTE_ONLY, never replay |
| 20260916235651 | 20260916235651 | same version |
| 20260917163000 | 20260917163000 | same version |

The reaction-count RPC divergence between Staging (token-bound contract) and Production (one-argument form) is out of scope. `20260916203000` and `20260916233708` stay `HOLD` for Production.

## What the tooling refuses

Deploy-only runs pass with five pending. An invocation executes at most the one version it was approved for, and refuses: a list, range or `all`; a version already in the ledger; a declared remote-only row; `HOLD` or `EXCLUDE`; an undeclared or out-of-order version; any unexplained local or remote drift; a `MIGRATION_FILE` that is not the governed file; and any project that is not Staging. No blanket `db push`, `migration up` or `db reset` is reachable.

## The destructive-SQL scanner (decision needed before the campaign can run)

The scanner is unchanged. Run strictly over the five migrations it blocks three of them:

| Version | Finding | Why it is present |
| --- | --- | --- |
| 20261002010000 | `TRUNCATE` (BLOCK) | The word appears only as a string literal in a `has_table_privilege` verification list (`('TRUNCATE')`), asserting clients hold no TRUNCATE privilege. No statement truncates anything. `ALLOW_DESTRUCTIVE_MIGRATION` does not clear a BLOCK pattern. |
| 20261002010000 | `DESTRUCTIVE_ALTER` | Five `ALTER TABLE ... DROP CONSTRAINT IF EXISTS ..., ADD CONSTRAINT ...` pairs that widen CHECK constraints on three K+ entitlement tables. No column or data is dropped. |
| 20261003195716 | `TRUNCATE` (BLOCK) | The same privilege-name literal in a verification list. |
| 20261004221500 | `DESTRUCTIVE_ALTER` | `DROP CONSTRAINT IF EXISTS user_closet_items_origin_enum` then `ADD CONSTRAINT` to add `purchase_import`. No column or data is dropped. |
| 20261004184118, 20261004231628 | none | |

The governed workflow does not set `ALLOW_DESTRUCTIVE_MIGRATION`, so these cannot run until an exception exists.

Evidence for the decision (all read-only, 2026-10-07):

- **Production precedent.** The SQL held in Production's `supabase_migrations.schema_migrations` equals these repo files for all five versions when compared with whitespace and semicolons ignored (md5 over the stripped text). Four were applied with a prepended `set local lock_timeout = '5s'; set local statement_timeout = '60s';` (56 characters); `20261004184118` was applied bare. The identical `TRUNCATE` literals and `DROP`/`ADD CONSTRAINT` pairs are therefore already live in Production.
- **Staging prerequisite and row risk.** `kplus_entitlement_grants`, `kplus_entitlement_transitions`, `kplus_entitlement_activations` and `user_closet_items` exist on Staging and hold **0 rows** each, and the columns the new `CHECK`s reference exist. `ADD CONSTRAINT` validates every existing row; I evaluated each new `CHECK` expression against Staging and 0 rows fail any of them (there are no rows). Nothing can be lost or rejected.
- **What each constraint does.** Four are widened (a strict superset of the old accepted values). `store_shape_check` and `revocation_check` are rewritten to add the `store_lifetime` source; they are the only non-trivial rewrites and they validate against an empty table.
- **Atomicity is not verified.** The apply script runs the file through `supabase db query --linked -f`. Whether that wraps the file in one transaction was not observed here; the post-apply verification and the stop-on-failure rule are what protect a partial failure.

Proposed overrides, each bound to the exact SQL (LF-normalised sha256) and to one finding id. They are **not committed**:

| Version | Finding | sha256 of the SQL |
| --- | --- | --- |
| 20261002010000 | `TRUNCATE` | `0cf0484ea2a2c905e67268066ce4d4cccadc5d29b20997877f0173cc8a66a528` |
| 20261002010000 | `DESTRUCTIVE_ALTER` | `0cf0484ea2a2c905e67268066ce4d4cccadc5d29b20997877f0173cc8a66a528` |
| 20261003195716 | `TRUNCATE` | `89b2bd32bb210d93c409f08bfa68f7241a0d2fa871d095fca129ebe5a7c3a9e3` |
| 20261004221500 | `DESTRUCTIVE_ALTER` | `d0387a0ca6d5fc809268ff5c53ae2d4cf453bf33b84ead4ca2e5115751417f26` |

The mechanism is version- and content-scoped and ships empty: a `scannerOverrides` entry on a version's Staging declaration (`findingId`, `sha256` of the LF-normalised SQL, `reason`) clears exactly that finding for exactly that file. Editing the SQL voids it; another version cannot inherit it; every use is written to the pre-apply and result artifacts. The scanner patterns are not weakened. **No override is committed. Each one needs explicit owner approval.** `scanner: the strict findings ... no override is committed yet` pins this.

## Running the campaign (after merge)

Dispatch `K Scan Staging Controlled Deploy` once per version with `approved_migration_version` set and `approve_migration` = `YES`. The workflow always deploys one allow-listed function; use the default `staging-health`. Order: 20261002010000, 20261003195716, 20261004184118, 20261004221500, 20261004231628. Stop at the first failure and do not run the next version.

After each version verify it (ledger row, then the effect: tables, RLS, grants, RPC privileges for that migration) before dispatching the next.

## Findings outside this change

Production also holds `20260916235651` and `20260917163000`, which its authority section still declares `KNOWN_FUTURE_UNAPPLIED`. The tooling tolerates this by design (a declared version present in the ledger is reported as fulfilled), so nothing is blocked. They are left unchanged here and listed for a follow-up correction.

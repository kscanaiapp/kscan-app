# Staging migration-ledger reconciliation for the backend authority (2026-09-16)

**Environment:** staging `yzqjvdfgefveprobvvyw` (read-only). Production `wyyuqfdxucjksghsmhry` was read only to confirm absence.
**Change type:** governance/source only. No migration was applied, replayed, renamed or deleted, and no ledger row was written.

## Why this exists

`staging-controlled-deploy` run [35154244943](https://github.com/kscanaiapp/kscan-app/actions/runs/35154244943) (PR #432, `scan-identify` only) stopped in Preflight:

```
remote-only migrations exist with no declared reconciliation: 20260909171001, 20260909171017,
20260914201155, 20260915030553, 20260915124849, 20260915133739, 20260915181554, 20260915181910,
20260915214857, 20260915232402, 20260916204355
```

PR #432 adds no migration. All eleven versions were applied to staging from outside this branch — ten from `release/kscan-pre-freeze-v1`, one from draft PR #431. `config/backend-authority.json` names this branch the sole checkout that may deploy to staging, so staging's ledger has to be accountable from this tree.

## The contract the gate enforces

`scripts/staging-deploy-preflight.mjs` treats a remote-only version as accounted for only when a `config/migration-authority-manifest.json -> ledgerReconciliation.environments.<ref>.reconciled` entry claims it. Every such entry must name a `localVersion` that exists in `supabase/migrations`. There is no declaration-only path, so the migration source has to be present in this tree.

The repository's precedent for exactly this situation is the `20260914120000` entry on `release/kscan-pre-freeze-v1`. That migration was applied to staging from an unmerged branch and blocked every deploy. The file was carried at its original authored version, with a renumber declaration, and nothing else from that branch was ported. This change follows the same precedent.

## The eleven versions

Every source file below is byte-identical to its blob on the governed ref named. None exists in production, under its version or its name.

| Staging version | Source file carried here | Source | Declaration |
|---|---|---|---|
| 20260909171001 | 20260909115726_watchlist_push_receipts | release line, f98b46e7 | EQUIVALENT_RENUMBER (verbatim from release line) |
| 20260909171017 | 20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation | release line, 6875c6e8 (PR #380) | EQUIVALENT_RENUMBER (verbatim from release line) |
| 20260914201155 | 20260914120000_close_authenticated_cross_actor_owned_item_snapshot | release line, 476f45fc / eba7c9c9 | EXACT_CONTENT_RENUMBER (verbatim from release line) |
| 20260915030553 | same version | release line, 814b5961 | none needed; common |
| 20260915124849 | same version | release line, d48148b9 | none needed; common |
| 20260915133739 | same version | release line, 917e8eab | none needed; common |
| 20260915181554 | same version | release line, a006297c | none needed; common |
| 20260915181910 | same version | release line, a006297c | none needed; common |
| 20260915214857 | same version | release line, 209de12a | none needed; common |
| 20260915232402 | same version | release line, 3eae120a | none needed; common |
| 20260916204355 | 20260916203000_reaction_counts_require_live_room_access | PR #431 draft, 96d1c3a1 | EQUIVALENT_RENUMBER (new) |

**Content identity.** For each version, staging's recorded statement was compared with the carried file:

- 3 match byte-for-byte: 20260915030553, 20260915124849, 20260915133739.
- 2 differ only by a trailing newline: 20260915181554, 20260915181910.
- The remaining 6 match once SQL line comments are stripped and whitespace is normalized.

That normalization reproduces the release line's published proof for 20260914120000 (`23a939056a54927124b2eb3eaf42f01b`, 2535 chars). For 20260916203000 it yields `b630bcd353b9120f379b19aa83a9bce5` (2391 chars) on both sides.

**Nature.** Comments stripped and statements inside function bodies ignored, none of the eleven contains `DROP`, a `TRUNCATE` statement, or top-level `INSERT`/`UPDATE`/`DELETE`. They consist of:

- additive tables, indexes and functions;
- function replacements;
- `GRANT`/`REVOKE` changes;
- five `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` statements, each on a table created by the same migration.

20260915133739 is a single `REVOKE`.

`security/scripts/detect-destructive-migrations.js` reports `TRUNCATE` for two carried files, and both matches are privilege text, not statements:

- 20260909115726 contains `revoke truncate, references, trigger, maintain on ...`.
- 20260915030553 contains a `('TRUNCATE')` literal in a privilege enumeration.

The tree already carried 18 CRITICAL/HIGH findings, and CI runs the scanner without `REQUIRE_DESTRUCTIVE_APPROVAL`.

## Why this cannot apply or replay anything

- The seven same-version files are already on staging's ledger, so they are common, not pending.
- The four renumbered files are declared reconciled, so they are not pending either.
- `scripts/apply-staging-migration.mjs` applies only a single explicitly approved pending version, never a blanket `db push`/`reset`/`migration up`. It computes "pending" after the same reconciliation.
- `security-staging-gate.yml`'s `deploy-staging` job runs only for `staging/production-parity` or a confirmed manual dispatch, so neither a PR into this branch nor a merge triggers it.
- The preflight gives an unknown ref, production included, no reconciliation authority, so production still fails closed.

## Proof

The preflight's own `compareMigrations` + `loadLedgerReconciliation` were run against staging's real 168-version ledger:

| Tree | ok | remote-only | pending | common | reconciled local / remote | blockers |
|---|---|---|---|---|---|---|
| authority 11580001 (control) | false | the 11 above | 0 | 132 | 26 / 25 | the exact CI refusal |
| this branch | **true** | **0** | **0** | 139 | 30 / 29 | **none** |

Of the eleven carried files, 7 are common, 4 are reconciled and 0 are pending.

Repository checks on this branch:

| Check | Result |
|---|---|
| `scripts/check-migration-version-collisions.js` | PASS |
| `scripts/verify-migration-authority.js` | PASS (26 entries) |
| `__tests__/migrationAuthorityGovernance.test.js` and `__tests__/staging/stagingMigrationReconciliation.test.js` | 39 tests, 39 passed, 0 failed, 0 skipped |

## What this does not do

- It does not review or approve PR #431. The 20260916203000 file is carried only because staging already runs it. Staging and production now differ on `public.get_item_reaction_counts`: staging requires a saved share or room access for signed-in callers, while production still runs the B33-SEC-001 body.
- It ports no application code, Edge Function, client change or other migration from either branch.
- It writes nothing to either database's ledger.

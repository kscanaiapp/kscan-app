# B33-OBS-003 — production commerce telemetry could not be written

**Date:** 2026-09-16
**Severity:** P2 — certain silent loss of all commerce telemetry on the first
commerce-executing request. **Latent when found: not yet manifested.**
**Status:** `FIXED_PRODUCTION_VERIFIED` (schema converged). End-to-end
confirmation still pending the first commerce-executing production request.
**Environments:** production `wyyuqfdxucjksghsmhry` · staging `yzqjvdfgefveprobvvyw`

## Summary

`scan-identify` v158 shipped to production on 2026-09-16 10:42:27Z carrying a
commerce-outcome row shape that production's `scan_commerce_events` table could
not accept. Any capture insert would have failed with `PGRST204` and been
swallowed to a `console.warn`, silently losing the row.

The defect was **latent when found** — no commerce-executing request had yet
reached v158, so no row had actually been lost. It was certain to drop the first
one. The repair pre-empted it.

Found while attempting B33-COM-001 runtime certification: the telemetry that
certification depends on could not have been written.

## Root cause

`buildCommerceOutcomeRow` (`supabase/functions/scan-identify/commerceOutcomeCapture.ts`)
returns an object literal containing **all 32 keys** of `CommerceOutcomeRow`. Five
are the v124/v127 accuracy-telemetry columns:

    query_strategy, top_agreement_score, top_agreement_band,
    commerce_identity_version, commerce_funnel_version

They are `null` when inapplicable, **but the keys are always present**. PostgREST
rejects an insert naming a column absent from its schema cache (`PGRST204`).
`isMissingTableError` matches on `'schema cache'`, so the failure is classified as
`capture_table_missing` and reduced to a `console.warn`.

Those columns are added by
`supabase/migrations/20260823175314_scan_commerce_events_accuracy_telemetry.sql`.
**Staging applied it; production never did.** Production's ledger jumps
`20260816020548 -> 20260905171030`, skipping the entire 2026-08-17 -> 2026-09-04
block.

The fields entered the governed source on 2026-08-29 (`bc458f41`), but production
ran an older deployed bundle until v158 — which is why nothing failed before the
deploy.

Same defect class as PR #428 Finding A: a migration that reached staging and
never reached production.

## Evidence

Schema divergence (read-only, `information_schema.columns`):

| environment | `scan_commerce_events` columns |
|---|---|
| staging | 34 |
| production (before) | 29 |

Ledger: `20260823175314` present in staging, absent in production.

That pair, plus the unconditional 32-key row literal, is sufficient on its own:
any capture attempt on v158 **would** have failed. This conclusion depends only
on schema and source, not on traffic.

### Correction to the initial reading

The first pass treated "6 scans on 2026-09-16, 0 rows" as proof that rows were
already being destroyed. **That inference does not hold.**

`shouldCaptureScanArtifacts()` (`supabase/functions/_shared/fashionIdentificationV2.ts`)
returns false for `identify_for_style` and `identify_for_closet` — *"a commerce
outcome row for a scan that ran no commerce is a false record."* Every production
request served since v158 deployed has been either an anonymous image scan or
`intent=identify_for_style` (Elise), verified in `function_logs` at 10:44, 11:19,
12:50–12:51 and 14:19. **All are designed no-artifact paths** and would have
written no row on any schema.

The historical ~1.0 capture ratio was produced by the *previous* deployed bundle,
which did not emit the five keys. So both sides of the apparent "cold break" are
confounded — by the bundle change and by a traffic mix that shifted entirely to
intent-suppressed paths.

The defect was real and certain. It had simply not been triggered yet.

### Competing hypothesis tested and rejected

`scan-identify` dispatches both captures fire-and-forget (`void captureCommerceOutcome(...)`,
`captureScanIntelligence(...)`) and there is **no `EdgeRuntime.waitUntil` anywhere**
in the function, so isolate teardown dropping the promises was a plausible
alternative explanation for missing rows. Disconfirmed: staging runs the same
governed source with the same dispatch and captured **52 rows in the 10 days to
2026-09-16 03:44**. Dispatch is not the problem.

## Repair

Applied the staging migration's identical statements to production under
production's own ledger version **`20260916141413`** — the one-logical-migration /
two-ledger-identities pattern already recorded in
`config/migration-authority-manifest.json` for `legal_acceptances_ai_processing_consent`.

All five statements are `ADD COLUMN IF NOT EXISTS` (nullable, no default,
therefore metadata-only) plus `COMMENT ON COLUMN`. Additive and idempotent.

## Verification (production)

| check | before | after |
|---|---|---|
| column count | 29 | **34** (exact staging parity) |
| row count | 112 | **112** (no data change) |
| the 5 accuracy columns | 0/5 | **5/5** |
| `NOT NULL` columns | 6 | 6 (unchanged) |
| full 32-column governed row shape | rejected | **plans via `EXPLAIN`** |

PostgREST schema cache: event trigger `pgrst_ddl_watch` is present and enabled
(`evtenabled='O'`), so the DDL auto-notified a reload; an explicit
`NOTIFY pgrst, 'reload schema'` was also issued.

`EXPLAIN` does not execute — row count confirmed still 112 afterwards. Staging
was not modified.

## Not closed by this repair

- **End-to-end confirmation is outstanding.** It requires one commerce-executing
  production request, which has not occurred on v158.
- **B33-COM-001 remains NOT CERTIFIED on v158** for the same reason.
- **Wider ledger drift** — production is missing the entire 2026-08-17 ->
  2026-09-04 migration block. Only the five columns with proven, concrete impact
  were converged; the rest is recorded, not shotgun-applied.
- **`isMissingTableError` conflates `PGRST204` with `PGRST205`** (P4, recorded). A
  schema mismatch and a dropped table are materially different operational
  conditions and should not share a label. Had they been distinguished, this
  would have been diagnosable from logs alone.
- **No `EdgeRuntime.waitUntil`** (P4, recorded). Not the cause here, but both
  captures remain structurally vulnerable to isolate teardown.

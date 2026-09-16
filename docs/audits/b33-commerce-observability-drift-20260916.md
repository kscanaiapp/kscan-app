# B33-OBS-003 — production commerce observability silently dark

**Date:** 2026-09-16
**Severity:** P2 (observability loss, silently swallowed; blocks runtime certification)
**Status:** `FIXED_PRODUCTION_VERIFIED` (schema converged) / observability end-to-end re-confirmation pending next commerce-executing production scan
**Environments:** production `wyyuqfdxucjksghsmhry` · staging `yzqjvdfgefveprobvvyw`

## Summary

`scan-identify` v158 shipped to production on 2026-09-16 10:42:27Z carrying a
commerce-outcome row shape that production's `scan_commerce_events` table could
not accept. Every capture insert has failed since, and the failure is swallowed
to a `console.warn`. Production commerce observability went dark the same day.

This was found while attempting B33-COM-001 runtime certification — the telemetry
that certification depends on was itself broken.

## Root cause

`buildCommerceOutcomeRow` (`supabase/functions/scan-identify/commerceOutcomeCapture.ts`)
returns an object literal containing **all 32 keys** of `CommerceOutcomeRow`. Five
of them are the v124/v127 accuracy-telemetry columns:

    query_strategy, top_agreement_score, top_agreement_band,
    commerce_identity_version, commerce_funnel_version

They are set to `null` when not applicable, **but the keys are always present**.
PostgREST rejects an insert naming a column absent from its schema cache with
`PGRST204`. `isMissingTableError` matches on `'schema cache'`, so the failure is
classified as `capture_table_missing` and reduced to a `console.warn`.

Those five columns are added by
`supabase/migrations/20260823175314_scan_commerce_events_accuracy_telemetry.sql`.
**Staging applied it; production never did.** Production's ledger jumps
`20260816020548 -> 20260905171030`, skipping the entire 2026-08-17 -> 2026-09-04
block.

The fields entered the governed source on 2026-08-29 (`bc458f41`), but production
continued running an older deployed bundle until v158 — which is why capture kept
working until the deploy, then stopped instantly.

This is the same defect class as PR #428 Finding A: a migration that reached
staging and never reached production.

## Evidence

Schema divergence (read-only, `information_schema.columns`):

| environment | `scan_commerce_events` columns |
|---|---|
| staging | 34 |
| production (before) | 29 |

Capture rate against the authoritative scan counter (`scan_identify_usage_daily`):

| day | scans | commerce rows | intelligence rows |
|---|---|---|---|
| **2026-09-16** (v158 deploy) | **6** | **0** | **0** |
| 2026-09-13 | 1 | 1 | 1 |
| 2026-09-11 | 1 | 1 | 1 |
| 2026-09-09 | 2 | 2 | 2 |
| 2026-09-01 | 2 | 2 | 2 |
| 2026-08-30 | 9 | 7 | 7 |
| 2026-08-28 | 9 | 6 | 6 |

Capture ran at ~1.0 rows/scan for weeks, then broke cold on deploy day.

**Competing hypothesis tested and rejected.** `scan-identify` dispatches both
captures fire-and-forget (`void captureCommerceOutcome(...)`, `captureScanIntelligence(...)`)
and there is no `EdgeRuntime.waitUntil` anywhere in the function, so isolate
teardown dropping the promises was a plausible alternative cause. It is
disconfirmed: staging runs the same governed source with the same dispatch and
captured **52 rows in the 10 days to 2026-09-16 03:44**. The differentiator is
the schema, not the dispatch.

## Repair

Applied the staging migration's identical statements to production under
production's own ledger version **`20260916141413`** — the one-logical-migration /
two-ledger-identities pattern already recorded in
`config/migration-authority-manifest.json` for `legal_acceptances_ai_processing_consent`.

All five statements are `ADD COLUMN IF NOT EXISTS` (nullable, no default, therefore
metadata-only) plus `COMMENT ON COLUMN`. Additive and idempotent throughout.

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

`EXPLAIN` does not execute — row count confirmed still 112 afterwards.
Staging was not modified.

## Not closed by this repair

- **B33-COM-001 remains NOT CERTIFIED.** Every production scan served by v158 was
  `commerce_skipped` (`style_intent` x2, `multi_item_detection_only` x5), so the
  provider path has not executed once on v158. Restoring telemetry is a
  precondition for that certification, not the certification itself.
- **Wider ledger drift.** Production is missing the whole 2026-08-17 -> 2026-09-04
  migration block. Only the five columns with proven, concrete impact were
  converged here; the rest is recorded, not shotgun-applied.
- **Error classification defect (P4, recorded).** `isMissingTableError` matches
  `'schema cache'`, so `PGRST204` (unknown column) is reported as
  `capture_table_missing` (`PGRST205`). A schema mismatch and a dropped table are
  materially different operational conditions and should not share a label.
- **No `EdgeRuntime.waitUntil` (P4, recorded).** Not the cause here, but both
  captures remain structurally vulnerable to isolate teardown.

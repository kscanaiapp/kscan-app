# Image Quarantine and Retention

- **Date**: 2026-08-03 · companion to `secure-image-ingestion-architecture.md`

## Storage objects (all new, all additive)

| Object | Migration | Public | Client access |
|---|---|---|---|
| `image-ingestion-quarantine` bucket | `20260803220000_image_ingestion_quarantine_storage.sql` | No | `INSERT` only, own `auth.uid()` path prefix. No `SELECT`/`UPDATE`/`DELETE` policy exists for `authenticated`/`anon` at all. |
| `image-ingestion-clean` bucket | `20260803220100_image_ingestion_clean_storage.sql` | No | `SELECT` only, own path prefix. No `INSERT`/`UPDATE`/`DELETE` policy for `authenticated`/`anon`. |
| `image_scan_verdicts` table | `20260803220200_image_scan_verdicts.sql` | N/A (RLS) | `SELECT` only, `WHERE user_id = auth.uid()`. No `INSERT`/`UPDATE`/`DELETE` policy for `authenticated`/`anon`; `anon` has zero grants. |

All three are enforced structurally (RLS/bucket policy), not by application-code discipline alone — see `__tests__/security/imageIngestionQuarantineRls.test.js`, which reads the migration SQL directly and asserts no forbidden policy exists.

## Object key scheme

Clean objects use a deterministic, content-addressed, server-controlled key: `{userId}/{sha256Canonical}{ext}` (`security/scan-worker/scanQuarantineObject.js:buildCleanObjectKey`). This is never the client's filename, and two uploads that re-encode to identical bytes land on the same object — a second layer of storage dedup independent of the database-level duplicate-hash check below. Uploads to the clean bucket use `upsert: false`, so an object is never silently overwritten in place.

## Lifecycle

```
client                    quarantine bucket        scan worker              clean bucket / verdicts table
  |  upload (own path)  ->                            |                              |
  |                                                    | download, hash, rate-check   |
  |                                                    | dedup-check (see below)      |
  |                                                    | runIngestionGate()           |
  |                                                    |                              |
  |                                            CLEAN --+--> upload canonical bytes -->|
  |                                                    |     insert verdict row ----->|
  |                                                    | delete quarantine object     |
  |                                                    |                              |
  |                                       REJECTED_* --+     insert verdict row ----->| (no clean_object_id)
  |                                                    | delete quarantine object (bytes NEVER retained)
  |                                                    |                              |
  |                              SCANNER_UNAVAILABLE/  |     insert verdict row ----->| (rejection_category = transient code)
  |                              SCAN_TIMEOUT (< max   | quarantine object KEPT for retry
  |                              retries) -------------+                              |
  |                                                    |                              |
  |                              (>= MAX_TRANSIENT_    |     insert verdict row ----->|
  |                               RETRIES) ------------+ delete quarantine object (give up)
```

Source: `security/scan-worker/scanQuarantineObject.js:processQuarantineObject`, unit-tested end to end for every branch in `imageIngestionScanWorker.test.js`.

## Duplicate-hash handling

Before scanning, the worker checks `image_scan_verdicts` for an existing **unexpired `CLEAN`** row matching the same `user_id` + `sha256_original` (`findReusableCleanVerdict`). If found: the new quarantine upload is deleted immediately, a new verdict row is written pointing at the **same** `clean_object_id`, and no rescan or duplicate clean object is created. This directly satisfies "do not repeatedly rescan identical clean bytes... when a valid unexpired verdict exists" and "do not allow duplicate hashes to create unlimited stored copies."

## Retention / TTLs

| State | TTL | Enforced by |
|---|---|---|
| `CLEAN` verdict | 24 hours (`DEFAULT_CLEAN_VERDICT_TTL_MS`) | `scanQuarantineObject.js`; re-checked at consumption time by both `verdict.js:verify` (ephemeral tokens) and `tryon-clothes-pro`'s `resolveCleanImage` (DB-backed verdicts) |
| Rejected/terminal verdict | 24 hours (`DEFAULT_REJECTED_VERDICT_TTL_MS`) | Same table; rejected rows carry no bytes to clean up, only the record itself ages out |
| Transient (`SCANNER_UNAVAILABLE`/`SCAN_TIMEOUT`) retry | Up to `MAX_TRANSIENT_RETRIES` (3) attempts before the quarantine object is deleted and a final transient verdict recorded | `transientRetryCount` counts prior rows for the same `quarantine_object_id` |

`image_scan_verdicts_expires_at_idx` (partial index on `expires_at IS NOT NULL`) and `image_scan_verdicts_pending_idx` (partial index on `verdict = 'PENDING'`) exist specifically so a periodic cleanup job can efficiently find expired rows and stuck-pending scans without a full table scan. **No cleanup cron job is implemented in this pass** — the indexes are in place for one to be added; today, expiry is enforced at read-time (a verdict past `expires_at` is treated as invalid regardless of whether a background job has deleted the row yet).

## What "temporary cleanup" means concretely

- **Quarantine bytes**: deleted in every terminal path (`CLEAN` promotion, rejection, transient give-up) — never left behind except during the bounded retry window for a transient scanner failure.
- **Rejected bytes**: never copied anywhere else; the only trace is the verdict row's metadata (hash, detected format, size, verdict code) — never the bytes themselves, never a base64 encoding, never in a log line (`imageIngestionNoRawLogging.test.js`).
- **No temp files on disk anywhere in this pipeline** — everything is in-memory `Buffer`s end to end (`server.js`'s existing memory-only handling for `/api/analyze`; the scan worker downloads directly into memory via the Supabase Storage SDK).

## Staging vs. production

All three migrations are additive (new bucket rows, new table) and are intended to be applied to **staging** (`yzqjvdfgefveprobvvyw`) only, consistent with `[[supabase-migration-history-diverges-from-repo]]` — production (`wyyuqfdxucjksghsmhry`) migration history is known to diverge from the repo already, and applying new migrations there is out of scope for this pass (read-only structural comparison only, per the brief).

# Build 33 — production deletion-state reconciliation (Finding B) and orphan media (Finding C)

**Environment:** production `wyyuqfdxucjksghsmhry` · **Date:** 2026-09-16
**Method:** read-only. No row, object, flag or Auth record was mutated by this audit.
**Reporting:** aggregate and sanitized. No user ids, emails, restoration tokens, credential
secrets or private content appear anywhere in this document.

---

## 1. What actually happened

Production holds **8** `deletion_requests` rows at status `deactivated`, all with the grace
period elapsed (1–40 days past), all with `attempt_count = 0` and `worker_id` null. The
worker has been off since 2026-07-22 (`account_deletion_worker_enabled = false`,
`account_deletion_worker_dry_run = true`) and production has no `pg_cron`/`pg_net`
scheduler, so it has never run.

The Auth users for all 8 are nonetheless gone. `deletion_state_transitions` explains how:
for the whole cohort it contains exactly **8 rows, one per request, all with
`to_state = 'deactivated'`** and `actor_type` in (`admin`, `user`). **No purge transition
exists for any of them.** The Auth deletions therefore happened outside the governed worker
path entirely — the ledger records the deactivation and nothing after it.

The consequences were then automatic:

| mechanism | effect |
|---|---|
| 51 FKs to `auth.users` with `ON DELETE CASCADE` | every user-scoped row was removed |
| `deletion_requests.user_id` `ON DELETE SET NULL` | **all 8 rows lost their user id** |
| `storage.objects` has **no FK** to `auth.users` | storage was untouched |

---

## 2. Answers to the ten reconciliation questions

| # | Question | Finding |
|---|---|---|
| 1 | Which user-data tables still contain rows for the deleted users? | **None, and the question is no longer answerable by user id.** A sweep of every `uuid` identity column in `public` (45 columns / 44 tables) found **0 orphan rows**. |
| 2 | What disappeared by Auth FK cascade? | Everything user-scoped: 51 cascading FKs covering profiles, privacy, wardrobe, dressing rooms, looks, style chat, quota, device sessions, Apple credentials. |
| 3 | What intentionally survives Auth deletion? | Three `SET NULL` survivors, now anonymized: `scan_intelligence_events` (33 null-owner rows of 162), `content_reports.reported_user_id` (1 of 1), `outfit_decision_groups.created_by` (0). |
| 4 | Is Apple credential revocation complete? | **No, and it is no longer achievable.** `apple_auth_credentials` cascades on Auth deletion, so the encrypted refresh token needed to call Apple's revocation endpoint was destroyed. The table has **no revocation-state column**, so revocation was never recorded either way. The worker's Apple revocation gate never ran. See §4. |
| 5 | Does RevenueCat / subscription mirror cleanup apply? | **No.** Production contains zero tables matching revenuecat / subscription / entitlement / purchase. Not applicable to this version. |
| 6 | Was Dressing Room ownership transfer bypassed? | **Yes**, but nothing is left in a broken state. `transferSharedRooms` never ran; `dressing_rooms.user_id` cascades, so those rooms were deleted outright rather than transferred. Participants lost access to rooms that no longer exist. Not repairable — the content is gone. |
| 7 | Any shared-room records in an invalid ownership state? | **No.** 0 shares with a missing room, 0 memberships with a missing share, 0 rooms/shares/memberships with a missing owner. Totals: 26 rooms, 12 shares, 3 memberships. |
| 8 | Any storage media outside `style-library-images`? | **No.** The other two buckets (`legal-documents` 6 objects, `public-assets` 2) are public system-asset buckets whose objects have no owner. All user media is in `style-library-images`. |
| 9 | How did the Auth deletion occur? | Outside the worker. Only `deactivated` transitions exist; `attempt_count = 0`, `worker_id` null, `purge_started_at`/`purged_at` null for all 8. |
| 10 | Can these be reconciled without touching surviving shared data? | **Yes.** The rows carry no user id and no foreign key into live content, so a ledger-only update cannot reach any surviving data. |

---

## 3. Classification

**`ledger_only_reconciliation`** — for the 8 `deletion_requests` rows.

Every correlatable customer record is already gone; what remains incomplete is the lifecycle
ledger. `residual_data_cleanup_required` does **not** apply (0 orphan rows),
`shared_room_transfer_repair_required` does **not** apply (0 invalid ownership state, and the
rooms no longer exist), and the cohort is not `unsafe_to_auto_repair`.

Two qualifications that must not be folded into that label:

* **`credential_revocation_required`, and unsatisfiable.** Apple authorization revocation for
  these accounts never happened and can no longer be performed (§4). This needs an owner
  decision, not a code change.
* **Storage residue is tracked separately** as Finding C (§5) and is *not* part of this
  cohort's reconciliation. It cannot even be attributed to it: the orphan objects have 4
  distinct owners while the ledger has 8 user-id-less rows, so **the two sets cannot be
  correlated at all**.

### The worker cannot touch these rows

This is true by construction, not by luck. Both candidate RPCs exclude them twice:

```
list_deletion_purge_candidates      ... and dr.user_id is not null
claim_deletion_requests_for_purge   ... join public.profiles p on p.id = dr.user_id
                                    ... and dr.user_id is not null
```

and the `profiles` rows cascaded away too. Enabling the worker therefore cannot select them,
cannot call `deleteUser(null)`, and cannot build a storage prefix from a null id.

### Restoration tokens: checked, not exploitable

All 8 rows still carry a `restoration_token_hash`. All 8 are **expired**, none used, and
`restore_account_by_token_hash` checks expiry — so it fails closed. It has no explicit
`user_id is not null` guard, which is worth adding as defence in depth (P4, §6).

### Proposed smallest repair — NOT EXECUTED, needs authorization

Move the 8 rows to a terminal state and record why, touching nothing else:

1. Append one `deletion_state_transitions` row per request: `deactivated → purged`,
   `actor_type = 'admin'`, `reason_code = 'RECONCILED_OUT_OF_BAND_AUTH_DELETE'`, with
   sanitized metadata noting that Auth deletion and cascade completed outside the worker.
2. Set `status = 'purged'`, `purged_at = now()`, and clear `restoration_token_hash`
   (already expired; clearing removes a dead secret from the table).
3. Leave `user_id` NULL, leave `subject_ref` intact.

Scope: 8 rows in one table plus 8 append-only ledger rows. No Auth call, no storage call,
no cascade, no surviving-content reference. It is reversible in the sense that the prior
values are reconstructible from the transition rows it writes.

**This has not been executed.** Lifecycle finalization is a customer-data action and is held
for explicit authorization.

---

## 4. Apple revocation gap

The deployed worker (v25) gates the purge on Apple revocation and refuses to continue unless
it settles — that control is correct and present. It simply never ran for these 8 accounts.

Because `apple_auth_credentials` cascades with the Auth user, the encrypted refresh token is
gone, so revocation **cannot now be performed** for them. The table also has no
revocation-state column, so there is no record either way.

This is an owner/compliance decision, not an engineering one. Two things are worth doing
regardless, and neither is in this lane's scope:

* Add a revocation-state column so future audits can answer this question from data.
* Decide whether the out-of-band deletions require any Apple-facing disclosure.

---

## 5. Finding C — the 7 orphan objects (B33-STO-002)

| property | value |
|---|---|
| bucket | `style-library-images` (private) |
| object count | **7** |
| distinct vanished owners | 4 |
| path shape | `<uuid>/scans/…` (6) and `<uuid>/inspirations/…` (1), all `.jpg` |
| total size | 1,979,028 bytes (~1.93 MB) |
| created | 2026-06-24 … 2026-07-23 |
| **reference verification** | **0 of 7 still referenced; 7 of 7 unreferenced** |

The reference check spans every column in `public` that can hold a storage reference, not just
`dressing_room_items`. It carries its own control: of the **41** objects owned by *live* users,
**39 resolved to a reference**, which proves the query finds references when they exist. "7
unreferenced" is a real result, not a query artifact.

**Root cause is not prefix coverage.** All 7 sit under `scans`/`inspirations`, both already in
the deployed worker's prefix templates. They were never swept because the purge never ran.

**This also rules out backporting the retained-owner-media work queue** (`20260831140000`):
that queue is populated by a *successful* purge registering prefixes it deliberately retained
because a surviving transferred room still referenced them. Nothing was ever enqueued here.
A queue cannot service rows that were never written.

### Also found: 5 objects with no owner at all

A separate class — `owner IS NULL`, 5 objects, 2,075 bytes, all 2026-07-07, all unreferenced.
Ownership cannot be proven, so the sweep deliberately excludes them. Recorded, not actioned.

### Also found: 2 unreferenced objects owned by live users

Of the 41 live-owner objects, 2 have no reference. Same leak class, but for accounts that still
exist, so they are out of scope for an orphan-owner sweep. Recorded for a future pass.

### Deletion of the 7 historical objects — AUTHORIZATION REQUESTED

Not performed, and not performed by deploying the sweep (which ships disabled and dry-run).

* **Method if authorized:** dispatch `reconcile-orphan-media` once in dry-run, confirm it
  reports exactly 7 candidates / ~1.93 MB / 4 owners, then run it live once.
* **Rollback:** **none.** Storage removal is irreversible and these objects have no backup
  reference. This is the reason authorization is required.
* **Risk if not done:** deleted users' photographs remain stored indefinitely with no account
  and no reference — a data-minimisation exposure, not a functional defect.

---

## 6. Recorded, not actioned

| id | severity | finding | recommended action |
|---|---|---|---|
| B33-SEC-SP-01 | **P4 — low, not exploitable** | 4 functions with mutable `search_path`: `set_profiles_updated_at`, `set_updated_at`, `set_style_objects_updated_at`, `normalize_dressing_room_note`. All are `SECURITY INVOKER`; their bodies call only `pg_catalog` built-ins (`now`, `btrim`, `coalesce`, `nullif`, `char_length`), which cannot be shadowed because `pg_catalog` is searched first unless named explicitly; and neither `anon` nor `authenticated` holds `CREATE` on `public`, so a client role cannot create a shadowing object at all. Staging already sets `search_path` on all four. | One `ALTER FUNCTION … SET search_path` per function, in its own migration. Deliberately excluded here: it is behavioral DDL and does not belong in a privilege migration. |
| B33-SEC-RT-01 | P4 | `restore_account_by_token_hash` has no explicit `user_id is not null` guard. Not exploitable today — expiry check fails closed and all 8 tokens are expired. | Add the guard as defence in depth. |
| B33-OPS-LPP-01 | P3 (operational) | Supabase leaked-password protection is **disabled**. It is Auth **dashboard/API configuration, not a migration**. Enabling it affects only future signups and password changes — existing users and existing sessions are unaffected, and no current auth flow is incompatible. | Enable. Requires explicit authorization since it is an Auth config change. |
| B33-PERF-01 | P4 | Production performance advisor: **91** `auth_rls_initplan`, **63** `unused_index`, **17** `unindexed_foreign_keys`, **8** `multiple_permissive_policies` (179 total). | Not touched. No production hot path was shown by query evidence to be affected, and broad schema change is out of scope for a repair lane. |
| B33-SEC-RLS-01 | informational | 44 `auth_allow_anonymous_sign_ins` and 7 `rls_enabled_no_policy` advisor warnings. | Not elevated. No reachable unauthorized data path was demonstrated; the policies use `auth.uid()` and fail closed for unsigned callers. |
| B33-OBS-SVC-01 | P4 | `service_role` holds no `USAGE` on schema `internal` in production. Not currently a defect — the helpers there are called from RLS predicates, which evaluate as the querying role, and `service_role` bypasses RLS. | Record only. |

### Intentionally anonymous, verified unchanged

`get_public_room_preview(text)`, `get_public_room_decision_preview(text)` and
`get_item_reaction_counts(uuid[])` retain `anon` EXECUTE in production. The advisor flags all
three as `anon_security_definer_function_executable`; that is the public share-link contract
working as designed, and they enforce authorization internally. They are **not** defects.

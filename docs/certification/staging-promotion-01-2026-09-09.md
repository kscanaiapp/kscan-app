# Staging Promotion 01 / Repair 06 — staging closure certification

**Date:** 2026-09-09
**Lane type:** environment promotion + certification (no runtime source change)
**Canonical SHA promoted and certified:** `c2df4867366169c4a361ae1ed5bbdcc78e9be067`
**Approved staging project:** `yzqjvdfgefveprobvvyw`
**Production project:** `wyyuqfdxucjksghsmhry` — frozen, never a mutation target

---

## Verdict

**PASS — REPAIR 06 CLOSED IN STAGING**, with one carried-forward follow-up
(`search-vinted-secondhand` promotion still pending staging configuration; it
was never part of this authorization).

Every deployed bundle in this promotion is byte-identical to the same canonical
runtime authority. The Repair 06 migration is present and exact on staging. The
terminal rule — `purgeAuthorized === true` if and only if `status === 'purged'`
**and** `purged_at IS NOT NULL` — is proven against the deployed bytes. All
synthetic fixtures were removed and the table is bit-identical to its pre-state.

---

## 1. Authority

Re-fetched, not assumed, before and after every mutation.

| Item | Value |
|---|---|
| canonical branch | `rebuild/backend-authority-v2` |
| canonical SHA (origin) | `c2df4867366169c4a361ae1ed5bbdcc78e9be067` |
| role | `backend-deployment-authority` |
| approved staging ref | `yzqjvdfgefveprobvvyw` |
| governed function count | 24 (config) / 24 (source) |
| manifest digest | `3efffee3e7b26b884945fbf8008176ab5e7694696788d9230b16eda841184b4e` |
| worktree | clean at the canonical SHA, before and after mutation |

Canonical did not move during the lane. Every one of the six deployments ran
from the identical head SHA, so "byte-identical to canonical" means identical to
*one* authority, not to six moving ones.

Gates, re-run after all staging mutation:

```
node scripts/verify-backend-authority.js                 PASS  (exit 0)
node scripts/generate-edge-function-manifest.js --check   PASS  (exit 0)
node scripts/check-edge-function-parity.js                PASS  (exit 0)
node scripts/check-migration-provenance.js                PASS  (exit 0)
node scripts/check-dependency-reachability.js             PASS  (exit 0)
npx tsc --noEmit                                          PASS  (exit 0)
```

---

## 2. The six-function promotion

All six ran through the governed `K Scan Staging Controlled Deploy`
(`.github/workflows/staging-controlled-deploy.yml`) with
`EXPECTED_STAGING_REF=yzqjvdfgefveprobvvyw` and its explicit production-ref
refusal. One function per dispatch; the next was not dispatched until the
previous one had been independently verified.

| # | run | function | version | verify_jwt | bundle expected/observed | byte-identity | unexpected files |
|---|---|---|---|---|---|---|---|
| 1 | [34296815191](https://github.com/kscanaiapp/kscan-app/actions/runs/34296815191) | `stylechat-generate` | 122 → 123 | true | 54 / 54 | MATCH | 0 |
| 2 | [34297133330](https://github.com/kscanaiapp/kscan-app/actions/runs/34297133330) | `privacy-correction-request` | 59 → 60 | true | 3 / 3 | MATCH | 0 |
| 3 | [34297509876](https://github.com/kscanaiapp/kscan-app/actions/runs/34297509876) | `privacy-data-export` | 58 → 59 | true | 3 / 3 | MATCH | 0 |
| 4 | [34297776186](https://github.com/kscanaiapp/kscan-app/actions/runs/34297776186) | `product-search-deals` | 61 → 62 | true | 3 / 3 | MATCH | 0 |
| 5 | [34298092688](https://github.com/kscanaiapp/kscan-app/actions/runs/34298092688) | `deletion-status` | absent → 1 | **false** | 2 / 2 | MATCH | 0 |
| 6 | [34298858789](https://github.com/kscanaiapp/kscan-app/actions/runs/34298858789) | `handle-user-deletion` | 75 → 76 | true | 5 / 5 | MATCH | 0 |

All six: `workflow_dispatch`, `conclusion: success`, head
`c2df4867366169c4a361ae1ed5bbdcc78e9be067`.

**Workflow success was not accepted as parity evidence.** For each function the
deployed payload was pulled back from staging and every file in the deployable
bundle was hashed and compared against the canonical manifest SHA-256. Missing,
mismatched and unexpected files were counted separately, and all three are zero
across all six.

Note on counting: manifest `files[]` is the *tree* list; the deployable bundle is
the `bundle: true` subset. `stylechat-generate` is 54 bundle files (80 in tree),
`deletion-status` 2 (3 in tree), `handle-user-deletion` 5 (6 in tree).

### Environment delta

Full staging Edge Function inventory, promotion pre-state vs post-state:

```
ADDED     deletion-status              -> v1  verify_jwt=false
CHANGED   handle-user-deletion         v75  -> v76
CHANGED   privacy-correction-request   v59  -> v60
CHANGED   privacy-data-export          v58  -> v59
CHANGED   product-search-deals         v61  -> v62
CHANGED   stylechat-generate           v122 -> v123
changed: 6   unchanged: 28   total: 33 -> 34
```

Nothing outside the authorized six moved. `search-vinted-secondhand` remains at
v52 — deliberately held back (see §7).

---

## 3. The Repair 06 migration on staging

`supabase/migrations/20260908230000_deletion_status_receipt.sql`,
SHA-256 `b8eda3f6f8258d9176fb0a965a211960d0c09a4d10d742a71273a6ccdb20c5e0`.

Classified **Case A — already applied and schema exact**, so it was not
reapplied. Live post-state proven directly against the staging schema:

| Required property | Observed |
|---|---|
| ledger records the migration | exactly one row, version `20260908230000`, name `deletion_status_receipt` |
| ledger total | 155 |
| `status_receipt_hash` exists | yes |
| type | `text` |
| nullable | `YES` |
| default | none (`column_default` is NULL) — no invented values |
| partial unique index | `deletion_requests_status_receipt_hash_uidx` |
| index predicate | `WHERE (status_receipt_hash IS NOT NULL)` |
| existing lifecycle rows rewritten | no — 6 rows, 0 hashes, id digest unchanged |
| raw-receipt column | none (`other receipt-named columns = 0`) |
| unrelated schema change | none; `deletion_requests` column count 36 |

Live index behaviour was probed rather than assumed, on synthetic rows only:

- inserting a second row with an already-used capability hash → refused by
  `deletion_requests_status_receipt_hash_uidx` (`unique_violation`);
- two rows with `status_receipt_hash IS NULL` coexist without colliding.

Both probes left zero residue.

### Governance caveat on the apply path

`security/scripts/apply-candidate-migrations.js` could not execute in the
certification sandbox because the Supabase CLI/token/link/network prerequisites
were unavailable. The lane therefore applied only the already-classified Repair
06 candidate through the staging Management API SQL path and recorded the exact
migration version afterward, reproducing the helper's narrow apply-and-record
semantics. The governed helper itself was not executed and is not claimed as
such. Post-state was independently verified against the staging schema and
migration ledger. Production was never targeted.

`security/scripts/select-candidate-migrations.js`'s `assertNotProductionRef` was
exercised independently: it refuses `wyyuqfdxucjksghsmhry` and accepts the
staging ref.

---

## 4. Deployed configuration

| Function | verify_jwt | canonical config | matches |
|---|---|---|---|
| `handle-user-deletion` | true | `supabase/config.toml` default | yes |
| `deletion-status` | **false** | `[functions.deletion-status] verify_jwt = false` in `supabase/config.toml` and `supabase/functions/deletion-status/config.toml` | yes |

`verify_jwt = false` on `deletion-status` is intentional and is the whole point
of Repair 06: deletion intake revokes sessions and bans the Auth user for the
grace window, and `process-account-deletions` later deletes the Auth identity
outright, so at the moment the terminal answer exists there is no identity left
to authenticate. The 256-bit opaque receipt is the credential. This must not be
"fixed" to `true`.

---

## 5. Live terminal contract — CASE matrix

### How it was executed

Outbound HTTPS from the certification sandbox to `*.supabase.co` is refused by
the environment proxy (`CONNECT tunnel failed, response 403`), so **live HTTP
invocation of the deployed endpoint was not executed from here**. Instead:

1. the deployed payload was pulled back from staging `deletion-status` v1 and
   written to disk — both files hash identically to canonical
   (`index.ts` `d1186f04…`, `_shared/deletion/statusReceipt.ts` `7d698484…`);
2. those *deployed bytes* were transpiled and executed under a `Deno.serve`
   capture harness;
3. the PostgREST response was served from the exact JSON body PostgREST returns
   for the real staging rows, captured from staging with `to_jsonb` over the same
   projection the function selects;
4. the URL the deployed code builds was asserted verbatim, not assumed.

The only substituted hop is the network transport. Everything else — the code,
the lifecycle rows, the response encoding — is the real thing.

The harness was negative-controlled: two deliberate mutations of the deployed
source (authorising purge on `status` alone; honouring `?receipt=` on GET) were
detected as CASE 2, CASE 10 and INVARIANT failures. The mutated copy was then
destroyed.

### Fixtures

Six synthetic `deletion_requests` rows, `user_id NULL`, `user_email NULL`,
`request_source = 'admin'`, tagged `SP01-REPAIR06-FIXTURE` in `internal_notes`.
No real customer, employee, owner account, production data or pre-existing
lifecycle was used. Each carried a freshly generated `ksdel_v1_` capability; only
its SHA-256 was ever written to the database. The raw values never left the
certification scratchpad — not into the database, a URL, this repository, this
document, or any log.

### Results

| Case | Condition | Result |
|---|---|---|
| 1 | `pending` / nonterminal | `state: pending`, `purgeAuthorized: false` — PASS |
| 2 | `purged` with `purged_at` missing | `purgeAuthorized: false` — PASS |
| 2b | `purged_at` present under `status ≠ purged` | `state: pending`, `purgeAuthorized: false` — PASS |
| 3 | `purged` + `purged_at` present | `state: purged`, `purgeAuthorized: **true**`, carries `purgedAt` — PASS |
| 4 | `restored` lifecycle | `state: restored`, `purgeAuthorized: false`, carries `restoredAt` — PASS |
| 5 | `purging` | `state: pending`, `purgeAuthorized: false` — PASS |
| 6 | `legal_hold` | `state: pending`, `purgeAuthorized: false` — PASS |
| 7 | `failed` | `state: failed`, `purgeAuthorized: false` — PASS |
| 8 | malformed receipt (12 shapes) | `400 {"error":"invalid_request"}`, **zero** database lookups — PASS |
| 8b | wrong content-type / unparseable / oversized body | `400`, zero lookups — PASS |
| 9 | unknown but validly-shaped receipt | `404 {"error":"not_found"}`, no enumeration — PASS |
| 10 | GET/HEAD/PUT/DELETE/PATCH, and `?receipt=` in the query string | `405`, capability never read from the URL; a POST with the receipt only in the query string is a `400` with no lookup — PASS |

Plus:

- **INVARIANT** — all 24 combinations of the full
  `deletion_requests_status_check` vocabulary × (`purged_at` null / present),
  plus an unrecognised status and a null status: `purgeAuthorized` is true for
  exactly the one combination `status = 'purged' AND purged_at IS NOT NULL`. PASS
- **FAIL-CLOSED** — a failed lookup returns `503` and never a terminal answer. PASS
- **READ-ONLY** — every outbound database call across all six fixtures is a
  bodyless `GET`. No write, no RPC, no Auth admin call, no storage call, no
  provider call. PASS
- **NO-LEAK** — the raw receipt appears in no response body and in no outbound
  URL; the stored hash is never returned. PASS

18 checks, 0 failures.

CASE 2 and CASE 2b describe rows the staging database cannot hold:
`deletion_requests_purged_at_status_check` enforces
`(purged_at IS NULL AND status IS DISTINCT FROM 'purged') OR (purged_at IS NOT NULL AND status = 'purged')`.
That was proven by probe — an attempted `purged`/`purged_at NULL` insert raised
`check_violation` and committed nothing. The constraint was **not** weakened to
manufacture the inconsistent state; the endpoint is checked against it anyway,
through the deployed code path, because a constraint can be dropped by a later
migration and this boolean authorises irreversible destruction of a user's data.

### Fixture cleanup

| Metric | Pre-state | Post-cleanup |
|---|---|---|
| `deletion_requests` rows | 6 | 6 |
| rows with `status_receipt_hash` | 0 | 0 |
| rows tagged `SP01-REPAIR06-FIXTURE` | 0 | 0 |
| rows with `request_source = 'admin'` | 0 | 0 |
| `md5` digest of all row ids | `9a943ed02bba8af164372953eacd92ed` | `9a943ed02bba8af164372953eacd92ed` |
| child `deletion_state_transitions` for fixtures | — | 0 |
| child `deleted_owner_retained_media` for fixtures | — | 0 |

The id digest is identical, so the surviving rows are the same rows, not a
same-sized replacement. `deletion_requests` carries only an `updated_at` trigger,
no audit fan-out, and both FK children were checked directly.

**Fixture residue: none.**

---

## 6. Security / privacy invariants

| Invariant | Evidence |
|---|---|
| raw status receipt never stored server-side | every `text`/`varchar` column of every base table in staging `public` scanned for a `ksdel_` prefix — **0 occurrences**; all 6 stored values were lowercase 64-hex SHA-256 |
| restoration token is not reused as the status credential | separate column, separate generator, separate lifetime — `deletionStatusContract` tests 33–35, 49, 50 |
| receipt lookup accepts no caller-supplied `user_id` | the outbound URL predicate is `status_receipt_hash=eq.<hash>` and nothing else — asserted verbatim per case |
| `deletion-status` performs no DB write | READ-ONLY check: every outbound call is a bodyless GET |
| no Auth admin action | the deployed bundle is 2 files and excludes `_shared/deletion/common.ts`, the module carrying the `auth.admin` footprint — `deletionStatusContract` test 54 |
| no storage mutation | same; the bundle imports nothing but `statusReceipt.ts` |
| `Cache-Control: no-store` | asserted on every response in the case matrix |
| POST-only | CASE 10 |
| malformed vs unknown are not an existence oracle | CASE 8 / CASE 9 — both are a single generic error string, and a malformed receipt never reaches the database at all |
| receipt survives terminal Auth deletion | `deletion_requests.user_id` is nullable with `ON DELETE SET NULL`, and `userDataResources.ts` tags the row `survive_auth_delete`; `mark_deletion_request_purged` clears `restoration_token_hash` but not `status_receipt_hash` — tests 49–51 |
| `restoration_token_hash` behaviour unchanged | test 50; the migration is additive only |
| 30-day restoration period unchanged | `GRACE_PERIOD_DAYS = 30` untouched; no worker semantics changed |
| lookup cannot restore, delete, or alter deletion state | test 56; single SELECT by construction |

---

## 7. Receipt-binding contract (Repair 07 prerequisite)

The deployed `handle-user-deletion` v76 bundle is byte-identical to canonical, so
the binding behaviour proven by the executable source tests is the behaviour
staging now runs:

| Requirement | Test |
|---|---|
| client-supplied receipt is hashed and bound in the **same insert** as the lifecycle row | 38, 39 |
| only the SHA-256 is stored | 38, 47 |
| a client-supplied receipt is never echoed back | 38 |
| a server-minted receipt is returned only when the client supplied none | 40 |
| an already-bound lifecycle is never rotated to a different receipt | 45 |
| the same receipt again is idempotent | 44 |
| a malformed supplied receipt creates no lifecycle at all | 41 |
| a project without the migration still accepts deletions (degrades to `statusReceiptBound: false`) | 42 |
| **network-loss recovery** — a client that never receives the response can still resolve status | **46** |

`__tests__/deletionStatusContract.test.js`: 56 tests, 56 pass.

**LIVE INTAKE DESTRUCTIVE TEST = NOT EXECUTED / NO GOVERNED DISPOSABLE ACTOR.**
Deletion intake revokes sessions, bans the Auth user for the full grace window,
and schedules irreversible purge; no governed disposable staging actor exists for
that, and inventing one was outside this lane. Live HTTP invocation was in any
case impossible from this sandbox (§5). Per the mission's own terms this does not
invalidate the byte-identical deployed source + exact schema + status-endpoint
certification.

### Carried-forward follow-up

`search-vinted-secondhand` remains deliberately off
`security/scripts/staging-deployment-allowlist.js`. `runApify()` hard-requires
`APIFY_VINTED_ACTOR_ID` and `APIFY_API_TOKEN`, and
`docs/staging-rebuild/secret-name-manifest.md` records both as absent on staging.
Deploying it would ship hardened source that can only answer
`SECONDHAND_RESULTS_UNAVAILABLE`. Setting secrets was outside this lane's
authority. **Vinted staging promotion pending staging configuration.**

---

## 8. Production freeze

Read-only verification. Production was never a mutation target.

| Check | Result |
|---|---|
| Edge Functions deployed | 18 — unchanged from the RP-06A.3 baseline |
| `deletion-status` on production | absent |
| `stylechat-generate` | v100 (baseline v100) |
| `privacy-correction-request` / `privacy-data-export` | v39 / v39 (baseline v39 / v39) |
| `product-search-deals` | v86 (unchanged) |
| `handle-user-deletion` | v84 (unchanged) |
| latest production function update | 2026-08-17 — weeks before this lane |
| migration ledger | 91 rows, max version `20260905171030` |
| `deletion_requests.status_receipt_hash` | **absent** |
| `deletion_requests_status_receipt_hash_uidx` | **absent** |

Production Edge Function deploys: 0. Production migrations: 0. Production
database writes: 0. Production secret/env changes: 0. EAS builds: 0. EAS
Updates: 0. TestFlight actions: 0. App Store actions: 0.

---

## 9. Regression

Run after all staging mutation, on the canonical SHA with a clean worktree.

```
node scripts/run-all-tests.js
  test files executed : 447
  tests               : 8191
  pass                : 8113
  fail                : 13
  skipped             : 65
Known full-suite failure baseline: 19 identities.
Observed failures: 13; known: 13; unexpected: 0.
```

**Unexpected failures: 0.** Identical to the pre-mutation run of the same suite
on the same SHA (8191 / 8113 / 13 / 0 unexpected), so the staging promotion moved
nothing in the governed test surface.

Focused suites, all green:

| Suite | Result |
|---|---|
| `deletionStatusContract.test.js` | 56 / 56 |
| deletion subsystem + parity/provenance/reachability gates (12 files) | 285 / 285 |
| Repair 06 deployed-byte CASE matrix (this lane) | 18 / 18 |


`config/test-failure-baseline.json` was not modified.

### Environment limitation

The local Deno toolchain remains unavailable in this sandbox (`deno.land:443` is
refused by the proxy, and invoking `deno` contaminates `node_modules`). The
governed backend Deno suite therefore runs in GitHub CI — workflow
**Security - Code and Dependencies**, job *Project checks* — not locally. That is
stated rather than papered over with a fake local PASS.

---

## 10. What this record does not claim

- It does not claim the governed migration helper executed (§3).
- It does not claim live HTTP invocation of the staging endpoint (§5).
- It does not claim a live destructive intake test (§7).
- It does not claim `search-vinted-secondhand` is promoted (§7).
- It does not claim anything about production beyond "unchanged" (§8).

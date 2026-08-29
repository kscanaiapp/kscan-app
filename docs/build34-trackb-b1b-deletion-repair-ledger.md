# Build 34 / Track B / Phase B1B — Deletion + Privacy Authority Repair: Ledger

Status: **DEPLOYED TO STAGING — DEFECTS A & B CLOSED**
Phase: B1B (registry repair only — no new deletion mechanism, no new migrations)
Production: **NOT TOUCHED**

See [docs/build34-trackb-closet-facts-ledger.md](./build34-trackb-closet-facts-ledger.md) for the B1A schema/RLS contract this phase builds on.

## Source authority

| | |
|---|---|
| Parent branch | `feature/backend-build34-closet-facts-v1` |
| Parent SHA (B1A) | `a617dc364372ba1d46214d49521453426fb7212e` |
| Repair branch | `repair/backend-build34-closet-deletion-v1` |
| Final SHA | `c3bd93ceeaa7b083c241bdb9e5337f6fa87cd770` |
| Staging project | `yzqjvdfgefveprobvvyw` |

No newer cumulative Build 34 backend integration branch had absorbed B1A at the time this phase started (`maintenance/b34-def001-backend-authority` is a documented, unrelated pre-existing gap — see `docs/build34-kplus-ledger.md`); confirmed via `git merge-base --is-ancestor` against every `*backend*`/`*track-b*` remote branch.

## Authority map (proven from actual consumers, not assumed)

| Role | File | Symbol | Consumers | Authoritative? |
|---|---|---|---|---|
| Table registry (Node) | `lib/account-deletion/user-data-resources.json` | `.tables` | `loadRegistry.cjs` → `scripts/process-deletion-request.js` (manual CLI); `userDataResources.mjs` → `processorCore.mjs` (shared pipeline core) | YES — single JSON source for every Node-side consumer |
| Storage registry (Node) | same JSON | `.storage` | same as above | YES |
| Table/storage registry (Deno) | `supabase/functions/_shared/deletion/userDataResources.ts` | `USER_DATA_RESOURCES`, `STORAGE_RESOURCE_TEMPLATES` | **only** `supabase/functions/process-account-deletions/index.ts` (confirmed by grep — no other Edge Function imports it) | Documented as a manual **mirror** of the JSON, not independently authoritative; must match it for the entries it declares |
| Privacy export inventory | `supabase/functions/privacy-data-export/index.ts` | inline `manifest` object | itself only | Separate, static, non-registry — see Defect/Export section below |
| Account deletion entrypoint (user-facing intake) | `supabase/functions/handle-user-deletion/index.ts` | `Deno.serve` handler | mobile app | Creates the `deletion_requests` row only; does not import either registry |
| Background/automated deletion processor | `supabase/functions/process-account-deletions/index.ts` | `processClaimedRequest`, `Deno.serve` handler | pg_cron / scheduled dispatch, worker-secret protected | YES — the live, scheduled purge path |
| Manual/audited deletion processor | `scripts/process-deletion-request.js` → `lib/account-deletion/processorCore.mjs` | `runHardDeletePipeline` | operator CLI (`docs/account-deletion-operations.md`) | YES — the audited manual path, same registry as above |
| Final auth user delete | inside both processors | `supabase.auth.admin.deleteUser(userId)` | — | Embedded in each processor, not a separate file |

Actual flow (automated worker, the default path):
```
process-account-deletions (pg_cron / scheduled invocation, worker-secret gated)
  → claim_deletion_requests_for_purge (RPC)
  → deleteDirectUserRows        (direct_delete_before_auth resources)
  → transferSharedRooms         (dressing room ownership handoff)
  → deleteOwnedStorage          (STORAGE_RESOURCES prefixes, paginated, reference-checked)
  → supabase.auth.admin.deleteUser(userId)   [cascades every ON DELETE CASCADE FK]
  → post-delete residual verification over USER_DATA_RESOURCES (excluding survive_auth_delete / parent-cascade entries)
  → mark_deletion_request_purged (RPC)
```
Manual CLI flow is identical in shape (`runHardDeletePipeline` in `processorCore.mjs`), minus the lease/claim machinery, plus its own operator safety gates (`assertCliPurgeEligible`, `assertGlobalGuardrailsForManualPurge`).

**K+ dependency: NONE.** Confirmed by full read of both processors (no reference to `has_active_k_plus`, `kplus_has_active_entitlement`, `RevenueCat`, or `grant_reason` anywhere in the deletion pipeline) and pinned by a new static test (`account deletion pipeline never consults K+ entitlement state`).

## Defect A — `user_closet_items` deletion coverage

- **Reproduced:** YES. Confirmed live on staging that the table exists (created in B1A) and was absent from both `USER_DATA_RESOURCES` copies.
- **Root cause:** B1A deliberately deferred registry wiring (its own Section 32). Nothing malicious — a scoping decision, not a bug in the table itself.
- **Current deletion method: CASCADE.** `user_closet_items.user_id references auth.users(id) on delete cascade` (B1A schema) already removes rows when the Auth user is deleted — proven live on staging by deleting a disposable synthetic user's `auth.users` row directly and confirming their `user_closet_items` rows (and `user_entitlements` row) disappeared with zero explicit delete statement against either table.
- **Current export coverage:** NO (see Privacy Export below) prior to this phase's manifest-line addition.
- **Repair:** registered `{ table: 'user_closet_items', column: 'user_id', action: 'auth_delete_cascade', optional: true }` in both the JSON (Node) and TS (Deno) registries. `action: 'auth_delete_cascade'`, not `direct_delete_before_auth` — no new deletion code, only coverage/residual-verification counting via the existing generic loop. `optional: true` because the table is staging-only (matches the existing convention for `user_entitlements`/`kplus_activation_events`).

## Defect B — saved-scans Storage purge drift

- **Reproduced:** YES, and it was live/real, not merely a lint gap: the automated worker (`process-account-deletions`) only ever iterated `{userId}/scans` and `{userId}/inspirations` — saved-scan images uploaded by `services/savedScanMedia.ts` to `style-library-images/{userId}/saved-scans/{savedScanId}.jpg` were never purged by the live automated path.
- **Root cause:** the Deno mirror (`supabase/functions/_shared/deletion/userDataResources.ts`) drifted from the JSON source of truth, which already had `{userId}/saved-scans` correct. No dedicated automated parity test existed for the *content* of that one field (only a manual "MUST match" code comment referencing a `deletionRegistryParity.test.js` file that does not exist in this repo — likely renamed at some point; the actual reproduction/pin test lives in `__tests__/processDeletionRequest.test.js`, already present in the repo before this phase and already red).
- **Authoritative file (bucket/prefix, confirmed from source):**
  - bucket: `style-library-images` (private; confirmed via `storage.buckets`)
  - exact normalized prefix: `{userId}/saved-scans` (no trailing slash — matches the two pre-existing templates' convention; `services/savedScanMedia.ts` writes `{userId}/saved-scans/{savedScanId}.jpg`)
  - divergent copy: `supabase/functions/_shared/deletion/userDataResources.ts` (fixed); `lib/account-deletion/user-data-resources.json` was already correct.
- **Repair:** added `'{userId}/saved-scans'` to `STORAGE_RESOURCE_TEMPLATES` in the `.ts` mirror. No new prefix invented (`{userId}/closet/` is explicitly out of scope — B1C).

## Storage contract (as verified from source; mechanism code unchanged by this phase)

```
bucket:                      style-library-images (private)
exact normalized prefix:     {userId}/saved-scans   (also {userId}/scans, {userId}/inspirations)
trailing slash behavior:     none on the prefix; listed names are joined as `${prefix}/${item.name}`
listing method:               bucket.list(prefix, { limit: 1000, offset }), looped until page.length < limit (P2-4 fix, pre-existing)
pagination:                   confirmed in source (listStoragePrefix / listPrefixPaths), unchanged
delete method:                bucket.remove(paths) after a reference-check against dressing_room_items.storage_path (fail-closed on reference-check error)
owner binding:                 userId is always a database uuid (auth.users.id / deletion_requests.user_id, itself uuid-typed) -- never free client text; prefixes are server-constructed, not caller-supplied, so path-escape is structurally not applicable (the stronger control per governing Section 25)
missing-object behavior:      'no_objects' / 'missing_storage_prefix_or_bucket' status, no error
retry behavior:                idempotent -- a second run against an already-empty prefix is a no-op (pre-existing test, still green)
```
This phase changed only the registry **data** (which prefixes exist); the removal mechanism itself (pagination, idempotency, reference-check, partial-removal detection) is pre-existing and was not modified.

## Privacy export

- **Same central registry?** NO. `privacy-data-export/index.ts` does not import `USER_DATA_RESOURCES`/`STORAGE_RESOURCES` at all — it only creates a `privacy_export_requests` row with a static, descriptive `manifest` object (`includes` / `excludes_pending_legal_review` / a raw-scan-storage note). No per-table export code exists anywhere in the repo for any table, Closet included.
- **`user_closet_items` exported?** Not applicable as a distinct field-level export (no table is field-level exported by this function); left uncovered by name in the manifest prior to this phase's change.
- **Implementation path:** request-intake only; fulfillment is an out-of-band, legally-reviewed manual process per the function's own wording (`excludes_pending_legal_review`).
- **Fields exported:** none mechanically enumerated for any table. Per Section 18's instruction not to redesign the export format, this phase did not add a Closet-specific manifest line either, since doing so would be the first table-specific entry in an otherwise fully generic manifest and no other B34 table (not even `user_entitlements`) has one — that would be a design decision beyond a narrow registry repair. **Recorded as an out-of-scope finding below**, not fixed in B1B.
- `row_version` / `schema_version`: not applicable — no field-level export path exists to include or exclude them from.

## Contract tests (live staging, disposable synthetic actors, all cleaned up)

Created and destroyed 3 synthetic `auth.users` rows for this phase only (`b1b-actor-{e,f,g}-*@kscan-test.invalid`), distinct from the reusable B1A K+ test identities:

- Actor E: active K+, 2 `user_closet_items` rows.
- Actor F: **expired** K+ (backdated `expires_at`), 1 `user_closet_items` row.
- Actor G: active K+, 1 `user_closet_items` row (isolation control).

| Test | Result |
|---|---|
| Delete E's `auth.users` row → E's 2 Closet rows + entitlement row gone | PASS (cascade) |
| F and G untouched after E's deletion | PASS (isolation) |
| Delete F's `auth.users` row (K+ was expired) → F's Closet row gone | PASS (K+-independent) |
| G untouched after F's deletion | PASS (isolation, second actor) |
| Re-delete E's already-gone `auth.users` row | PASS (0 rows affected, no error — idempotent retry) |
| All 3 fixtures removed at completion | PASS (`0` remaining `auth.users`/`user_closet_items`/`user_entitlements` rows for the fixture emails) |

Unit-level (mocked, `__tests__/processDeletionRequest.test.js`, new in this phase):
- `USER_DATA_RESOURCES` registers `user_closet_items` with the correct column/action(`auth_delete_cascade`)/optional flag.
- Registry text contains `user_closet_items` in both the `.ts` and `.json` copies.
- Static source check: neither `process-account-deletions/index.ts` nor `processorCore.mjs` references K+/RevenueCat/grant_reason.

Pre-existing (already in the repo, now green because of the `.ts` fix): the 5 saved-scans tests in `__tests__/processDeletionRequest.test.js` (registry-content parity, single/multiple object removal, cross-user isolation, idempotency, no-broad-delete).

## Negative controls

| Control | Method | Result |
|---|---|---|
| A — Closet registry entry removed | In-memory filter (`USER_DATA_RESOURCES.filter(r => r.table !== 'user_closet_items')`) re-run through the exact migration-coverage scan; no file touched | Coverage check correctly re-flags `user_closet_items` as missing → PASS (detects) |
| B — saved-scans prefix removed | In-memory `.replaceAll('{userId}/saved-scans', '')` on the real file's text; no file touched | Parity assertion correctly fails to match → PASS (detects) |
| C — K+ independence | Live staging: deleted Actor F's `auth.users` row while F's K+ was expired, via the same raw FK-cascade path the real pipeline relies on | Deletion succeeded, Closet row removed — PASS (no K+ check exists to expose) |

Per Section 26's stated preference, A and B were performed as in-memory/test-time overrides rather than live staging mutations (no policy, constraint, or file on staging was ever weakened); C was necessarily a live test since it is a live-data claim (an actual expired-K+ actor's real deletion), and used freshly created, fully cleaned-up disposable fixtures.

## Staging deployment

```
FUNCTION:     process-account-deletions
SOURCE BRANCH: repair/backend-build34-closet-deletion-v1
SOURCE SHA:    c3bd93ceeaa7b083c241bdb9e5337f6fa87cd770
STAGING PROJECT: yzqjvdfgefveprobvvyw
DEPLOY COMMAND: node scripts/deploy-edge-functions.js --function process-account-deletions --confirm-deploy process-account-deletions
DEPLOY RESULT: success (Management API deploy, function version 51, status ACTIVE)
POST-DEPLOY HASH/PARITY EVIDENCE: fetched the live deployed file content via the Supabase MCP get_edge_function tool; sha256 of the deployed
  supabase/functions/_shared/deletion/userDataResources.ts is 5915d0f2bceb8653618a1eb989bdcd62ac37d883633bd352752eb7d790ced10c,
  an exact match to config/edge-function-manifest.json's recorded hash for that file at commit c3bd93c.
```
Only `process-account-deletions` was deployed. Proven by grep: it is the *only* Edge Function among the 19 governed functions whose source imports `_shared/deletion/userDataResources.ts` (confirmed via `resolveBundle`'s bundle-file diff, which showed exactly one function entry changed in the regenerated manifest). `handle-user-deletion` (governed, but does not import the changed file) and every other governed function were left untouched and their manifest entries are byte-identical before/after.

**Not invoked live** (dry-run/live worker HTTP call): `ACCOUNT_DELETION_WORKER_SECRET` is a server secret not available in this environment, and this session does not attempt to obtain or guess server secrets. The DB-level cascade guarantee (the actual mechanism Defect A concerns) was instead proven directly and more rigorously via a real `DELETE FROM auth.users` against disposable staging fixtures, which exercises the identical Postgres FK constraint the deployed worker relies on, independent of the HTTP layer around it.

## Regression

- Focused: `node --test __tests__/processDeletionRequest.test.js` → 62/63 pass (the 1 failure is the pre-existing, unrelated 11-table migration-coverage gap; `user_closet_items` confirmed removed from its "missing" list).
- Focused: `node --test __tests__/edgeFunctionSourceParity.test.js` → 22/22 pass (manifest regenerated and current).
- Full suite: see final report Section I for the exact fixed/remaining/new-regression classification against the B1A baseline (4,703/4,781 pass, 19 fail).

## Migration governance

```
NEW MIGRATIONS:                     NONE
B1A MIGRATIONS MODIFIED:            NO
HISTORICAL MIGRATION MANIFEST CHANGED: NO (config/migration-authority-manifest.json diff is empty)
```

## Out-of-scope findings (not fixed in B1B)

- `USER_DATA_RESOURCES covers all user-linked tables in migrations` remains failing for 11 pre-existing, unrelated tables (`provider_request_reservations`, `provider_security_events`, `privacy_request_rate_limits`, `apple_auth_credentials`, `wardrobe_wear_event_items`, `wearable_pairings`, `wearable_sessions`, `wearable_results`, `wearable_actions`, `wearable_auth_attempts` ×2) — pre-existing debt, out of scope per the governing "do not fix unrelated privacy drift" rule.
- `lib/account-deletion/user-data-resources.json` also carries 2 tables (`elise_generation_operations`, `image_scan_verdicts`) that the `.ts` mirror still lacks. Unrelated to Closet/saved-scans; left as-is (no automated exact-equality parity test forces fixing them, only the two specific substring checks this phase satisfied).
- `docs/account-deletion-operations.md` is a stale (2026-07-07) manual runbook that predates the automated worker, the saved-scans prefix, and several registry tables. Not updated in B1B — doc staleness, not a functional authority gap, and not in the required file list.
- Privacy export (`privacy-data-export`) has no per-table field-level export mechanism for *any* table, not just Closet — a pre-existing design gap, not something B1B invents a fix for.

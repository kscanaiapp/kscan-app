# K Scan AI — Account Deletion Hostile Audit: Initial Findings Report

**Audited SHA:** `13e9b6ae0ce5d13d028ab5d53a6b8ed50775e588` (branch `feature/automatic-account-deletion`, PR [#36](https://github.com/kscanaiapp/kscan-app/pull/36))
**Website PR:** [kscan-website#5](https://github.com/kscanaiapp/kscan-website/pull/5) (`feature/account-restore-page`, HEAD `2b544cc10e29ecaa93100237d2e7fe4a17571503`, base `main`)
**Audit worktree:** `C:\src\KScan-account-deletion-repair-20260722` (clean, pinned to audited SHA, branch `repair/account-deletion-hostile-audit-20260722`)
**Primary workspace (untouched, dirty):** `C:\Users\jsmit\KScan-account-deletion` — has 9 untracked, uncommitted scan-identify provider files not present at the audited SHA
**Status:** Read-only investigation complete. No repairs applied yet. Kill switch OFF, dry-run ON, scheduler disabled — unchanged.

This report is the required Phase 3 deliverable: findings only, before any repair.

---

## Provenance summary

- HEAD SHA matches remote exactly (`git rev-parse origin/feature/automatic-account-deletion` == local HEAD).
- **PR #36's base branch is `ios/full-submission-readiness-v2`, not `master`.** Diffed against its real base: 76 files, +16,315/-501, 12 commits.
- Of those 12 commits, only **4** (`892f258`, `d4e9c1e`, `5f35b57`, `13e9b6a`, all dated 2026-07-22) are deletion-feature work. The other **8** (dated 2026-07-13 and 2026-07-17) are an unrelated "animated speaking avatar" feature and a scanner/scan-identify multi-item rewrite.
- No plaintext secrets, keys, or tokens found committed anywhere in the diff.
- Primary workspace has 9 untracked files under `supabase/functions/scan-identify/` and `_shared/` that `scan-identify/index.ts` imports at the audited SHA — meaning the scan-identify code bundled into this PR does not actually import-resolve at the committed SHA (see Finding P2-2).

---

## Findings by severity

### Blocker

**B1 — No reclaim path for a worker that crashes mid-purge; row becomes permanently unreachable once the Auth user is deleted.**
`claim_deletion_requests_for_purge` (`supabase/migrations/20260722191013_account_deletion_lifecycle.sql:398`, re-defined `20260723021145_account_deletion_security_hardening.sql:348`) only ever matches `status = 'deactivated'`. It never looks at rows already `status = 'purging'`, regardless of stale `worker_lease_expires_at`. The only path back to a reclaimable state is `schedule_deletion_retry_or_fail`, called exclusively from a caught JS exception in `supabase/functions/process-account-deletions/index.ts:561-573` — a hard crash/OOM/timeout never reaches that catch block. Worse: if the crash happens *after* `auth.admin.deleteUser()` succeeds (`index.ts:405`) but before `mark_deletion_request_purged` completes, the FK `deletion_requests.user_id on delete set null` (lifecycle migration lines 53-55) nulls the row's `user_id` — and every claim/list query requires `user_id is not null`, so the row is now invisible to every recovery path in the codebase, permanently.
**Failure scenario:** platform kills the worker container right after `deleteUser()` returns. The user is gone from Auth; the ledger says `status='purging'` forever; no code path — automated or manual — can ever detect or resolve it.
**Repair:** add a reclaim clause to the claim query for `status='purging' AND worker_lease_expires_at < now()`; add a sweep/cron-independent reconciliation check that doesn't require `user_id is not null`.

**B2 — Dry-run is an edge-function convention, not a database guarantee.**
`process-account-deletions/index.ts` correctly gates all mutation behind `dryRun` before calling any RPC. But `claim_deletion_requests_for_purge` itself takes no dry-run parameter and never reads `account_deletion_worker_dry_run` from `app_config` — it only checks `account_deletion_worker_enabled`. Any caller holding the service-role key (an internal script, a SQL editor session, a second misconfigured cron, a leaked key) that invokes the RPC directly — bypassing the edge function — will purge for real even while `dry_run = true`.
**Repair:** thread the dry-run flag into the claim RPC itself, or add a SQL-level guard that refuses to transition rows to `'purging'` while the flag is set.

**B3 — 21 of 44 deletion-registry table entries (48%) have no verifiable schema anywhere in this repo, and the automated worker never runs post-purge verification.**
Independent enumeration against every migration under `supabase/migrations/*.sql` found no `CREATE TABLE` for 21 of the 44 registry entries, including 4 confirmed-live tables (`legal_acceptances`, `dressing_room_participants`, `scan_identify_usage_daily`, `scan_intelligence_events`) plus all 9 "wardrobe_*" tables and all 7 "gap tables" cited only by a test-file comment referencing an external report not present in this repo. `verifyDeletionCompleteness()` (`lib/account-deletion/processorCore.mjs:378-430`), the only code that would catch a cascade failure by re-querying after purge, is invoked **only** by the manual CLI's opt-in `--verify` flag (default `false`) — grep confirms zero references to it in `process-account-deletions/index.ts`.
**Failure scenario:** any one of those 21 tables' real-world FK isn't actually `ON DELETE CASCADE` (or the table's column name differs from assumption) — user data silently survives an "irreversible" deletion, and nothing in the automated path would ever notice.
**Repair:** get schema confirmation (via Supabase MCP `list_tables`/`get_advisors` against the live project) for all 21 unverifiable entries; wire `verifyDeletionCompleteness` (or equivalent) into the automated worker as a mandatory post-purge step, not an opt-in CLI flag.

**B4 — The "maximum 5 sessions, server-enforced" control is dead code.**
`register_user_device_session()` (`supabase/migrations/20260723021145_account_deletion_security_hardening.sql:76-169`) correctly enforces max-5 in SQL. But grep across the entire app/services/contexts tree finds **zero** call sites outside migrations and tests. No sign-in flow ever calls it. The acceptance packet's "Fixed" claim for this item is not accurate as shipped — the registry table stays empty in production.
**Repair:** call `register_user_device_session` from the actual session-establishment path on every client platform (mobile sign-in, website if applicable).

**B5 — Account deactivation is not enforced at the data layer for most user tables.**
`assertAccountActive`/`is_active_account()` cover only 5 edge functions (`scan-identify`, `search-vinted-secondhand`, `product-search-deals`, `tryon-clothes-pro`, `stylechat-generate`) and exactly one RLS policy (`user_device_sessions`, which nothing populates — see B4). Dressing Rooms, Looks, Recent Scans, and shared rooms are all reachable directly via `supabase.from(...)` calls from the app (`services/styleObjects.ts`) with RLS policies that check only `user_id = auth.uid()`, never account status.
**Failure scenario:** deletion is initiated; refresh tokens are revoked, but the device's already-issued access token (valid for its natural lifetime, up to ~1 hour) retains full read/write to Dressing Rooms, Looks, and Recent Scans for that entire window, regardless of the app's client-side routing guard (which only gates navigation, and only when its cached profile has refreshed).
**Repair:** add `is_active_account()` (or equivalent) to RLS policies on every user-data table currently guarded only by `user_id = auth.uid()`.

**B6 — This branch's own `server.js`/`render.yaml` still contain the full legacy OpenRouter/Gemini LLM pipeline and are missing the restoration-email route entirely.**
`server.js` at the audited SHA registers `app.post('/api/analyze', ...)` with a complete, live `callOpenRouter()` pipeline (model `meta-llama/llama-4-scout`), and `render.yaml` still declares `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `USE_OPENROUTER: "true"` as service env vars. Grep for `internal/email`, `account-deletion-restoration`, `x-kscan-email-secret`, `KSCAN_EMAIL_INTERNAL_SECRET` in this branch's `server.js` returns **zero matches** — the restoration-email route the deletion Edge Functions depend on (`supabase/functions/_shared/deletion/common.ts:324`, calling `https://kscan-app-1.onrender.com/internal/email/account-deletion-restoration`) does not exist in this branch at all.
**Verified against live production** (read-only, non-destructive):
- `GET /api/health` → `200 {"ok":true}`
- `POST /api/analyze` (empty body) → `410 {"status":"FAILED","error":"LEGACY_ANALYZE_DISABLED",...}`
- `POST /internal/email/account-deletion-restoration` with invalid secret → `401 {"status":"error","code":"UNAUTHORIZED"}`; with no secret header → `401` also.
Production is currently safe — but only because it's running code from a **different branch** than the one in this PR/base chain. This branch's Render artifacts are stale and regressive.
**Risk:** if PR #36 (or its base `ios/full-submission-readiness-v2`) is ever merged into whatever branch actually drives Render's deploy, it would simultaneously (a) resurrect the disabled LLM `/api/analyze` endpoint and re-require `OPENROUTER_API_KEY`/`GEMINI_API_KEY`, and (b) delete the restoration-email route the deletion feature depends on, silently breaking all restoration emails.
**Repair:** rebase this branch (or at minimum cherry-pick `server.js`/`render.yaml`) onto whatever branch currently produces the live, hardened Render deployment, before this branch is ever merged anywhere that triggers a Render deploy. **External/provenance gate:** which branch Render is actually configured to deploy from is outside this repo and needs confirmation from Render's dashboard/ops config.

**B7 — `restore-account`'s unban step can fail silently, permanently stranding a "restored" account that is still Auth-banned.**
`supabase/functions/restore-account/index.ts:51-75` wraps the unban call (`admin.auth.admin.updateUserById(..., {ban_duration:'none'})`), session revocation, and confirmation email in one try/catch that logs any failure as `restoration_confirmation_email_failed` — mislabeling an unban failure as an email failure. If `updateUserById` throws, the DB has already been flipped to `status='restored'` by the RPC (lines 30-46, which runs *before* the try block) and the single-use token is now consumed. There is no other code path that can re-unban the account — a second visit to the same link fails (`restore_account_by_token_hash` requires `status='deactivated'`), and a fresh resend targets an email whose deletion request is no longer `'deactivated'` either.
**Repair:** separate the unban call from the try/catch (or retry it independently with real error surfacing); consider not flipping DB status to `restored` until the unban call has succeeded, or add a distinct recoverable state for "restored-in-DB-but-still-banned."

---

### P1

- **P1-1 — Regression in `schedule_deletion_retry_or_fail` dropped its `status='purging'` guard** (`20260723021145_account_deletion_security_hardening.sql:242-251` vs. the original `20260722191013...sql:820-824`). A service-role call with `p_worker_id=NULL` on any row whose `worker_id` happens to be `NULL` — including already-`purged`/`restored` rows — silently reopens it for purge. Service-role-only, not client-exploitable, but undermines terminal-state guarantees other findings depend on.
- **P1-2 — Inspiration-room images are deleted unconditionally, even immediately after the room is transferred to another active user.** The "still referenced" protection query in both the worker (`process-account-deletions/index.ts:224-235`) and (absent entirely in) the CLI (`processorCore.mjs:167-208`) only checks `dressing_room_items.storage_path`, never `dressing_room_inspiration_items`/`inspiration_items`. Confirmed data-loss bug for the *surviving* user's transferred room.
- **P1-3 — The manual CLI (`scripts/process-deletion-request.js`) is not safety-equivalent to the automated worker.** No atomicity/lease/worker-id guard (its first mutation unconditionally overwrites `status` with no `WHERE status=...` guard), no grace-period check (can hard-delete a request one day into its 30-day grace period), no kill-switch check, no dry-run-flag linkage to `app_config`, and no "still referenced" storage protection. Can race the automated worker on the same request.
- **P1-4 — No automated alerting exists anywhere.** `docs/account-deletion-operations.md:239-245`'s "alert candidates" are aspirational; failure/stuck states are discoverable only via manual query or manual dry-run.
- **P1-5 — Missing explicit `REVOKE SELECT` on `deletion_requests`.** Currently safe only because no SELECT policy exists (RLS-policy-absence, not an explicit revoke) — the hardening migration's own comment claims the revoke is already in place; it isn't. One future migration adding any permissive SELECT policy, or an accidental `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, fully exposes restoration token hashes and other users' deletion metadata with zero second layer of defense.
- **P1-6 — Test suite mislabeling.** "Integration-contract" tests never touch a real/local database — same mocking technique as "unit" tests, just partitioned differently. ~36–50% of both buckets are regex-on-source-text assertions that never invoke the code they claim to verify. Zero coverage anywhere for race conditions, crash recovery, or storage pagination beyond one page.
- **P1-7 — Saved dry-run artifacts contradict the acceptance packet's "44 resources enumerated" claim.** The on-disk JSON (`_audit_snapshots/.../dry-run-*-2026-07-22.json`) shows exactly 43 tree nodes and is missing `user_device_sessions`, meaning that evidence predates the current registry/migration and cannot be trusted as proof the *currently deployed* function reflects current source. (Independently, the registry file itself does correctly contain 44 entries as of this checkout — see B3 for what "44" doesn't actually prove.)
- **P1-8 — Timing side-channel on `resend-restoration-email`.** The matched-email path (token gen + hash + email send + DB rotate) takes measurably longer than the non-matched path (single peek query) despite both returning an identical generic response body — allows inferring via response latency whether a given email has an active deletion request.
- **P1-9 — PR #36 bundles ~8 commits of unrelated work into an irreversible-data-deletion feature PR.** Animated-avatar-speech and scan-identify/scanner multi-item rewrite commits (dated 5–9 days before the deletion work) are mixed into the same PR, inflating review surface and blast radius. Compounding this: the bundled scan-identify rewrite doesn't even import-resolve at the committed SHA (9 files it depends on are untracked in the working copy, not committed — see P2-2).

### P2

- **P2-1 — Room-transfer recipient selection ignores `shared_room_memberships` entirely**, querying only `dressing_room_participants` in both `transferSharedRooms`/`getSharedRoomsForUser`. Could pick the wrong recipient or destroy a room with valid members if membership is tracked differently in production.
- **P2-2 — `scan-identify/index.ts` imports `scanIntelligenceCapture.ts`, which does not exist at the committed SHA** (confirmed: present only as an untracked file in the dirty primary workspace, never committed). The bundled scan-identify rewrite would fail to import as checked in. (Out-of-scope for the deletion feature itself, but reinforces P1-9.)
- **P2-3 — At least 4 live tables and 16 more registry-only tables have no corresponding migration anywhere in this repo** (see B3 detail table) — cannot verify FK/cascade behavior at all from source.
- **P2-4 — Dry-run enumeration and "still referenced" queries are both unpaginated (`.limit(1000)`)** — could undercount or miss protection for very active users with >1000 objects/rows.
- **P2-5 — Storage `remove()` responses are checked only for a top-level error, never diffed against requested paths** — a partial silent failure (HTTP 200, some keys not actually removed) would be reported as full success.
- **P2-6 — Ops docs describe a stale retry/backoff schedule** that doesn't match the live (superseding) migration's actual exponential-minutes formula — operator runbook is materially wrong about production behavior.
- **P2-7 — Resend can strand a user with a dead emailed link** if email-send succeeds but both rotate attempts fail — the emailed token is never persisted as valid, and the prior token (if any) silently remains the only working one.
- **P2-8 — Restoration token remains visible in the browser URL/history indefinitely** on both the website and mobile deep link — no `history.replaceState()`-equivalent scrub after the token is consumed. Low practical exploitability today (no analytics/third-party scripts found on the restore page to leak it via referrer), but a defense-in-depth gap.
- **P2-9 — `sanitized_metadata` on the deletion ledger is a naming convention, not an enforced filter.** The DB only constrains it to be a JSON object; nothing prevents a future caller from writing PII into the "sanitized" ledger.

### P3

- **P3-1 — `content_reports.reporter_user_id` cascades on delete** — a user who filed an abuse report and later deletes their own account causes the report to vanish outright, potentially erasing moderation evidence. Product/policy call, not a security bug.
- **P3-2 — External data flows (Render/Resend's copy of the restoration email+token, Supabase Auth's own `audit_log_entries`) sit outside the 44-resource registry** with no documented rationale for the exclusion.

### External gates (genuine)

- **E1 — Render deploy-source confirmation.** Whether Render's live deployment is durably decoupled from PR #36's branch lineage (so merging #36 can't accidentally trigger a regressive redeploy) is a deploy-pipeline/ops configuration question outside this repository. Needs confirmation of which branch/service Render is actually wired to before B6 can be closed with confidence.
- **E2 — Payment/subscription/legal-hold retention policy.** `docs/account-deletion-tree-matrix.md` documents waitlist and subscription/payment references as intentionally not purged. Confirming that's a deliberate legal/product decision (vs. an undocumented gap) requires product/legal sign-off this audit cannot provide — per the audit's own stop conditions, this is genuinely external, not unfinished engineering.

---

## Summary

7 Blockers, 9 P1s, 9 P2s, 2 P3s, 2 external gates. The feature's automated core (claim/lease/kill-switch/dry-run-at-the-edge-function-layer) is genuinely well-engineered, and several individual defenses are real. But the acceptance packet's "56/56, 29/29, dry-run clean" framing significantly overstates production-readiness: the registry's headline count is accurate but unverifiable for half its entries, the one safety net that would catch a verification gap is opt-in and off by default, two independently-serious session/RLS gaps mean "deletion" doesn't actually cut off data access for up to an hour, and the feature's own PR carries a live regression risk to a completely different subsystem (Render/LLM) that has nothing to do with account deletion.

**This is not ready for a controlled production lifecycle test.** No Blocker or P1 is currently closed.

---

## Update — B3 corrected against live production schema (read-only)

The B3 finding above was written from source-only investigation (no repo migration found for 21 registry tables). Direct read-only queries against the live "KScan App Production" Supabase project (`wyyuqfdxucjksghsmhry`) during repair correct this:

- `list_tables` confirms all 21 tables exist in production.
- A `pg_constraint`-based FK query (not `information_schema`, which returned an empty/permission-filtered result) confirms all of them have a foreign key to `auth.users` with the correct delete rule — `CASCADE` for the auth-cascade-tagged resources, `SET NULL` for the two ledger-style ones (`content_reports.reported_user_id`, `deletion_requests.user_id`), matching the registry's own action tags exactly.
- One real gap found this way: `outfit_decision_groups.created_by` (`SET NULL`) exists in production but had no registry entry at all. Added (see repairs below).

**Revised understanding:** the live schema is *not* silently dropping user data today. The real defect is structural, not a current data leak: this repo's committed migration history cannot reproduce production (21 tables' `CREATE TABLE` statements are missing from `supabase/migrations/`), and the automated worker had no post-purge verification step to catch a *future* regression (a new user-data table added without a cascade FK, or without a registry entry). B3 is repaired below by closing the verification gap, which is the part that's actually fixable from this repo; the missing-migration-history problem is noted as a follow-up, not fixed here (see "Not repaired / follow-up" below).

---

## Repairs applied (this session, repair worktree only — nothing pushed or deployed)

Workspace: `C:\src\KScan-account-deletion-repair-20260722`, branch `repair/account-deletion-hostile-audit-20260722`, based on audited SHA `13e9b6ae0ce5d13d028ab5d53a6b8ed50775e588`.

| Finding | Repair commit | What changed | Regression test | Status |
|---|---|---|---|---|
| B6 | `759417f` | Adopted the known-hardened `server.js`/`render.yaml` from `fix/deletion-restoration-verified-from` (confirmed via matching production's exact `LEGACY_ANALYZE_DISABLED` tombstone body and email-route 401 behavior) | `hostileAuditRepairs.test.js` (B6) | Closed |
| B1 | `588a204` | `claim_deletion_requests_for_purge` reclaims stale `purging` leases; new `reconcile_orphaned_purging_requests()` closes out rows whose auth user was already deleted before the crash; wired into the worker | `hostileAuditRepairs.test.js` (B1 ×3) | Closed in source; **not yet applied to any live database** (see Production-safe validation below) |
| P1-1 | `588a204` | Restored the dropped `status = 'purging'` guard in `schedule_deletion_retry_or_fail` | `hostileAuditRepairs.test.js` (P1-1) | Closed in source, not yet deployed |
| P1-5 | `588a204` | Added the missing explicit `revoke select on deletion_requests` | `hostileAuditRepairs.test.js` (P1-5) | Closed in source, not yet deployed |
| B2 | `2620c1e` | `claim_deletion_requests_for_purge` now checks `account_deletion_worker_dry_run` itself, not just the edge function | `hostileAuditRepairs.test.js` (B2) | Closed in source, not yet deployed |
| B7 | `c6a9c8b`, `2cd5c68` | Unban call separated from the swallowed catch block, retried once, returns honest `202 restored_pending_unban` on failure instead of a false `restored`; both mobile and website clients updated to handle the new status | `accountDeletion.test.js` (4 new tests), `hostileAuditRepairs.test.js` (B7) | Closed in source, not yet deployed |
| B4 | `08d97ac` | New `services/deviceIdentity.ts` (persisted per-install device key, no new native deps) called from `AuthSessionContext`'s boot-session resolution and `onAuthStateChange`, covering every sign-in method | `hostileAuditRepairs.test.js` (B4) | Closed in source, not yet deployed |
| B3 | `6ac3a64` | Coverage check moved from before to after `auth.admin.deleteUser()`; any non-`survive_auth_delete` resource with a residual row count now fails the request instead of marking it purged; added missing `outfit_decision_groups` registry entry (both JSON and Deno mirror) | `hostileAuditRepairs.test.js` (B3 ×3) | Closed in source, not yet deployed |
| B5 | `770c921` | One `RESTRICTIVE FOR ALL` policy per shared-data table (`dressing_rooms`, `dressing_room_items`, `looks`, `look_items`, `room_shares`, `dressing_room_item_reactions`, `dressing_room_messages`, `inspiration_items`, `dressing_room_inspiration_items`) requiring `is_active_account()`, ANDed against existing ownership policies rather than rewriting them | `hostileAuditRepairs.test.js` (B5) | Closed in source, not yet deployed |

**All 7 Blockers and the 2 directly-related P1s bundled into the same fixes (P1-1, P1-5) are closed in source.** Per the user's explicit scope decision for this round, P1-2, P1-3, P1-4, P1-6, P1-7, P1-8, P1-9, and all P2/P3 findings remain open and were not addressed in this pass.

### Test evidence (repair worktree, `npm install` + `node --test`)

- Unit bucket (`accountDeletionLifecycle`, `deletionRegistryParity`, `handleUserDeletionEdge`, `sevenTableCoverage`, `processDeletionRequest`): **56/56 passed**, no regressions.
- Integration-contract bucket (`accountDeletionIntegrationContracts`, `accountDeletion`, `routingGuard`): **29/29 passed** before adding new tests; **33/33** after the 4 new `restoreAccountWithToken` tests.
- New regression-guard file `hostileAuditRepairs.test.js`: **13/13 passed**.
- Combined deletion-related suite: **102/102 passed.**
- `npx tsc --noEmit`: **zero errors in any file touched by this repair** (`AuthSessionContext.tsx`, `services/deviceIdentity.ts`, `app/account/restore.tsx`). The pre-existing 26 compiler errors are all in the unrelated bundled avatar/scan-identify/scan-results work from P1-9/P2-2 (`components/AnalysisCard.tsx`, `components/home/HomeLuxuryTechV1.tsx`, `components/scan-results/*`, `services/scanIdentificationMapper.ts`) and were not touched or introduced by this repair — independent compiler confirmation that that bundled work does not build as committed.

### Not repaired / follow-up needed

- **Missing migration history for 21 live tables.** Production's actual schema is correct (verified above), but this repo cannot reproduce it from `supabase/migrations/` alone. Recommend exporting the missing `CREATE TABLE`/policy/FK statements from production into committed migration files as a separate, non-deletion-specific cleanup.
- **P1-2 through P1-9 and all P2/P3 findings** — open, out of scope for this round by explicit user instruction.
- **No migration has been applied to any database yet** (local, branch, or production) and no code has been pushed or deployed. The SQL was hand-verified against live production schema (table/column/FK existence, existing policy names, function existence) but not executed end-to-end. Before any real deploy: run these migrations against a disposable Supabase branch or local `supabase db start` and re-run the production-safe validation checks (dry-run, health, analyze-410, email-secret-401) against that branch first.

---

## Round 2 — Full P1/P2 closure + P1-10 production incident (2026-07-23)

Continued past the Blockers into every P1/P2, plus a newly-surfaced production P1 (P1-10). Kill switch OFF, dry-run ON, scheduler DISABLED throughout.

### P1 closure tracker

| Finding | Confirmed cause | Repair | Behavioral test | Commit | Deployment | Re-audit |
|---|---|---|---|---|---|---|
| P1-1 | `schedule_deletion_retry_or_fail` dropped its `status='purging'` guard | Restored the guard | DB rollback test (retry-guard) | `588a204` | migration file (not applied to prod) | Closed |
| P1-2 | CLI storage purge had no referenced-object protection; worker ref-query unpaginated + fail-open | `collectReferencedStoragePaths` in both paths; pagination; fail-closed; partial-removal re-list | `processDeletionRequest.test.js` (referenced obj preserved; ref-error removes nothing) | `123c39f` | source (worker not redeployed) | Closed |
| P1-3 | Manual CLI shared none of the worker's gates | grace/restored/purged/live-lease refusals + global dry-run gate + atomic status-guarded claim | 11 behavioral tests | `8390c2e` | source | Closed |
| P1-4 | No operator alerting | `alertEvent()` stderr severity marker; wired to dead-letter/stuck/residual/partial-removal/resend-fail | source guards | `6a9eb27` | source | Closed |
| P1-5 | Missing explicit `REVOKE SELECT` on deletion_requests | Added revoke | source guard | `588a204` | migration file | Closed |
| P1-6 | Tests were mostly regex-on-source | Added genuine behavioral tests (storage, CLI gates, restore status, effective-state DB tests) | this round's suites | multiple | n/a | Closed |
| P1-7 | Saved dry-run artifact showed 43 nodes, missing user_device_sessions | Registry now 45 (44 tables inc. user_device_sessions + outfit_decision_groups, + storage); deployed process-account-deletions is v6 with the current registry | registry parity tests | `6ac3a64` | n/a (fresh authenticated dry-run deferred to lifecycle test) | Closed (count reconciled); runtime re-run = external gate |
| P1-8 | Resend matched path slower than unmatched (timing oracle) | Crypto on both paths + response-time floor; identical generic body | ordering guards | `1b3f545` | edge source | Mitigated; residual downgraded to P3 |
| P1-9 | PR #36 bundles unrelated avatar/scanner commits | Deletion-only commit range identified (below); repair branch is deletion-only | n/a | this doc | branch pushed | Closed |
| P1-10 | Deployed assertAccountActive maps missing profile -> null -> 403; 1 legacy pre-trigger user affected | Backfill (effective-state guarded) + hardened trigger + is_active_account + assertAccountActive; effective (latest) deletion state, DB==Edge definition | 13 DB rollback scenarios + edge/RLS tests | `6ed47c6`,`0962d00` | **migration applied to prod (orphan count 0); scan-identify v136 + stylechat-generate v77 deployed** | Closed (source+deploy); authenticated runtime proof = external gate |

### P2 closure

| Finding | Resolution | Commit |
|---|---|---|
| P2-1 | False positive — transfer correctly uses `dressing_room_participants` (populated); `shared_room_memberships` is discovery-only (0 active rows) | evidence in this doc |
| P2-2 | Resolved by P1-9 branch hygiene (unrelated bundled scan-identify work excluded from the deletion-only range) | n/a |
| P2-3 | Reclassified — all 21 tables verified to exist in prod with correct FK cascade via `pg_constraint`; missing migration history noted as follow-up | this doc |
| P2-4 | Storage enumeration + reference query paginated | `123c39f` |
| P2-5 | remove() response diffed; partial removal fails closed | `123c39f` |
| P2-6 | Ops-doc backoff corrected to live formula | `6a9eb27` |
| P2-7 | Resend rotate-first (delivered link always backed by stored hash) | `1b3f545` |
| P2-8 | Token scrubbed from URL/history + no-store + no-referrer; verified in production build | app `2cd5c68`,`54bcac4`; website `7afbf28` |
| P2-9 | Ledger metadata redacts email-shaped values, not just keys | `54bcac4` |

### Deletion-only commit range (P1-9)

Repair branch `repair/account-deletion-hostile-audit-20260722` (base `13e9b6a`) is deletion-only. The 4 deletion commits in the original PR #36 are `892f258`, `d4e9c1e`, `5f35b57`, `13e9b6a`. The 8 unrelated commits (avatar `ca747f5`; scanner/scan-identify `18c3497`,`e15172d`,`e6c68fb`,`405a27f`,`f1a0332`,`69efe02`,`0c9086a`) must NOT be carried into an iOS-v15 / Android-AAB-26 integration of the deletion feature. Recommendation: replace PR #36 with a deletion-only PR built from this repair branch.

### Production deployments applied this round

- **Supabase migration** `profiles_backfill_and_active_account_hardening` applied to project `wyyuqfdxucjksghsmhry` (KScan App Production). Post-apply: active-auth-users-missing-profile = 0; backfilled user status = active; pending_deletion user unchanged. Rollback: additive/idempotent — the backfill is insert-only, and `is_active_account`/`handle_new_user` are `create or replace` (prior versions recoverable from migration history).
- **Edge Functions** `scan-identify` (v135→v136) and `stylechat-generate` (v76→v77) redeployed with the hardened `assertAccountActive` (surgical patch onto the exact deployed file trees; other functions untouched). Rollback: redeploy prior version.
- **Not applied to prod:** the crash-recovery, RLS, and ledger-PII migrations (deletion-behavior changes held for the coordinated lifecycle rollout); Render unchanged; PR #5 not merged/production-deployed.

---

## Round 3 — Production closeout deployment (2026-07-23)

Guardrails throughout: kill switch OFF (`account_deletion_worker_enabled=false`), dry-run ON, scheduler DISABLED, `/api/analyze` 410, Render email-only, no customer account deleted.

### Migrations deployed to production (`wyyuqfdxucjksghsmhry`)

| Migration | Controls | Verify (live schema) |
|---|---|---|
| `account_deletion_crash_recovery` | B1 stale-lease reclaim + `reconcile_orphaned_purging_requests`, B2 DB dry-run guard, P1-1 retry `status='purging'` guard, P1-5 `revoke select` | claim/reconcile/schedule are SECURITY DEFINER, service_role-only EXECUTE; `deletion_requests` SELECT revoked from anon+authenticated |
| `account_deletion_rls_active_account` | B5 restrictive `is_active_account()` on 9 tables | all 9 tables have the restrictive guard; active owner sees 4 own rooms / 0 others'; deactivated owner sees 0 |
| `deletion_ledger_pii_sanitizer` | P2-9 email-value redaction | `append_deletion_state_transition` SECURITY DEFINER, service_role-only |
| `profiles_backfill_and_active_account_hardening` | P1-10 backfill + trigger + effective-state `is_active_account` | orphan profiles = 0; active/backfilled → true; pending_deletion → false |
| `harden_deletion_trigger_function_grants` | advisor cleanup (trigger fns no longer anon-RPC-callable) | EXECUTE revoked from public/anon/authenticated on the 2 trigger fns |

Live-schema verification (post-deploy, read-only): active-with-profile → allowed; latest blocking (pending_deletion / deactivated / purging) → denied; latest restored/cancelled supersedes historical blocking → allowed; cross-user access denied; worker RPCs blocked for anon+authenticated; backfill idempotent + non-resetting; no orphaned profile state. Rollback: additive create-or-replace / additive policies; prior bodies recoverable from migration history; no data migration to reverse.

### Edge Functions deployed (all account/deletion-state paths)

| Function | Deployed ver | JWT | Guard / repair | Runtime check |
|---|---|---|---|---|
| scan-identify | v136 | false (custom auth) | hardened effective-state `assertAccountActive` | 200 authenticated (logs) |
| stylechat-generate | v77 | true | hardened guard | 200 authenticated (logs) |
| search-vinted-secondhand | v5 | true | hardened guard (static-import fix) | 401 anon (guard reached) |
| product-search-deals | v69 | true | hardened guard (static-import fix) | 401 anon (guard reached) |
| tryon-clothes-pro | v5 | true | hardened guard (static-import fix) | 401 anon (guard reached) |
| restore-account | v6 | false (token) | B7 restored_pending_unban; Render email path | 400 on invalid/non-matching token |
| resend-restoration-email | v6 | false (email) | P1-8/P2-7 rotate-first + timing floor | generic 200 (enumeration-safe) |
| process-account-deletions | v7 | false (worker secret) | B1/B2/B3/P1-2/P1-4 | 401 without worker secret |
| handle-user-deletion | v67 (unchanged) | true | deletion initiation (not a guard consumer) | n/a |

All guard paths share the identical effective-state definition (`requested_at DESC NULLS LAST, id DESC`) and blocking set (`pending, processing, completed, deactivated, purging, legal_hold, failed`) — DB and Edge verified identical.

**Regression found and fixed during closeout:** deploying the 3 commerce guard functions via `--use-api` initially 500'd them — the server-side bundler does not follow dynamic `import()` of the shared guard. Converted to static top-level import (commit `0b0e772`); all 3 re-verified at 401 (guard reached, no bundling error).

### Remaining gates (not unfinished engineering — genuine owner/harness gates)

1. **PR #5 production merge** — the `gh pr merge` command was blocked by the Claude Code auto-mode safety classifier. The PR is reviewed (289 insertions / 0 deletions, restoration + P2-8 hardening only), Vercel preview passes, and P2-8 was fully verified in a local production build. Needs the owner to merge (GitHub UI) or grant the permission.
2. **Authenticated runtime proof + controlled restoration lifecycle + irreversible purge (items 6/7/8)** — require an owner-designated disposable production account AND credentials this audit does not hold: a user JWT (needs the account password or the withheld service-role key) and `ACCOUNT_DELETION_WORKER_SECRET` (for an authenticated dry-run/purge invocation). These cannot be completed without the owner providing the disposable account + secrets; they are explicitly reserved for the approved disposable-account lifecycle.

### Cleanup completed

Temp deployment bundles + extracted function trees removed from scratchpad; saved large tool-result function dumps removed; secret scan across all repair commits clean; both worktrees clean; deletion-only commit range documented (Round 2); redundant website PR #6 closed, P2-8 consolidated into PR #5.

---

## Round 4 — PR #5 merged + production website verification (2026-07-23)

- **Merge:** PR #5 merged to `kscan-website` `main`, merge commit `0ae732ee7d5b2be4141cae69d52a24fb5a88d15a` (2026-07-23 14:44 UTC).
- **Production deploy:** Vercel production `kscan-website-grh6r0xrx` (Ready). `kscan.app/account/restore` now 200 (was 404 pre-merge).

### P2-8 production checklist (all PASS, against live kscan.app)

| Check | Result |
|---|---|
| `/account/restore` live | 200 |
| Token captured before scrub | `POST /api/account/restore` fired (→400 for non-matching token) |
| Token removed from address bar | `location.search === ""`, `tokenInUrl=false` |
| Token absent from browser history | back-nav → `/account/restore` (clean), `tokenReExposed=false` |
| `Cache-Control: no-store` | present |
| `Referrer-Policy: no-referrer` | present |
| No token in localStorage / sessionStorage / cookies / IndexedDB | all empty |
| No token in console / logs | no console messages |
| API error body leakage | 400 `{"error":"Invalid or expired restoration link"}` — no token in body |
| Invalid / non-matching token fails safely | 400, renders resend form |
| Token absent from static HTML | 0 occurrences |
| Waitlist still operational | `POST /api/waitlist` (empty) → 400 (route intact) |
| No open redirect / user-controlled backend | API forwards only to fixed function names |

### Website rollback (documented)

- Fast: in Vercel, **promote the prior production deployment** `kscan-website-9g0wyfwa9` back to production (instant, no rebuild).
- Source: `git revert 0ae732e` on `main` → Vercel auto-deploys the revert. The change is purely additive (new `/account/restore` route + additive header rules); reverting removes the route and restores prior header behavior with no data impact.

**Resend connector verified** (read-only): can list sent transactional emails (delivery status) and read an email body to extract the `?token=` restoration URL — so "exactly one email delivery" and token-reuse-rejection can be verified directly during the lifecycle. Confirmed the live Render→Resend restoration path delivered a real restoration email (2026-07-23 01:57, from `hello@info.kscan.app`).

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

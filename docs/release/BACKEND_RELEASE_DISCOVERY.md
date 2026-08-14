# Backend Release & Rollback Infrastructure V1 — Phase 1 Discovery

Status: discovery output only. No production mutation, no deployment, no EAS
build occurred while producing this document. Verified 2026-08-11 against
`origin/staging/production-parity` @ `7d7c73bd4065ad9a25349e42f347418117d91867`
and live Supabase project state (read-only Management API calls). Non-secret
facts only.

See also `ENVIRONMENT_AUTHORITY.md` for the environment-identity deep dive this
document assumes as background.

> **Phase 2A corrections (2026-08-11).** Four corrections were applied to this
> document after manager review of Phase 1. They are marked inline below as
> **[CORRECTED IN PHASE 2A]**:
> 1. The proposal to commit every generated staging-certification JSON to Git
>    is **withdrawn**. See `RELEASE_EVIDENCE_POLICY.md` for the replacement
>    three-tier retention model.
> 2. Production migration state is stated as **observed ledger entries**, not
>    as trustworthy release provenance. The two are not the same thing here.
> 3. `shared_room_item_contributions` is now a **formal production-promotion
>    reconciliation blocker**, machine-enforced. See
>    `PRODUCTION_MIGRATION_RECONCILIATION.md`.
> 4. The absence of verified PITR/restore now carries an explicit
>    **prohibition** on DATA_TRANSFORMING and DESTRUCTIVE production
>    promotion, encoded in `security/release/backup-capability-policy.json`.

## Source state

- Repository: `kscanaiapp/kscan-app`. Default branch (`origin/HEAD`): `master`.
- Canonical integration branch: `staging/production-parity`.
- `CURRENT_STAGING_HEAD` (origin): `7d7c73bd4065ad9a25349e42f347418117d91867` —
  identical to the SHA given as "historical handoff" context, i.e. **the remote
  staging branch has not advanced since handoff**.
- `CURRENT_MASTER_HEAD` (origin): `fdb2c0fada410abb3b8ebee6413116204f49e1aa`.
- The local branch pointers for both `staging/production-parity` (local tip
  `da3a4f4`) and `master` (local tip `08f0d0e`) are stale **ancestors** of their
  origin counterparts (confirmed via `merge-base --is-ancestor`, not just
  assumed from ahead/behind counts) — not real divergence, just an
  out-of-date local ref. Origin is authoritative.
- `staging/production-parity` and `master` do share a common ancestor
  (`a601adfa...`) but have been genuinely divergent since — 517 commits unique
  to staging, 50 unique to master, versus the merge base.
- **Workspace classification: DIRTY / non-standard.** The primary working
  directory `c:\Users\jsmit\KScan` is checked out on an unrelated branch
  (`ios/full-submission-readiness-v2`, 9 unpushed local commits, 61 commits
  behind its own origin, and real uncommitted modifications across ~10+ files).
  Its `.git` is additionally misconfigured with `core.bare = true`, which
  breaks plain `git status`/`git checkout` from that directory even though it
  has a live, dirty working tree — a pre-existing condition, not something
  this pass changed. `c:\Users\jsmit\KScan\.git` itself is the shared bare
  object store backing ~240 other worktrees. **This workspace was never
  touched.** All discovery reads used explicit `--git-dir` tree-ish inspection
  against `origin/staging/production-parity`; no working tree was checked out
  or modified until this implementation worktree/branch was created fresh.
- Implementation branch: `ops/backend-release-rollback-v1`, created from
  `origin/staging/production-parity` HEAD, in a new isolated worktree at
  `C:/src/KScan-backend-release-rollback-v1-20260811`. No other worktree or
  branch was touched.

## Backend component inventory

### Edge Functions

| | Repo (`supabase/functions/*` on staging branch) | Staging deployed | Production deployed |
|---|---|---|---|
| Count | 17 dirs (16 functions + `_shared`) | 20 | 16 |

- 16 of 17 repo functions are deployed to **both** environments (the 17th,
  `staging-health`, is intentionally staging-only).
- 3 functions are live on **staging only** with **zero repo source ever**:
  `privacy-controls`, `public-sale-share-opt-out` (website-heritage, permanent),
  `product-match` (governed quarantine boundary, correctly excluded).
- 16 of 16 production functions have matching repo source directories.
- **Version numbers are not a valid parity signal.** Supabase's per-project
  deploy counter is independent per project (e.g. `scan-identify` shows v4 on
  staging vs v141 on production) and does **not** indicate content drift by
  itself — the repo's own tooling (`config/edge-function-manifest.json`) uses
  content SHA-256/tree-hash comparison instead, correctly.
- **VERSION_ATTRIBUTION_STATE: PARTIAL.** Full, gated, content-hash attribution
  exists for exactly 2 of 16 shared functions (`scan-identify`,
  `stylechat-generate` — `style-outfit-generate` is referenced in some docs as
  a third governed function but the live manifest object governs 2; treat the
  exact governed set as authoritative from `config/edge-function-manifest.json`
  itself, not from this summary). The remaining ~14 functions have no
  source-attribution mechanism. Deploy provenance (via Supabase's own
  `entrypoint_path` metadata) shows a **mix of ephemeral-upload-style and
  local-developer-CLI-style** deploys to both projects — see "Deployment path"
  below; this is evidence, not certainty, since entrypoint_path only reflects
  the most recent deploy.

### Database

- **REPO_MIGRATION_LEVEL** (staging branch, `supabase/migrations/*.sql`): 103
  files.
- **STAGING_MIGRATION_LEVEL** (live, via Management API): 103 applied — matches
  repo count exactly.
- **PRODUCTION_MIGRATION_LEVEL**: **[CORRECTED IN PHASE 2A]** 87 ledger
  entries were **observed** via the Management API. This is a statement about
  what the ledger reports, **not** a statement that production's migration
  provenance is known or trustworthy. Production's own
  `supabase_migrations.schema_migrations` table contains at least two entries
  whose stored `statements` are placeholders rather than the DDL that ran
  (documented in `docs/security/batch0-migration-source-restoration.md`), so
  ledger presence proves a record exists, not that the recorded DDL executed.
  Production migration provenance therefore remains **UNKNOWN**; do not
  collapse "87 observed entries" into "production is at migration level 87."
- Project convention (documented in-repo, GP-004/GP-006 migration headers):
  **the applied `version` timestamp does not match the migration filename** —
  the deploy tool stamps its own apply-time timestamp. Reconciliation must
  match by migration **name**, never by version number. A naive version-number
  diff is actively misleading on this repo.
- **Migration drift, reconciled by name:**
  - 18 non-waitlist migrations exist on staging with no equivalent (by name) on
    production — the expected direction (staging is the proving ground; these
    are pending promotion). 2 additional staging-only migrations
    (`create_waitlist_signups_main_backend`, `waitlist_email_delivery_state`)
    are permanently staging-only by design (website heritage).
  - **4 migrations exist on production with no equivalent (by name) on
    staging**: `add_ai_output_reporting`, `contribution_block_enforcement`,
    `legal_acceptances_add_ai_processing`, `shared_room_item_contributions`.
    This is the **unexpected direction** — production has schema that staging
    has never validated. Two of these (`add_ai_output_reporting`,
    `contribution_block_enforcement`, per prior project history) were
    deliberately deployed directly to production as part of a specific,
    reviewed feature (GP-006/GP-004) — a documented exception, not an
    accident, but it means staging's current certified state does **not**
    reproduce current production schema.
  - `shared_room_item_contributions` is the most concrete drift finding: the
    file for it sits in `supabase/migrations-deferred/` on the staging branch,
    with a repo-committed README stating (as of its own writing) *"it is not
    applied in production."* Live data shows this is now **false** — the
    identically-named migration is applied and active in production
    (`20260808201806`). The deferred file's RLS/column rationale
    (`dressing_room_items` policy differences) has not been re-validated
    against current production since production changed underneath it.
    **This is the single clearest, best-evidenced example of drift a future
    gate must catch: a migration explicitly marked "not safe to promote
    because production differs" where production has since moved further
    without staging's knowledge.**

    **[CORRECTED IN PHASE 2A]** This is now a **formal production-promotion
    reconciliation blocker**, not merely a noted discrepancy. It is recorded
    in `security/release/production-migration-reconciliation.json` with
    `promotionImpact: BLOCKS_PRODUCTION_PROMOTION`, and
    `security/release/production-eligibility.js` returns
    `PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED` while it is unresolved.
    Resolving it requires a scoped, owner-authorized read-only comparison of
    production's current `dressing_room_items` policy set and column list
    against the deferred file — Phase 2A deliberately did not perform that
    comparison. See `PRODUCTION_MIGRATION_RECONCILIATION.md`.
  - **MIGRATION_DRIFT classification: UNEXPECTED_DRIFT** (not merely
    EXPECTED_ENVIRONMENT_DIVERGENCE) — specifically because of the 4
    production-ahead migrations and the stale-deferral case above. The
    staging-ahead backlog (18 items) is separately classified
    EXPECTED_ENVIRONMENT_DIVERGENCE (normal pending-promotion backlog).
  - Even production's own migration ledger is not fully trustworthy as ground
    truth: a repo-documented finding (`docs/security/batch0-migration-source-restoration.md`)
    shows at least 2 production ledger rows contain placeholder text
    (`"applied via lifecycle rollout"`, `select 1;`) instead of the actual
    applied DDL — meaning production's migration history table cannot always
    be replayed to reconstruct what was actually run.
- **RLS_STATE**: RLS/GRANT changes are common and ongoing; the most recent 20
  migrations contain zero destructive DDL (no DROP TABLE/COLUMN, no TRUNCATE,
  no unbounded DELETE, no ALTER TYPE, no enum removal) but do contain frequent
  `CREATE OR REPLACE FUNCTION` redefinitions of SECURITY DEFINER function
  *bodies* under unchanged signatures, and `DROP POLICY` + recreate pairs on
  populated tables. See "Migration risk sample" below.
- **RPC_STATE**: SECURITY DEFINER RPCs are the dominant privileged-access
  pattern (~40 distinct functions across account-deletion, dressing-room, and
  quota/StyleChat subsystems). Every one confirmed (per repo's own live audit
  doc) to set an explicit `search_path`.
- **TRIGGERS**: 32 triggers, overwhelmingly `*_set_updated_at` maintenance
  triggers plus a handful of behavioral ones (`on_auth_user_created`,
  `dressing_room_messages_flat_thread`, `dressing_rooms_normalize_note`,
  `inspiration_items_prevent_media_rewrite`).
- **EXTENSIONS**: only `pgcrypto` is ever created by a migration (idempotently,
  4×). Both live projects have `pgcrypto`, `uuid-ossp`, `pgtap`,
  `pg_stat_statements`, and `supabase_vault` installed (platform defaults),
  plus `pg_cron` and ~70 others merely *available* but **not installed** on
  either project.
- **SCHEDULED_DB_JOBS**: none. `pg_cron` is listed as available on both
  projects but `installed_version: null` on both — confirmed live and
  independently confirmed in a repo audit doc. No `cron.schedule` call exists
  anywhere in the migration history.

### Storage

4 buckets, all migration-defined: `style-library-images` (private, 5 MB,
image/jpeg|png|webp), `image-ingestion-quarantine` (private, 10 MB, worker-only
write), `image-ingestion-clean` (private, 10 MB, worker-only write, owner
read), `legal-documents` (public, added specifically to match a production
audit finding that production has exactly two buckets:
`legal-documents` + `style-library-images` — i.e., the two ingestion buckets
are staging/newer-feature-only today).

### Configuration

Non-secret categories only (names, not values): app-level feature flags
(`constants/featureFlags.ts`, `constants/freeTierBackendFlags.ts`), a
DB-driven kill-switch (`public.app_config`, key `mobile_feature_freeze`),
AI-provider routing modules (`supabase/functions/_shared/llmModelRouting.ts`
and per-function routing files), client env vars (`EXPO_PUBLIC_SUPABASE_URL`,
`EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_API_URL`), server env vars
(`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `USE_OPENROUTER`).
`eas.json` on the canonical staging branch correctly targets all 4 build
profiles (`preview`, `development`, `staging` → staging ref; `production` →
production ref) — a prior known misconfiguration (preview/development
pointing at production) is confirmed **resolved** on this branch. EAS itself
remains out of scope for this project.

### Workers / scheduled jobs

Only one worker-shaped component exists: the account-deletion lifecycle
(`process-account-deletions`, `resend-restoration-email`, `restore-account`
Edge Functions).

- **How started**: HTTP `Deno.serve` handler, shared-secret-authenticated
  (`ACCOUNT_DELETION_WORKER_SECRET`). The repository workflow is
  `workflow_dispatch` only and targets staging for owner-authorized synthetic
  verification. Automatic final purge/scheduler activation is
  **DEFERRED_BY_EXPLICIT_PRODUCT_DECISION** for Build 29. No production trigger
  was created or changed by this release.
- **How stopped**: two independent `app_config` kill-switch rows
  (`account_deletion_worker_enabled`, seeded `false`;
  `account_deletion_worker_dry_run`, seeded `true`), enforced in 3 independent
  layers (Edge Function, RPC, operator CLI script) — a real, working pause
  mechanism, but it only stops the *effect* of an invocation, not whatever
  external trigger (if any) is calling the endpoint.
- **Idempotency**: strong — claim-and-lease pattern with `for update skip
  locked`, lease expiry, and crash-recovery reconciliation. Confirmed via
  direct migration/source read, not inference.
- **Restoration resend control**: `rotate_restoration_token_by_email` enforces
  at most three restoration emails in a rolling 24-hour window while the Edge
  Function preserves the same generic response for matched and unmatched
  addresses. The RPC remains service-role-only.

## Health / version surfaces

| Path | Auth | Env identity? | Source SHA? | Release ID? | Expensive deps? | Suitable for release verification? |
|---|---|---|---|---|---|---|
| `staging-health` Edge Function (staging only) | `verify_jwt=false`, public | Yes, hardcoded `'staging'` | No — `version` field reads an env var (`KSCAN_DEPLOY_VERSION`) that is **set on neither project**, so it always returns a static placeholder | No | 3 bounded (8s-timeout, `limit=1`) DB reads | Partially — good liveness/DB-reachability shape, but version/release identity is currently inert |
| Every other Edge Function | Mixed (`verify_jwt` per `supabase/config.toml`) | No | No | No | N/A | No — 405 on non-POST, no health branch, only distinguishes deployed-vs-not via error code |
| `config/edge-function-manifest.json` | N/A (build-time artifact, not an endpoint) | N/A | Yes (`provenance.generatedFromGitSha`, explicitly excluded from parity comparisons) | Partial (2 functions only) | N/A | Deploy-time gate input, not a queryable runtime surface |
| Legacy Render `server.js` `/api/health` | Public (extra diagnostic headers, incl. `X-KScan-Deployed-Commit`, gated behind a shared secret in production) | No | **Yes** — the only surface in the repo returning a real deployed commit SHA, via Render's auto-injected `RENDER_GIT_COMMIT` | No | No | No — this service is deployed and publicly reachable but **orphaned from the app's runtime call graph** (confirmed via docs: mobile client no longer calls it); a real but irrelevant health surface today |
| Production | — | — | — | — | — | **No health/version surface of any kind exists for production.** |

**Gaps against the conceptual `/health/live`, `/health/ready`, `/version`,
protected `/health/dependencies` model**: none of the four exist in that shape
today, on either environment. `staging-health` and `scripts/verify-supabase.js`
(the richer, CI-invoked check — see Smoke Tests below) together cover roughly
the live/ready/dependencies shape for staging only. Production has nothing.

## Existing deployment path

**Staging**: two overlapping, mature CI workflows —
`security-staging-gate.yml` (PR-triggered and reusable-called; branch-identity
gated to `staging/production-parity`, refuses the production ref by explicit
guard, deploys only PR-changed migrations/functions, never a full-directory
push) and `staging-controlled-deploy.yml` (manual, single-function,
migration-approval-gated, with an automated `rollback-on-failure` job on
health/synthetic-test failure). `staging-release-certification.yml` wraps
the former with SHA/tree identity verification and produces
`security/reports/staging-certification.json` as a CI artifact.

**Production: no CI-driven deployment path exists at all.** No workflow
references the production project ref as a write target — it appears only
inside deny-list guards ("refuse if ref equals production"). The one
repo-documented production path is `scripts/deploy-edge-functions.js`, a
**local, manually-invoked CLI wrapper**, never called from any workflow,
governing 2 of 16 shared functions, requiring an operator to hold Supabase
credentials on their own machine and pass `--confirm-deploy` explicitly. The
doc's own text: *"a user with the Supabase CLI and credentials can still
bypass the wrapper."* Live Edge Function metadata (`entrypoint_path`) is
consistent with at least some production functions having been deployed via
raw local CLI runs from specific developer worktrees rather than any gated
path — this is evidence from deploy-time metadata, not a certainty, since
that metadata only reflects the most recent deploy.

Master's role: `promote-certified-staging.yml` opens an auto-merge PR from a
certified staging candidate into `master`; `master-promotion-validation.yml`
enforces a runtime-tree-equivalence check on that PR. Master itself has no
further deploy mechanism — reaching master is a **code-merge** milestone, not
a **running-service** milestone. `master-required-checks.yml` re-runs the same
static scanner set scoped to master.

**SHA/environment enforcement**: real and repeated at multiple independent
layers (branch-ref checks, `git cat-file -e` commit-existence assertions,
tree-hash comparisons before any write, JWT `ref`-claim decoding in tests).

**Security gates** (inventory only, none added/removed): repo-defined test
suite (`security-code.yml`), Gitleaks, Semgrep, OSV-Scanner, Trivy, npm audit
(report-only, dual-defined for staging and master), ZAP Baseline + ZAP API
(staging, skip cleanly if unconfigured), RLS/RPC policy tests (blocking),
artifact-exposure scan (blocking), quarantine/provenance-exception enforcement
(blocking), leaked-password-protection check (**currently BLOCKED** —
Supabase free-plan limitation, HTTP 402, an active failing control, not just a
gap), master-scoped runtime-tree equivalence (blocking). **CodeQL's workflow
definition could not be found in `.github/workflows/*` on either branch** —
commit messages imply it runs via GitHub's native code-scanning default
setup, which is UNKNOWN/unconfirmable from repo files alone.

**Maestro**: confirmed SUSPENDED (`security/release/native-ui-automation-policy.json`,
`status: SUSPENDED`, `required_for_release: false`, decided 2026-08-09) and
explicitly read at certification time as informational-only, never
PASS/BLOCKED. No Maestro workflow file exists on `staging/production-parity`
at all; a manual-dispatch-only Maestro workflow still exists on `master`
(checks out a separately pinned branch), consistent with "parked for future
manual use," not reintroduced as a gate.

**Reusable as-is**: SHA/tree-identity verification pattern; the
resolve→certify→independently-re-validate→write separation in
`promote-certified-staging.yml`; report-only-vs-blocking scanner split;
change-scoped migration/function deploy tooling; the quarantine/provenance-
exception mechanism; policy-as-data for suspendable gates (the Maestro policy
file pattern); staging's automated rollback-on-failure job.

## Smoke / synthetic test capability

~220 files under `__tests__/` (no separate `tests/`/`e2e/` dir). The large
majority (Auth, Scanner, Elise/StyleChat, Closet, Dressing Rooms, Sharing) are
**ALREADY_AUTOMATED but pure unit/mock tests** — real coverage of contract
shape, zero live network calls.

Two genuine live/synthetic assets exist:

1. **`security/scripts/synthetic-staging-tests.js`** (CI-invoked, the actual
   "Synthetic auth tests" job) — fails closed on any non-staging URL before
   the first network call, uses 3 pre-provisioned throwaway
   `*@kscan-test.invalid` accounts, never creates/deletes a user, never
   touches Waitlist/privacy tables, and does make one real LLM-backed
   `stylechat-generate` call per run (real provider cost, bounded).
   **PRODUCTION_SAFE_SYNTHETIC in design intent, STAGING_ONLY in current
   wiring** (no production-equivalent synthetic accounts exist).
2. **`__tests__/staging/stagingBackendContract.test.js`** — anon-key-only,
   explicitly asserts it cannot target production (decodes the JWT `ref`
   claim), read-only by construction (RLS-negative-read assertions, RPC/
   function existence probes only). **Env-gated and, per available evidence,
   not wired into any CI workflow today** — appears to run manually/locally
   only. This is the strongest existing candidate to generalize into a
   dual-environment release-verification smoke suite, since its design is
   already production-safe in spirit.

`scripts/verify-supabase.js` (the actual script the `staging-health` CI job
runs, despite the job's name) is a broader PASS/WARN/BLOCKER check covering
Auth reachability, PostgREST reachability, 6 schema-column probes, 1 RPC
probe, and 3 Edge Function deployment probes — **PRODUCTION_SAFE_READ_ONLY as
written**, but has no built-in production-refusal guard of its own (unlike
the two assets above); safety today is entirely a property of which env vars
the calling workflow happens to set, not of the script itself.

`DELETE_LIFECYCLE`/account-deletion coverage is **PARTIAL**: all existing
tests mock the Supabase client or regex-match Edge Function source text; no
automated test exercises a live deletion end-to-end. This is deliberate —
`docs/account-deletion-e2e-gate.md` is a human-run runbook requiring named-
owner approval for every destructive step — but the doc itself is now stale
(it claims "no staging project is configured," which predates the current
rebuilt staging project) and should be re-validated before being relied on.

Per-group classification: AUTH/SCANNER/ELISE/CLOSET/DRESSING_ROOMS/SHARING —
ALREADY_AUTOMATED (unit-level). DELETE_LIFECYCLE/STORAGE — PARTIAL.
DATABASE/RLS/RPC — ALREADY_AUTOMATED for static policy text, live verification
exists but lives outside `__tests__/` in `security/scripts/verify-*.js`.

## Production release provenance

- **SOURCE_SHA: UNKNOWN.** No CI deploys production, so nothing attributes a
  commit SHA to what's running. A one-time, now-stale Phase 2A manual
  comparison exists for 2 functions only, and the doc that recorded it says
  outright it "does not and cannot confirm what is currently running in
  production."
- **MIGRATION_LEVEL: UNKNOWN** in the strict sense — two stale manual
  snapshots exist (~80-81 migrations, both about a week old relative to this
  discovery), and production's own migration ledger has confirmed placeholder
  rows that don't reflect actually-applied DDL. The live count obtained during
  this pass (87) is the most current number available but is a point-in-time
  read, not a continuously-verified figure.
- **EDGE_FUNCTION_RELEASE_ATTRIBUTION: PARTIAL.** Content-hash manifest exists
  for a small governed subset; even that subset's live version numbers had
  already moved past the last recorded manifest snapshot by the time of a
  prior audit, confirming the manifest is not kept continuously in sync with
  live state.
- **CONFIG_FINGERPRINT: NOT_AVAILABLE.** No production-scoped config manifest
  or fingerprinting script exists anywhere in the repo.

## Last Known Good

**STATUS: UNKNOWN.** No artifact anywhere bundles source SHA + migration level
+ function versions + config state + passing verification evidence together,
for either environment. The closest candidate,
`docs/staging/staging-operational-baseline.md` (the most recent baseline-freeze
doc, dated 2026-08-10), is staging-only and **self-disqualifies**: its own
certification verdict is `BLOCKED` (`leaked_password_protection`), and its
paired mobile build never completed. 8 git tags exist; all are mobile/feature
build baselines that predate this governance effort and do not pair a SHA with
migration level + verification evidence. No GitHub Releases mechanism exists.
Every "known-good" phrase found in docs refers to a single Edge Function or
single migration rollback, never a whole-backend bundle.

## Rollback capability

| Component | Status | Evidence |
|---|---|---|
| FEATURE_FLAG_ROLLBACK | PARTIAL | Ad hoc per-variable toggles exist (`app_config`, `ALLOW_DEV_FALLBACK`); no unified rollback tool/history |
| CONFIG_ROLLBACK | PARTIAL/MISSING | Aspirational guidance only ("should be reversible the same way"), never drilled |
| EDGE_FUNCTION_ROLLBACK | **CONFIRMED, staging only** | Automated `rollback-on-failure` CI job + documented, stated-exercised manual procedure. No production equivalent anywhere. |
| WORKER_PAUSE | PARTIAL | `app_config` kill-switches exist for the one real worker (account deletion); no pause mechanism for anything else |
| WORKER_ROLLBACK | Same as Edge Function rollback (workers here are Edge Functions) | staging only |
| DATABASE_REVERSE_MIGRATION | PARTIAL | Manual, case-specific `DROP`-statement runbooks exist for individual migrations; no generic/automated tool |
| DATABASE_FORWARD_FIX | PARTIAL | One documented example (config-toggle-preferred-over-rollback pattern); not a general runbook |
| DATA_RESTORE | MISSING (as a general capability) | Only a bespoke, one-off, staging-only, 2-table snapshot tool tied to a single historical rebuild; explicitly never targets production |
| PITR | **MISSING** | Free-plan org confirmed live; repo's own security-layer audit doc states "Backup and recovery: Not covered" |
| FULL_MULTI_COMPONENT_RECOVERY | MISSING | No component above reaches "confirmed" together, let alone in combination |

**Governing conclusion**: the repo has one real, automated, exercised rollback
mechanism — Edge Function redeploy-on-failure — scoped entirely to staging.
Every other rollback category is partial, ad hoc, or missing, and nothing
reaches production. A future release system must treat production rollback as
**net-new infrastructure to build**, not existing capability to wire up.

## Backup / PITR

- **PLAN**: free (verified live via Management API, not inferred).
- **BACKUPS**: no automated backup mechanism confirmed for either project; no
  doc claims one exists.
- **PITR**: not available — free plan; no add-on purchase evidenced anywhere.
- **RESTORE_PATH**: none general-purpose; the one existing restore-adjacent
  tool is scoped to 2 legacy tables on staging only, sourced from an
  out-of-repo manual snapshot file.
- **RESTORE_DRILL_HISTORY**: none found.
- **CONFIDENCE: VERIFIED** (for "not available/not confirmed" — this is a
  confirmed absence, not an unexamined gap; the free-plan status itself is
  independently, live-verified fact).

**Governance conclusion (required by the task)**: since PITR/restore is
unverified (in fact, verified-absent), any future automated production
promotion path must **prohibit** DATA_TRANSFORMING and DESTRUCTIVE migration
classes (per the Phase 11 taxonomy below) from being applied to production
without a manual, reviewed, individually-approved forward-fix or reverse
script prepared *in advance* — there is no safety net to fall back on if such
a migration goes wrong. EXPANSION_SAFE and REVERSIBLE-only migrations are the
only classes safe for any future automated promotion.

**[CORRECTED IN PHASE 2A]** This is no longer advisory prose. It is encoded
as machine-enforced policy in
`security/release/backup-capability-policy.json` and applied by
`security/release/production-eligibility.js`:

| Risk class | Production promotion | Blocker code |
|---|---|---|
| EXPANSION_SAFE | eligible after normal gates | — |
| REVERSIBLE | blocked until a **tested** recovery path exists (an unexercised rollback runbook does not satisfy this) | `RECOVERY_PLAN_REQUIRED_FOR_RISK_CLASS` |
| DATA_TRANSFORMING | **blocked** while PITR is unavailable | `PITR_REQUIRED_FOR_RISK_CLASS` |
| FORWARD_FIX_ONLY | blocked pending an explicit reviewed recovery plan | `REVIEWED_RECOVERY_PLAN_REQUIRED` |
| DESTRUCTIVE | **blocked** | `DESTRUCTIVE_MIGRATION_PROHIBITED` |

Note the policy file's own escalation guard: flipping
`productionPitrAvailable` to `true` is necessary but **not sufficient** to
reconsider DATA_TRANSFORMING promotion — `productionRestoreDrillHistory` must
also record a real, successful restore drill.

## Migration risk sample (basis for the future safety gate)

Sample: all 20 migration files from `20260803020000` onward (the most recent
contiguous block). **Zero destructive DDL** (no DROP TABLE/COLUMN, TRUNCATE,
unbounded DELETE, ALTER TYPE, NOT NULL tightening, enum removal) appears in
this sample — but three real risk patterns recur and must be what the future
gate is built to detect, since a naive DDL-keyword scanner would miss all of
them:

1. **`CREATE OR REPLACE FUNCTION` redefining a pre-existing, already-granted
   SECURITY DEFINER function's body under an unchanged signature.** This is
   the dominant privileged-access change pattern in the codebase (dozens of
   instances). A signature-only diff tool would see no change at all.
2. **`DROP POLICY` + recreate pairs on tables that already carry real user
   rows** (e.g. `dressing_rooms`, `content_reports` in
   `20260806153233_dressing_room_user_blocking.sql`) — reversible in
   principle, but with no automated down-migration, only hand-authored
   markdown rollback runbooks (one exists for this file:
   `20260806153233_dressing_room_user_blocking_ROLLBACK.md`, which itself
   labels its own down-steps as data-destructive).
3. **Broad `REVOKE`/`GRANT` campaigns** spanning dozens of functions in a
   single migration — individually reversible, collectively capable of
   fail-closed regressions. One already shipped and was caught only in a
   follow-up migration (`20260808115735` had to add
   `grant usage on schema internal to authenticated` after a prior migration's
   privilege changes caused two live RLS policies to fail closed in staging).
   This is direct, in-repo evidence of exactly the failure mode a promotion
   gate exists to prevent.
4. One embedded, probabilistic, table-wide (not row/user-scoped)
   `DELETE ... WHERE updated_at < now() - interval '1 day'` inside a hot,
   client-triggered SECURITY DEFINER RPC path (`20260808121216`) — bounded by
   its own WHERE clause and low execution probability, but a pattern ("DELETE
   with no LIMIT running inside a request-path RPC, not a maintenance job")
   worth a dedicated gate rule regardless of this specific instance's safety.

Concrete SQL patterns the future gate must detect: `DROP TABLE`, `DROP
COLUMN`, `TRUNCATE`, `DELETE` without a single-row/single-user-scoped `WHERE`,
`ALTER ... TYPE`, `ALTER COLUMN ... SET NOT NULL` on a pre-existing column,
RPC signature changes, enum value removal, `DROP POLICY`/`REVOKE`/`GRANT` on
pre-existing populated tables — **and additionally, specific to this repo's
actual pattern of risk, `CREATE OR REPLACE FUNCTION` on any function already
referenced by a live RLS policy or already granted to `authenticated`/`anon`**,
since that is where real regressions have actually occurred here.

## CI / credential permissions

- **STAGING_CREDENTIAL_ISOLATION: PASS, with a caveat.** Distinct secret/var
  names, consistent `environment: staging` gating, multiple independent
  script-level production-ref refusals. Caveat: the underlying
  `SUPABASE_ACCESS_TOKEN` is likely account-wide-scoped, not project-scoped —
  isolation is a logic guarantee, not a credential guarantee (see
  `ENVIRONMENT_AUTHORITY.md`).
- **PRODUCTION_CREDENTIAL_ISOLATION: UNKNOWN.** There is no CI-side production
  credential to evaluate — production is reachable only via a developer's own
  local Supabase CLI session, which is an operational control this repo does
  not describe (no doc on how production credentials are stored/rotated on
  developer machines).
- **UNTRUSTED_PR_PRODUCTION_SECRET_ACCESS: NO.** No production-named secret
  exists anywhere to leak; the workflows that do carry secrets trigger on
  plain `pull_request` (not `pull_request_target`), which does not forward
  secrets to fork-originated PRs under GitHub's default behavior. The repo is
  additionally single-owner-operated per its own release-approval doc, making
  this a low-relevance vector regardless.
- **GAP**: GitHub Environment protection-rule configuration (required
  reviewers, wait timers) for the `staging` environment cannot be confirmed
  from repository files — it is live GitHub settings state.

## Reusable existing controls

- SHA/tree-identity verification pattern (`git cat-file -e`, tree-hash
  comparison before any write) — `staging-release-certification.yml`,
  `promote-certified-staging.yml`.
- Resolve → certify → independently re-validate → write separation in
  `promote-certified-staging.yml`.
- Report-only-vs-blocking scanner split in `security-code.yml`.
- Change-scoped migration/function deploy tooling
  (`apply-candidate-migrations.js`, `deploy-changed-functions.js`,
  `select-changed-functions.js`), driven by a documented incident postmortem.
- Quarantine/provenance-exception mechanism
  (`security/staging/provenance-exceptions.json` +
  `staging-deployment-allowlist.js`).
- Policy-as-data pattern for suspendable gates
  (`security/release/native-ui-automation-policy.json`).
- Staging's automated rollback-on-failure job
  (`scripts/rollback-staging-function.mjs`).
- `__tests__/staging/stagingBackendContract.test.js` as the seed of a
  dual-environment smoke suite.
- `config/edge-function-manifest.json` + `scripts/generate-edge-function-manifest.js`
  as the seed of a full release manifest, once extended past 2 functions.

## Missing controls

- Any production deployment automation whatsoever.
- Any production health/version/dependency-health endpoint.
- Any production rollback, restore, or forward-fix automation.
- A unified release-state manifest covering all ~20 Edge Functions (today: 2).
- A continuously-verified (vs. point-in-time-snapshot) production
  migration/function/config attribution mechanism.
- A Last Known Good bundle definition and the tooling to produce one.
- PITR or any backup capability (plan-level absence, not a tooling gap).
- A generic, automated database reverse-migration/forward-fix tool (today:
  case-by-case hand-authored runbooks).
- Automatic account-deletion purge scheduling is intentionally absent from the
  Build 29 release surface: `DEFERRED_BY_EXPLICIT_PRODUCT_DECISION`.
- GitHub Environment-level protection-rule visibility from repo tooling.

## Stop-condition review

| Condition | TRUE/FALSE | Classification |
|---|---|---|
| CANONICAL_PRODUCTION_PROJECT_UNCLEAR | FALSE | — |
| STAGING_PRODUCTION_CREDENTIALS_MIXED | FALSE (no evidence of actual mixing; scope-verification gap noted, not mixing) | — |
| PRODUCTION_MIGRATION_STATE_UNKNOWN | **TRUE** | PRODUCTION_PROMOTION_BLOCKER |
| LAST_KNOWN_GOOD_UNKNOWN | **TRUE** | PRODUCTION_PROMOTION_BLOCKER (does not block building the staging-first control plane) |
| DESTRUCTIVE_MIGRATION_WITHOUT_RECOVERY | **TRUE** (structurally — no PITR/restore exists, so any future destructive migration would lack recovery, even though none in the sampled 20 files is itself destructive today) | PRODUCTION_PROMOTION_BLOCKER |
| PRODUCTION_BACKUP_PITR_UNVERIFIED | **TRUE** (verified-absent, which is stronger than merely unverified) | PRODUCTION_PROMOTION_BLOCKER |
| SOURCE_SHA_AMBIGUOUS | **TRUE** (for production only; staging SHA/tree identity is well-enforced) | PRODUCTION_PROMOTION_BLOCKER |
| SECURITY_BYPASS_REQUIRED | FALSE | — |
| KNOWN_SCHEMA_INCOMPATIBLE_ROLLBACK | FALSE (no evidence found; not exercised either) | — |
| MIGRATION_HISTORY_DRIFT | **TRUE** (4 production-only migrations; the stale-deferral case) | PRODUCTION_PROMOTION_BLOCKER |
| UNREVIEWED_MANUAL_PROD_SQL_REQUIRED | FALSE (this pass required none; historically, production Edge Function/migration changes have happened via reviewed-but-manual channels, which is a process-maturity gap, not a stop condition for this pass) | — |
| AUTOMATION_WOULD_EXPOSE_SECRETS | FALSE | — |

**None of the TRUE conditions block building Phase 2's staging-first release
control plane** (environment authority verification, release-state model,
manifest/freeze, migration classification, health/version contracts, staging
smoke verification, staging deployment orchestration, evidence, Last-Known-Good
definition for staging). All of them legitimately block **automated production
promotion** until: (a) production's actual current migration/function state is
re-verified and reconciled against staging (starting with the 4-migration gap
found here), (b) a Last-Known-Good bundle definition exists and staging can
produce one that passes cleanly, (c) either PITR is purchased/enabled or the
future promotion gate hard-prohibits DATA_TRANSFORMING/DESTRUCTIVE migration
classes from automated production promotion, and (d) production gets a real
SHA/version attribution mechanism (starting with wiring `KSCAN_DEPLOY_VERSION`
into whatever eventually deploys it).

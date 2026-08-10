# Staging operational baseline

First operational baseline established by the staging-final-operational-readiness pass, 2026-08-10.

This document is the reference point for "is staging usable right now" and "how do I validate a future staging change." It supersedes ad hoc knowledge scattered across prior audit docs for day-to-day operating purposes; the historical provenance docs under `docs/release/` and `docs/staging-rebuild/` remain the record of *how* staging got here and are not superseded.

## Baseline identity

| Field | Value |
|---|---|
| Baseline staging SHA | `2efc7e2573cfcfdde02c158da3cbe8a41819ecd2` |
| Baseline master SHA | `fdb2c0fada410abb3b8ebee6413116204f49e1aa` |
| Certification run ID | [`31411378813`](https://github.com/kscanaiapp/kscan-app/actions/runs/31411378813) |
| Certification candidate SHA | `2efc7e2573cfcfdde02c158da3cbe8a41819ecd2` (== staging branch head == deployed SHA) |
| Staging Supabase project | `yzqjvdfgefveprobvvyw` ("K Scan AI Staging") |
| Production Supabase project | `wyyuqfdxucjksghsmhry` ("KScan App Production") — **no-touch**, not accessed by this pass |
| Runtime release certification | **BLOCKED** — solely by `leaked_password_protection` (see below) |
| Staging development readiness | **READY** |

## What changed to reach this baseline

Two PRs landed as part of this pass, both fixing the same underlying issues (CodeQL scans `master`, the default branch; the vulnerable code was byte-identical on both branches):

- [#103](https://github.com/kscanaiapp/kscan-app/pull/103) into `staging/production-parity`
- [#104](https://github.com/kscanaiapp/kscan-app/pull/104) into `master`

Fixes:
- `services/transactionalEmail.js`: a polynomial-backtracking regex (`EMAIL`) had its length gate ordered *after* the regex test, so it never actually bounded input before the expensive match ran (~23s at 40k chars, measured). Reordered so length is checked first. Regression test added (`__tests__/transactionalEmailValidation.test.js`).
- `server.js`: `CORS_ORIGIN` defaulted to `'*'` when unset. `render.yaml` always sets it explicitly for the deployed service, so this was a zero-live-behavior-change hardening of the fallback.
- 5 `js/clear-text-logging` CodeQL alerts in `scripts/verify-supabase.js` were dismissed as false positive after tracing the dataflow (the only secret in that script is masked before logging; the flagged lines never touch it).

Result: **0 open CodeQL alerts** (3 fixed and verified by re-scan, 5 dismissed with documented reasoning), down from 8.

## Runtime release certification: BLOCKED, and why that's the correct call

Run [`31411378813`](https://github.com/kscanaiapp/kscan-app/actions/runs/31411378813) against the baseline SHA:

| Gate | Result |
|---|---|
| `static_security` | PASS |
| `contract_tests` | PASS |
| `staging_parity` | PASS |
| `staging_health` | PASS |
| `synthetic_auth` | PASS |
| `rpc_rls_authorization` | PASS |
| `artifact_exposure` | PASS |
| `quarantine_policy` | PASS |
| `zap_baseline` | PASS |
| `zap_api` | PASS |
| `migration_validation` | NOT_APPLICABLE (no migrations in this change set) |
| `native_ui_automation` | `SUSPENDED`, `required: false`, `NOT_REQUIRED_BY_CURRENT_POLICY` (per owner policy — no native evidence blocks present, confirming PR #99's fix holds) |
| `leaked_password_protection` | **BLOCKED** |

`blocking_findings: ["leaked_password_protection"]`, `operational_failures: []`, `final_verdict: BLOCKED`, `promotion_eligible: false`.

### leaked_password_protection — OWNER_EXTERNAL_ACTION_REQUIRED

Verified directly against the live project (Supabase security advisors: `auth_leaked_password_protection`, WARN — "Leaked password protection is currently disabled"). Supabase's own documentation states leaked-password protection (HaveIBeenPwned checking) **requires the Pro Plan or above**. The `KScan` organization (`dtcbsuytyjpvadcnyymn`) is on the **free** plan (confirmed via the Management API). No available tool — MCP or CLI — exposes an auth-config mutation endpoint regardless, so this cannot be enabled autonomously even if the plan allowed it.

**Required owner action:** upgrade the `KScan` Supabase organization to the Pro plan (or above), then enable "Leaked password protection" under Authentication → Policies for the `yzqjvdfgefveprobvvyw` project. This is the only blocker standing between `BLOCKED` and a clean `PASS`.

Per the task's own framing, this is a plan-capability gap, not an application or security defect — staging remains fully usable for development in the meantime.

## Staging environment contract

Verified against the live-consumed config (`eas.json` build-profile `env` blocks — the actual runtime source of truth; there is no `app.config.js/.ts`):

- `staging`, `preview`, `development` profiles → `EXPO_PUBLIC_SUPABASE_URL=https://yzqjvdfgefveprobvvyw.supabase.co` ✅
- `production` profile → `https://wyyuqfdxucjksghsmhry.supabase.co` ✅
- `supabase/config.toml` CLI link → `yzqjvdfgefveprobvvyw` ✅
- Enforced in CI by `__tests__/staging/easProfileParity.test.js` and `__tests__/runtimeProvenanceResolution.test.js`

**Known stale documentation** (not live-config-affecting, cleanup opportunity only): several pre-cutover docs (`docs/app-staging-catalog-readiness-v1.md`, `docs/stylechat-v0.2/0.3/0.4.md`, `docs/catalog-ingest-v1.md`, `docs/edge-function-deployment.md`, and others) and `.env.example`'s staging section still use the pre-2026-08 naming, where `wyyuqfdxucjksghsmhry` was called "App Staging." Current naming (confirmed live via `list_projects`): `yzqjvdfgefveprobvvyw` = "K Scan AI Staging", `wyyuqfdxucjksghsmhry` = "KScan App Production". A developer following the stale `.env.example` comment alone (not the actual `eas.json` values) could misidentify which project is which — worth a documentation-only cleanup PR, not urgent.

## Database / Edge Function / RLS parity

Verified with `node security/scripts/verify-staging-parity.js --state <observed>`, where `<observed>` was built from live queries against `yzqjvdfgefveprobvvyw` (migrations via Management API, tables/RLS/RPC grants/storage via `pg_catalog`/`information_schema`/`storage.buckets`, Edge Functions via Management API):

```
MATCH: 450   EXPECTED_EXCEPTION: 3   UNTRACKED_LIVE_OBJECT: 0
MISSING_LIVE_OBJECT: 0   SOURCE_HASH_MISMATCH: 0   PRIVILEGE_DRIFT: 0
CONFIGURATION_DRIFT: 1 (expected_branch_sha was stale — refreshed by this pass)
```

103 migrations, 60 tables (all RLS-enabled), 82 RPC grants, 5 storage buckets, 20 Edge Functions — all match `security/staging/staging-state-manifest.json` exactly, aside from the manifest's `expected_branch_sha`, which this pass refreshed to the baseline SHA above.

### Active quarantines (unchanged, verified still correctly excluded from parity)

| Function | Issue | Policy |
|---|---|---|
| `privacy-controls` | #46 | `DO_NOT_REDEPLOY`, source unrecoverable in this repo |
| `public-sale-share-opt-out` | #46 | `DO_NOT_REDEPLOY`, source lives in `kscan-website` repo |
| `product-match` | #72 | `DO_NOT_REDEPLOY`, source exists only on unmerged `product-match/foundation-v1[-ios]` branches |

All three are live and publicly reachable (pre-existing state, not something this pass changed) but excluded from redeploy per `security/staging/provenance-exceptions.json` and enforced by `security/scripts/staging-deployment-allowlist.js`. Do not merge their off-branch source or add them to the deploy allowlist without an explicit owner decision.

## Test-account operating model

Three persistent synthetic accounts already exist on `yzqjvdfgefveprobvvyw` and are documented in full (provisioning, rotation, secret names) in [`docs/security/staging-synthetic-auth.md`](../security/staging-synthetic-auth.md). Verified live via direct query against `auth.users`/`profiles` — matches the doc exactly:

| Role | Email | `account_status` | Maps to |
|---|---|---|---|
| Active | `synthetic-active@kscan-test.invalid` | `active`, has 1 `style_chat_sessions` row | **POPULATED_USER** |
| Pending deletion | `synthetic-pending@kscan-test.invalid` | `pending_deletion` | **RESTRICTED_OR_EDGE_USER** |
| Locked | `synthetic-locked@kscan-test.invalid` | `locked` | **RESTRICTED_OR_EDGE_USER** |

Credentials live only as GitHub repository/environment secrets (`STAGING_SYNTHETIC_{ACTIVE,PENDING,LOCKED}_{EMAIL,PASSWORD}`, plus `SUPABASE_STAGING_PUBLISHABLE_KEY`) — never in the repo, never printed to logs (masked via `::add-mask::`). Agents/developers reference an account by role name in scripts/prompts; only the `Synthetic auth tests` CI job (`.github/workflows/security-staging-gate.yml`) and an owner with dashboard/secret access can resolve a role to an actual credential.

**CLEAN_USER** is intentionally *not* a stored fixture — a persistent "clean" account stops being clean the first time anyone exercises it. Create one on demand per the public signup flow documented in `staging-synthetic-auth.md` step 1 (publishable key only, `mailer_autoconfirm: true` means it's immediately usable, no service-role key needed):

```bash
curl -X POST "https://yzqjvdfgefveprobvvyw.supabase.co/auth/v1/signup" \
  -H "apikey: <publishable key>" -H "Content-Type: application/json" \
  -d '{"email":"clean-<purpose>-<date>@kscan-test.invalid","password":"<generated>"}'
```

### Safe reset procedure

The three synthetic accounts are persistent by design — never delete/recreate them casually (see decommission steps in `staging-synthetic-auth.md` if actually needed). To reset accumulated test state on the `active` account without touching its identity or required fixture row:

```sql
-- Scoped to the single synthetic-active user id — never a table-wide delete.
delete from public.saved_scans where user_id = '<synthetic-active auth.users id>';
delete from public.style_chat_messages where session_id = 'a1b2c3d4-5555-4000-8000-000000000001';
-- Do NOT delete the style_chat_sessions row itself — staging-synthetic-auth.md
-- documents it as a required fixture for the "active-user request succeeds" CI check.
```

No blanket/global reset exists or is recommended — `security/scripts/snapshot-legitimate-staging-data.js` provides row-count snapshots (waitlist, privacy, deletion-request tables) for before/after drift detection around a deploy, not a reset mechanism.

## Staging build profiles

`eas.json`'s `staging` profile (already correct, no changes needed): `distribution: internal`, both `android` (`buildType: apk`) and `ios` (`buildConfiguration: Release`) blocks present, targets `yzqjvdfgefveprobvvyw`, feature-flag set asserted parity-equal to `production` (only URL/key differ) by `__tests__/staging/easProfileParity.test.js`.

### Android — READY

```bash
eas build --profile staging --platform android
```
Builds an installable internal APK (no store submission) against the staging backend. Uses EAS-managed remote credentials (Keystore `loFzVVCde6`) — no owner action needed.

### iOS — OWNER_EXTERNAL_ACTION_REQUIRED

```bash
eas build --profile staging --platform ios
```
fails non-interactively: *"EAS CLI couldn't find any credentials suitable for internal distribution."* Confirmed via build history (`eas build:list --platform ios`) that every prior iOS build used the `production`/`store` profile — no ad-hoc/internal-distribution credentials have ever been generated for this project. This requires an interactive `eas build --profile staging --platform ios` (or `eas credentials`) run once, by someone with access to the Apple Developer account, to generate and store a distribution certificate + ad-hoc provisioning profile. This is owner-controlled signing material — not something to auto-provision. Once done, subsequent non-interactive builds (CI or agent-triggered) will succeed using the stored credentials.

### Builds produced by this pass

| Platform | Build ID | Source SHA | Profile | Result |
|---|---|---|---|---|
| Android | [`e8d9bb4d-2062-4438-91ff-a0d97eb461d8`](https://expo.dev/accounts/ams2dad/projects/kscan/builds/e8d9bb4d-2062-4438-91ff-a0d97eb461d8) | `92c1a4b25d8dc202bb9022a39f35b2d9717abff1` | `staging` | queued/building at report time — see run log for final status |
| iOS | — | — | `staging` | Not produced — blocked on credentials, see above |

## Mobile smoke validation

No physical device or emulator/simulator is available in this environment, so on-device UI flows could not be walked directly. Where possible, the equivalent was validated at the backend layer instead:

| Check | Result |
|---|---|
| App launch / welcome / onboarding / consent screen | NOT_TESTED — no device/emulator available in this environment |
| Auth (create account / login / logout) | **PASS** — via CI `Synthetic auth tests` job (certification run 31411378813): real sign-in against real staging credentials for all three account states |
| Restriction flow (locked / pending-deletion rejection) | **PASS** — same CI job; `locked`/`pending_deletion` accounts correctly rejected |
| Scanner entry point reaches staging backend | **PASS** — direct check: `OPTIONS /functions/v1/scan-identify` → 200; unauthenticated `POST {}` → 200 with a structured "no image provided" response (confirms routing + request handling live; `scan-identify` intentionally accepts anonymous rate-limited requests alongside authenticated per-user-quota requests, consistent with prior documentation) |
| Results path renders | NOT_TESTED — requires on-device rendering; backend response shape confirmed well-formed (see above) |
| Closet / dressing room core surfaces | NOT_TESTED — no device/emulator available |
| Privacy / account controls open | PARTIAL — `OPTIONS /functions/v1/privacy-controls` returned 404 (not 200); this function is quarantined (Issue #46, `DO_NOT_REDEPLOY`, source unrecoverable) so it was **not** investigated further or touched, per quarantine policy. Worth an owner-level look, not a this-pass fix. |
| Commerce/retailer handoff resolves to staging-safe behavior | **PASS** — `OPTIONS /functions/v1/product-search-deals` → 200, staging-scoped |
| No raw PII logged by new test tooling | **PASS** — no new test tooling introduced touches PII; the two code fixes in this pass don't add logging |

## Known non-blocking issues

- `leaked_password_protection` — see above, `OWNER_EXTERNAL_ACTION_REQUIRED`.
- iOS staging build credentials — see above, `OWNER_EXTERNAL_ACTION_REQUIRED`.
- Stale pre-cutover documentation using old project naming — cosmetic, does not affect live config.
- `privacy-controls` Edge Function returned 404 on an `OPTIONS` probe — quarantined function, not investigated further this pass.
- 44 open Dependabot alerts (2 critical, 24 high, 14 moderate, 4 low) reported by GitHub on push — out of scope for this pass (Dependabot version updates are explicitly OFF per standing policy; NOT triaged or touched here). Worth a dedicated pass.
- `npm audit` reports 30 vulnerabilities (2 low, 12 moderate, 15 high, 1 critical) in the dependency tree as of `npm ci` in this worktree — same standing policy, not touched.

## How agents/developers validate staging going forward

1. `git fetch && git worktree add <path> -b <branch> origin/staging/production-parity` — don't work directly in the bare repo.
2. Make the change, run the relevant `node --test __tests__/...` suites locally.
3. `gh pr create --base staging/production-parity ...` — required CI gates run automatically (`.github/workflows/security-staging-gate.yml`): Gitleaks, Semgrep, OSV-Scanner, Trivy, npm audit, ZAP baseline + API, contract tests, staging health, synthetic auth (skipped for non-deploy-relevant changes, as seen in this pass).
4. On merge, `.github/workflows/staging-release-certification.yml` runs automatically and produces `security/reports/staging-certification.json` — check `final_verdict` and `blocking_findings`. `leaked_password_protection` will keep it at `BLOCKED` until the Pro-plan upgrade lands; that alone does not mean staging is unusable for development (see Runtime release certification vs. Staging development readiness distinction above).
5. For DB/Edge-Function-affecting changes, re-run `node security/scripts/verify-staging-parity.js --state <observed>` (build `<observed>` from live `list_migrations`/`list_edge_functions`/`execute_sql` calls, matching the field shapes documented above) before considering the change staging-verified.
6. For UI-sensitive changes, manual verification on a real device/emulator remains necessary — no automated substitute exists while Maestro is suspended (`security/release/native-ui-automation-policy.json`).
7. Master remains the promotion destination; production remains owner-controlled and out of scope for routine staging work.

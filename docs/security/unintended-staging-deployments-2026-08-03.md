# Unintended staging deployments — 2026-08-03

## What happened

CI's staging deploy job (`.github/workflows/security-staging-gate.yml`, prior to this fix) looped over every directory in `supabase/functions/` rather than only the functions a PR actually changed. When PR #43 finally exercised that step successfully (after `SUPABASE_ACCESS_TOKEN` was configured), it deployed **9** functions, not the 1 (`stylechat-generate`) the PR modified. 4 of those 9 were already deployed pre-PR (redeployed with identical, unmodified source — no behavior change). **5 were not previously deployed to staging at all.**

This document is the required investigation and rollback manifest for those 5, per the standing instruction not to remove anything without presenting this first.

## Findings

| Function | Deployed before this run? | Version now | `verify_jwt` | Live mobile caller? | Required secrets | Present on staging? |
|---|---|---|---|---|---|---|
| `nike-shoe-details` | No | 1 | `true` | **No** — `services/nikeShoeDetails.ts` exists but nothing under `app/`/`components/`/`hooks/` imports it; only a dev helper (`nikeShoeDetailsDevHelper.ts`, itself unimported) calls it | `RAPIDAPI_KEY` | Yes |
| `privacy-correction-request` | No | 1 | `true` | **Yes** — `app/privacy.tsx` calls `requestCorrection()` (via `services/supabasePrivacy.js`), reachable from the live Privacy screen | none (DB write only) | n/a |
| `privacy-data-export` | No | 1 | `true` | **Yes** — `app/privacy.tsx` calls `requestDataExport()` the same way | none (DB write only) | n/a |
| `search-vinted-secondhand` | No | 1 | `true` | **No** — `services/secondhand.js` calls it, but nothing under `app/`/`components/`/`hooks/` imports that service | `APIFY_API_TOKEN`, `APIFY_VINTED_ACTOR_ID`, `APIFY_VINTED_INPUT_TEMPLATE`, `APIFY_VINTED_TIMEOUT_SECS` | **No** — none of these are in the staging secret set, so the function cannot reach its provider even if invoked |
| `tryon-clothes-pro` | No | 1 | `true` | **No** — `services/tryOnClothesPro.ts` exists but is unimported anywhere under `app/`/`components/`/`hooks/` | `RAPIDAPI_KEY` (and this project's `MODELSLAB_*` secrets are present too, for a related try-on path) | Yes |

## Risk assessment

- **`privacy-correction-request` / `privacy-data-export`**: already reachable from the shipping Privacy screen, make no external provider calls, and only write to their own request tables (RLS-appropriate, no new secret exposure). Deploying them to staging does not meaningfully expand risk — they were the intended target of real user-facing functionality, just not part of *this* PR.
- **`nike-shoe-details` / `tryon-clothes-pro`**: no live caller, but their required secret (`RAPIDAPI_KEY`) **is** present on staging, so an authenticated staging user who discovered the endpoint directly (e.g. via `supabase.functions.invoke`) could actually trigger a real, costed provider call. This is a genuine (if narrow — staging-only, requires a valid staging JWT) expansion of exposure versus before this run, when these endpoints didn't exist at all.
- **`search-vinted-secondhand`**: no live caller, and its required Apify secrets are absent from staging, so a direct invocation cannot reach the provider — it would fail closed (missing-secret / configuration error) rather than incur cost. Lower risk than the two above, but still a newly-reachable, unhardened endpoint that didn't exist a day ago.
- None of the 5 carry the security hardening from this PR (auth/account-state/validation/quota layers) — they run whatever pre-existing code was already in the repo, unmodified by this work.

## Rollback manifest

Removing all 5 restores the exact pre-run staging function inventory (verified via `security/scripts/report-staging-inventory-diff.js`, which is now wired into the deploy job and will flag this automatically on future runs). Rollback command per function (safe, standard Supabase CLI operation, staging only):

```bash
supabase functions delete nike-shoe-details --project-ref yzqjvdfgefveprobvvyw
supabase functions delete privacy-correction-request --project-ref yzqjvdfgefveprobvvyw
supabase functions delete privacy-data-export --project-ref yzqjvdfgefveprobvvyw
supabase functions delete search-vinted-secondhand --project-ref yzqjvdfgefveprobvvyw
supabase functions delete tryon-clothes-pro --project-ref yzqjvdfgefveprobvvyw
```

**Not executed.** Per instruction, this is presented for approval before any removal. Two of the five (`privacy-correction-request`, `privacy-data-export`) are live-reachable, legitimate functionality that arguably *should* stay deployed regardless of how they got there — removing them would break a working Privacy screen feature that has nothing to do with this PR. The other three (`nike-shoe-details`, `search-vinted-secondhand`, `tryon-clothes-pro`) have no current caller and are reasonable candidates for rollback if the preference is to keep staging's function inventory limited to what's actively used. This is a product/ops call, not a security-mandated one — recommend deciding per-function rather than as a block.

## Prevention

The root cause (CI deploying every directory) is fixed in this same change: `security/scripts/select-changed-functions.js` + `security/scripts/deploy-changed-functions.js` now compute and deploy only the functions a PR's diff actually touches (directly, or via real import-tracing through a changed `_shared` module), and `security/scripts/report-staging-inventory-diff.js` diffs the function inventory before/after every deploy so any future side effect is surfaced in the job summary automatically rather than discovered after the fact.

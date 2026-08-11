# Environment Authority — K Scan AI Backend

Status: discovery output, Phase 1 of Backend Release & Rollback Infrastructure V1.
Verified 2026-08-11. Non-secret facts only. No secret values (keys, tokens) appear
in this document, even where a value was observed during discovery.

## Identity

| | STAGING | PRODUCTION |
|---|---|---|
| Supabase project name | K Scan AI Staging | KScan App Production |
| Project ref | `yzqjvdfgefveprobvvyw` | `wyyuqfdxucjksghsmhry` |
| Region | us-west-1 | us-east-2 |
| DB host | `db.yzqjvdfgefveprobvvyw.supabase.co` | `db.wyyuqfdxucjksghsmhry.supabase.co` |
| Postgres version | 17.6.1.155 | 17.6.1.104 |
| Created | 2026-05-14 | 2026-04-04 |
| Org | `dtcbsuytyjpvadcnyymn` ("KScan"), **plan: free** (verified live) | same org |

Both refs were independently verified three ways: (1) live `list_projects`/`get_project`
against the Supabase Management API — exactly these two projects exist, no third
project is reachable from this account; (2) `supabase/config.toml` on
`origin/staging/production-parity` declares `project_id = "yzqjvdfgefveprobvvyw"`;
(3) `config/edge-function-manifest.json` declares `approvedProjectRef =
"wyyuqfdxucjksghsmhry"` for the governed production Edge Functions. All three
agree. **SEPARATION_STATUS: CONFIRMED PHYSICALLY DISTINCT** — different hosts,
different Postgres minor versions, different regions, different creation dates.

The org is on a hard 2-project free-tier cap (previously hit when a third project
was attempted); there is no capacity to spin up an ephemeral/branch project for
drills without pausing or upgrading — both previously declined by the owner. Any
future drill design must reuse the existing two projects, not assume a spare one.

## The staging project's non-obvious history

`yzqjvdfgefveprobvvyw` was **not created as a mobile staging project**. It began
as "K Scan Privacy Controls," the backend for the public waitlist/privacy-request
website, and was repurposed. Its website heritage is still live on it today:

- Tables `public.waitlist_signups` and `public.website_sale_share_opt_out_requests`
  hold small amounts of **real, protected user data** (verified low row counts).
  These must never be dropped, truncated, reseeded, or migrated elsewhere by any
  future release/rollback automation.
- Edge Functions `privacy-controls` and `public-sale-share-opt-out` are deployed
  and ACTIVE on staging today. **Neither has any source in this repository at any
  point in git history** (confirmed via `git log --all` and full-tree grep) — a
  future manifest/freeze mechanism cannot cover them by source comparison; they
  are an acknowledged, permanent gap, already documented in-repo
  (`docs/security/public-ingress-inventory.md`, "Critical Finding").
- A third Edge Function, `product-match`, is also live on staging with no repo
  source on this branch — this one is a known **quarantined** feature (see
  Quarantine Boundaries below), correctly excluded from the governed branch, not
  a provenance gap.

This is why "staging == production minus website stuff" is the correct mental
model, not "staging and production are symmetric." A future parity/freeze tool
must special-case these objects rather than treat any staging-only object as
drift.

## Fail-closed environment matching — current state

There is **no single technical control** that makes it structurally impossible
for staging tooling to hit production, or vice versa. Separation today is
enforced entirely at the **script/workflow logic layer**, repeated independently
in several places:

- Every staging-writing workflow (`security-staging-gate.yml`,
  `staging-controlled-deploy.yml`) explicitly checks
  `SUPABASE_STAGING_PROJECT_REF != wyyuqfdxucjksghsmhry` and refuses to proceed
  if it matches production.
- `security/scripts/verify-staging-project-ref.js`,
  `security/scripts/select-candidate-migrations.js` (`assertNotProductionRef`),
  and the synthetic-auth suite (`assertNotProductionUrl`) each independently
  fail closed against the production ref before making any network call.
- `__tests__/staging/stagingBackendContract.test.js` decodes the anon JWT's
  `ref` claim at runtime and asserts it is staging, not production, before
  running any assertion.

**Gap**: `SUPABASE_ACCESS_TOKEN` (the Supabase Management API token used by CI
for staging deploys) is a personal access token. No repo evidence shows it is
scoped to the staging project only — Supabase Management API tokens are
typically account-wide. If so, the isolation described above is entirely a
**logic-layer** guarantee (the workflow chooses not to touch production), not a
**credential-layer** guarantee (the credential is technically incapable of
touching production). This is the single most important fact for the future
release system's threat model: a bug in one of the guard scripts, not a stolen
credential, is the realistic failure mode today.

There is **no `environment: production`** GitHub Environment anywhere in the
workflow set, and no CI-driven production deploy path exists at all — see
`BACKEND_RELEASE_DISCOVERY.md` §Existing Deployment for the full production
path (a manual, local, credentialed CLI action, outside CI entirely).

**One local-worktree hazard, independently confirmed**: `supabase/config.toml`
on several other worktrees, and the historical link state of the main
`c:\Users\jsmit\KScan` checkout, has previously pointed at the **production**
ref rather than staging. The Supabase CLI's `db push`/`db dump` act on whatever
project is currently `supabase link`-ed and have no `--project-ref` override
flag. This is an operator-workstation hazard, not a CI hazard — any local CLI
session must re-verify its link target before running a mutating command.

## FAIL_CLOSED_GAPS (summary)

1. `SUPABASE_ACCESS_TOKEN` credential scope unverified — likely account-wide,
   making staging/production separation a logic-only, not credential-only,
   guarantee.
2. Production has no CI identity, so there is nothing to environment-match
   against in an automated way — the entire production deploy path is a human
   action with a Supabase CLI session, outside every guard listed above.
3. Two independent "canonical ref" constants exist in two different tools for
   two different purposes (`supabase/config.toml` → staging;
   `scripts/edge-function-manifest-lib.js` → production) — not a security bug
   today, but a reconciliation risk for anyone extending either tool without
   knowing both exist.
4. GitHub Environment protection rules (required reviewers, wait timers) for
   the `staging` environment could not be verified from repository files —
   this is live GitHub repo-settings state, not committed config.

## Quarantine boundaries (inventory only — not evaluated, not changed)

Per the task's known governance list, cross-checked against live/repo evidence:

- **product-match** — deployed to staging only (not production), no source on
  `staging/production-parity`. Confirmed correctly excluded from the governed
  branch.
- **privacy-controls / public-sale-share-opt-out** — website-heritage functions,
  live on staging only, no repo source ever. Not a quarantine in the
  feature-flag sense; a permanent architectural fact of the repurposed project.
- **migrations-deferred/** (`supabase/migrations-deferred/`) — a formal,
  repo-documented quarantine mechanism for migrations deliberately excluded
  from the staging baseline. Currently holds one migration
  (`shared_room_item_contributions`) whose deferral rationale is now **stale**:
  production has since received the same logical change through a channel
  outside this branch's governed migration history (see
  `BACKEND_RELEASE_DISCOVERY.md` §Migration Drift). This is a live discrepancy
  between the deferred file's documented rationale and current production
  state, not a hypothetical one.

No quarantine boundary was modified, activated, or deactivated during this
discovery pass.

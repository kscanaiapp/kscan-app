# Build 35 ordinary brand search expansion — release evidence

Verdict: **FAIL — Not ready for controlled Production activation.**

This is a separately gated ordinary commerce retrieval lane. It creates no ownership claims,
merchant relationships, product inventory, feed authorizations or verified badges.

## Baselines and scope

- Backend: `rebuild/backend-authority-v2@4a832287f291086f600cf7411343ae5554cbf344`.
- Backend feature branch: `feature/build35-brand-search-backend`.
- Mobile: `integration/build35-v1-convergence@2f621e5a9da4d916de1f9fb53a9112d1381fe871`.
- Mobile feature branch: `feature/build35-brand-search-mobile`.
- Draft reviews: [backend #741](https://github.com/kscanaiapp/kscan-app/pull/741) and
  [mobile #742](https://github.com/kscanaiapp/kscan-app/pull/742). Neither is merged.
- Remote heads and open PRs were inspected before implementation. Open OC-02/03/04
  PRs #731/#732/#736 were not incorporated; their action authority stays outside this work.
- The original `C:\Users\jsmit\KScan` directory is a bare Git repository with leftover
  files and an unreadable HEAD tree; implementation is isolated under `.worktrees/`.
- Backend authority, verified-catalog flags, ownership review, merchant authorization,
  authorized feeds, catalog moderation and production configuration are unchanged.

## A. Source registry

| Measure | Observed result |
|---|---|
| Research candidates loaded | **0** |
| Enabled sources | **0** |
| Excluded sources loaded | **0** |
| Research candidates awaiting input | The directive describes 80; the actual files are unavailable |
| Enabled category coverage | None until reviewed sources are supplied |
| Supported category routes | Outerwear, blazer, dress, pants, top, footwear, bag, accessory |

Neither `KScan_US_Brand_Research_Seed.json` nor
`KScan_Brand_Discovery_Research_Registry.xlsx` was present in the supplied repository,
Downloads, Documents or OneDrive search. No replacement seed was invented. Source
qualification and the best-25 initial selection therefore remain **not performed**.

The pending migration `20261104233754_black_owned_brand_search_expansion.sql` adds:

- `black_owned_brand_search_sources`: names, HTTPS root domains, alternate domains,
  social references, categories, keywords, U.S. eligibility, enabled/review state,
  review date, notes/provenance, rotation weight and database-issued revision.
- `brand_search_source_audit`: append-only source insert/update/delete snapshots.
- `brand_search_source_coverage`: aggregate searches, surfaced qualified products,
  last search and last successful search; no shopper data.
- `user_stylist_preferences.include_black_owned_brand_search`, default `false`,
  protected by the existing account-isolated RLS policies.

All new tables have RLS. Ordinary client roles receive no registry, audit, coverage
or management-RPC grants. Only protected service administration can maintain sources;
the trigger audits changes and assigns a new revision. Domain overlaps, invalid roots,
unsupported categories and stale enabled reviews are rejected. Runtime also validates
every source and rejects reviews older than 180 days.

Maintenance procedure:

1. Supply source records as a JSON array using the migration's source fields. Import
   research leads with `enabled:false`, `review_status:"review"`; retain exclusion notes.
2. Generate reviewable SQL: `node scripts/brand-search-source-plan.mjs sources.json > source-plan.sql`.
   This command does not connect to a database or read credentials.
3. Review official identity/domain, active U.S. relevance and documented product categories
   using public references. This is ordinary source qualification, not verified ownership
   or merchant onboarding. Enable only the selected 25, with review dates and provenance.
4. Execute reviewed source maintenance through existing protected service administration
   in Staging. Update/disable by source ID; source changes are audited. No mobile update
   is required. Never insert these records into `discovery_products`.
5. Evaluate coverage and relevance before enabling 50/80/more sources. Runtime selects
   from at most 500 category candidates, not a full-registry model prompt.

There is no registry cache; edits/removals are consulted on the next eligible search.
Expanded provider caches include source ID/revision/query, so a revised source cannot
reuse an older targeted result. Disabled/removed sources are never selected.

## B. Integration

| Files / functions | Change |
|---|---|
| `_shared/brandSearchExpansion.ts` | Account/flag gate, source validation, category selection, daily deterministic weighted rotation, bounded query, ordinary relevance merge, aggregate telemetry |
| `scan-identify/shoppingProvider.ts` | Reuses the unused second provider slot after successful primary Serper retrieval; one additional Serper request, existing normalization, cache, cancellation and salvage |
| `scan-identify/scanCommerceRouter.ts` | Passes server-resolved lane into primary shopping retrieval; enabled shelves bypass ordinary result cache to prevent preference/source leakage |
| `scan-identify/index.ts` | Resolves preference from authenticated actor for deferred image commerce, inline image commerce and both TextScan routes; no identification mutation |
| `readOnlyTools/adapters.ts` | Ordinary Elise shopping uses the same lane; preference lookup time deducted from existing retrieval budget |
| `readOnlyTools/broker.ts` | Server-only presentation ordering accepts only live refs issued by the same session; no new model tool/action |
| `stylechat-generate/eliseCommerceWiring.ts` | Binds expansion to the authenticated actor; no model-selected registry/backend |
| `stylechat-generate/eliseCommerceTools.ts` | Explicit Black-owned request retains the verified lane and may use the second existing broker slot for ordinary retrieval; combines by existing agreement score and saves displayed reference order |
| `stylechat-generate/index.ts` | Supplies authenticated ordinary expansion gate; existing planner and prose restrictions retained |
| Mobile `services/brandSearchPreferenceService.ts` | Account-scoped fetch/upsert with actor recheck and strict boolean/default OFF |
| Mobile `components/BrandSearchPreference.tsx`, `app/privacy.tsx` | One persistent setting; busy/error states and account-switch protection |
| Migration authority, parity manifest and exact pending-migration tests | Declare the additive pending migration and regenerate backend source hashes; unknown drift remains blocked |

Flag: `BLACK_OWNED_BRAND_SEARCH_EXPANSION_ENABLED`. Only exact `true` enables the
optional lane; absent/false/malformed values bypass it. It follows existing server
environment flag handling and is independent of all verified-catalog flags.

OFF performs no preference or registry I/O and constructs no targeted query. Flag ON /
preference OFF reads only the account preference, then preserves the legacy retrieval
path, cache behavior and provider calls. ON / ON selects one category-relevant source.
Queries preserve validated subtype, color and material; scanner brand guesses, original
customer prose and registry notes are excluded. The selected brand is a target only.

Primary Serper failure retains the original Brave fallback and skips expansion. On primary
success, one targeted Serper call can consume the otherwise unused second provider slot.
It is capped at 700 ms **within** the remaining shopping timeout, with a 50 ms return margin.
Registry/provider failure or no qualifying products preserves primary products. No new
provider, LLM source selector, third outer tool, website scraping or arbitrary network
destination is introduced. Poshmark and existing enrichment routing remain intact.

The normal category agreement, image/URL validation, price representation, dedupe and
retailer-neutral ranking are reused. Expanded homepages are additionally rejected.
Directory inclusion provides no ranking bonus, product-brand assertion or ownership label.
Mixed Elise results cannot authorize model ownership prose from one verified card.

## C. Test evidence

Local commands and results (synthetic fixtures only, no live-product claims):

| Validation | Result |
|---|---|
| Full governed Deno directories, equivalent to `scripts/run-backend-tests.js` discovery | **2,127 passed; 34 steps; 0 failed; 1 existing ignored** |
| New expansion tests | **21 passed**, including actual fetch cancellation, no post-cancel fallback, and exact Scanner identity/quality context propagation |
| Canonical Git-object OFF parity (`qa/bobse/brandSearchCanonicalParity.ts`) | **16 comparisons passed**, two requests each; full results and provider invocation/cache patterns across primary/fallback/empty/unsafe/disabled, image fast/inline and TextScan parity |
| Actual migration, source-plan and migration governance Node tests | **113 passed; 0 failed** |
| Mobile account preference service tests | **5 passed; 0 failed** |
| Scanner and StyleChat entrypoint type checks | Passed in governed Deno type-checking |
| `git diff --check` | Passed |
| Complete mobile TypeScript | **Passed** after installing the two already pinned RevenueCat dependencies locally; no package/lockfile change |
| Clean-tree backend authority and source parity Node tests | **37 passed; 0 failed** |
| Primary integrity, cross-path manifest and Scanner edge contract tests | **82 passed; 0 failed** after the CI-discovered reconciliation |
| TestSprite | Explicitly waived by owner; not used |
| Staging live-path scans and Elise | **Not tested** |
| Live recall, diversity, latency, provider charges | **Not measured** |

Windows' original backend runner exceeded the OS command-length limit before tests
started. The replacement invocation used the same 13 governed directories directly:

```powershell
deno test --no-config --allow-read --allow-env --allow-run=deno `
  supabase/functions/black-owned-catalog-sync supabase/functions/black-owned-discovery `
  supabase/functions/scan-identify supabase/functions/handle-user-deletion `
  supabase/functions/process-account-deletions supabase/functions/shared-room-image-url `
  supabase/functions/stylechat-generate supabase/functions/stylist-speech `
  supabase/functions/style-outfit-generate supabase/functions/commerce-watch-refresh `
  supabase/functions/vto-generate supabase/functions/kplus-activate supabase/functions/_shared
```

Evidence logs reside in the implementation worktrees (`bobse-full-deno.log`,
`bobse-feature.log`, `bobse-sql-governance.log`, `bobse-parity.log`,
mobile `bobse-typecheck.log`). They are local run artifacts, not production evidence.

Coverage includes all category routes, unsafe/stale/disabled/excluded sources, duplicates,
query injection exclusion, flag/preference combinations, provider OFF parity of output
and request bodies, actual synthetic expanded retrieval, revision cache reuse, homepage /
invalid URL / image / category / malformed-price rejection, hanging registry and preference
handling, primary salvage and preserved Brave fallback. Existing suites cover product
provenance, broker prompt injection, ownership isolation, source evidence, quotas,
unauthorized actions and cross-account references. SQL tests exercise actual RLS/grants,
audit immutability, source edits/removals and coverage revision binding.

Telemetry reports counts, closed outcomes, revision and elapsed expansion time. Actual
provider pricing is not known to this code; `costUsd:null` is intentional. The 700 ms
limit and two-call ceiling are functional bounds, **not measured performance or cost
acceptance**. Live primary/expansion latency, recall, cost and source diversity must be
measured on Staging before increasing the query allowance or approving Production.

Initial backend Project checks failed on the historical primary-source pins, cross-path
manifest and the literal legacy TextScan call shape. The call shape is now retained on
the explicit OFF branch. Cross-path hashes were regenerated. The immutable historical
Black-owned and VRI-03 records were preserved; `bobse-primary-integrity-approval.json`
records only the three authorized primary-file changes with exact prior/current digests
and an independently pinned consent-stripped digest. Tests still reject unnamed files
or any further source drift. This is feature source reconciliation, not platform parity
or deployment certification. Mobile PR #742 Project checks and security promotion passed;
backend PR checks must pass on the final repaired head before promotion.

The later backend compiler failure was the Deno-only canonical comparison probe being
included by the mobile compiler from `scripts/`. It now lives under the already excluded
`qa/` tree; no compiler checks or exclusions were weakened. A local full Node run found
two environment failures: Deno-generated duplicate Expo packages under `node_modules/.deno`
triggered the native foreground-service census, and the sandbox denied reading a historical
Git object in the unchanged mirror test. Those local failures are not counted as passes;
clean Linux Project checks remain the authoritative full Node-suite evidence.
The unchanged mirror test passed 20/20 when rerun with access to the historical Git
object. The final Scanner merge carries the existing relevance options, quality band
and graded identity evidence into candidate selection before truncation; a dedicated
runtime test checks both image routes and unchanged identification. Canonical OFF
parity remains 16/16. Backend revision `17d402ec` passed all 33 applicable CI checks
(13 skipped); the subsequent ranking-context head requires its own final CI pass.

## D. Readiness and remaining work

Readiness FAIL can mean not performed; it does not imply an observed functional failure.

| Requirement | Readiness | Evidence / limitation |
|---|---|---|
| Source registry built | PASS | Actual migration and privilege tests |
| Sources loaded | FAIL | Not performed: research files missing; 0 loaded/enabled |
| Scanner integrated | PASS | Local wiring, compile and regression tests; device flow not tested |
| Elise integrated | PASS | Ordinary retrieval, two-slot bound, reference-order tests; live follow-up not tested |
| User preference integrated | PASS | Client service and SQL isolation tests; device UI not tested |
| Existing search preserved | PASS | Local OFF parity and existing regression suites |
| Relevance and dedupe preserved | PASS | Existing ranker reused; provider/source edge tests |
| Tests passing | PASS locally | Governed suites above; remote checks tracked in PRs |
| Staging deployed | FAIL | Not performed; governed deployment and source qualification outstanding |
| Real-path verified | FAIL | Not tested |
| Production deployed | FAIL | Intentionally not performed |
| Production enabled | FAIL | Intentionally not performed; no activation approval |

Before Staging acceptance:

1. Supply the two research files; import all candidates disabled, retain exclusions and
   publicly qualify/enable the best 25 with genuine category/provenance evidence.
2. Finish dependency-complete mobile CI and all required PR/security/parity checks.
3. Use `.github/workflows/staging-controlled-deploy.yml` and the canonical backend
   lineage to apply exactly migration `20261104233754` and deploy `scan-identify` and
   `stylechat-generate`, retaining their existing JWT settings. Reconcile live ledgers
   first; the pending declaration does not certify them or bypass workflow gates.
4. Enable only in Staging and opt in a controlled account. Use actual image scans across
   categories and Elise follow-ups. Record selected source IDs/revisions, provider-query
   evidence without user images/prose, real returned offers, primary survival, request
   counts, relevance, latency and actual provider charges.
5. Test account OFF and server OFF independently, plus cancellation/unavailable/empty
   cases. Verify account persistence and mobile presentation on device.
6. Return a new readiness verdict with live evidence. Production remains a separate,
   approved governed deployment/activation decision.

Rollback: set only `BLACK_OWNED_BRAND_SEARCH_EXPANSION_ENABLED=false`. The next
eligible request bypasses preference/source retrieval and expansion; the in-flight
lane rechecks it before query selection and merging. Account preference OFF independently
bypasses the lane. Disable individual registry sources through audited administration.
Keep the additive schema and account setting; no destructive rollback is required.
Do not change verified-discovery or verified-badge flags as a rollback for this feature.

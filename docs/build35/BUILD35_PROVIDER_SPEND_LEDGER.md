# Build 35 provider spend ledger (Staging)

Reconciled application-side authority: human instruction received October 8, 2026. These balances are existing allocations, not new authorizations. **PAID_DISPATCH_STATUS=HELD_PENDING_EXTERNAL_PROVIDER_RECONCILIATION.**

| Feature | Authorized ceiling | Previously accounted attempts | Remaining allocation | External provider account reconciliation |
|---|---:|---:|---:|---|
| Contextual VTO | 1 real generation | 0 | 1 | Pending |
| Smart Watchlist | 2 provider refreshes | 1 | 1 | Pending |
| Packing Intelligence | 3 provider invocations | 2 | 1 | Pending |
| Total | 6 | 3 | 3 | Pending |

Application-side evidence reconciled by the owner includes authorization history, GitHub evidence, Staging database records and available Supabase logs, including activity outside Actions. VTO October 8 denials were 403/422, with zero generation-request rows; no paid generation evidenced. Empty Watch scheduled/direct runs with zero claimed/evaluated watches do not count as provider attempts. Two October 7 Packing successes with approximately 10.7 and 13.7 seconds provider execution substantiate its consumed count. This evidence cannot exclude direct calls against external provider accounts.

## Required dispatch record

Before any paid attempt, record feature, authorization ceiling, previous consumption, completed external-provider reconciliation, intended request ID, exact integration SHA and intended evidence/audit method. Record the result afterward. Every outbound provider attempt counts, including failed attempts and retries. No automatic retries, ambiguous-result retries, resets or allowance transfer between features.

No paid attempt was made by this convergence run. The VTO authenticated negative-control workflow (37807287304), log audit (37807703897), source/mocked tests and anonymous TestSprite boundary test are zero-spend controls. They do not consume or renew these allocations.

| Attempt ID | Feature | Integration SHA | Prior / remaining | Account reconciliation | Result |
|---|---|---|---|---|---|
| None dispatched | All three | 8f25fb7e219dc0d400e26e76fd6474c454fea661 | As above | Pending | Held |

No Production provider experiment is authorized.

## Full-convergence campaign addendum (2026-10-08 ET)

**PAID_DISPATCH_STATUS is unchanged: HELD.** No attempt was made, no allowance was created or transferred, and no ambiguous request was retried.

Zero-spend actions in this campaign (none can reach a provider): read-only Supabase function listings and aggregate SQL on Production and Staging (no row contents, no identifiers); read-only `get_edge_function` source retrieval; GitHub Actions re-runs of the ZAP *baseline* workflow against the Staging health endpoint (a passive scanner, no AI/commerce/VTO provider); local Node/Deno tests with mocked providers; local `tsc`; EAS read commands (`env:list`, `build:version:get`). The Premium runtime harness (`security/scripts/build35-premium-runtime.js`), which reveals Staging service keys through the CLI and writes GitHub environment secrets, was **not** run.

**Consequence for the Packing allowance.** The remaining Packing invocation is no longer merely "one more attempt". The Packing runtime proof was earned at governed-source fingerprint `7131b140…`; the combined branch (contextual VTO changes `stylechat-generate`) fingerprints `c4c643b5…`, so the existing proof stops authorizing. The single remaining Packing invocation is therefore the only way to re-earn Packing on the combined source, and it must follow the dispatch record above and the external-provider reconciliation. Until then Packing stays dark and the combined branch pins `packing = false`.

**Consequence for VTO.** Real paid VTO generation remains 0 of 1. The zero-spend rejection matrix (22 controls) and log audit (12 controls) are complete on the Staging deployment of `vto-generate` v19 / `stylechat-generate` v133; they prove denial paths only.

**Watchlist.** The provider-side entitlement recheck (PR #524) is not deployed, so no lapse/zero-dispatch Staging proof exists. Its zero-spend lapse proof (lapsed K+ ⇒ zero provider requests) needs a synthetic lapsed actor and a Staging-deployed guard; neither is in place. The remaining Watchlist refresh stays unspent.

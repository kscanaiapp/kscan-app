# Build 35 paid K+ -- Phase C: verified RevenueCat lifecycle ingestion

Status: implemented on `feature/build35-kplus-revenuecat-lifecycle-v1`, cut from
`integration/build35-v1-convergence` at `c017e63b377d5e9466a6279d936eeb9bb9372343`
(PR #494, native RevenueCat, is an ancestor). **Not deployed anywhere.** No
staging, production, Supabase-secret, RevenueCat-dashboard, Apple, Google or EAS
change was made. No migration was added.

Phase C closes the server loop Phase B left open:

    STORE -> REVENUECAT -> verified webhook -> apply_kplus_provider_*transition
          -> Supabase K+ grants -> get_my_kplus_entitlement_summary()
          -> useKPlusEntitlement()   (mobile; unchanged)

The mobile app still resolves K+ only from Supabase. Nothing in this phase gives
the device a path to a provider transition (a static test pins that).

## What already existed, and was reused unchanged

The database side was built in Build 34 Phase 1 and Build 35 Phase A, and it is
the part that owns correctness. Phase C adds **no migration** because that layer
already provides everything the brief requires:

| concern | owner (unchanged) |
|---|---|
| ordering by provider time `(occurred_at, lifecycle rank, event id)`, a stale event never changes state | `apply_kplus_provider_transition`, `apply_kplus_provider_lifetime_transition` |
| idempotency `(provider, external_event_id)` | same; `kplus_entitlement_transitions` is the event ledger (no payload, no receipt) |
| one purchase -> one user | same (`*_owned_by_other_user`) |
| environment recorded per grant; cross-environment mutation of one grant refused | same |
| anonymous / unknown user refused | same |
| union of grants, provenance preserved, a provider event touches only its own grant | `kplus_effective_access_state`, the grant table's per-source model |
| one-way purchase digests (no raw transaction id stored) | `deriveKPlus*RefDigest` in the shared contract |

`supabase/functions/_shared/revenuecat/revenueCatClient.ts` and
`kplus-reconcile-revenuecat` are the **outbound promotional mirror** (Supabase ->
RevenueCat). They are untouched and not suitable for inbound lifecycle: the new
path is separate and additive.

## What Phase C adds

| file | role |
|---|---|
| `supabase/functions/kplus-revenuecat-webhook/index.ts` | thin Deno entry; wires env, clock, logger, service-role RPC |
| `_shared/revenuecat/revenueCatWebhookHandler.ts` | request path, HTTP semantics, telemetry |
| `_shared/revenuecat/revenueCatWebhookAuth.ts` | Authorization secret + optional HMAC verification |
| `_shared/revenuecat/revenueCatWebhookEvent.ts` | strict parse, actor mapping, RevenueCat event -> internal transition |
| `_shared/revenuecat/revenueCatProductClassification.ts` | typed store-product -> K+ class boundary |
| `supabase/config.toml`, `scripts/edge-function-manifest-lib.js`, `config/edge-function-manifest.json` | registration, governance, `verify_jwt = false` |

## Authentication -- what RevenueCat actually provides

From RevenueCat's webhook documentation (read 2026-10-02):

1. an optional **Authorization header** value configured in the dashboard, sent
   verbatim on every delivery (a shared secret; it proves the caller, not the body);
2. optional **HMAC-SHA256 signing**: `X-RevenueCat-Webhook-Signature: t=<unix>,v1=<hex>`,
   HMAC over `"<timestamp>.<raw body>"`, secret shown once in the dashboard;
3. no IP allowlist; retries on any non-200 (up to 5 attempts, 5/10/20/40/80 min,
   60 s timeout); "at least once" delivery, no ordering guarantee.

Implemented policy (strongest supported, fail closed):

- the Authorization secret is **required**; unset means 503 for everything;
- if a signing secret is also configured, a valid, fresh (5 min) signature is
  **additionally required**; if not configured the signature header is ignored;
- constant-time comparison; one generic 401 for every failure; authentication runs
  **before** the body is parsed.

**Verify before relying on the HMAC path.** The signature format above was taken
from the provider documentation; no live delivery existed in this phase, so it is
proven only against that documented format. Confirm with a dashboard TEST event
before enabling signing in production. The Authorization secret path is the
baseline and does not depend on it.

## Event mapping (RevenueCat vocabulary -> internal)

| RevenueCat | internal result |
|---|---|
| `INITIAL_PURCHASE` / `RENEWAL` / `PRODUCT_CHANGE` / `UNCANCELLATION` / `SUBSCRIPTION_EXTENDED` | live period: `trial` if `period_type=TRIAL`, else `active` (paid; `INTRO` is paid) |
| `CANCELLATION` (`cancel_reason != CUSTOMER_SUPPORT`) | **paid-through preserved**: still active/trial with `will_renew=false`; `expired` only if the period has already elapsed |
| `CANCELLATION` + `CUSTOMER_SUPPORT` | **refund** -> `refunded` |
| `SUBSCRIPTION_PAUSED` | scheduled pause: access NOT revoked (`will_renew=false`) |
| `EXPIRATION` | `expired`; `EXPIRATION`+`SUBSCRIPTION_PAUSED` -> `paused`; `+CUSTOMER_SUPPORT` -> `refunded`; an end still in the future (provider ended it early) -> `revoked` |
| `BILLING_ISSUE` | `grace_period` if `grace_period_expiration_at_ms` is present, else `billing_retry` |
| `REFUND_REVERSED` | reinstated |
| `NON_RENEWING_PURCHASE` (product classified `LIFETIME`) | `store_lifetime` purchase (open-ended) |
| lifetime `CANCELLATION`/`EXPIRATION` + `CUSTOMER_SUPPORT` / `REFUND_REVERSED` | lifetime refund / re-activation |
| `TEST`, `INVOICE_ISSUANCE`, `SUBSCRIBER_ALIAS`, `PURCHASE_REDEEMED`, `TEMPORARY_ENTITLEMENT_GRANT`, `VIRTUAL_CURRENCY_TRANSACTION`, `EXPERIMENT_ENROLLMENT`, price-increase events | ignored (200) |
| `TRANSFER` | ignored (200) -- see "Transfer boundary" |
| any other type | ignored (200), no mutation |

Time always comes from the provider (`event_timestamp_ms`, `purchased_at_ms`,
`expiration_at_ms`), never the server clock.

Not represented (stated plainly): RevenueCat has no distinct Google "account hold"
event; it surfaces as `BILLING_ISSUE` then `EXPIRATION(BILLING_ERROR)`. `PREPAID`
and `PROMOTIONAL` period types are not store subscription periods K+ models and
are ignored.

## Identity

The only actor is `app_user_id`, and only when it is a UUID (Phase B logs
RevenueCat in as the Supabase user UUID). Email, alias text, device ids and
`$RCAnonymousID:` ids never become an actor and nothing is granted for them.
`aliases` is never read. If `original_app_user_id` is **also a K Scan UUID but a
different one**, ownership moved between two K Scan accounts: refused (below).
A webhook field is never trusted for ownership beyond that: the user must exist in
`auth.users` and be non-anonymous (the RPC checks).

**Known property of RevenueCat, not fixable here:** RevenueCat does not
authenticate app user ids. Anyone with the (public) SDK key who learns a K Scan
user UUID could log RevenueCat in as that UUID and buy for them. That can only ever
*add* a grant the buyer paid for to that account; it cannot read, remove or move
anyone's access, and UUIDs are unguessable. Worth knowing; no code change warranted.

## Product classification

Owner product ids are pending, so the repository names none. The mapping is the
server secret `KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION`:

    { "version": 1,
      "products": [ { "store": "apple"|"google", "productId": "<id>", "class": "MONTHLY_SUBSCRIPTION"|"LIFETIME" } ] }

Matching is **exact** on `(store, productId)`; there is no "monthly"/"lifetime"
substring logic anywhere (a test proves ids like `monthly`, `k_plus_lifetime`,
and case/whitespace variants do not classify). Apple and Google are configured
separately. Missing, unparseable, malformed or duplicated (even consistently
duplicated) configuration classifies nothing. An unmapped product, or a
class/event mismatch (a subscription event on a LIFETIME product), is a **422**:
nothing is granted, an alert is emitted, and RevenueCat retries -- so a corrected
mapping can still settle the event inside the retry window.

## Environment isolation

The database stores each grant's `provider_environment` and refuses to mutate one
grant across environments, **but its access resolver does not distinguish
environments**. A sandbox grant would therefore grant K+. The gate is at the door:
`KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS` defaults to **production only**. A sandbox
(TestFlight / Play internal / developer) purchase on a production project is
ignored (200) and cannot grant. Accepting sandbox is an explicit owner decision
(a staging project would set it). Environment is also part of the purchase digest,
so the same store purchase has different grant keys per environment.

## HTTP semantics (RevenueCat retries any non-200)

| outcome | status |
|---|---|
| applied / duplicate / stale / permanent refusal / deliberate ignore | 200 |
| bad or missing authentication | 401 |
| malformed payload | 400 |
| oversize body | 413 |
| unmapped product / bad classification config | 422 (retryable) |
| endpoint not configured; database trouble; unrecognised RPC answer; provider time in the future | 503 (retryable) |

## Observability

Bounded fields only: RevenueCat event type, store, environment, outcome, reason,
and **opaque 12-hex digests** of the event id and product id. Never the raw body, a
receipt, a transaction id, a purchase token, an email, a name, or the app user id.
Responses never echo input. A test sends sentinel receipts / tokens / emails through
every path and asserts none reaches a log, alert or response.

## Convergence

- **Purchase:** native purchase (Phase B, state `PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING`)
  -> RevenueCat -> `INITIAL_PURCHASE` / `NON_RENEWING_PURCHASE` webhook -> provider
  transition committed -> `get_my_kplus_entitlement_summary()` returns `k_plus` ->
  Phase B's bounded re-checks (2/5/10/20 s) or the next foreground refresh see it.
  RevenueCat usually delivers in 5-60 s; if it is slower than Phase B's re-check
  window the app stays RESOLVING (truthful) until the next refresh. Proven end to
  end on a real Postgres: the real handler drives the real SQL functions and the
  answer is parsed by the **mobile** contract parser.
- **Restore (same K Scan account):** the grant already exists from the original
  webhooks; restore is a no-op server-side and canonical state is already correct.
  If a delivery was lost, RevenueCat's retry (5 attempts) is the only recovery --
  there is **no pull-based reconciliation** in this phase (the DB already has the
  `provider_reconciliation` cause for one; building the RevenueCat REST pull is a
  recommended follow-up, not done here).
- **Restore into a different K Scan account:** NOT supported -- see below.

## Transfer boundary (STOPPED, by instruction)

RevenueCat moves a purchase between app user ids on restore ("transfer"). Whether
a purchase may move between two K Scan accounts needs an owner policy that does
not exist. Therefore:

- `TRANSFER` events mutate nothing;
- later events for a transferred purchase arrive with a different `app_user_id`
  and a different K Scan `original_app_user_id` -> refused (`alias_conflict`); and
  if that guard were ever bypassed, the database's `*_owned_by_other_user` check
  refuses it again;
- the original owner keeps whatever they already had; the second account gets
  nothing. No lifetime ownership is ever moved silently.

Owner-side, also set RevenueCat's project **transfer behavior** deliberately; it
decides what RevenueCat does before this code sees anything.

## Account deletion and lifetime -- finding (no policy invented)

What the code does today, verified by reading it:

- **Supabase:** purging an account deletes the `auth.users` row, and
  `kplus_entitlement_grants`, `_transitions` and `_activations` all
  `ON DELETE CASCADE`. The lifetime grant **and its idempotency ledger** are erased.
  The purge notes already say it "does not cancel a store subscription".
- **RevenueCat:** deletion calls `retireMirroredEntitlement` -- it retires only the
  **promotional** mirror. The RevenueCat customer and the store purchase attached to
  it are not deleted.
- **Store:** Apple/Google keep the lifetime purchase on the user's store account.
- **Recreated account (new UUID) + Restore:** RevenueCat sees a purchase attached to
  the OLD customer and (per its transfer setting) transfers it. The new account's
  events are then expected to carry the old UUID as `original_app_user_id` (RevenueCat's
  first id for that customer -- inferred from its documented fields, not observed live),
  which this code **refuses** -- so the new account does **not** regain lifetime, and the lifetime
  the user paid for is, in effect, lost to them. Stale renewal/refund events for the
  deleted account arrive for a non-existent user and are refused (`unknown_user`).
- A still-billing **subscription** on a deleted account keeps billing in the store
  and grants nothing (the same warning the deletion UI must give).

**Launch blocker (owner decision, not implemented):** the policy for "delete
account, later return" -- warn and accept the loss, or define a safe reconnect
(for example verified re-link after re-authentication) -- must be chosen before
launch. It affects the deletion warning copy, the RevenueCat customer-deletion
behavior, and whether `original_app_user_id` reconnection is ever allowed. Until it
is chosen, the code fails closed (no reconnect, no silent transfer).

## Owner-side configuration required later (values deliberately not invented)

1. Supabase Edge Function secrets, per project (never set by this repo):
   `KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION`, optional
   `KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET`,
   `KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION`, optional
   `KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS` (default production only).
2. RevenueCat dashboard webhook: URL
   `https://<project-ref>.supabase.co/functions/v1/kplus-revenuecat-webhook`;
   Authorization header value **equal to** `KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION`;
   optional signing secret equal to `..._SIGNING_SECRET`; environment filter per
   project; send for the K+ app only. Run a **TEST** event.
3. Store product ids per store, and their class (monthly subscription / lifetime).
4. RevenueCat project transfer behavior (see above).
5. A decision on sandbox acceptance for any production-project beta testing.
6. The account-deletion/lifetime policy above.
7. Deploy: the function is governed (manifest + `verify_jwt = false`); the
   `*.toml` LF pin matters on Windows checkouts (see the governed-gate notes).

## Validation performed

- Deno handler matrix A-Z + signature + classification + redaction: 65 tests.
- Node file `__tests__/kplusRevenueCatLifecycle.test.js`: 44 tests -- negative
  controls (handler mutants rebuilt in a vm; SQL mutants applied to the live
  functions inside a transaction that is always rolled back) and the real-database
  convergence scenarios. The 27 database tests are opt-in
  (`KSCAN_DISPOSABLE_SUPABASE_DB_CONTAINER`) and SKIP visibly in CI, which has no
  database.
- Real Postgres 17 + GoTrue (disposable `supabase start`, own project id and ports,
  not the pre-existing local stack, never staging/production): the K+ pgTAP suites
  pass -- authority 234/234, lifetime foundation 206/206, user entitlements 17/17.
  Phase A's evidence for the lifetime SQL was PGlite only; this is the first run on
  real Postgres.

Pre-existing defects found while building the disposable stack (not fixed here):
a fresh replay of the repo's migration chain fails at
`20260721201347_dr4_collab_idempotency_room_scope.sql` (constraint already exists,
because `20260721183308` creates the same one) and at
`20260916125206_build33_production_rpc_privilege_convergence.sql` (an
assertion-only migration that trips on the local image's default privileges). The
disposable stack used scratch-only patched copies of those two; the repo's
migrations are untouched. One stale assertion in
`supabase/tests/kplus_entitlement_authority_test.sql` (B7) predated Phase A's
`complimentaryHistory` summary key; it is corrected here (one line).

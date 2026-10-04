# Build 35 Phase E — Inbound RevenueCat State Reconciliation

Status: source implementation. This document records the approved architecture with the Phase E design-gate corrections incorporated.

```text
SOURCE_COMPLETE=YES
LIVE_CONFIGURED=NO
PROVIDER_CERTIFIED=NO
GLOBAL_DRIFT_DISCOVERY=NOT_IMPLEMENTED
```

## Authority and direction

Supabase remains the only K+ authorization authority:

```text
RevenueCat evidence
→ authenticated server normalization
→ provider-owned transition RPC
→ Supabase canonical resolver
→ mobile canonical reread
```

The pull response contains no entitlement summary and cannot unlock K+. It returns `canonicalRefreshRequired: true`; a future consumer must then call `get_my_kplus_entitlement_summary()` through the existing canonical mobile store and `useKPlusEntitlement()`.

The existing `kplus-reconcile-revenuecat` function is preserved. It is an outbound, internal promotional-mirror worker: Supabase complimentary state → RevenueCat promotional state. It is not invoked or repurposed here and it does not mutate local K+.

Phase E adds `kplus-revenuecat-pull-reconcile`, an inbound, JWT-authenticated per-actor repair primitive. Routine mobile wiring remains inert.

## RevenueCat contract

```text
REVENUECAT_API_VERSION=v2 (Developer API 2.0.0)
HTTP_METHODS=GET only
PROJECT_ID_SOURCE=server-only REVENUECAT_PROJECT_ID
SECRET_KEY_SOURCE=server-only REVENUECAT_RECONCILE_SECRET_API_KEY
ENVIRONMENT_SOURCE=server-only KPLUS_REVENUECAT_RECONCILE_ENVIRONMENT
```

Endpoints:

| Endpoint | Use | Permission | Rate-limit domain |
|---|---|---|---|
| `/v2/projects/{project_id}/customers/{actor}/subscriptions` | Current subscriptions | `customer_information:subscriptions:read` | Customer Information, 480/min default |
| `/v2/projects/{project_id}/customers/{actor}/purchases` | Current one-time purchases | `customer_information:purchases:read` | Customer Information, 480/min default |
| `/v2/projects/{project_id}/customers/{actor}/events` | Additional chronology only when required | `customer_information:customers:read` | Customer Information, 480/min default |
| `/v2/projects/{project_id}/products/{product_id}` | Authoritative store identifier/type on cache miss | `project_configuration:products:read` | Project Configuration, 60/min default |

The credential is a RevenueCat v2 secret API key with those read-only permissions. It is distinct from `KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION` and the optional webhook signing secret. No credential is created or configured by this change.

Every customer-resource page includes `environment=production` or `environment=sandbox`; pagination links are accepted only on `https://api.revenuecat.com/v2/`, are capped by `KPLUS_REVENUECAT_RECONCILE_MAX_PAGES`, and have the environment filter reapplied. The deployment environment must be explicit or the endpoint fails closed.

## Fields consumed

Only this bounded subset is parsed:

| Resource | Provider field | Purpose / normalized field | Required |
|---|---|---|---|
| subscription | `id` | bounded resource identity, not persisted raw | yes |
| subscription | `customer_id`, `original_customer_id` | both must equal JWT subject | yes |
| subscription | `product_id` | RevenueCat product-resource lookup key | yes, non-promotional |
| subscription | `starts_at` | provider metadata validation | yes |
| subscription | `current_period_starts_at` | period start and safe current-state chronology | yes |
| subscription | `current_period_ends_at`, `ends_at` | paid-through/trial/grace end | nullable; at least one required for a supported mutation |
| subscription | `gives_access`, `pending_payment` | access-bearing and pending state | yes |
| subscription | `status`, `auto_renewal_status` | lifecycle, period, `willRenew` | status yes; renewal nullable |
| subscription | `store`, `environment` | Apple/Google mapping and isolation | yes |
| subscription | `store_subscription_identifier` | input to irreversible grant-reference digest | yes |
| purchase | `id` | bounded resource identity, not persisted raw | yes |
| purchase | `customer_id`, `original_customer_id` | both must equal JWT subject | yes |
| purchase | `product_id` | RevenueCat product-resource lookup key | yes |
| purchase | `purchased_at`, `status` | lifetime start/current ownership | yes |
| purchase | `store`, `environment` | Apple/Google mapping and isolation | yes |
| purchase | `store_purchase_identifier` | input to irreversible purchase-reference digest | yes |
| embedded product / product | `id`, `store_identifier`, `type` | exact K Scan classification and family/type check | yes |
| customer event | `id`, `type`, `occurred_at` / `body.event_timestamp_ms` | corroborating chronology | yes when fetched |
| customer event body | `app_user_id`, `original_app_user_id`, `environment`, `store`, `product_id`, `transaction_id`, `original_transaction_id` | exact actor/environment/product/reference correlation | bounded subset |
| list | `items`, `next_page` | bounded parsing and pagination | yes |

No raw response, receipt, token, transaction reference, email, or provider secret is logged or stored. Store transaction references become domain-separated SHA-256 digests before the database call.

## Observation and ordering semantics

A pull is a state observation, not an event. K Scan records `observed_at` on reconciliation ledger rows, but never uses it as provider chronology and never includes it in deterministic state identity.

Safe access-bearing mutations use provider-native current-state timestamps (`current_period_starts_at` for subscriptions and `purchased_at` for lifetime). Destructive or reversal mutations that could conflict with a newer local terminal state require a correlated customer event whose provider `occurred_at` is newer than the local `provider_state_occurred_at` watermark. If no such event exists, chronology is unproved and no mutation occurs.

`request_date_ms` and K Scan fetch time are not treated as lifecycle timestamps.

### Current-state-only transitions

- Trialing, active, cancelled-but-paid-through, or grace subscription → absent/nonterminal matching subscription grant.
- Owned lifetime purchase → absent/nonterminal matching lifetime grant.
- Identical current state may reach the transition authority and resolve as duplicate/no-op.

### Event-corroborated transitions

- Retry/pending-payment or expired subscription when a live local subscription would lose access.
- Access-bearing subscription when the matching local grant is terminal/revoked.
- Refunded/revoked lifetime when a live local lifetime grant would lose access (future provider fixture; absence alone is insufficient).
- Owned lifetime when the matching local lifetime grant is terminal/revoked.

Phase E never invents chronology. Unsupported, incomplete, or uncorrelated cases remain unresolved.

## Subscription reconciliation matrix

The matching local column is subscription-only. Complimentary/lifetime grants are not inputs to this matrix.

| Provider subscription state | Local absent | Local live/nonterminal | Local terminal/revoked |
|---|---|---|---|
| trialing | APPLY from current state | APPLY/NO_OP/DUPLICATE by transition authority | APPLY only with newer restoring event; otherwise DRIFT_UNRESOLVED |
| active | APPLY from current state | APPLY/NO_OP/DUPLICATE | APPLY only with newer restoring event; otherwise DRIFT_UNRESOLVED |
| cancelled, paid through | APPLY from current state with `willRenew=false` | APPLY/NO_OP/DUPLICATE | APPLY only with newer restoring event; otherwise DRIFT_UNRESOLVED |
| grace, access-bearing | APPLY from current state | APPLY/NO_OP/DUPLICATE | APPLY only with newer restoring event; otherwise DRIFT_UNRESOLVED |
| retry/pending payment | NO_MUTATION | APPLY only with newer terminal/billing event; otherwise DRIFT_UNRESOLVED | NO_OP/STALE |
| expired | NO_MUTATION | APPLY only with newer terminal event; otherwise DRIFT_UNRESOLVED | NO_OP/STALE |
| absent | NO_MUTATION | NO_MUTATION / DRIFT_UNRESOLVED | NO_OP |
| ambiguous/incomplete/paused-without-end | REJECT or DRIFT_UNRESOLVED | NO_MUTATION / DRIFT_UNRESOLVED | NO_MUTATION / DRIFT_UNRESOLVED |

## Lifetime reconciliation matrix

The matching local column is lifetime-only. Subscription and complimentary grants are orthogonal.

| Provider lifetime state | Local absent | Local live | Local terminal/revoked |
|---|---|---|---|
| owned | APPLY from current state | APPLY/NO_OP/DUPLICATE | APPLY only with newer restoring event; otherwise DRIFT_UNRESOLVED |
| refunded/revoked | NO_MUTATION | APPLY only with newer refund/revocation event | NO_OP/STALE |
| absent | NO_MUTATION | NO_MUTATION / DRIFT_UNRESOLVED | NO_OP |
| ambiguous | REJECT or DRIFT_UNRESOLVED | NO_MUTATION / DRIFT_UNRESOLVED | NO_MUTATION / DRIFT_UNRESOLVED |

Complimentary, complimentary-code, employee, friends/family, manual-support, and promotional grants are invariant. Provider reconciliation never lists or mutates them. The existing real-database test `W: complimentary + an expired subscription -> complimentary remains active` creates the complimentary fixture, expires the provider grant, and proves canonical K+ remains active. Its SQL mutation control proves deleting that grant turns the test red.

## Product lookup rate boundary

Resolution order is:

1. Consume an exact embedded product object when the customer resource includes the matching RevenueCat product ID, store identifier, and type.
2. Query the private TTL cache keyed by irreversible project and product-resource digests.
3. Call the v2 product endpoint only on cache miss, then cache the authoritative store identifier/type.

The existing `KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION` exact map still classifies `(store, authoritative store_identifier)`. The RevenueCat resource ID, name, price, duration, or naming pattern never classifies K+. Cache failure is a miss; if the authoritative lookup also fails, the unknown product fails closed.

## Identity, ownership, and environment

The actor is always the verified Supabase JWT subject. Request keys other than `trigger` and `force` are rejected, so body/query actor injection cannot be silently ignored. Anonymous or inactive accounts are refused.

Both `customer_id` and `original_customer_id` must equal the actor. Any mismatch yields `ownership_conflict`, no mutation, no alias reconnect, and no transfer. Lifetime synchronization is same-actor only.

Supported stores are Apple App Store/macOS App Store → `apple`, and Play Store → `google`. Promotional and unsupported stores are ignored as inbound authority. Provider resource environment must equal the configured query environment. Sandbox cannot feed a production run and vice versa.

## Deterministic identity and ledger

The state identity is `rcpull_` plus SHA-256 over canonical ordered fields:

```text
actor + grant family + store + environment + classified store product ID
+ reference digest + normalized lifecycle + period/lifetime fields
+ provider-native material timestamp
```

`observed_at` is excluded. An identical snapshot therefore reaches the existing `(provider, external_event_id)` idempotency ledger as the same identity. The migration extends the existing transition ledger with observation time and refreshes only `last_provider_verified_at` for duplicate observations.

The wrappers `reconcile_kplus_provider_transition` and `reconcile_kplus_provider_lifetime_transition` call the existing apply RPCs. If v2 exposes a current transaction reference while a webhook used the original reference, a wrapper may reuse a grant only when exactly one same-actor, same-family, same-store, same-environment, same-product candidate exists. Multiple candidates fail closed as `ambiguous_provider_grant_identity`.

## Webhook/pull convergence and concurrency

Both webhook and pull now enter the same wrapper and the same existing transactional lock:

```text
pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || actor_uuid, 0))
```

Scope is per actor. Pull-vs-pull additionally uses a per-actor/environment lease before provider traffic. Different actors use different advisory keys and do not intentionally block each other.

- Webhook active then pull active: same provider grant; duplicate/no-op rather than a second grant.
- Pull active then equivalent webhook: unique candidate resolution converges on the same grant.
- Newer terminal evidence then older active pull: restoring event must clear the watermark or pull remains unresolved.
- Newer pull then older webhook: existing provider ordering classifies the webhook stale.

## Provider call control and failures

Configurable controls:

- `KPLUS_REVENUECAT_RECONCILE_COOLDOWN_SECONDS` (default 300, range 0–86400)
- `KPLUS_REVENUECAT_RECONCILE_LEASE_SECONDS` (default 30, range 5–300)
- `KPLUS_REVENUECAT_RECONCILE_TIMEOUT_MS` (default 8000, range 1000–20000)
- `KPLUS_REVENUECAT_RECONCILE_MAX_PAGES` (default 3, range 1–5; 100 resources/page)
- `KPLUS_REVENUECAT_PRODUCT_CACHE_TTL_SECONDS` (default 86400, range 60–2592000)

`force=true` exists only on explicit recovery triggers: `post_purchase_unresolved`, `restore_unresolved`, and `check_again`. There is no routine-foreground trigger. A second request receives a bounded retry time while the lease/cooldown is active.

RevenueCat timeout/5xx is retryable and never revokes. A 429 returns bounded `Retry-After` (maximum 300 seconds) and does not busy-loop. Malformed responses, unknown products, environment mismatches, ownership conflicts, ambiguous chronology, and canonical RPC failure make no unsupported mutation.

Provider absence is specifically `NO_MUTATION / DRIFT_UNRESOLVED`, never rejection or revocation evidence.

## Observability

Bounded event names cover requested, provider query success/failure, product-resolution source, drift/unresolved drift, applied/duplicate/stale/rejected transition, ownership conflict, unknown product, environment refusal, throttling, canonical failure, and completion counters. Fields contain only short actor prefixes, enums, counts, booleans, and bounded reasons.

```text
PER_ACTOR_REPAIR=SUPPORTED
GLOBAL_DRIFT_DISCOVERY=NOT_IMPLEMENTED
BACKGROUND_SWEEP=NOT_IMPLEMENTED
```

The cooldown table records the last bounded outcome and the grant `last_provider_verified_at` field creates a future manual discovery seam. No bulk crawler or scheduler is added.

## Mobile consumer contract

No mobile file is changed. A later certified flow may perform one forced call after a native purchase/restore fails to converge inside the existing resolution window, then must reread canonical K+. It must not interpret `reconciled`, a RevenueCat resource, or native CustomerInfo as access.

## Provider certification plan and limitations

During authorized Apple/Google/RevenueCat sandbox certification, compare the real purchase webhook-derived state, v2 pull-derived state, transition ledger, canonical Supabase summary, and mobile parser. This source work does not configure products, API keys, trials, offerings, stores, Supabase environments, or EAS builds.

Known limitations:

- Provider behavior is fixture/document verified, not provider certified.
- Provider absence without a correlated, supported current resource does not revoke.
- Ambiguous paused/incomplete resources are unresolved rather than guessed.
- No global discovery guarantee exists; an actor must trigger reconciliation.
- Disposable-database convergence is reported separately when a local Supabase-compatible database is available.

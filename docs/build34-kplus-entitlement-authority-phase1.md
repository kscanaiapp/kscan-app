# K Scan AI — Build 34 K+ Entitlement Authority (K+ Paywall Program, Phase 1)

Status: **implemented on branch `feature/build34-kplus-entitlement-authority-phase1`; applied to staging only.**
Production: **not deployed.** Paid K+: **not activated.**

```
PAID_KPLUS_ACTIVATED=NO
CURRENT_KPLUS_PRICE_USD=0
```

Build 34 K+ is free of charge and is delivered only as K Scan AI-controlled complimentary grants.
That is an intentional product state, not a missing configuration value, and it is never modelled as a
store subscription. The future paid price is undecided; nothing in this phase infers one.

| Item | Value |
|---|---|
| Build 34 release authority | `release/kscan-pre-freeze-v1` @ `173c9dba9ebd15dfd5b82173af8a70e8042b4385` |
| Migration | `supabase/migrations/20260915030553_kplus_entitlement_authority.sql` |
| Staging ledger | version `20260915030553`, statements byte-identical to the file (MD5 `be95025b6e916a0c835e830552024a1a`) |
| Runtime matrix | `supabase/tests/kplus_entitlement_authority_test.sql` (208 pgTAP assertions) |
| Server contract | `supabase/functions/_shared/kplus/kplusEntitlementContract.ts` |
| Client contract | `types/kplusEntitlementContract.ts` |
| Static/contract controls | `__tests__/kplusEntitlementAuthority.test.js`, `supabase/functions/_shared/kplus/kplusEntitlementContract.test.ts` |

---

## 1. The answer

> Does this authenticated K Scan AI user currently have K+, why, and until when?

```sql
select public.get_my_kplus_entitlement_summary();   -- authenticated; identity = auth.uid()
```

```json
{
  "contractVersion": 1,
  "entitlementKey": "k_plus",
  "access": "k_plus",
  "displaySource": "complimentary",
  "effectiveExpiresAt": "2027-02-28T18:42:58.590Z",
  "isOpenEnded": false,
  "trialEndsAt": null,
  "willRenew": null,
  "store": null,
  "billingState": null,
  "accountManagement": { "storeManagementRelevant": false, "managementStore": null },
  "snapshotIssuedAt": "2026-09-15T03:10:00.000Z"
}
```

Every server-side K+ gate already asks the same question through `kplus_has_active_entitlement` /
`has_active_k_plus()`, which now delegate to the same resolver.

## 2. Entitlement model

**Grants, not one status.** `kplus_entitlement_grants` holds one row per grant. A user may hold any
number at once. No grant ever replaces, shortens or deletes another.

**Sources** (`source`): `store_subscription`, `complimentary`, `complimentary_code`, `employee`,
`friends_family`, `manual_support`, `promotional`. A store free trial is **not** a source: it is a
lifecycle state of a `store_subscription` (`current_period_type = 'trial'`), so a converted trial keeps
its provenance (`trial_ends_at`) on the same grant.

**Entitlement key vs product vs source.** `entitlement_key` is the capability (`k_plus`); `product_id` is
the store SKU on a store grant; `source` is why the grant exists. Uniqueness is per
`(user_id, entitlement_key, source, grant_key)`, so one product never equals one entitlement row.

**Effective access** = the union of every contributing grant, legacy and new
(`kplus_entitlement_facts` → `kplus_effective_access_state`).

**Effective expiry** = the latest `access_until` among contributing grants, or `null` with
`isOpenEnded = true` when any contributing grant is deliberately open-ended. Grants cannot be scheduled
to start in the future (the RPCs refuse it), so contributing windows are contiguous.

**Display-source precedence** among contributing grants (deterministic):

1. `subscription` — store grant, paid period
2. `trial` — store grant, trial period
3. `complimentary` — every complimentary-family source
4. `unknown` — legacy rows with unverified provenance

Ties: open-ended first, then latest `access_until`, earliest start, grant id. A paying subscriber is
shown the subscription first because it is the relationship they can act on (renewal, cancellation).
Store/billing fields describe the store relationship a customer can act on — contributing first, then the
newest provider fact — even when it is not the display source (for example complimentary K+ alongside a
Google subscription on account hold).

## 3. Lifecycle state matrix

| State / condition | Contributes access? | Until when | Authoritative fact |
|---|---|---|---|
| Free | no | — | no contributing grant |
| Trial | yes | trial end | store grant, `current_period_type='trial'`, `billing_state='normal'`, `revoked_at` null |
| Active paid | yes | `expires_at` | `current_period_type='paid'`, `billing_state='normal'` |
| Cancelled, paid-through | yes | `expires_at` | `will_renew=false` (cancellation is not a state) |
| Uncancelled | yes | `expires_at` | `will_renew=true`, same grant, no new activation |
| Grace period | yes | `max(expires_at, grace_period_expires_at)` | `billing_state='grace_period'` |
| Billing retry | only while `expires_at > now()` | `expires_at` | `billing_state='billing_retry'`; revokes nothing |
| Google account hold | no (suspended) | — | `billing_state='account_hold'` |
| Google paused | no (suspended) | until a newer resume transition | `billing_state='paused'`, `pause_resumes_at` |
| Resumed / recovered | yes | new `expires_at` | newer transition on the same grant; not a new activation |
| Expired | no | — | `expires_at <= now()` |
| Refunded | no | — | `revoked_at`, `revocation_reason='refunded'` |
| Provider revoked | no | — | `revoked_at`, `revocation_reason='provider_revoked'` |
| Complimentary, bounded | yes | `expires_at` | complimentary-family source |
| Complimentary, open-ended | yes | none | `is_open_ended=true` (a NULL expiry must say so explicitly) |
| Complimentary, operator-revoked | no | — | `revoked_at`, `revocation_reason='operator_revoked'` |
| Legacy Build 34 row | verbatim Build 34 predicate | `expires_at` | `status='active' AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at > now()` |

Access is computed from these facts, never from a stored label.

## 4. Activation (Welcome to K+) semantics

An activation row (`kplus_entitlement_activations`, event `kplus.entitlement_activated`) is written only
when a transition takes the **user** from no effective K+ to effective K+, and it is not the same
subscription continuing. Continuity covers resuming from billing retry, account hold or pause, and a new
period that starts within one hour of the previous paid-through (or grace) end — which is what makes
"trial → first paid renewal processed after the trial end" continuity rather than a second Welcome. A
refunded or revoked grant never continues.

| Transition | Activation |
|---|---|
| free → complimentary (incl. Early Access) | yes, `complimentary` |
| free → store trial or subscription | yes, `subscription_or_trial` |
| trial → paid renewal | no |
| complimentary active → paid purchase | no |
| paid active → complimentary grant or Early Access | no |
| billing retry / hold / pause → recovered | no |
| restore or reconciliation of the same subscription | no |
| expired (gap > 1 hour) → new subscription | yes, `isReactivation=true` |

The payload carries no email address and no price. A subscription/trial Welcome must take price,
period and trial terms from verified store/provider product data at send time; a complimentary Welcome
never mentions a charge, auto-renewal or trial conversion.

## 5. Schema

| Object | Purpose | Key constraints / indexes |
|---|---|---|
| `kplus_entitlement_grants` | one row per grant | unique `(user_id, entitlement_key, source, grant_key)`; unique `(provider, store, grant_key) WHERE source='store_subscription'` (one subscription → one user); store shape CHECK; store `grant_key` must be a 64-hex SHA-256 digest; `(expires_at IS NULL) = is_open_ended`; revocation reason bound to source |
| `kplus_entitlement_transitions` | append-oriented ledger + provider-event idempotency | unique `(provider, external_event_id) WHERE external_event_id IS NOT NULL`; shape CHECK per cause; outcome `applied`/`stale`; no json column |
| `kplus_entitlement_activations` | lifecycle activation events | unique `event_id`; exactly one origin (grant or legacy row); class CHECK |
| `kplus_entitlement_facts(uuid,text,timestamptz)` | normalized legacy + grant facts | service_role |
| `kplus_effective_access_state(uuid,text,timestamptz)` | union access + expiry | service_role |
| `kplus_entitlement_summary(uuid,text)` | read contract (service form) | service_role |
| `get_my_kplus_entitlement_summary()` | read contract (client form) | authenticated only |
| `grant_kplus_complimentary(...)` | trusted complimentary grant | service_role |
| `revoke_kplus_grant(uuid,uuid)` | operator revocation (non-store) | service_role |
| `apply_kplus_provider_transition(...)` | verified provider state → authority | service_role |
| `kplus_user_entitlement_row_is_active(uuid,text)` | row-scoped mirror gate | service_role |
| `kplus_has_active_entitlement(uuid,text)` | **replaced body**: now the union | service_role (unchanged grant) |
| `grant_kplus_early_access(uuid)` | **replaced body**: same signature/return/idempotency, per-user lock, records activation | service_role (unchanged grant) |

Compatibility: `user_entitlements`, `kplus_activation_events`, `has_active_k_plus()`,
`list_kplus_pending_revenuecat_sync` and `set_kplus_revenuecat_sync_status` are unchanged.

## 6. Security

- **Read authority:** clients call only `get_my_kplus_entitlement_summary()`. It has no parameters; the
  user is `auth.uid()`; a missing subject raises `42501` (never "free").
- **Write authority:** every mutation is a `SECURITY DEFINER` RPC executable only by `service_role`,
  with `search_path` pinned. Even `service_role` has only `SELECT` on the three tables, so writes cannot
  bypass ordering, idempotency, the ledger or activation logic.
- **RLS:** enabled on all three tables with no policy; `anon`/`authenticated` hold no table privilege.
  The migration ends with a guard that aborts if any client role can reach a K+ table or privileged K+
  function.
- **Cross-user:** revocation is scoped by user id AND grant id; one store subscription belongs to one user
  (`subscription_owned_by_other_user`); a provider event id is bound to one user
  (`event_identity_conflict`).
- **Identity:** anonymous identities and unknown users are refused; complimentary grants also require an
  active, unlocked profile.
- **Tamper resistance:** a client cannot extend, change source, change billing state, remove a refund,
  fabricate a provider transition, self-grant or change RevenueCat sync status (pgTAP J1–J19, C9–C10).

## 7. Event safety

- **Idempotency:** `(provider, external_event_id)` is unique. A duplicate applies nothing and increments
  `duplicate_deliveries` on the original row. RevenueCat reuses `id` and `event_timestamp_ms` on retries.
- **Ordering:** each store grant keeps a watermark `(provider_state_occurred_at, provider_state_rank,
  provider_state_event_id)`. An incoming transition at or below it is **stale**: recorded for audit, never
  applied. Ordering uses provider time only — never server receipt time. Exact-timestamp ties resolve to
  the more restrictive lifecycle rank. Provider timestamps more than 15 minutes ahead of server time are
  refused without being recorded, so they cannot poison the watermark and a corrected retry still applies.
- **Concurrency:** every K+ mutation takes `pg_advisory_xact_lock(hashtextextended('kplus_entitlement:'
  || user_id, 0))` before its first write; unique indexes are the backstop.
- **Determinism:** stale events may merge only two monotone provenance facts (earliest period start,
  latest trial end), so the same events in any order produce the same grant row and summary (pgTAP
  H12–H15, mutation-controlled).
- **Rejected** transitions (unknown user, anonymous identity, subscription owned by another user,
  environment mismatch, provider time too far ahead, event id reuse) are returned, not recorded.

## 8. Time authority

All timestamps are `timestamptz` (stored UTC). Access is evaluated with server `now()`. No
authorization path accepts a client time; `p_at` exists only on service_role building blocks for
boundary evaluation. The summary formats instants as UTC ISO-8601 with `Z`, identically under any
session time zone. Expiry is exclusive: at `expires_at` access has ended.

## 9. Ledger, privacy and deletion

Retained in the ledger: normalized identifiers and facts only — user id, grant id, cause, provider,
external event id, environment, normalized event type, provider time, lifecycle state, outcome, access
before/after, effective expiry before/after, activation id, duplicate counters.

Never stored: email, name, phone, JWT or auth token, receipt, purchase token, raw transaction id, price,
currency, country, subscriber attributes, free text, provider payload. There is no json column in any of
the three tables, and a store grant's reference is a SHA-256 digest of
`provider|store|environment|original_transaction_id`.

```
ACTIVE_ACCOUNT_LEDGER_BEHAVIOR=append-oriented, user-linked, service_role-read-only; only duplicate-delivery counters are ever updated
TERMINAL_DELETION_LEDGER_BEHAVIOR=hard delete: every K+ row (grants, transitions incl. provider event ids, activations, user_entitlements, kplus_activation_events) cascades from auth.users at purge; no de-identified K+ residue is retained
```

No K+ record needs to outlive terminal deletion for system integrity: Apple, Google and RevenueCat keep
purchase records, K Scan AI never issues store refunds, and the deletion subsystem already keeps its own
de-identified purge receipt. A late provider event for a purged user resolves to `unknown_user` and is not
recorded. All three tables are registered in both deletion registries.

**Account deletion does not cancel a store subscription.** `accountManagement.storeManagementRelevant` is
the input a future deletion flow uses to warn and route to the store before terminal deletion. The
existing RevenueCat mirror retirement (`retireMirroredEntitlement`) still revokes only granted
(promotional) entitlements and is unchanged.

## 10. RevenueCat compatibility

- Identity: RevenueCat App User ID = Supabase auth user UUID. No email ids, aliases or anonymous ids.
- The complimentary mirror (`kplus-activate` → `syncPromotionalEntitlement`,
  `kplus-reconcile-revenuecat`, `list_kplus_pending_revenuecat_sync`, `set_kplus_revenuecat_sync_status`)
  is unchanged. A sync failure never changes access (pgTAP A12–A17).
- `kplus-activate` now gates its mirror on `kplus_user_entitlement_row_is_active`: with several grants,
  "the user has K+" no longer means "this row is live", and mirroring on the user-level answer would
  re-open SEC-KPLUS-008.
- RevenueCat `store = PROMOTIONAL` is K Scan AI's own mirror and must never flow back in as authority.

## 11. Typed integration contracts

Server (`supabase/functions/_shared/kplus/kplusEntitlementContract.ts`):

- **A. Read** — `KPlusEntitlementSummary`, `KPLUS_CLIENT_SUMMARY_RPC`, `KPLUS_SERVICE_SUMMARY_RPC`
- **B. Trusted transition** — `KPlusProviderTransitionInput`, `KPlusProviderTransitionResult`,
  `toApplyKPlusProviderTransitionArgs(input)`, `deriveKPlusSubscriptionRefDigest(params)`
- **C. Complimentary grant** — `KPlusComplimentaryGrantInput`, `KPlusComplimentaryGrantResult`,
  `toGrantKPlusComplimentaryArgs(input)`, `KPlusGrantRevocationResult`
- **D. Reconciliation** — `KPlusReconciliationRequest` (empty body), `KPlusReconciliationResponse`,
  `KPLUS_RECONCILIATION_POLICY`
- **E. Provider events** — closed vocabularies plus the RevenueCat normalization tables
  (`REVENUECAT_EVENT_TYPE_TO_KPLUS`, `REVENUECAT_STORE_TO_KPLUS_STORE`,
  `REVENUECAT_STORES_NEVER_AUTHORITATIVE`, `REVENUECAT_EVENT_FIELDS_NEVER_PERSISTED`)
- **F. Activation event** — `KPlusEntitlementActivatedEvent`, `toKPlusEntitlementActivatedEvent(row)`
- **G. Account management** — `KPlusAccountManagement`, `kplusDeletionRequiresSubscriptionNotice(summary)`

Client (`types/kplusEntitlementContract.ts`): `KPlusEntitlementSummary`, `KPlusEntitlementClientState`,
`KPLUS_PRESENTATION_SNAPSHOT_POLICY`, `parseKPlusEntitlementSummary`,
`evaluateKPlusPresentationSnapshot`, `kplusPresentationSnapshotValidUntilMs`,
`shouldPresentKPlusPaywall`, `presentsKPlusAccess`.

`__tests__/kplusEntitlementAuthority.test.js` keeps the SQL CHECK vocabularies, the summary keys and
both contracts identical.

## 12. Read and offline policy

| Client state | Meaning | Paywall? |
|---|---|---|
| `resolved` + `access: 'k_plus'` | server (or valid snapshot) says K+ | never |
| `resolved` + `access: 'free'` | server positively says free | allowed |
| `resolving` | request in flight | never |
| `unavailable` | network/server error, malformed response, expired snapshot, untrusted clock | never |
| `signed_out` | no account | sign-in, not a paywall |

Presentation snapshot (client policy, never database authority): valid until
`min(snapshotIssuedAt + 15 min, effectiveExpiresAt)`; a device clock more than 5 minutes behind
`snapshotIssuedAt` is not trusted; past validity the state is `unavailable`, never `free`; a free snapshot
can never present K+; a snapshot never authorizes a server operation. Server fail-closed behaviour is
unchanged: gated server work re-checks the canonical predicate and denies when it cannot read it.

## 13. Build 34 K+ gate inventory

| Surface | Gate | Classification |
|---|---|---|
| Wardrobe Concierge (server) | `stylechat-generate` → `has_active_k_plus()`; Closet RLS | CONSUMES_NEW_CONTRACT |
| Packing Intelligence (server) | `packingHandler` precheck + confirmation → `has_active_k_plus()`; Closet RLS | CONSUMES_NEW_CONTRACT |
| Still-image VTO (server) | `vto-generate` → `kplus_has_active_entitlement`; its direct `user_entitlements` fallback is unchanged | CONSUMES_NEW_CONTRACT (canonical RPC); fallback DEFERRED — see below |
| Voice Scan (server) | none — on-device speech into the core Text Scan field | N/A (no server route) |
| Smart Watchlist (server) | `commerce-watch-refresh`, watchlist claim/create SQL | CONSUMES_NEW_CONTRACT |
| Closet cloud facts (server) | `user_closet_items` RLS → `has_active_k_plus()` | CONSUMES_NEW_CONTRACT |
| Signature Style recompute (server) | `recompute_signature_style` → `has_active_k_plus()` | CONSUMES_NEW_CONTRACT (rights unchanged) |
| Early Access mirror (server) | `kplus-activate` → `kplus_user_entitlement_row_is_active` | CONSUMES_NEW_CONTRACT (row-scoped by design) |
| Voice Scan (client) | `TextScanFeatureRow`, `VoiceScanButton`, `HomeVoiceScanPill`, `useVoiceScan` | NEEDS_MIGRATION |
| Still-image VTO (client) | `TryItOnEntry`, `useVtoAvailability` | NEEDS_MIGRATION |
| Packing Intelligence (client) | `app/packing/index.tsx`, `usePackingPlan` | NEEDS_MIGRATION |
| Wardrobe Concierge (client) | no gate; Elise wait copy reads K+ | NEEDS_MIGRATION (display) |
| Account → K+ | `app/privacy.tsx` status row | NEEDS_MIGRATION |
| Onboarding K+ | `PermissionsStepV1` | NEEDS_MIGRATION |
| Watchlist (client) | 4 `KPlusGate` sites | NEEDS_MIGRATION |
| Closet sync / restore engines | `getKPlusEntitlementSnapshot` | NEEDS_MIGRATION |

Every client surface reads through one path (`kplusClient` → `kplusEntitlementStore` →
`useKPlusEntitlement` / `KPlusGate`), which reads the caller's own `user_entitlements` row. In every state
reachable in Build 34 (no `kplus_entitlement_grants` rows exist) that row and the new contract agree. The
client migration swaps that one read for `get_my_kplus_entitlement_summary()`; no UI changed in Phase 1.

### Deferred VTO consumer migration — `VTO_KPLUS_FALLBACK_MIGRATION_REQUIRED=YES`

- **Current Phase 1 status.** VTO's canonical server-side K+ check, `kplus_has_active_entitlement`,
  consumes the new entitlement authority unchanged.
- **Deferred migration.** VTO's direct legacy-row fallback (`resolveVtoEntitlement` when that RPC is
  unavailable) is unchanged. `supabase/functions/vto-generate/**` is read-only under
  `docs/vto-live-integration-manifest.md`; a Phase 1 edit to it was reverted and the manifest was not
  widened. While the RPC is unreachable, the fallback still reads only `user_entitlements`, so an absent or
  lapsed legacy row resolves `denied`.
- **Why it is not a Phase 1 regression.** Phase 1 activates no non-legacy grant: no store purchase, trial,
  access-code or paid grant exists, so today `user_entitlements` is the whole authority and the fallback's
  answer matches the canonical one.
- **Required later work.** Before VTO is allowed to rely on new non-legacy K+ grant types in a production
  launch state, its fallback path must be updated under an explicitly authorized VTO integration lane so an
  unavailable canonical entitlement RPC cannot falsely classify an otherwise-entitled user as free/denied.
  It becomes a launch blocker the moment any non-legacy grant (store subscription, store trial or a
  `grant_kplus_complimentary` grant) can be written in an environment where VTO serves users.

## 14. Existing grants and dual-read compatibility

Staging before and after the migration: 3 `user_entitlements` rows, all `k_plus` /
`complimentary_early_access` / `kplus_early_access_2026`, all dated (none open-ended), none revoked; 2
currently valid and 1 lapsed; sync status 2 `failed_terminal`, 1 `synced`. 20 `kplus_activation_events`
(detail keys `newly_granted` / `status` only). Production: no K+ table exists.

| Legacy `grant_reason` | Source | Display |
|---|---|---|
| `complimentary_early_access` | `complimentary` | complimentary |
| `staff` | `employee` | complimentary |
| `admin` | `manual_support` | complimentary |
| `promo` | `promotional` | complimentary |
| `trial`, `paid_ios`, `paid_android` | `legacy_unverified` | unknown |

Legacy rows are not copied into the grants table (shipped clients read them with `.maybeSingle()` and
the RevenueCat mirror operates on them). The resolver reads them through the verbatim Build 34 predicate,
so no user gains or loses access, and a legacy NULL expiry is never reinterpreted as open-ended. When the
client has moved to `get_my_kplus_entitlement_summary()` and the Early Access campaign moves onto
`grant_kplus_complimentary`, a later phase may retire the direct `user_entitlements` read.

## 15. Platform parity (Phase 1 layer)

| Surface / behavior | iOS | Android | Result | Difference reason / evidence |
|---|---|---|---|---|
| Entitlement read | `get_my_kplus_entitlement_summary()` | same | PARITY_CONFIRMED | no platform input; store-agnostic resolver (static control); pgTAP N1–N12 |
| Onboarding K+ | shared `PermissionsStepV1` gate | same | PARITY_CONFIRMED (static) | no platform branch; device run not performed |
| Continue Free | free product never K+-gated (core boundary inventory) | same | PARITY_CONFIRMED (static) | future paywall control not built |
| Voice Scan gate | shared gate; Swift on-device recognizer | shared gate; Kotlin on-device recognizer | PLATFORM_DIFFERENCE_JUSTIFIED | OS speech-recognition APIs differ; gate and flag identical |
| VTO gate | shared client + same server gate | same | PARITY_CONFIRMED | server CONSUMES_NEW_CONTRACT |
| Concierge gate | server only | server only | PARITY_CONFIRMED | `stylechat-generate` |
| Packing gate | shared client + same server gate | same | PARITY_CONFIRMED | server CONSUMES_NEW_CONTRACT |
| Restore | not built | not built | not classifiable yet | contract is platform-neutral; N13–N15: restoring the same subscription adds no grant and no activation |
| Access Code | not built | not built | not classifiable yet | single server boundary `grant_kplus_complimentary` |
| Account → K+ | shared status row | same | PARITY_CONFIRMED (current row) | future manage destination differs by store: PLATFORM_DIFFERENCE_JUSTIFIED (`managementStore`) |
| Trial lifecycle | mapped | mapped | PARITY_CONFIRMED | N1 |
| Cancellation | mapped | mapped | PARITY_CONFIRMED | N3 |
| Expiration | mapped | mapped | PARITY_CONFIRMED | N8 |
| Refund/revocation | mapped | mapped | PARITY_CONFIRMED | N9 |
| Billing recovery | grace + billing retry | grace + retry + account hold + pause | PLATFORM_DIFFERENCE_JUSTIFIED | Apple has no account hold or pause; identical access when the same state arrives (N4–N7) |
| Offline/resolving | one shared policy | same | PARITY_CONFIRMED (contract) | device degraded-network runs not performed |
| Legal links | not built for K+ | not built for K+ | not classifiable yet | — |
| Welcome email | not built | not built | contract PARITY_CONFIRMED | account-level activation, no platform field; C13, G5, G14, N14 |

No PARITY_DEFECT was found in Phase 1 scope. Rows marked "not classifiable yet" belong to surfaces that
do not exist in Build 34; they block closure of the K+ program until the phase that builds them
completes its own parity pass on devices.

## 16. Rollback and fix-forward

- Every table and function is new except `kplus_has_active_entitlement` and `grant_kplus_early_access`.
- Restoring Build 34 behaviour is a forward migration re-creating those two from `20260829120000` /
  `20260829180000`; the new tables may remain unused. No step deletes or rewrites `user_entitlements`.
- The Edge Function and test changes revert with the commit.
- Once a later phase writes `kplus_entitlement_grants` rows, restoring the old predicate would remove those
  users' access: count grant rows before any rollback.
- `supabase/tests/kplus_entitlement_authority_test.sql` validates a project with the migration applied;
  `scripts/kplus/build-entitlement-authority-sql-batch.mjs` wraps it for a single rolled-back run.

## 17. Paid activation gate

Paid K+ stays inactive until each item below is separately confirmed:

- K+ production price approved; trial terms approved
- App Store and Google Play subscription products configured and approved
- RevenueCat products and paid offering configured
- Apple and Google financial agreements, tax and banking complete
- Canonical Privacy Policy, Terms and Cancellation & Refund Policy live, with the same URLs in store metadata
- Paywall carries the required subscription disclosures from store/RevenueCat product metadata
- Restore purchases, cancellation management and purchase/refund/expiration behaviour certified on iOS and Android
- Privacy and data disclosures updated for purchase/subscription data; RevenueCat (and Resend, if
  transactional email is activated) in the processor inventory
- Final counsel and store compliance approval
- Engineering preconditions from this phase:
  - deploy the row-scoped `kplus-activate` mirror gate to any environment before grant rows can exist there
  - repair the `kplus-reconcile-revenuecat` revoked-row mirror
  - move client surfaces to `get_my_kplus_entitlement_summary()`
  - build the RevenueCat webhook and authenticated reconciliation endpoint on these contracts
  - decide the store-subscription transfer policy
  - decide the sandbox acceptance policy per environment
  - decide the Welcome dispatch cutoff for pre-existing activations
  - promote the migration to production through the governed path
  - `VTO_KPLUS_FALLBACK_MIGRATION_REQUIRED`: migrate VTO's direct legacy-row fallback under an authorized
    VTO/K+ integration lane before any non-legacy K+ grant becomes launch-active for VTO

## 18. Recorded, not repaired

| # | Severity | Location | Finding |
|---|---|---|---|
| 1 | P2 (pre-existing) | `kplus-reconcile-revenuecat` / `list_kplus_pending_revenuecat_sync` | a revoked row still `pending` is mirrored into RevenueCat as live on the next sweep |
| 2 | P4 (pre-existing) | `set_user_entitlements_updated_at()` | SECURITY DEFINER trigger function executable by anon/authenticated (advisor 0028/0029) |
| 3 | Observation | `recompute_signature_style` | requires active K+ while the program contract lists Signature Style as free; rights not altered |
| 4 | Observation | Smart Watchlist, Closet cloud sync | K+-gated in Build 34 but outside the program's K+ surface list; not altered, consume the new contract |
| 5 | Precondition | staging `kplus-activate` v18 | runs pre-Phase-1 source (user-level mirror gate); safe while no grant rows exist on staging |
| 6 | Observation | staging ledger `20260914201155` | a Build 35 migration not in the Build 34 tree; touches no K+ object |
| 7 | Compatibility | `user_entitlements` own-row SELECT | still exposes the legacy row's sync/customer columns to its owner; retire after client migration |
| 8 | Deferred (launch blocker for non-legacy grants) | `vto-generate/vtoEntitlement.ts` fallback | with the canonical RPC unavailable, an absent/lapsed legacy row resolves `denied`; protected by the VTO integration manifest, so it needs an authorized VTO/K+ lane (`VTO_KPLUS_FALLBACK_MIGRATION_REQUIRED`) |

# Build 35 paid K+ -- Phase A: canonical entitlement + lifetime foundation

Status: implemented on `feature/build35-kplus-paid-phase-a-v1`, cut from the final
Build 34 source `5a0e2c3dae04e27e2528f05967388e3c19b2a346`. Not deployed anywhere.
No staging, production, EAS, App Store, Play or RevenueCat change was made.

This phase prepares K Scan AI's own side of paid K+. It adds a first-class
lifetime (one-time, non-consumable) store grant to the existing K+ entitlement
authority, defines how complimentary, subscription and lifetime coexist, and moves
the mobile reader onto the canonical summary. It builds no purchase flow.

## What is, and is not, in this phase

In: the lifetime grant model and its provider transition; the entitlement union;
the mobile reader and store migration; forward-only SQL; tests with negative
controls.

Not in (by instruction): the native RevenueCat SDK, a paywall, store products,
pricing, trial length, reminder timing, promo UI, restore UI, notifications, any
deploy. Nothing in this phase states a price, a trial length, or a store product.
Synthetic identifiers appear only inside tests.

## Authority is unchanged

Supabase / K Scan AI remains the K+ access authority. The tables, resolver and
RPCs from Build 34 Phase 1 are preserved:

    kplus_entitlement_grants, kplus_entitlement_transitions, kplus_entitlement_activations
    get_my_kplus_entitlement_summary(), kplus_has_active_entitlement(...), has_active_k_plus(...)
    apply_kplus_provider_transition(...)

Feature gates (Voice Scan, Virtual Try-On, Packing, Wardrobe Concierge, Watchlist,
Closet) keep asking one question -- does this actor have K+ -- and learn nothing
about stores. Purchase complexity lives inside the entitlement/provider layer.

## Grant model

| source | what it is | open-ended | provider facts |
|---|---|---|---|
| `store_subscription` | Apple/Google subscription via RevenueCat (renewal, trial, billing retry, grace) | no | yes |
| `store_lifetime` | one-time non-consumable purchase (**new**) | yes, until refund/revocation | yes, minus every subscription fact |
| `complimentary`, `complimentary_code`, `employee`, `friends_family`, `manual_support`, `promotional` | K Scan AI-issued | per grant | none |
| legacy `user_entitlements` rows | Build 34 complimentary | no (a NULL expiry stays inactive) | none |

A `store_lifetime` row is enforced by a database CHECK to be open-ended with
`expires_at`, `current_period_type`, `current_period_starts_at`, `trial_ends_at`,
`will_renew`, `grace_period_expires_at` and `pause_resumes_at` all NULL and
`billing_state = 'normal'`. It cannot pretend to have a renewal date, a trial, a
billing retry, a grace period or a period end. Its identity (`grant_key`) is an opaque
SHA-256 digest; no raw transaction id or purchase token can enter the table.

Provenance recorded for lifetime: provider (`revenuecat`), store (`apple|google`),
product id, purchase digest, provider environment (`production|sandbox`), provider
lifecycle watermark (time, rank, event id), last verified time, and refund/revocation
(`refunded` or `provider_revoked`).

## Access union

K+ is active if any currently valid grant contributes access. Nothing deletes,
shortens or overwrites another grant. Presentation picks the strongest commercial
source (`lifetime`, then `subscription`, `trial`, `complimentary`, `unknown`) without
destroying provenance.

| situation | result |
|---|---|
| lifetime + cancelled monthly | active |
| complimentary + expired monthly | active until the complimentary grant ends |
| active monthly + expired complimentary | active |
| refunded lifetime, nothing else | **free** |
| refunded lifetime + live complimentary | active (on the complimentary grant) |
| cancelled subscription | active through the verified paid-through date |
| billing retry / grace | obey the verified store lifecycle (retry alone revokes nothing; an elapsed expiry or grace is not access) |
| resolving / unreadable | **not free** (see the mobile section) |

The resolver predicate for existing sources is byte-identical to Build 34's; lifetime
is simply an open-ended grant that is not revoked, so it cannot drift from the union
rule. A static test pins this.

## Provider transition for lifetime

`apply_kplus_provider_lifetime_transition(...)` is a separate service_role-only RPC.
The Build 34 subscription transition is **not redefined**, so lifetime handling cannot
weaken its ordering or idempotency.

* server-only: revoked from `public`, `anon`, `authenticated`; the migration fails
  itself if any client role can execute it or touch a K+ table
* idempotent on `(provider, external_event_id)`; a duplicate only moves the delivery
  counter; an event id applied as a subscription cannot be reused as lifetime
* out-of-order safe: ordering is `(provider time, lifecycle rank, event id)`, never
  server receipt time; a stale event is recorded for audit and never applied; an exact
  timestamp tie resolves to the restrictive state (a refund beats a purchase)
* actor isolated: another user can neither replay an event nor claim a purchase
  (`purchase_owned_by_other_user`), also enforced by a unique index
* store and environment isolated: a production purchase cannot be mutated by a
  sandbox event (`environment_mismatch`)
* no client claim is an input: there is no price, period, trial, receipt, token,
  payload or email parameter. Event type and lifecycle must agree, so a payload cannot
  claim contradictory facts. Lifecycle is only `active | refunded | revoked`.

Typed contract: `supabase/functions/_shared/kplus/kplusEntitlementContract.ts`
(`KPlusLifetimeTransitionInput`, `toApplyKPlusProviderLifetimeTransitionArgs`,
`deriveKPlusLifetimePurchaseRefDigest`, `REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME`).

## Mobile entitlement authority

The Build 34 client read `user_entitlements` directly, which can only see the legacy
complimentary row. A store subscription or lifetime purchase would have been invisible
to the device. Now:

    get_my_kplus_entitlement_summary()
      -> services/kplus/kplusEntitlementReader.ts   (strict parse, no cache)
      -> services/kplus/kplusEntitlementStore.ts    (canonical state + bounded presentation snapshot)
      -> hooks/useKPlusEntitlement                  (unchanged public API; every gate keeps using it)

Canonical states are those of `types/kplusEntitlementContract.ts`: `resolved`,
`resolving`, `unavailable`, `signed_out`. The legacy UI states are a projection.

* The device never grants itself K+. `active` is projected only from a server answer
  that parsed and said `k_plus`; an activation response never sets state.
* **RESOLVING != FREE.** Every failed, malformed or unanswered read is unresolved
  (`loading` / `error`), never `eligible` or `expired`.
* A cached **K+** answer may stand in for an unreachable server for at most 15 minutes
  (never past its own end; a device clock set back cannot extend it). A cached **free**
  answer never stands in: unreadable is not free. A *malformed* answer never uses a
  snapshot, because it may mean the contract moved.
* Lifetime is open-ended: no end date, no expiry timer, never downgraded as time passes.
* Bounded access that runs past its own end becomes *unverified* (not free) and the
  store re-asks the server at the boundary, so a subscription that renewed in that
  instant is never told it is free.
* An actor reset invalidates any read in flight, even if the next actor has already
  answered.

The summary gained one additive key, `complimentaryHistory`: whether the account has
ever held a complimentary-family or legacy grant. It lets the device keep telling a
never-activated account (`eligible`) from one whose complimentary access has ended
(`expired`) without reading the legacy table. A Phase 1 server that lacks it reads as
never-activated.

## Complimentary users (approved policy)

Existing Build 34 complimentary users keep their grant exactly as issued. Nothing in
this phase removes, shortens, replaces, converts, restarts or auto-enrols them, forces a
paywall on them, or charges them. A later deliberate purchase *adds* a store grant
beside the complimentary one. Tests assert the legacy row and a new-style complimentary
grant are byte-identical after a lifetime purchase, and that a lifetime purchase never
creates an Early Access row or a Welcome activation on top of continuous access.

## Database

One forward-only migration, sorted after the Build 34 production ledger (143; last
`20261001204903_canonical_closet_owned_look_support`):

    20261002010000_kplus_paid_lifetime_entitlement_foundation.sql

It adds no table, no column, no policy and no table grant, and drops/deletes nothing.
It widens four closed CHECK lists, adds one unique index, replaces three functions
(`kplus_entitlement_facts`, `kplus_entitlement_summary`, `revoke_kplus_grant`) with
unchanged signatures and privileges, replaces one trigger guard, and adds one function.
The four recorded K+ migrations it builds on are pinned by content in the tests. The
migration ends with a post-condition guard that fails the migration if any client role
can reach a K+ table or privileged function.

The trigger change is a real fix, not cosmetic: the Build 34 mirror-retirement trigger
excluded only `store_subscription`, so a refunded lifetime row would have been queued as
a RevenueCat *promotional*-mirror retirement. A store purchase is never a promotional
mirror.

## Evidence

All run locally against the repository's real migrations in a disposable in-process
Postgres (PGlite 0.5.8, PostgreSQL 18.3) with Supabase-shaped shims for `auth` and the
three roles. Nothing touched a Supabase project.

* behavioural matrix: 42 scenarios, all passing (the brief's A-S, plus coexistence,
  hardening, legacy and privilege cases)
* the committed pgTAP file `supabase/tests/kplus_paid_lifetime_foundation_test.sql`:
  206 assertions, all passing; it errors without the migration
* negative controls: 16 deliberate defects, run against both the matrix and the pgTAP
  file; every one turns them red (lifetime as expiring, complimentary overwritten,
  client-reachable authority, stale event wins, same purchase on two users, refund not
  revoking, promotional-mirror leak, environment isolation removed, idempotency removed,
  operator revoking lifetime, legacy NULL-expiry regression, weakened shape constraint,
  raw reference accepted, contradictory claims accepted)
* mobile: 35 tests in `kplusCanonicalMobileReader.test.js` (resolving, unavailable,
  malformed, expired snapshot, actor change in flight) with 9 mutation controls against
  the store and reader sources
* static migration audit: 38 tests with 17 mutation controls

The pgTAP file is the reproducible form of the database evidence. The local PGlite
harness is not committed: it needs a dependency the repository does not carry.

## Hazards and findings for the next phases

1. **Release ordering.** The migration must be applied to a backend before a mobile
   build that reads `lifetime` can be relied on. A Build 35 client against a Phase 1
   backend still works (it reads `complimentaryHistory` as absent and never sees
   lifetime) but cannot show a lifetime purchase.
2. **VTO fallback.** `supabase/functions/vto-generate/vtoEntitlement.ts` asks the
   canonical RPC first, so it handles lifetime correctly. Only its RPC-outage fallback
   reads the legacy table, which would deny a lifetime or subscription customer during
   an outage. That path is VTO-owned (read-only under the VTO scope guard) and was not
   touched. It becomes a real defect once paid grants exist.
3. **Feature flag coupling (resolved by the Build 35 decoupling follow-up).**
   `EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED` now controls only the legacy complimentary
   acquisition experience. `useKPlusEntitlement` always reads canonical entitlement
   truth for authenticated actors, including when the variable is absent, false, or
   malformed. No EAS profile values were changed.
4. **Ownership transfer (Phase C).** A purchase is bound to one K Scan AI user for good.
   RevenueCat transfers a purchase between App User IDs on restore. The current design
   refuses to move a grant, so restore-after-account-switch needs an explicit, verified
   transfer rule.
5. **Sandbox in production.** The resolver honours both environments (App Review and
   TestFlight purchases are sandbox). Whether a production backend should honour
   sandbox grants for non-reviewer accounts is an owner decision.
6. **Account deletion.** Deleting a K Scan AI account does not cancel a store
   subscription (a notice exists) and a lifetime purchase is lost with the account. A
   deletion warning for lifetime owners is a product decision.
7. **Welcome activation.** A `lifetime` activation class exists; the Welcome to K+
   sender is not built.
8. **The Step 6 Early Access activation** (`KPlusActivationStep`) still grants complimentary
   access. How it coexists with the Phase D paywall is open and unchanged here.

## Phase B readiness

Phase B (native RevenueCat SDK, offerings, purchase, restore) can start from this
branch: the grant, ordering, ownership, environment and privilege rules are in place
and verified, and the mobile store already resolves a lifetime purchase and fails closed.
Phase B must still decide the RevenueCat identity rules (App User ID = Supabase auth
UUID) and must reconcile purchases through the server, never accept a client claim.
